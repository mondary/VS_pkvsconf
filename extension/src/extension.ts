import * as vscode from "vscode";
import * as fs from "fs/promises";
import { Dirent } from "fs";
import * as path from "path";

const SIZE_UNITS = ["KB", "MB", "GB", "TB"] as const;
const ICON_PREFIX = "icon.";
const VIEW_ID = "projectIconView";
const EXTENSION_TAGS_VIEW_ID = "extensionTagsView";
const EXTENSION_TAGS_STORAGE_KEY = "extensionTags";

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

type ExtensionTagsMap = Record<string, string[]>;

class ExtensionTagsStore {
  constructor(private context: vscode.ExtensionContext) {}

  getAll(): ExtensionTagsMap {
    return this.context.globalState.get<ExtensionTagsMap>(
      EXTENSION_TAGS_STORAGE_KEY,
      {}
    );
  }

  async setAll(tags: ExtensionTagsMap): Promise<void> {
    await this.context.globalState.update(EXTENSION_TAGS_STORAGE_KEY, tags);
  }

  getTagsForExtension(extensionId: string): string[] {
    const tags = this.getAll()[extensionId] ?? [];
    return tags.slice().sort((a, b) => a.localeCompare(b));
  }

  async setTagsForExtension(
    extensionId: string,
    tags: string[]
  ): Promise<void> {
    const next = this.getAll();
    const normalized = uniqueTags(tags);
    if (normalized.length === 0) {
      delete next[extensionId];
    } else {
      next[extensionId] = normalized;
    }
    await this.setAll(next);
  }

  getAllTagNames(): string[] {
    const names = new Set<string>();
    for (const tags of Object.values(this.getAll())) {
      for (const tag of tags) {
        names.add(tag);
      }
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }
}

const CATEGORY_COLORS_HEX = [
  "#3794ff", // Bleu
  "#89d185", // Vert
  "#cca700", // Jaune/Or
  "#bc3fbc", // Magenta
  "#2bc7b4", // Cyan
  "#f14c4c", // Rouge
  "#e07a3a", // Orange
  "#a970ff", // Violet
  "#ff6b9d", // Rose
  "#70c0ff"  // Bleu clair
];

function getCategoryColor(categoryName: string, allCategories: string[]): string {
  const index = allCategories.indexOf(categoryName);
  return CATEGORY_COLORS_HEX[index % CATEGORY_COLORS_HEX.length];
}

interface ExtensionInfo {
  id: string;
  name: string;
  iconPath: string | undefined;
}

class ExtensionCategoriesWebviewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private collapsedCategories: Set<string> = new Set();

  constructor(
    private store: ExtensionTagsStore,
    private extensionUri: vscode.Uri
  ) {}

