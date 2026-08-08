// UI pickers: local base, remote base, file/folder multi-select, connection pick.

import * as vscode from 'vscode';
import { ConnectionInfo } from './types';

export async function pickLocalBase(): Promise<string | undefined> {
    const sel = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select Local Base Folder',
    });
    return sel && sel[0] ? sel[0].fsPath : undefined;
}

export async function pickRemoteBase(defaultValue?: string): Promise<string | undefined> {
    const value = await vscode.window.showInputBox({
        title: 'Sync Anchor — Remote Base Folder',
        prompt: 'Absolute path on the remote (e.g. /home/user/ISRA, or ~/ISRA)',
        value: defaultValue,
        validateInput: (v) => (v.trim() ? undefined : 'Path is required'),
    });
    return value ? value.trim() : undefined;
}

export async function pickFilesIn(base: string): Promise<string[]> {
    const sel = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: true,
        canSelectMany: true,
        defaultUri: vscode.Uri.file(base),
        openLabel: 'Select Files/Folders to Upload',
    });
    return sel ? sel.map((u) => u.fsPath) : [];
}

export async function pickConnection(
    list: ConnectionInfo[],
    activeId?: string,
): Promise<ConnectionInfo | undefined> {
    const items = list.map((c) => ({
        label: c.label,
        description:
            `port ${c.port}` +
            (c.source === 'config'
                ? ' · ssh config'
                : c.source === 'remote'
                  ? ' · current window'
                  : ' · recent'),
        info: c,
    }));
    const picked = await vscode.window.showQuickPick(items, {
        title: 'Sync Anchor — Select Connection',
        placeHolder: activeId ? `Connected: ${activeId}` : 'No active connection',
    });
    return picked?.info;
}
