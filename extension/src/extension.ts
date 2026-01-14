import * as vscode from "vscode";
import * as fs from "fs/promises";
import { Dirent } from "fs";
import * as path from "path";

const SIZE_UNITS = ["KB", "MB", "GB", "TB"] as const;
const ICON_PREFIX = "icon.";
const VIEW_ID = "projectIconView";

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

class ProjectIconViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private workspaceRoot: string | undefined;
  private fallbackMessage = "Place a file named icon.* on root project";

  setWorkspace(root: string | undefined): void {
    this.workspaceRoot = root;
    this.fallbackMessage = "Place a file named icon.* on root project";

    if (this.view) {
      this.view.webview.options = {
        enableScripts: false,
        localResourceRoots: root ? [vscode.Uri.file(root)] : []
      };
    }
  }

  refresh(): void {
    if (this.view) {
      void this.render();
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: false,
      localResourceRoots: this.workspaceRoot
        ? [vscode.Uri.file(this.workspaceRoot)]
        : []
    };

    void this.render();
  }

  private async render(): Promise<void> {
    if (!this.view) {
      return;
    }

    const iconPath = this.workspaceRoot
      ? await findIconPath(this.workspaceRoot)
      : undefined;

    this.view.webview.html = buildHtml(
      this.view.webview,
      iconPath,
      this.fallbackMessage
    );
  }
}

async function findIconPath(root: string): Promise<string | undefined> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const matches = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.toLowerCase().startsWith(ICON_PREFIX))
      .sort((a, b) => a.localeCompare(b));

    if (matches.length === 0) {
      return undefined;
    }

    return path.join(root, matches[0]);
  } catch {
    return undefined;
  }
}

function buildHtml(
  webview: vscode.Webview,
  iconPath: string | undefined,
  fallbackMessage: string
): string {
  const bodyContent = iconPath
    ? `<img class="icon" src="${webview.asWebviewUri(
        vscode.Uri.file(iconPath)
      )}" alt="Project icon" />`
    : `<div class="fallback">${escapeHtml(fallbackMessage)}</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      color-scheme: light dark;
    }

    body {
      margin: 0;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    .icon {
      width: 100%;
      height: 100%;
      object-fit: contain;
      padding: 12px;
      box-sizing: border-box;
    }

    .fallback {
      font-size: 20px;
      font-weight: 600;
      text-align: center;
      padding: 12px;
      word-break: break-word;
    }
  </style>
</head>
<body>
  ${bodyContent}
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function toGitHubHttps(rawUrl: string): string | undefined {
  const trimmed = rawUrl.trim();
  if (trimmed.startsWith("git@github.com:")) {
    const repoPath = trimmed.replace("git@github.com:", "").replace(/\.git$/, "");
    return `https://github.com/${repoPath}`;
  }

  if (trimmed.startsWith("ssh://git@github.com/")) {
    const repoPath = trimmed
      .replace("ssh://git@github.com/", "")
      .replace(/\.git$/, "");
    return `https://github.com/${repoPath}`;
  }

  if (trimmed.startsWith("https://github.com/")) {
    return trimmed.replace(/\.git$/, "");
  }

  if (trimmed.startsWith("http://github.com/")) {
    return `https://github.com/${trimmed
      .replace("http://github.com/", "")
      .replace(/\.git$/, "")}`;
  }

  if (trimmed.startsWith("git://github.com/")) {
    return `https://github.com/${trimmed
      .replace("git://github.com/", "")
      .replace(/\.git$/, "")}`;
  }

  return undefined;
}

interface GitRemote {
  name: string;
  fetchUrl?: string;
  pushUrl?: string;
}

interface GitRepository {
  rootUri: vscode.Uri;
  state: { remotes: GitRemote[] };
}

interface GitApi {
  repositories: GitRepository[];
}

interface GitExtension {
  getAPI(version: number): GitApi;
}