  refresh(): void {
    if (this.view) {
      this.render();
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.extensionUri,
        ...vscode.extensions.all.map(ext => vscode.Uri.file(ext.extensionPath))
      ]
    };

    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case "toggleCategory":
          if (this.collapsedCategories.has(message.category)) {
            this.collapsedCategories.delete(message.category);
          } else {
            this.collapsedCategories.add(message.category);
          }
          this.render();
          break;
        case "openExtension":
          vscode.commands.executeCommand(
            "workbench.extensions.action.showExtensionsWithIds",
            [message.extensionId]
          );
          break;
        case "setCategory":
          this.handleSetCategory(message.extensionId);
          break;
      }
    });

    this.render();
  }

  private async handleSetCategory(extensionId: string): Promise<void> {
    const extension = vscode.extensions.all.find(ext => ext.id === extensionId);
    if (!extension) return;

    const existingCategories = this.store.getAllTagNames();
    const currentCategory = this.store.getTagsForExtension(extensionId)[0];

    interface CategoryPickItem extends vscode.QuickPickItem {
      action?: "new" | "none";
    }

    const items: CategoryPickItem[] = [
      { label: "$(add) Nouvelle catégorie...", action: "new" },
      { label: "$(close) Aucune catégorie", action: "none" },
      ...existingCategories.map((cat) => ({
        label: cat,
        description: cat === currentCategory ? "✓ actuelle" : undefined
      }))
    ];

    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: currentCategory
        ? `Catégorie actuelle : ${currentCategory}`
        : "Choisir une catégorie"
    });

    if (!selection) return;

    if (selection.action === "none") {
      await this.store.setTagsForExtension(extensionId, []);
    } else if (selection.action === "new") {
      const newCategory = await vscode.window.showInputBox({
        prompt: "Nom de la nouvelle catégorie",
        placeHolder: "AI, Theme, Language..."
      });
      if (newCategory && newCategory.trim()) {
        await this.store.setTagsForExtension(extensionId, [newCategory.trim()]);
      }
    } else {
      await this.store.setTagsForExtension(extensionId, [selection.label]);
    }

    this.refresh();
  }

  private getExtensionsByCategory(): Map<string, ExtensionInfo[]> {
    const allExtensions = vscode.extensions.all.filter(
      (ext) => !ext.id.startsWith("vscode.")
    );
    const tagsMap = this.store.getAll();
    const categories = new Map<string, ExtensionInfo[]>();

    // Grouper par catégorie
    for (const ext of allExtensions) {
      const category = tagsMap[ext.id]?.[0] || "— Sans catégorie —";
      if (!categories.has(category)) {
        categories.set(category, []);
      }

      const iconPath = ext.packageJSON.icon
        ? this.view?.webview.asWebviewUri(
            vscode.Uri.file(path.join(ext.extensionPath, ext.packageJSON.icon))
          )?.toString()
        : undefined;

      categories.get(category)!.push({
        id: ext.id,
        name: ext.packageJSON.displayName ?? ext.packageJSON.name ?? ext.id,
        iconPath
      });
    }

    // Trier les extensions dans chaque catégorie
    for (const [, exts] of categories) {
      exts.sort((a, b) => a.name.localeCompare(b.name));
    }

    // Trier les catégories (Sans catégorie en dernier)
    const sortedCategories = new Map<string, ExtensionInfo[]>();
    const sortedKeys = Array.from(categories.keys()).sort((a, b) => {
      if (a === "— Sans catégorie —") return 1;
      if (b === "— Sans catégorie —") return -1;
      return a.localeCompare(b);
    });

    for (const key of sortedKeys) {
      sortedCategories.set(key, categories.get(key)!);
    }

    return sortedCategories;
  }

  private render(): void {
    if (!this.view) return;

    const categories = this.getExtensionsByCategory();
    const allCategoryNames = this.store.getAllTagNames();

    let categoriesHtml = "";

    for (const [categoryName, extensions] of categories) {
      const isCollapsed = this.collapsedCategories.has(categoryName);
      const color = categoryName === "— Sans catégorie —"
        ? "#888888"
        : getCategoryColor(categoryName, allCategoryNames);
      const chevron = isCollapsed ? "▶" : "▼";

      let extensionsHtml = "";
      if (!isCollapsed) {
        for (const ext of extensions) {
          const iconHtml = ext.iconPath
            ? `<img src="${ext.iconPath}" class="ext-icon" />`
            : `<span class="ext-icon-fallback">📦</span>`;

          extensionsHtml += `
            <div class="extension" data-id="${escapeHtml(ext.id)}">
              ${iconHtml}
              <span class="ext-name">${escapeHtml(ext.name)}</span>
            </div>
          `;
        }
      }

      categoriesHtml += `
        <div class="category" style="--category-color: ${color};">
          <div class="category-header" data-category="${escapeHtml(categoryName)}">
            <span class="chevron">${chevron}</span>
            <span class="category-name">${escapeHtml(categoryName)}</span>
            <span class="category-count">(${extensions.length})</span>
          </div>
          <div class="category-extensions ${isCollapsed ? 'collapsed' : ''}">
            ${extensionsHtml}
          </div>
        </div>
      `;
    }

    this.view.webview.html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      margin: 0;
      padding: 8px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
    }
    .category {
      margin-bottom: 4px;
    }
    .category-header {
      display: flex;
      align-items: center;
      padding: 4px 8px;
      cursor: pointer;
      border-radius: 4px;
      user-select: none;
    }
    .category-header:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .chevron {
      font-size: 10px;
      width: 14px;
      text-align: center;
    }
    .category-name {
      margin-left: 4px;
      font-size: 13px;
      font-weight: bold;
      color: var(--category-color, var(--vscode-foreground));
    }
    .category-count {
      margin-left: 6px;
      opacity: 0.7;
      font-size: 12px;
      color: var(--category-color, var(--vscode-foreground));
    }
    .category-extensions {
      margin-left: 20px;
    }
    .category-extensions.collapsed {
      display: none;
    }
    .extension {
      display: flex;
      align-items: center;
      padding: 4px 8px;
      cursor: pointer;
      border-radius: 4px;
    }
    .extension:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .ext-icon {
      width: 18px;
      height: 18px;
      margin-right: 8px;
      object-fit: contain;
    }
    .ext-icon-fallback {
      width: 18px;
      margin-right: 8px;
      font-size: 14px;
    }
    .ext-name {
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--category-color, var(--vscode-foreground));
    }
  </style>
</head>
<body>
  ${categoriesHtml}
  <script>
    const vscode = acquireVsCodeApi();

    document.querySelectorAll('.category-header').forEach(header => {
      header.addEventListener('click', () => {
        const category = header.dataset.category;
        vscode.postMessage({ command: 'toggleCategory', category });
      });
    });

    document.querySelectorAll('.extension').forEach(ext => {
      ext.addEventListener('click', () => {
        const extensionId = ext.dataset.id;
        vscode.postMessage({ command: 'openExtension', extensionId });
      });

      ext.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const extensionId = ext.dataset.id;
        vscode.postMessage({ command: 'setCategory', extensionId });
      });
    });
  </script>
