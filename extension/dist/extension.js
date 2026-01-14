"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const fs = require("fs/promises");
const path = require("path");
const SIZE_UNITS = ["KB", "MB", "GB", "TB"];
function formatBytes(bytes) {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    let size = bytes;
    let unitIndex = -1;
    do {
        size /= 1024;
        unitIndex += 1;
    } while (size >= 1024 && unitIndex < SIZE_UNITS.length - 1);
    const precision = size < 10 ? 1 : 0;
    return `${size.toFixed(precision)} ${SIZE_UNITS[unitIndex]}`;
}
async function getDirectorySizeBytes(rootPath) {
    let total = 0;
    let entries;
    try {
        entries = await fs.readdir(rootPath, { withFileTypes: true });
    }
    catch {
        return 0;
    }
    for (const entry of entries) {
        const entryPath = path.join(rootPath, entry.name);
        try {
            if (entry.isSymbolicLink()) {
                continue;
            }
            if (entry.isDirectory()) {
                total += await getDirectorySizeBytes(entryPath);
            }
            else if (entry.isFile()) {
                const stat = await fs.stat(entryPath);
                total += stat.size;
            }
        }
        catch {
            continue;
        }
    }
    return total;
}
function activate(context) {
    const rootSizeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    rootSizeItem.text = "Root size: --";
    rootSizeItem.tooltip = "Click to refresh root folder size";
    rootSizeItem.command = "revealInFinderButton.refreshRootSize";
    rootSizeItem.show();
    let rootSizeInProgress = false;
    const refreshRootSize = async () => {
        if (rootSizeInProgress) {
            return;
        }
        const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!workspaceUri) {
            rootSizeItem.text = "Root size: n/a";
            rootSizeItem.tooltip = "No workspace folder open";
            return;
        }
        rootSizeInProgress = true;
        rootSizeItem.text = "Root size: calculating...";
        rootSizeItem.tooltip = `Root: ${workspaceUri.fsPath}`;
        try {
            const sizeBytes = await getDirectorySizeBytes(workspaceUri.fsPath);
            const formatted = formatBytes(sizeBytes);
            rootSizeItem.text = `Root size: ${formatted}`;
        }
        finally {
            rootSizeInProgress = false;
        }
    };
    const refreshCmd = vscode.commands.registerCommand("revealInFinderButton.refreshRootSize", refreshRootSize);
    const cmd = vscode.commands.registerCommand("revealInFinderButton.revealActive", async () => {
        if (process.platform !== "darwin") {
            vscode.window.showInformationMessage("Reveal in Finder is only available on macOS.");
            return;
        }
        const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
        const activeTabUri = vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri;
        const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        const uri = activeEditorUri ?? activeTabUri ?? workspaceUri;
        if (!uri) {
            vscode.window.showInformationMessage("No active file or workspace folder to reveal.");
            return;
        }
        await vscode.commands.executeCommand("revealFileInOS", uri);
    });
    context.subscriptions.push(cmd, refreshCmd, rootSizeItem);
    void refreshRootSize();
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void refreshRootSize();
    }));
}
function deactivate() { }
//# sourceMappingURL=extension.js.map