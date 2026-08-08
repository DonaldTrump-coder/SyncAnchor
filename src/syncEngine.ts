// Sync engine: expand selection to files, diff against remote, upload with
// overwrite-only semantics (never deletes anything on the remote).

import * as fs from 'fs';
import * as path from 'path';
import { SFTPWrapper } from 'ssh2';
import { QueueItem, RemoteDirEntry } from './types';
import { relativeToBase, joinRemote, matchesExclude } from './relative';

/**
 * Expand selected files/folders into a flat file list (file-granularity).
 * Folders are recursive; excluded patterns and symlinks are skipped.
 * Paths outside the local base are dropped by the traversal guard.
 */
export function expandSelection(
    localBase: string,
    remoteBase: string,
    selectedPaths: string[],
    excludes: string[],
): QueueItem[] {
    const items: QueueItem[] = [];
    const seenTop = new Set<string>();
    const seenFiles = new Set<string>();

    const addFile = (absPath: string) => {
        if (seenFiles.has(absPath)) {
            return; // dedupe: folder expansion may already include this file
        }
        const rel = relativeToBase(localBase, absPath);
        if (!rel) {
            return; // outside base — guarded
        }
        if (excludes.some((p) => matchesExclude(p, rel))) {
            return;
        }
        let st: fs.Stats;
        try {
            st = fs.statSync(absPath);
        } catch {
            return;
        }
        items.push({
            relPath: rel,
            localPath: absPath,
            remotePath: joinRemote(remoteBase, rel),
            status: 'new',
            size: st.size,
            mtimeMs: st.mtimeMs,
        });
        seenFiles.add(absPath);
    };

    const walk = (absPath: string) => {
        let st: fs.Stats;
        try {
            st = fs.lstatSync(absPath);
        } catch {
            return;
        }
        if (st.isSymbolicLink()) {
            return; // never follow symlinks
        }
        if (st.isFile()) {
            addFile(absPath);
            return;
        }
        if (!st.isDirectory()) {
            return;
        }
        const rel = relativeToBase(localBase, absPath);
        if (rel && excludes.some((p) => matchesExclude(p, rel))) {
            return; // excluded directory — do not descend
        }
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(absPath, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (e.isSymbolicLink()) {
                continue;
            }
            const child = path.join(absPath, e.name);
            if (e.isDirectory()) {
                walk(child);
            } else if (e.isFile()) {
                addFile(child);
            }
        }
    };

    for (const p of selectedPaths) {
        const key = path.resolve(p);
        if (seenTop.has(key)) {
            continue;
        }
        seenTop.add(key);
        walk(key);
    }
    return items;
}

/** Compare local items against the remote: new / overwrite / skip by size+mtime. */
export async function diffRemote(
    sftp: SFTPWrapper,
    items: QueueItem[],
    onItem?: (item: QueueItem) => void,
): Promise<QueueItem[]> {
    for (const it of items) {
        try {
            const st = await stat(sftp, it.remotePath);
            const same = st.size === it.size && Math.abs(st.mtime * 1000 - it.mtimeMs) < 2000;
            it.status = same ? 'skip' : 'overwrite';
        } catch (e) {
            if (e && (e as NodeJS.ErrnoException).code === 'ENOENT') {
                it.status = 'new'; // remote file does not exist — legitimately new
            } else {
                // Anything else (e.g. the SSH session died mid-diff) is NOT
                // "new": flag it so the user sees the failure before uploading.
                it.status = 'error';
                it.error = e instanceof Error ? e.message : String(e);
            }
        }
        onItem?.(it);
    }
    return items;
}

/** Upload items over SFTP. Overwrites existing files, creates missing ones, never deletes. */
export async function uploadFiles(
    sftp: SFTPWrapper,
    items: QueueItem[],
    opts: {
        backup: boolean;
        onProgress: (done: number, total: number, current: string) => void;
    },
): Promise<void> {
    const { backup, onProgress } = opts;
    const backupRoot = backup ? await prepareBackupRoot(sftp) : undefined;
    let done = 0;
    for (const it of items) {
        if (it.status === 'skip') {
            it.status = 'done';
            done++;
            onProgress(done, items.length, it.relPath);
            continue;
        }
        try {
            if (backupRoot && it.status === 'overwrite') {
                await backupRemote(sftp, backupRoot, it.remotePath, it.relPath);
            }
            await ensureRemoteDir(sftp, dirname(it.remotePath));
            await fastPut(sftp, it.localPath, it.remotePath);
            it.status = 'done';
        } catch (e) {
            it.status = 'error';
            it.error = e instanceof Error ? e.message : String(e);
        }
        done++;
        onProgress(done, items.length, it.relPath);
    }
}

/** List a remote directory (read-only reference tree). */
export async function readRemoteDir(sftp: SFTPWrapper, remoteDir: string): Promise<RemoteDirEntry[]> {
    const list = await readdir(sftp, remoteDir);
    return list
        .filter((x) => x.attrs && x.attrs.isDirectory() !== undefined)
        .map((x) => ({ name: x.filename, isDir: x.attrs.isDirectory() }));
}

/** Recursively create a remote directory if needed. */
export async function ensureRemoteDir(sftp: SFTPWrapper, remoteDir: string): Promise<void> {
    const parts = remoteDir.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
        cur += '/' + part;
        try {
            await stat(sftp, cur);
        } catch {
            await mkdir(sftp, cur);
        }
    }
}

// ---- SFTP helpers (promisified) ----

function stat(sftp: SFTPWrapper, p: string): Promise<{ size: number; mtime: number }> {
    return new Promise((resolve, reject) =>
        sftp.stat(p, (err, st) => (err ? reject(err) : resolve({ size: st.size, mtime: st.mtime }))),
    );
}

function readdir(sftp: SFTPWrapper, p: string): Promise<Array<{ filename: string; attrs: { isDirectory: () => boolean } }>> {
    return new Promise((resolve, reject) =>
        sftp.readdir(p, (err, list) => (err ? reject(err) : resolve(list))),
    );
}

function fastPut(sftp: SFTPWrapper, local: string, remote: string): Promise<void> {
    return new Promise((resolve, reject) =>
        sftp.fastPut(local, remote, (err) => (err ? reject(err) : resolve())),
    );
}

function mkdir(sftp: SFTPWrapper, p: string): Promise<void> {
    return new Promise((resolve, reject) =>
        sftp.mkdir(p, (err) => (err ? reject(err) : resolve())),
    );
}

function rename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
    return new Promise((resolve, reject) =>
        sftp.rename(from, to, (err) => (err ? reject(err) : resolve())),
    );
}

function dirname(remotePath: string): string {
    const i = remotePath.lastIndexOf('/');
    return i <= 0 ? '/' : remotePath.slice(0, i);
}

async function prepareBackupRoot(sftp: SFTPWrapper): Promise<string> {
    const root = `.sync-anchor-backup/${Date.now()}`;
    await ensureRemoteDir(sftp, root);
    return root;
}

async function backupRemote(sftp: SFTPWrapper, root: string, remotePath: string, relPath: string): Promise<void> {
    const dest = `${root}/${relPath}`;
    await ensureRemoteDir(sftp, dirname(dest));
    await rename(sftp, remotePath, dest);
}
