"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerKanban = registerKanban;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const KANBAN_TERMINAL_NAME = "PK Kanban";
async function openKanban(context, editor) {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
        void vscode.window.showErrorMessage("Ouvrez un dossier ou un workspace avant de lancer le Kanban.");
        return;
    }
    let terminal = vscode.window.terminals.find((item) => item.name === KANBAN_TERMINAL_NAME);
    const isNew = !terminal;
    if (!terminal) {
        const config = vscode.workspace.getConfiguration("pkvsconf.kanban");
        const agentCommand = config.get("agentCommand", "opencode --prompt {prompt}");
        const tmuxCommand = config.get("tmuxCommand", "tmux");
        const scriptPath = path.join(context.extensionPath, "dist", "kanbanTui.js");
        terminal = vscode.window.createTerminal({
            name: KANBAN_TERMINAL_NAME,
            cwd: workspace.uri,
            shellPath: process.execPath,
            shellArgs: [scriptPath, "--workspace", workspace.uri.fsPath],
            env: {
                ELECTRON_RUN_AS_NODE: "1",
                PK_KANBAN_AGENT_COMMAND: agentCommand,
                PK_KANBAN_TMUX_COMMAND: tmuxCommand
            }
        });
    }
    terminal.show(false);
    if (editor) {
        await vscode.commands.executeCommand("workbench.action.terminal.moveToEditor", terminal);
    }
    else if (!isNew) {
        await vscode.commands.executeCommand("workbench.action.terminal.moveToTerminalPanel", terminal);
    }
}
function registerKanban(context) {
    const panelBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 92);
    panelBtn.name = "PK Kanban (terminal)";
    panelBtn.text = "$(terminal) Kanban";
    panelBtn.tooltip = "Ouvrir le Kanban dans le volet terminal du bas";
    panelBtn.command = "pkvsconf.kanbanOpen";
    panelBtn.show();
    const editorBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 91);
    editorBtn.name = "PK Kanban (éditeur)";
    editorBtn.text = "$(go-to-editor) Kanban";
    editorBtn.tooltip = "Ouvrir le Kanban dans un onglet de l'éditeur";
    editorBtn.command = "pkvsconf.kanbanOpenEditor";
    editorBtn.show();
    const panelCmd = vscode.commands.registerCommand("pkvsconf.kanbanOpen", () => openKanban(context, false));
    const editorCmd = vscode.commands.registerCommand("pkvsconf.kanbanOpenEditor", () => openKanban(context, true));
    context.subscriptions.push(panelBtn, editorBtn, panelCmd, editorCmd);
}
//# sourceMappingURL=kanban.js.map