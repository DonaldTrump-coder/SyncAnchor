// Relative-path math with a hard path-traversal guard.

import * as path from 'path';

/**
 * Compute the relative path of `absPath` under `base`, using POSIX separators.
 * Returns undefined when `absPath` is outside `base` (traversal guard) or equals `base`.
 */
export function relativeToBase(base: string, absPath: string): string | undefined {
    const rel = path.relative(base, absPath);
    if (!rel) {
        return undefined; // absPath === base
    }
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
        return undefined; // outside base, or cross-drive absolute path on Windows
    }
    return rel.split(path.sep).join('/');
}

/** Join a remote base and a POSIX relative path into a remote path. */
export function joinRemote(base: string, relPath: string): string {
    const b = base.endsWith('/') ? base.slice(0, -1) : base;
    return `${b}/${relPath}`;
}

/**
 * Simple glob-like matcher for exclude patterns (rsync-style semantics).
 * Supports `*` (within one path segment).
 * A pattern without `/` matches any path segment (basename); a pattern with
 * `/` matches the whole relative path or any leading prefix.
 */
export function matchesExclude(pattern: string, relPath: string): boolean {
    const rel = relPath.replace(/\\/g, '/');
    const regex = new RegExp('^' + pattern.split('*').map(escapeRegex).join('[^/]*') + '$');
    if (!pattern.includes('/')) {
        return rel.split('/').some((seg) => regex.test(seg));
    }
    const segments = rel.split('/');
    for (let i = 1; i <= segments.length; i++) {
        if (regex.test(segments.slice(0, i).join('/'))) {
            return true;
        }
    }
    return false;
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
