// Sync Anchor extension entry point.

import * as vscode from 'vscode';
import { ConnectionManager } from './connection';
import { SyncAnchorPanel } from './panel';
import { registerActivityBar } from './activitybar';

let output: vscode.OutputChannel;
let conn: ConnectionManager;

export function activate(context: vscode.ExtensionContext): void {
    output = vscode.window.createOutputChannel('Sync Anchor');
    conn = new ConnectionManager();
    const log = (line: string) => output.appendLine(line);

    const openPanel = () => SyncAnchorPanel.show(context, conn, log);

    context.subscriptions.push(
        vscode.commands.registerCommand('syncAnchor.openPanel', openPanel),
        vscode.commands.registerCommand('syncAnchor.setLocalBase', () =>
            openPanel().handleCommand('setLocalBase'),
        ),
        vscode.commands.registerCommand('syncAnchor.setRemoteBase', () =>
            openPanel().handleCommand('setRemoteBase'),
        ),
        vscode.commands.registerCommand('syncAnchor.pickConnection', () =>
            openPanel().handleCommand('pickConnection'),
        ),
    );

    registerActivityBar(context, {
        openPanel,
        getStatus: () =>
            conn.activeInfo ? `● ${conn.activeInfo.label}` : '○ Not connected — click to open',
    });
}

export function deactivate(): void {
    void conn.disconnect();
}
