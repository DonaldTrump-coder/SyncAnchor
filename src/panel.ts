// Full-screen webview panel: local tree, remote tree, transfer queue, log.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConnectionManager } from './connection';
import { pickConnection, pickLocalBase, pickRemoteBase } from './picker';
import { diffRemote, expandSelection, readRemoteDir, uploadFiles } from './syncEngine';
import { matchesExclude, relativeToBase } from './relative';
import { parseGitignore } from './gitignore';
import { DirEntry, E2WMessage, QueueItem, W2EMessage } from './types';

export class SyncAnchorPanel {
    static readonly viewType = 'syncAnchor.panel';
    private static current: SyncAnchorPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private readonly disposables: vscode.Disposable[] = [];
    private queue: QueueItem[] = [];
    private uploading = false;
    private previewGen = 0;
    private gitignoreBase = '';
    private gitignoreMtime = 0;
    private gitignoreMatcher: ((relPath: string, isDir: boolean) => boolean) | undefined;

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly ctx: vscode.ExtensionContext,
        private readonly conn: ConnectionManager,
        private readonly log: (line: string) => void,
    ) {
        this.panel = panel;
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')],
        };
        // Register the message listener BEFORE setting html: the webview loads and
        // posts `ready`/`getConnections` immediately, and messages sent before the
        // listener exists are silently dropped — leaving the dropdown empty.
        panel.webview.onDidReceiveMessage((m: W2EMessage) => void this.onMessage(m), undefined, this.disposables);
        panel.webview.html = this.html();
        panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    }

    /** Show the panel (reveal when already open). */
    static show(
        ctx: vscode.ExtensionContext,
        conn: ConnectionManager,
        log: (line: string) => void,
    ): SyncAnchorPanel {
        const column = vscode.ViewColumn.One;
        if (SyncAnchorPanel.current) {
            SyncAnchorPanel.current.panel.reveal(column, true);
            return SyncAnchorPanel.current;
        }
        const panel = vscode.window.createWebviewPanel(SyncAnchorPanel.viewType, 'Sync Anchor', column, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')],
        });
        SyncAnchorPanel.current = new SyncAnchorPanel(panel, ctx, conn, log);
        return SyncAnchorPanel.current;
    }

    /** Run a panel action from a command (panel is opened on demand). */
    async handleCommand(action: 'setLocalBase' | 'setRemoteBase' | 'pickConnection'): Promise<void> {
        if (action === 'setLocalBase') {
            await this.chooseLocalBase();
        } else if (action === 'setRemoteBase') {
            await this.chooseRemoteBase();
        } else {
            await this.chooseConnection();
        }
    }

    // ---- webview <-> extension ----

    private post(m: E2WMessage): void {
        void this.panel.webview.postMessage(m);
    }

    private sendState(): void {
        const cfg = vscode.workspace.getConfiguration('syncAnchor');
        this.post({
            type: 'state',
            localBase: this.ctx.globalState.get<string>('syncAnchor.localBase'),
            remoteBase: this.ctx.globalState.get<string>('syncAnchor.remoteBase'),
            connId: this.conn.activeInfo?.id,
            connLabel: this.conn.activeInfo?.label,
            connected: !!this.conn.active,
            backup: cfg.get<boolean>('backupBeforeOverwrite', false),
            excludes: cfg.get<string[]>('excludes', []),
        });
    }

    private async pushConnections(): Promise<void> {
        try {
            const list = await this.conn.listCandidates();
            // The SSH session we were connected to is gone (user closed the
            // terminal / dropped the connection): release the active state so
            // the indicator turns grey and the buttons disable.
            const active = this.conn.activeInfo;
            if (active && !list.some((c) => c.id === active.id)) {
                this.log(`Connection ${active.label} is no longer live — disconnecting`);
                await this.conn.disconnect();
                this.post({
                    type: 'status',
                    text: `SSH connection closed — disconnected (${active.label})`,
                    ok: false,
                });
            }
            this.log(
                `Found ${list.length} connection candidate(s): ` +
                    list
                        .map((c) => `${c.user}@${c.host}:${c.port}${c.current ? '*CURRENT*' : ''}`)
                        .join(', '),
            );
            this.post({
                type: 'connections',
                list,
                // Prefer the active connection; fall back to the last used one.
                activeId: this.conn.activeInfo?.id ?? this.ctx.globalState.get<string>('syncAnchor.connId'),
            });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.log(`Failed to load connections: ${msg}`);
            this.post({ type: 'error', message: `Failed to load connections: ${msg}` });
            this.post({ type: 'connections', list: [], activeId: undefined });
        }
    }

    private async onMessage(m: W2EMessage): Promise<void> {
        switch (m.type) {
            case 'ready':
            case 'getState':
                this.sendState();
                break;
            case 'getConnections':
                await this.pushConnections();
                break;
            case 'connect':
                await this.connectTo(m.id, m.password);
                break;
            case 'disconnect':
                await this.conn.disconnect();
                this.log('Disconnected');
                this.sendState();
                break;
            case 'readDir':
                this.readLocalDir(m.dirPath);
                break;
            case 'pickLocalBase':
                await this.chooseLocalBase();
                break;
            case 'setLocalBase':
                await this.setLocalBase(m.path);
                break;
            case 'pickRemoteBase':
                await this.chooseRemoteBase();
                break;
            case 'setRemoteBase':
                await this.setRemoteBase(m.path);
                break;
            case 'setBackup':
                await vscode.workspace
                    .getConfiguration('syncAnchor')
                    .update('backupBeforeOverwrite', m.value, vscode.ConfigurationTarget.Global);
                this.sendState();
                break;
            case 'preview':
                await this.preview(m.selectedPaths);
                break;
            case 'cancelPreview':
                // Invalidate any in-flight preview so its diff callbacks stop
                // appending into the queue (e.g. the user hit Refresh mid-run).
                this.previewGen++;
                this.queue = [];
                this.log('Preview cancelled');
                break;
            case 'upload':
                await this.upload();
                break;
            case 'readRemoteDir':
                await this.readRemote(m.dirPath);
                break;
            case 'collectFiles':
                this.collectLocalFiles(m.dirPath);
                break;
        }
    }

    // ---- connections ----

    private async connectTo(id: string, password?: string): Promise<void> {
        const info = (await this.conn.listCandidates()).find((c) => c.id === id);
        if (!info) {
            this.post({ type: 'error', message: `Unknown connection: ${id}` });
            return;
        }
        try {
            this.post({ type: 'status', text: `Connecting to ${info.label}...`, ok: true });
            this.log(`Connecting to ${info.label}...`);
            await this.conn.connect(info, password);
            this.log(`Connected: ${info.label}`);
            this.post({ type: 'status', text: `Connected: ${info.label}`, ok: true });
            await this.ctx.globalState.update('syncAnchor.connId', info.id);
            this.sendState();
            const base = this.ctx.globalState.get<string>('syncAnchor.remoteBase');
            if (base) {
                await this.readRemote(base);
            } else {
                // No base set yet: start browsing from the home directory.
                const home = await this.conn.resolveTilde('~');
                if (home) {
                    this.post({ type: 'homeDir', path: home });
                }
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.log(`Connect failed: ${msg}`);
            this.post({ type: 'status', text: 'Connect failed', ok: false });
            if (!password && isAuthError(msg)) {
                const pw = await vscode.window.showInputBox({
                    prompt: `Password for ${info.label}`,
                    password: true,
                });
                if (pw) {
                    await this.connectTo(id, pw);
                    return;
                }
            }
            this.post({ type: 'error', message: msg });
        }
    }

    private async chooseConnection(): Promise<void> {
        const picked = await pickConnection(await this.conn.listCandidates(), this.conn.activeInfo?.id);
        if (picked) {
            await this.connectTo(picked.id);
        }
    }

    // ---- bases ----

    private async chooseLocalBase(): Promise<void> {
        const picked = await pickLocalBase();
        if (picked) {
            await this.setLocalBase(picked);
        }
    }

    private async setLocalBase(p: string): Promise<void> {
        await this.ctx.globalState.update('syncAnchor.localBase', p);
        this.log(`Local base: ${p}`);
        this.sendState();
    }

    private async chooseRemoteBase(): Promise<void> {
        const cur = this.ctx.globalState.get<string>('syncAnchor.remoteBase');
        const picked = await pickRemoteBase(cur);
        if (picked) {
            await this.setRemoteBase(picked);
        }
    }

    private async setRemoteBase(p: string): Promise<void> {
        const resolved = await this.conn.resolveTilde(p);
        await this.ctx.globalState.update('syncAnchor.remoteBase', resolved);
        this.log(`Remote base: ${resolved}`);
        this.sendState();
        if (this.conn.active) {
            await this.readRemote(resolved);
        }
    }

    // ---- trees ----

    private readLocalDir(dirPath: string): void {
        const excludes = this.excludes();
        const base = this.ctx.globalState.get<string>('syncAnchor.localBase') ?? '';
        // Load base/.gitignore, re-reading it when the FILE CHANGES (mtime), so
        // edited ignore rules take effect without switching the base.
        const giPath = base ? path.join(base, '.gitignore') : '';
        let giMtime = 0;
        try {
            giMtime = fs.statSync(giPath).mtimeMs;
        } catch {
            giMtime = -1; // absent (or unreadable)
        }
        if (giPath !== this.gitignoreBase || giMtime !== this.gitignoreMtime) {
            this.gitignoreBase = giPath;
            this.gitignoreMtime = giMtime;
            try {
                this.gitignoreMatcher = parseGitignore(fs.readFileSync(giPath, 'utf8'));
            } catch {
                this.gitignoreMatcher = undefined;
            }
        }
        let entries: DirEntry[] = [];
        try {
            const dirents = fs.readdirSync(dirPath, { withFileTypes: true });
            entries = dirents.map((d) => {
                const abs = path.join(dirPath, d.name);
                const rel = relativeToBase(base, abs);
                const ignoredByGi =
                    !!this.gitignoreMatcher && !!rel && this.gitignoreMatcher(rel, d.isDirectory());
                return {
                    name: d.name,
                    path: abs,
                    isDir: d.isDirectory(),
                    excluded: excludes.some((p) => matchesExclude(p, d.name)) || ignoredByGi,
                };
            });
        } catch (e) {
            this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
            return;
        }
        entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
        this.post({ type: 'dir', dirPath, entries });
    }

    /**
     * Recursively list every file (and subdirectory) under dirPath, honouring
     * exclude patterns and .gitignore. Used to auto-check a folder's subtree.
     */
    private collectLocalFiles(dirPath: string): void {
        const excludes = this.excludes();
        const base = this.ctx.globalState.get<string>('syncAnchor.localBase') ?? '';
        const files: string[] = [];
        const dirs: string[] = [];
        const walk = (p: string): void => {
            let dirents: fs.Dirent[];
            try {
                dirents = fs.readdirSync(p, { withFileTypes: true });
            } catch {
                return;
            }
            for (const d of dirents) {
                if (d.isSymbolicLink()) {
                    continue;
                }
                const abs = path.join(p, d.name);
                const rel = base ? relativeToBase(base, abs) : undefined;
                const excluded =
                    excludes.some((pat) => matchesExclude(pat, d.name)) ||
                    (!!this.gitignoreMatcher && !!rel && this.gitignoreMatcher(rel, d.isDirectory()));
                if (excluded) {
                    continue;
                }
                if (d.isDirectory()) {
                    dirs.push(abs);
                    walk(abs);
                } else if (d.isFile()) {
                    files.push(abs);
                }
            }
        };
        walk(dirPath);
        this.post({ type: 'filesCollected', dirPath, files, dirs });
    }

    private async readRemote(dirPath: string): Promise<void> {
        const live = this.conn.active;
        if (!live) {
            return;
        }
        try {
            const entries = await readRemoteDir(live.sftp, dirPath);
            entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
            this.post({ type: 'remoteDir', dirPath, entries });
        } catch (e) {
            this.post({
                type: 'error',
                message: `Remote read failed: ${e instanceof Error ? e.message : String(e)}`,
            });
        }
    }

    // ---- sync ----

    private async preview(selectedPaths: string[]): Promise<void> {
        const localBase = this.ctx.globalState.get<string>('syncAnchor.localBase');
        const remoteBase = this.ctx.globalState.get<string>('syncAnchor.remoteBase');
        if (!localBase || !remoteBase) {
            this.post({ type: 'error', message: 'Set both local and remote base first.' });
            return;
        }
        const live = this.conn.active;
        if (!live) {
            this.post({ type: 'error', message: 'Connect to a server first.' });
            return;
        }
        // Supersede any in-flight preview: its diff callbacks must not keep
        // appending into the queue of THIS run (that would duplicate files).
        const gen = ++this.previewGen;
        this.log(`Preview: expanding ${selectedPaths.length} selection(s)...`);
        const items = expandSelection(localBase, remoteBase, selectedPaths, this.excludes());
        if (items.length === 0) {
            this.post({ type: 'queue', items: [], mode: 'preview' });
            this.log('Preview: nothing selected (all excluded or empty)');
            return;
        }
        // Stream the diff: clear the panel, then push each file as it is
        // checked against the remote — much nicer feedback than one big dump.
        this.queue = [];
        this.post({ type: 'queue', items: [], mode: 'preview' });
        await diffRemote(live.sftp, items, (it) => {
            if (gen !== this.previewGen) {
                return; // a newer Preview started — drop this stale result
            }
            this.queue.push(it);
            this.post({ type: 'queueItem', item: it, mode: 'preview' });
        });
        if (gen !== this.previewGen) {
            return; // superseded — do not emit the final queue either
        }
        const nNew = items.filter((i) => i.status === 'new').length;
        const nOv = items.filter((i) => i.status === 'overwrite').length;
        const nSkip = items.filter((i) => i.status === 'skip').length;
        this.log(`Preview: ${items.length} file(s) — ${nNew} new, ${nOv} overwrite, ${nSkip} skip`);
        // Final full sync so the panel and the extension agree on the state.
        this.post({ type: 'queue', items: this.queue, mode: 'preview' });
    }

    private async upload(): Promise<void> {
        if (this.uploading) {
            return;
        }
        const live = this.conn.active;
        if (!live) {
            this.post({ type: 'error', message: 'Connect to a server first.' });
            return;
        }
        if (this.queue.length === 0) {
            this.post({ type: 'error', message: 'Nothing to upload — check files and run Preview first.' });
            return;
        }
        this.uploading = true;
        const backup = vscode.workspace.getConfiguration('syncAnchor').get<boolean>('backupBeforeOverwrite', false);
        // Snapshot the queue so an in-flight preview or refresh can never
        // mutate the array this upload is iterating.
        const items = this.queue.slice();
        const total = items.filter((i) => i.status !== 'skip').length;
        this.log(`Upload: ${total} file(s) to transfer (backup=${backup})`);
        try {
            await uploadFiles(live.sftp, items, {
                backup,
                onProgress: (done, all, current) =>
                    this.post({ type: 'progress', done, total: all, current }),
            });
        } finally {
            this.uploading = false;
        }
        const ok = items.filter((i) => i.status === 'done').length;
        const err = items.filter((i) => i.status === 'error').length;
        this.log(`Upload finished: ${ok} ok, ${err} error(s)`);
        this.post({ type: 'queue', items, mode: 'result' });
        this.post({
            type: 'status',
            text: err ? `Upload finished: ${ok} ok, ${err} error(s)` : `Upload finished: ${ok} ok`,
            ok: err === 0,
        });
        // Let the webview clear the stale selection (only when everything went
        // through — keep it on errors so the user can retry the failed files).
        this.post({ type: 'uploadDone', hasErrors: err > 0 });
    }

    // ---- helpers ----

    private excludes(): string[] {
        return vscode.workspace.getConfiguration('syncAnchor').get<string[]>('excludes', []);
    }

    private html(): string {
        const mediaUri = this.panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.ctx.extensionUri, 'media'),
        );
        const htmlPath = path.join(this.ctx.extensionPath, 'media', 'panel.html');
        let html = fs.readFileSync(htmlPath, 'utf8');
        html = html.replace(/{{MEDIA}}/g, mediaUri.toString());
        // cspSource is the official, guaranteed-correct origin for webview
        // resources (scheme + host of the webview's resource server).
        const cspSource = this.panel.webview.cspSource;
        const csp =
            `default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource}; ` +
            `img-src ${cspSource} data:; font-src ${cspSource};`;
        html = html.replace('{{CSP}}', csp);
        return html;
    }

    private dispose(): void {
        SyncAnchorPanel.current = undefined;
        while (this.disposables.length) {
            this.disposables.pop()!.dispose();
        }
    }
}

function isAuthError(msg: string): boolean {
    return /All configured authentication methods failed|Permission denied|password|auth/i.test(msg);
}
