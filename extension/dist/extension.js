"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
function activate(context) {
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
    context.subscriptions.push(cmd);
}
function deactivate() { }
//# sourceMappingURL=extension.js.map