</body>
</html>`;
  }
}

function normalizeTag(tag: string): string | undefined {
  const trimmed = tag.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function uniqueTags(tags: string[]): string[] {
  const seen = new Set<string>();
  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (normalized) {
      seen.add(normalized);
    }
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}

function resolveExtensionId(arg: unknown): string | undefined {
  if (!arg) {
    return undefined;
  }
  if (typeof arg === "string") {
    return arg;
  }
  const anyArg = arg as {
    id?: string;
    identifier?: { id?: string };
    extensionId?: string;
  };
  return anyArg.id ?? anyArg.identifier?.id ?? anyArg.extensionId;
}

async function pickExtension(
  arg: unknown
): Promise<vscode.Extension<any> | undefined> {
  const extensionId = resolveExtensionId(arg);
  if (extensionId) {
    const resolved = vscode.extensions.all.find((ext) => ext.id === extensionId);
    if (resolved) {
      return resolved;
    }
  }

  if (arg && (arg as vscode.Extension<any>).packageJSON) {
    return arg as vscode.Extension<any>;
  }

  const picks = vscode.extensions.all
    .filter((ext) => !ext.id.startsWith("vscode."))
    .map((extension) => ({
      label:
        extension.packageJSON.displayName ??
        extension.packageJSON.name ??
        extension.id,
      description: extension.id,
      extension
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const selection = await vscode.window.showQuickPick(picks, {
    placeHolder: "Select an extension"
  });
  return selection?.extension;
}

const NEW_CATEGORY_OPTION = "$(add) Nouvelle catégorie...";
const NO_CATEGORY_OPTION = "$(close) Aucune catégorie";

async function pickCategoryForExtension(
  store: ExtensionTagsStore,
  extensionId: string
): Promise<string[] | undefined> {
  const existingCategories = store.getAllTagNames();
  const currentCategory = store.getTagsForExtension(extensionId)[0];

  interface CategoryPickItem extends vscode.QuickPickItem {
    action?: "new" | "none";
  }

  const items: CategoryPickItem[] = [
    { label: NEW_CATEGORY_OPTION, action: "new" },
    { label: NO_CATEGORY_OPTION, action: "none" },
    ...existingCategories.map((cat) => ({
      label: cat,
      description: cat === currentCategory ? "✓ actuelle" : undefined
    }))
  ];

  const selection = await vscode.window.showQuickPick(items, {
    placeHolder: currentCategory
      ? `Catégorie actuelle : ${currentCategory}`
      : "Choisir une catégorie"
  });

  if (!selection) {
    return undefined;
  }

  if (selection.action === "none") {
    return [];
  }

  if (selection.action === "new") {
    const newCategory = await vscode.window.showInputBox({
      prompt: "Nom de la nouvelle catégorie",
      placeHolder: "AI, Theme, Language..."
    });
    if (newCategory && newCategory.trim()) {
      return [newCategory.trim()];
    }
    return undefined;
  }

  return [selection.label];
}

async function promptNewTag(): Promise<string | undefined> {
  return await vscode.window.showInputBox({
    prompt: "New tag name",
    placeHolder: "ai, syntax, theme"
  });
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
  const tagsStore = new ExtensionTagsStore(context);
  const categoriesProvider = new ExtensionCategoriesWebviewProvider(
    tagsStore,
    context.extensionUri
  );

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

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(EXTENSION_TAGS_VIEW_ID, categoriesProvider)
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

  const manageCategoryCmd = vscode.commands.registerCommand(
    "pkvsconf.addTagToExtension",
    async (arg) => {
      const extension = await pickExtension(arg);
      if (!extension) {
        return;
      }

      const newCategory = await pickCategoryForExtension(tagsStore, extension.id);
      if (newCategory === undefined) {
        return;
      }

      await tagsStore.setTagsForExtension(extension.id, newCategory);
      categoriesProvider.refresh();
    }
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

  const searchExtensionsCmd = vscode.commands.registerCommand(
    "pkvsconf.searchExtensions",
    async () => {
      const query = await vscode.window.showInputBox({
        prompt: "Rechercher des extensions",
        placeHolder: "Ex: python, prettier, docker..."
      });

      if (query) {
        await vscode.commands.executeCommand(
          "workbench.extensions.search",
          query
        );
      }
    }
  );

  context.subscriptions.push(cmd, refreshCmd, openRepoCmd, rootSizeItem);
  context.subscriptions.push(manageCategoryCmd, searchExtensionsCmd);

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
