// Minimal .gitignore parser: turn gitignore text into a matcher for relative
// paths (POSIX separators). Covers the common rules:
//   - blank lines and `#` comments
//   - `!` negation (last matching rule wins, like git)
//   - trailing `/` directory-only patterns
//   - leading `/` anchored to the ignore-file directory (the base)
//   - patterns without `/` match the basename at any depth
//   - `*` (any run of non-`/`), `**` (any run including `/`), `?` (one char)

export interface GitignoreRule {
    regex: RegExp;
    negate: boolean;
    dirOnly: boolean;
    anchored: boolean;
    /** Original pattern (leading / stripped) for anchored subtree matches. */
    anchor?: string;
}

export function parseGitignore(text: string): (relPath: string, isDir: boolean) => boolean {
    const rules: GitignoreRule[] = [];
    for (let line of text.split(/\r?\n/)) {
        line = line.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }
        let negate = false;
        let dirOnly = false;
        if (line.startsWith('!')) {
            negate = true;
            line = line.slice(1).trim();
        }
        if (line.endsWith('/')) {
            dirOnly = true;
            line = line.slice(0, -1);
        }
        // Git semantics: a pattern containing `/` (other than a trailing one,
        // already stripped) is anchored to the ignore-file directory.
        const anchored = line.startsWith('/') || line.includes('/');
        line = line.replace(/^\/+/, '');
        if (!line) {
            continue;
        }
        rules.push({
            regex: globToRegex(line),
            negate,
            dirOnly,
            anchored,
            anchor: anchored ? line : undefined,
        });
    }
    return (relPath: string, isDir: boolean): boolean => {
        let ignored = false;
        const segs = relPath.split('/');
        const name = segs[segs.length - 1];
        for (const r of rules) {
            let hit: boolean;
            if (r.dirOnly) {
                // A directory pattern matches the directory itself (when the
                // entry IS a directory) or anything under it (parent segment).
                const parents = segs.slice(0, -1);
                hit = (isDir && r.regex.test(name)) || parents.some((s) => r.regex.test(s));
            } else if (r.anchored) {
                // Match the pattern itself or anything under it.
                hit =
                    r.regex.test(relPath) ||
                    (r.anchor !== undefined &&
                        (relPath === r.anchor || relPath.startsWith(r.anchor + '/')));
            } else {
                hit = r.regex.test(name) || r.regex.test(relPath) || segs.some((s) => r.regex.test(s));
            }
            if (hit) {
                ignored = !r.negate;
            }
        }
        return ignored;
    };
}

function globToRegex(glob: string): RegExp {
    let out = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                i++;
                out += '.*';
            } else {
                out += '[^/]*';
            }
        } else if (c === '?') {
            out += '[^/]';
        } else {
            out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp('^' + out + '$');
}
