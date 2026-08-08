// Activity Bar entry: clicking the icon opens the full-screen panel, then the
// sidebar auto-closes so the user only ever sees the panel.
//
// Implementation note: `onDidChangeViewContainerVisibility` is only a proposed
// API, so we use the stable `TreeView.onDidChangeVisibility` instead — the
// sidebar status view becomes visible the moment the Activity Bar icon is
// clicked, which triggers the panel.

import * as vscode from 'vscode';

interface ActivityBarDeps {
    openPanel: () => void;
    getStatus: () => string;
}

class StatusTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

    constructor(private readonly deps: ActivityBarDeps) {}

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(): vscode.TreeItem[] {
        const item = new vscode.TreeItem(this.deps.getStatus(), vscode.TreeItemCollapsibleState.None);
        item.command = { command: 'syncAnchor.openPanel', title: 'Open Sync Anchor' };
        return [item];
    }

    refresh(): void {
        this.onDidChangeTreeDataEmitter.fire();
    }
}

/**
 * Register the Activity Bar icon container and the "click icon → open full-screen
 * panel → close sidebar" behavior.
 */
export function registerActivityBar(
    ctx: vscode.ExtensionContext,
    deps: ActivityBarDeps,
): vscode.TreeView<vscode.TreeItem> {
    const provider = new StatusTreeProvider(deps);
    const treeView = vscode.window.createTreeView('syncAnchor.status', {
        treeDataProvider: provider,
    });
    ctx.subscriptions.push(treeView);
    treeView.onDidChangeVisibility((visible) => {
        if (visible) {
            deps.openPanel();
            void vscode.commands.executeCommand('workbench.action.closeSidebar');
        }
    });
    return treeView;
}
