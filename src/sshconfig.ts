// ~/.ssh/config parser — turns existing host entries into ConnectionInfo.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConnectionInfo } from './types';

interface RawHost {
    alias: string;
    hostName?: string;
    user?: string;
    port?: string;
    identityFile?: string;
}

/** Parse ~/.ssh/config into ConnectionInfo list. Hosts without HostName+User are skipped. */
export function readSshConfig(): ConnectionInfo[] {
    const configPath = path.join(os.homedir(), '.ssh', 'config');
    let text: string;
    try {
        text = fs.readFileSync(configPath, 'utf8');
    } catch {
        return [];
    }

    const raws: RawHost[] = [];
    let current: RawHost | null = null;

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }
        const m = line.match(/^(\S+)\s+(.+)$/);
        if (!m) {
            continue;
        }
        const key = m[1].toLowerCase();
        const value = m[2].trim();
        if (key === 'host') {
            if (current) {
                raws.push(current);
            }
            current = { alias: value };
        } else if (current) {
            if (key === 'hostname') {
                current.hostName = value;
            } else if (key === 'user') {
                current.user = value;
            } else if (key === 'port') {
                current.port = value;
            } else if (key === 'identityfile') {
                // Expand ~ and take the first IdentityFile only.
                if (!current.identityFile) {
                    current.identityFile = value.replace(/^~/, os.homedir());
                }
            }
        }
    }
    if (current) {
        raws.push(current);
    }

    const result: ConnectionInfo[] = [];
    for (const r of raws) {
        if (!r.hostName || !r.user) {
            continue; // Host * blocks or incomplete entries
        }
        const port = parseInt(r.port || '22', 10) || 22;
        const aliasLabel = r.alias && r.alias !== '*' ? ` (${r.alias})` : '';
        result.push({
            id: `${r.hostName}:${port}`,
            label: `${r.user}@${r.hostName}${aliasLabel}`,
            host: r.hostName,
            port,
            user: r.user,
            keyPath: r.identityFile,
            source: 'config',
            alias: r.alias && r.alias !== '*' ? r.alias : undefined,
        });
    }
    return result;
}
