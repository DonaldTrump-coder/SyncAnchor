// Detect LIVE SSH connections by scanning ssh/ssh.exe process command lines.
//
// VS Code extensions cannot read another window's active connections, but the
// OS can: every live `ssh` connection is a process, and its command line names
// the target host. This is the most reliable way to answer "what am I connected
// to right now" from a local window.

import * as cp from 'child_process';

export interface LiveSshTarget {
    host: string;
    port?: number;
    user?: string;
}

/** ssh short options that take a value (skip their value token when parsing). */
const OPT_WITH_VALUE = new Set([
    '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-L', '-l', '-m',
    '-o', '-O', '-p', '-Q', '-R', '-S', '-W', '-w',
]);

/** Command lines of running ssh processes (cross-platform). */
export function listSshProcesses(): string[] {
    try {
        if (process.platform === 'win32') {
            const out = cp.execSync(
                'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'ssh.exe\'\\" | Select-Object -ExpandProperty CommandLine"',
                { encoding: 'utf8', timeout: 10000 },
            );
            return out
                .split(/\r?\n/)
                .map((s) => s.trim())
                .filter(Boolean);
        }
        const out = cp.execSync('ps -ax -o command=', { encoding: 'utf8', timeout: 5000 });
        return out
            .split(/\r?\n/)
            .filter((l) => /\b(?:ssh|ssh\.exe)\b/.test(l) && !/\b(?:grep|ps)\b/.test(l));
    } catch {
        return [];
    }
}

/** Scan for live SSH connections — the target of every running ssh process. */
export function scanLiveSsh(): LiveSshTarget[] {
    const seen = new Set<string>();
    const out: LiveSshTarget[] = [];
    for (const cmd of listSshProcesses()) {
        const t = parseSshCommandLine(cmd);
        if (!t || !t.host) {
            continue;
        }
        const key = `${t.user ?? ''}@${t.host}:${t.port ?? 22}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push(t);
    }
    return out;
}

/** Parse one ssh command line into its destination host (first positional arg). */
export function parseSshCommandLine(cmd: string): LiveSshTarget | undefined {
    const tokens = tokenize(cmd);
    const positional: string[] = [];
    let port: number | undefined;
    let user: string | undefined;

    for (let i = 1; i < tokens.length; i++) {
        // skip program path (tokens[0])
        const t = tokens[i];
        if (t === '-p' && tokens[i + 1]) {
            const n = parseInt(tokens[++i], 10);
            if (!isNaN(n)) {
                port = n;
            }
            continue;
        }
        if (t === '-l' && tokens[i + 1]) {
            user = tokens[++i];
            continue;
        }
        if (OPT_WITH_VALUE.has(t) && tokens[i + 1]) {
            i++; // option value
            continue;
        }
        if (t.startsWith('-')) {
            continue;
        }
        positional.push(t);
    }

    const dest = positional[0];
    if (!dest) {
        return undefined;
    }
    let host = dest;
    let u = user;
    if (dest.includes('@')) {
        const i = dest.lastIndexOf('@');
        u = u || dest.slice(0, i);
        host = dest.slice(i + 1);
    }
    if (!host) {
        return undefined;
    }
    return { host, port, user: u };
}

/** Quote-aware tokenizer for a command line. */
function tokenize(cmd: string): string[] {
    const tokens: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < cmd.length; i++) {
        const ch = cmd[i];
        if (ch === '"') {
            inQ = !inQ;
            continue;
        }
        if (ch === ' ' && !inQ) {
            if (cur) {
                tokens.push(cur);
                cur = '';
            }
            continue;
        }
        cur += ch;
    }
    if (cur) {
        tokens.push(cur);
    }
    return tokens;
}
