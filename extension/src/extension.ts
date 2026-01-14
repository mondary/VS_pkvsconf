import * as vscode from "vscode";
import * as fs from "fs/promises";
import { Dirent } from "fs";
import * as path from "path";

const SIZE_UNITS = ["KB", "MB", "GB", "TB"] as const;

function formatBytes(bytes: number): string {
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

async function getDirectorySizeBytes(
  rootPath: string
): Promise<{ total: number; hadError: boolean }> {
  let total = 0;
  let hadError = false;
  let entries: Dirent[];

  try {
    entries = await fs.readdir(rootPath, { withFileTypes: true });
  } catch {
    return { total: 0, hadError: true };
  }

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);

    try {
      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        const result = await getDirectorySizeBytes(entryPath);
        total += result.total;
        hadError = hadError || result.hadError;
      } else if (entry.isFile()) {
        const stat = await fs.stat(entryPath);
        total += stat.size;
      }
    } catch {
      hadError = true;
    }
  }

  return { total, hadError };
}

export function activate(context: vscode.ExtensionContext) {
  const rootSizeItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
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

    if (workspaceUri.scheme !== "file") {
      rootSizeItem.text = "Root size: unsupported";
      rootSizeItem.tooltip = "Not available on remote or virtual workspaces";
      return;
    }

    rootSizeInProgress = true;
    rootSizeItem.text = "Root size: calculating...";
    rootSizeItem.tooltip = `Root: ${workspaceUri.fsPath}`;

    try {
      const result = await getDirectorySizeBytes(workspaceUri.fsPath);
      const formatted = formatBytes(result.total);
      rootSizeItem.text = `Root size: ${formatted}`;
      if (result.hadError) {
        rootSizeItem.tooltip = `Root: ${workspaceUri.fsPath}\nSome folders could not be read.`;
      }
    } finally {
      rootSizeInProgress = false;
    }
  };

  const refreshCmd = vscode.commands.registerCommand(
    "revealInFinderButton.refreshRootSize",
    refreshRootSize
  );

  const cmd = vscode.commands.registerCommand(
    "revealInFinderButton.revealActive",
    async () => {
      if (process.platform !== "darwin") {
        vscode.window.showInformationMessage(
          "Reveal in Finder is only available on macOS."
        );
        return;
      }

      const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
      const activeTabUri = (
        vscode.window.tabGroups.activeTabGroup.activeTab?.input as {
          uri?: vscode.Uri;
        } | null
      )?.uri;
      const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
      const uri = activeEditorUri ?? activeTabUri ?? workspaceUri;

      if (!uri) {
        vscode.window.showInformationMessage(
          "No active file or workspace folder to reveal."
        );
        return;
      }

      await vscode.commands.executeCommand("revealFileInOS", uri);
    }
  );

  context.subscriptions.push(cmd, refreshCmd, rootSizeItem);

  void refreshRootSize();

  const refreshIntervalMs = 5 * 60 * 1000;
  const refreshInterval = setInterval(() => {
    void refreshRootSize();
  }, refreshIntervalMs);

  context.subscriptions.push({
    dispose: () => clearInterval(refreshInterval),
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void refreshRootSize();
    })
  );
}

export function deactivate() {}
