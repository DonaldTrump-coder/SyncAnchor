// Shared types for Sync Anchor.

import * as ssh2 from 'ssh2';

/** A candidate SSH connection, built from existing config — no user input required. */
export interface ConnectionInfo {
    /** Unique id, e.g. `host:port`. */
    id: string;
    /** Display label, e.g. "featurize@workspace.featurize.cn (featurize)". */
    label: string;
    host: string;
    port: number;
    user: string;
    /** Optional private key path. */
    keyPath?: string;
    /** Where the connection came from. */
    source: 'config' | 'recent' | 'remote';
    /** ssh config alias (Host) when the entry came from ~/.ssh/config. */
    alias?: string;
    /** True when this host is Remote-SSH's current/last connection. */
    current?: boolean;
}

/** Live SSH session: client + SFTP wrapper. */
export interface LiveConnection {
    info: ConnectionInfo;
    client: ssh2.Client;
    sftp: ssh2.SFTPWrapper;
}

/** Per-file transfer state. */
export type QueueStatus = 'new' | 'overwrite' | 'skip' | 'done' | 'error';

export interface QueueItem {
    /** Path relative to the local base, POSIX separators. */
    relPath: string;
    /** Absolute local path. */
    localPath: string;
    /** Absolute remote path = remote base + relPath. */
    remotePath: string;
    status: QueueStatus;
    /** Local file size in bytes. */
    size: number;
    /** Local mtime in ms. */
    mtimeMs: number;
    error?: string;
}

/** A directory entry shown in the local tree. */
export interface DirEntry {
    name: string;
    /** Absolute path. */
    path: string;
    isDir: boolean;
    /** True when the entry matches an exclude pattern (hidden from tree). */
    excluded: boolean;
}

/** Remote directory entry (read-only reference tree). */
export interface RemoteDirEntry {
    name: string;
    isDir: boolean;
}

/** Message protocol: webview -> extension. */
export type W2EMessage =
    | { type: 'ready' }
    | { type: 'getState' }
    | { type: 'getConnections' }
    | { type: 'connect'; id: string; password?: string }
    | { type: 'disconnect' }
    | { type: 'readDir'; dirPath: string }
    | { type: 'pickLocalBase' }
    | { type: 'setLocalBase'; path: string }
    | { type: 'pickRemoteBase' }
    | { type: 'setRemoteBase'; path: string }
    | { type: 'setBackup'; value: boolean }
    | { type: 'preview'; selectedPaths: string[] }
    | { type: 'cancelPreview' }
    | { type: 'upload' }
    | { type: 'readRemoteDir'; dirPath: string }
    | { type: 'collectFiles'; dirPath: string };

/** Message protocol: extension -> webview. */
export type E2WMessage =
    | {
          type: 'state';
          localBase: string | undefined;
          remoteBase: string | undefined;
          connId: string | undefined;
          connLabel: string | undefined;
          connected: boolean;
          backup: boolean;
          excludes: string[];
      }
    | { type: 'connections'; list: ConnectionInfo[]; activeId?: string }
    | { type: 'dir'; dirPath: string; entries: DirEntry[] }
    | { type: 'remoteDir'; dirPath: string; entries: RemoteDirEntry[] }
    | { type: 'homeDir'; path: string }
    | { type: 'filesCollected'; dirPath: string; files: string[]; dirs: string[] }
    | { type: 'queue'; items: QueueItem[]; mode: 'preview' | 'result' }
    | { type: 'queueItem'; item: QueueItem; mode: 'preview' }
    | { type: 'uploadDone'; hasErrors: boolean }
    | { type: 'progress'; done: number; total: number; current: string }
    | { type: 'log'; line: string }
    | { type: 'status'; text: string; ok: boolean }
    | { type: 'error'; message: string };