function pickGitHubRemoteUrl(remotes: GitRemote[]): string | undefined {
  const origin = remotes.find((remote) => remote.name === "origin");
  const originUrl =
    origin?.fetchUrl ?? origin?.pushUrl ?? (origin ? undefined : undefined);
  const originGitHub = originUrl ? toGitHubHttps(originUrl) : undefined;
  if (originGitHub) {
    return originGitHub;
  }

  for (const remote of remotes) {
    const url = remote.fetchUrl ?? remote.pushUrl;
    if (!url) {
      continue;
    }
    const githubUrl = toGitHubHttps(url);
    if (githubUrl) {
      return githubUrl;
    }
  }

  return undefined;
}

async function getGitHubRepoUrlFromGitApi(): Promise<
  { label: string; url: string }[]
> {
  const gitExtension =
    vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (!gitExtension) {
    return [];
  }

  const gitApi = gitExtension.isActive
    ? gitExtension.exports.getAPI(1)
    : (await gitExtension.activate()).getAPI(1);

  return gitApi.repositories
    .map((repo) => {
      const url = pickGitHubRemoteUrl(repo.state.remotes);
      if (!url) {
        return undefined;
      }

      return {
        label: path.basename(repo.rootUri.fsPath),
        url
      };
    })
    .filter((item): item is { label: string; url: string } => Boolean(item));
}

async function getGitHubRepoUrlFromRoot(
  workspaceRoot: string
): Promise<string | undefined> {
  try {
    const configPath = path.join(workspaceRoot, ".git", "config");
    const content = await fs.readFile(configPath, "utf8");
    const lines = content.split(/\r?\n/);
    let currentSection = "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const sectionMatch = trimmed.match(/^\[(.+)\]$/);
      if (sectionMatch) {
        currentSection = sectionMatch[1];
        continue;
      }

      if (currentSection.startsWith('remote "')) {
        const urlMatch = trimmed.match(/^url\s*=\s*(.+)$/);
        if (urlMatch) {
          const githubUrl = toGitHubHttps(urlMatch[1]);
          if (githubUrl) {
            return githubUrl;
          }
        }
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new ProjectIconViewProvider();
  let watcher: vscode.FileSystemWatcher | undefined;

  const updateWorkspace = () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const workspaceRoot = workspaceFolder?.uri.fsPath;
    provider.setWorkspace(workspaceRoot);
    provider.refresh();

    if (watcher) {
      watcher.dispose();
      watcher = undefined;
    }

    if (!workspaceRoot) {
      return;
    }

    watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceRoot, "icon.*")
    );

    watcher.onDidCreate(() => provider.refresh());
    watcher.onDidChange(() => provider.refresh());
    watcher.onDidDelete(() => provider.refresh());

    context.subscriptions.push(watcher);
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider)
  );

  updateWorkspace();

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => updateWorkspace())
  );

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

  const openRepoCmd = vscode.commands.registerCommand(
    "revealInFinderButton.openGitHubRepo",
    async () => {
      const gitRepos = await getGitHubRepoUrlFromGitApi();
      if (gitRepos.length > 1) {
        const selection = await vscode.window.showQuickPick(gitRepos, {
          placeHolder: "Select a GitHub repository to open"
        });
        if (selection) {
          await vscode.env.openExternal(vscode.Uri.parse(selection.url));
        }
        return;
      }

      if (gitRepos.length === 1) {
        await vscode.env.openExternal(vscode.Uri.parse(gitRepos[0].url));
        return;
      }

      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        vscode.window.showInformationMessage("No workspace folder open.");
        return;
      }

      const repoUrl = await getGitHubRepoUrlFromRoot(workspaceRoot);
      if (!repoUrl) {
        vscode.window.showInformationMessage(
          "No GitHub remote found in this workspace."
        );
        return;
      }

      await vscode.env.openExternal(vscode.Uri.parse(repoUrl));
    }
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

  context.subscriptions.push(cmd, refreshCmd, openRepoCmd, rootSizeItem);

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
