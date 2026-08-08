// Connection management: sources merged from existing config, no user input required.

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Client, SFTPWrapper } from 'ssh2';
import { ConnectionInfo, LiveConnection } from './types';
import { readSshConfig } from './sshconfig';
import { readRemoteSshHistory } from './remoteState';
import { scanLiveSsh } from './liveSsh';

export class ConnectionManager {
    private live: LiveConnection | null = null;
    private home = '';

    /**
     * Connections the user is CURRENTLY connected to: live ssh processes at
     * the OS level, plus the current remote window (when running inside one).
     * Config/history candidates are intentionally NOT merged in — the dropdown
     * shows only what is connected right now, and updates as connections change.
     */
    async listCandidates(): Promise<ConnectionInfo[]> {
        const map = new Map<string, ConnectionInfo>();
        try {
            for (const c of this.liveConnections()) {
                map.set(c.id, c);
            }
        } catch {
            // Non-fatal.
        }
        try {
            for (const c of await this.currentRemote()) {
                if (!map.has(c.id)) {
                    map.set(c.id, c);
                }
            }
        } catch {
            // Non-fatal.
        }
        return [...map.values()];
    }

    /**
     * Live SSH connections detected at the OS level (running ssh processes).
     * These are the servers the user is connected to right now, marked current
     * and listed first.
     */
    private liveConnections(): ConnectionInfo[] {
        const configHosts = readSshConfig();
        const results: ConnectionInfo[] = [];
        const seen = new Set<string>();
        for (const t of scanLiveSsh()) {
            // `ssh <alias>` resolves through config; `ssh host` matches directly.
            const cfg = configHosts.find((c) => c.alias === t.host) ||
                configHosts.find((c) => c.host === t.host);
            const host = cfg ? cfg.host : t.host;
            const port = cfg ? cfg.port : t.port ?? 22;
            const user = cfg ? cfg.user : t.user ?? 'root';
            const id = `${host}:${port}`;
            if (seen.has(id)) {
                continue;
            }
            seen.add(id);
            results.push({
                id,
                label: `${user}@${host}`,
                host,
                port,
                user,
                keyPath: cfg?.keyPath,
                source: 'remote',
                current: true,
            });
        }
        return results;
    }

    get active(): LiveConnection | null {
        return this.live;
    }

    get activeInfo(): ConnectionInfo | undefined {
        return this.live?.info;
    }

    /**
     * The connection of the Remote-SSH window this extension runs in, if any.
     * In a remote window the workspace folder URIs carry `ssh-remote+user@host`;
     * when no folder is open, fall back to the machine itself (whoami/hostname —
     * the extension host runs ON the remote box).
     */
    private async currentRemote(): Promise<ConnectionInfo[]> {
        if (vscode.env.remoteName !== 'ssh-remote') {
            return [];
        }
        const authority =
            vscode.workspace.workspaceFolders?.[0]?.uri.authority ||
            (vscode.workspace.workspaceFile ? vscode.workspace.workspaceFile.authority : '');
        const m = authority.match(/^ssh-remote\+(.+)$/);
        if (m) {
            const [user, hostPort] = splitUserHost(m[1]);
            const { host, port } = splitHostPort(hostPort);
            return [
                {
                    id: `${host}:${port}`,
                    label: `${user}@${host} (current window)`,
                    host,
                    port,
                    user,
                    source: 'remote',
                },
            ];
        }
        try {
            const who = cp.execSync('whoami', { encoding: 'utf8', timeout: 5000 }).trim();
            const hn = cp.execSync('hostname', { encoding: 'utf8', timeout: 5000 }).trim();
            if (who && hn) {
                return [
                    {
                        id: `${hn}:22`,
                        label: `${who}@${hn} (this machine)`,
                        host: hn,
                        port: 22,
                        user: who,
                        source: 'remote',
                    },
                ];
            }
        } catch {
            // ignore
        }
        return [];
    }

