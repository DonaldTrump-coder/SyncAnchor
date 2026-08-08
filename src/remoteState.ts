// Read Remote-SSH connection history from VS Code's state.vscdb.
//
// Modern Remote-SSH stores its state in the SQLite-backed state.vscdb rather
// than loose JSON files in globalStorage. SQLite stores string values as
// contiguous UTF-8 bytes, so a plain-text scan of the file reliably extracts
// `ssh-remote+...` authority strings without needing a SQLite dependency.
// Entries with connection parameters are hex-encoded JSON, e.g.
//   7b22686f73744e616d65223a... -> {"hostName":"host -p 1234","user":"..."}

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface RemoteSshEntry {
    host: string;
    port: number;
    user?: string;
    /** True when Remote-SSH marks this host as a current/last connection (tunnels.toRestore). */
    isCurrent?: boolean;
}

export function remoteSshDbPath(): string {
    return process.platform === 'win32'
        ? path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'state.vscdb')
        : path.join(os.homedir(), '.config', 'Code', 'User', 'globalStorage', 'state.vscdb');
}

/** Scan state.vscdb for every host the user has connected to via Remote-SSH. */
export function readRemoteSshHistory(dbPath?: string): RemoteSshEntry[] {
    const p = dbPath || remoteSshDbPath();
    try {
        if (!fs.existsSync(p)) {
            return [];
        }
        const text = fs.readFileSync(p, 'utf8');

        // Current/last connections are marked by Remote-SSH as tunnel-restore entries.
        const current = new Set<string>();
        const curRe = /remote\.tunnels\.toRestore\.ssh-remote\+([^\s"'`})\\ \u0000-\u001f\u007f-\uffff]+)/g;
        let cm: RegExpExecArray | null;
        while ((cm = curRe.exec(text))) {
            const e = decodeHostEntry(cm[1]);
            if (e && e.host) {
                current.add(e.host);
            }
        }

        // All ssh-remote+ authorities (folder history, hints, storage markers).
        const byHost = new Map<string, RemoteSshEntry>();
        const re = /ssh-remote\+([^\s"'`})\\ \u0000-\u001f\u007f-\uffff]+)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
            const e = decodeHostEntry(m[1]);
            if (!e || !e.host) {
                continue;
            }
            const prev = byHost.get(e.host);
            if (!prev || (current.has(e.host) && !prev.isCurrent)) {
                byHost.set(e.host, { ...e, isCurrent: current.has(e.host) });
            }
        }
        const entries = [...byHost.values()];
        // Current/last connections first, then insertion order.
        entries.sort((a, b) => (a.isCurrent === b.isCurrent ? 0 : a.isCurrent ? -1 : 1));
        return entries;
    } catch {
        return [];
    }
}

/** Decode one `ssh-remote+...` value into a host entry (handles hex-encoded JSON). */
export function decodeHostEntry(raw: string): RemoteSshEntry | undefined {
    let host = raw;
    let user: string | undefined;
    let port = 22;

    if (/^[0-9a-f]+$/i.test(raw) && raw.length > 40) {
        // Hex-encoded JSON: {"hostName":"host -p 1234","user":"user"}
        try {
            const json = JSON.parse(Buffer.from(raw, 'hex').toString('utf8'));
            if (json.hostName) {
                const parts = String(json.hostName).split(/\s+/);
                host = parts[0];
                const pi = parts.indexOf('-p');
                if (pi >= 0 && parts[pi + 1]) {
                    const n = parseInt(parts[pi + 1], 10);
                    if (!isNaN(n)) {
                        port = n;
                    }
                }
            }
            if (json.user) {
                user = String(json.user).replace(/^ssh\s+/i, '');
            }
        } catch {
            return undefined;
        }
    }

    if (!host) {
        return undefined;
    }
    if (host.includes('@')) {
        const i = host.lastIndexOf('@');
        if (!user) {
            user = host.slice(0, i);
        }
        host = host.slice(i + 1);
    }
    // Strip Remote-SSH instance-id suffix: `host.<long-digits>` (not for bare IPv4).
    const inst = host.match(/^(.+?)\.(\d{6,})$/);
    if (inst && !/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        host = inst[1];
    }
    if (!isPlausibleHost(host)) {
        return undefined;
    }
    return { host, port, user };
}

/**
 * Strict hostname sanity check. The plain-text SQLite scan can pick up
 * neighboring binary/boolean residues (e.g. `hostfalse`), so only accept
 * well-formed IPv4 addresses or domain names.
 */
function isPlausibleHost(host: string): boolean {
    if (!host || host.length > 100 || /false|true/i.test(host)) {
        return false;
    }
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
        return true; // IPv4
    }
    const labels = host.split('.');
    if (labels.length < 2) {
        return false;
    }
    for (const l of labels) {
        if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(l)) {
            return false;
        }
    }
    const tld = labels[labels.length - 1];
    return /^[a-zA-Z]{2,24}$/.test(tld);
}