    /**
     * Connections the user has used before: Remote-SSH history (state.vscdb)
     * merged with ~/.ssh/config so user/port/key come from the config when
     * a host has an entry there. The current/last Remote-SSH host is marked.
     * (Kept for potential future use — the dropdown intentionally shows only
     * live connections.)
     */
    private recentConnections(): ConnectionInfo[] {
        const configHosts = readSshConfig();
        const results: ConnectionInfo[] = [];
        const seen = new Set<string>();

        const add = (host: string, port: number, user: string | undefined, isCurrent: boolean) => {
            const cfg = configHosts.find((c) => c.host === host);
            const p = cfg ? cfg.port : port;
            const id = `${host}:${p}`;
            if (seen.has(id)) {
                return;
            }
            seen.add(id);
            const u = user || cfg?.user || 'root';
            results.push({
                id,
                label: `${u}@${host}`,
                host,
                port: p,
                user: u,
                keyPath: cfg?.keyPath,
                source: 'recent',
                current: isCurrent,
            });
        };

        for (const h of readRemoteSshHistory()) {
            add(h.host, h.port, h.user, !!h.isCurrent);
        }

        // Legacy fallback: Remote-SSH used to keep recent connections as JSON
        // files in its globalStorage folder.
        try {
            const base =
                process.platform === 'win32'
                    ? path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'ms-vscode-remote.remote-ssh')
                    : path.join(os.homedir(), '.config', 'Code', 'User', 'globalStorage', 'ms-vscode-remote.remote-ssh');
            if (fs.existsSync(base)) {
                for (const file of fs.readdirSync(base)) {
                    if (!file.endsWith('.json')) {
                        continue;
                    }
                    const text = fs.readFileSync(path.join(base, file), 'utf8');
                    const re = /ssh-remote\+([^\s"']+)/g;
                    let m: RegExpExecArray | null;
                    while ((m = re.exec(text))) {
                        const [user, hostPort] = splitUserHost(m[1]);
                        const { host, port } = splitHostPort(hostPort);
                        add(host, port, user || undefined, false);
                    }
                }
            }
        } catch {
            // Non-fatal.
        }
        return results;
    }

    /** Connect over SSH2 and open the SFTP channel. Reuses the live connection when ids match. */
    async connect(info: ConnectionInfo, password?: string): Promise<LiveConnection> {
        if (this.live && this.live.info.id === info.id) {
            return this.live;
        }
        await this.disconnect();

        const client = new Client();
        const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
            let settled = false;
            const fail = (err: Error) => {
                if (!settled) {
                    settled = true;
                    reject(err);
                }
            };
            client.once('error', fail);

            const cfg: {
                host: string;
                port: number;
                username: string;
                readyTimeout: number;
                privateKey?: Buffer;
                password?: string;
            } = {
                host: info.host,
                port: info.port,
                username: info.user,
                readyTimeout: 15000,
            };
            const key = info.keyPath || path.join(os.homedir(), '.ssh', 'id_rsa');
            if (fs.existsSync(key)) {
                cfg.privateKey = fs.readFileSync(key);
            }
            if (password) {
                cfg.password = password;
            }

            client.once('ready', () => {
                client.sftp((err, s) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    if (err) {
                        client.end();
                        reject(err);
                        return;
                    }
                    resolve(s);
                });
            });
            client.connect(cfg);
        });

        this.live = { info, client, sftp };
        this.home = '';
        return this.live;
    }

    async disconnect(): Promise<void> {
        if (this.live) {
            const c = this.live.client;
            this.live = null;
            try {
                c.end();
            } catch {
                // ignore
            }
        }
    }

    /** Expand `~/...` in a remote path using the connected session's $HOME. */
    async resolveTilde(p: string): Promise<string> {
        if (!p.startsWith('~')) {
            return p;
        }
        if (!this.live) {
            return p;
        }
        if (!this.home) {
            this.home = await new Promise<string>((resolve) => {
                const live = this.live;
                if (!live) {
                    resolve('');
                    return;
                }
                live.client.exec('echo -n "$HOME"', (err, stream) => {
                    if (err) {
                        resolve('');
                        return;
                    }
                    let out = '';
                    stream.on('data', (d: Buffer) => {
                        out += d.toString();
                    });
                    stream.on('close', () => resolve(out.trim()));
                });
            });
        }
        return this.home ? p.replace(/^~/, this.home) : p;
    }
}

function splitUserHost(s: string): [string, string] {
    const i = s.lastIndexOf('@');
    return i >= 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, ''];
}

function splitHostPort(s: string): { host: string; port: number } {
    if (!s) {
        return { host: 'localhost', port: 22 };
    }
    if (s.startsWith('[')) {
        const m = s.match(/^\[(.+)\](?::(\d+))?$/);
        return { host: m ? m[1] : s, port: m && m[2] ? parseInt(m[2], 10) : 22 };
    }
    const i = s.lastIndexOf(':');
    if (i > 0) {
        const port = parseInt(s.slice(i + 1), 10);
        return { host: s.slice(0, i), port: isNaN(port) ? 22 : port };
    }
    return { host: s, port: 22 };
}
