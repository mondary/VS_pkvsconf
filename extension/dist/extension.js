"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const fs = require("fs/promises");
const path = require("path");
const SIZE_UNITS = ["KB", "MB", "GB", "TB"];
const ICON_PREFIX = "icon.";
const VIEW_ID = "projectIconView";
const EXTENSION_TAGS_VIEW_ID = "extensionTagsView";
const EXTENSION_TAGS_STORAGE_KEY = "extensionTags";
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
class ProjectIconViewProvider {
    constructor() {
        this.fallbackMessage = "Place a file named icon.* on root project";
    }
    setWorkspace(root) {
        this.workspaceRoot = root;
        this.fallbackMessage = "Place a file named icon.* on root project";
        if (this.view) {
            this.view.webview.options = {
                enableScripts: false,
                localResourceRoots: root ? [vscode.Uri.file(root)] : []
            };
        }
    }
    refresh() {
        if (this.view) {
            void this.render();
        }
    }
    resolveWebviewView(view) {
        this.view = view;
        view.webview.options = {
            enableScripts: false,
            localResourceRoots: this.workspaceRoot
                ? [vscode.Uri.file(this.workspaceRoot)]
                : []
        };
        void this.render();
    }
    async render() {
        if (!this.view) {
            return;
        }
        const iconPath = this.workspaceRoot
            ? await findIconPath(this.workspaceRoot)
            : undefined;
        this.view.webview.html = buildHtml(this.view.webview, iconPath, this.fallbackMessage);
    }
}
async function findIconPath(root) {
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
    }
    catch {
        return undefined;
    }
}
function buildHtml(webview, iconPath, fallbackMessage) {
    const bodyContent = iconPath
        ? `<img class="icon" src="${webview.asWebviewUri(vscode.Uri.file(iconPath))}" alt="Project icon" />`
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
function escapeHtml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
async function getDirectorySizeBytes(rootPath) {
    let total = 0;
    let hadError = false;
    let entries;
    try {
        entries = await fs.readdir(rootPath, { withFileTypes: true });
    }
    catch {
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
            }
            else if (entry.isFile()) {
                const stat = await fs.stat(entryPath);
                total += stat.size;
            }
        }
        catch {
            hadError = true;
        }
    }
    return { total, hadError };
}
function toGitHubHttps(rawUrl) {
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
class ExtensionTagsStore {
    constructor(context) {
        this.context = context;
    }
    getAll() {
        return this.context.globalState.get(EXTENSION_TAGS_STORAGE_KEY, {});
    }
    async setAll(tags) {
        await this.context.globalState.update(EXTENSION_TAGS_STORAGE_KEY, tags);
    }
    getTagsForExtension(extensionId) {
        const tags = this.getAll()[extensionId] ?? [];
        return tags.slice().sort((a, b) => a.localeCompare(b));
    }
    async setTagsForExtension(extensionId, tags) {
        const next = this.getAll();
        const normalized = uniqueTags(tags);
        if (normalized.length === 0) {
            delete next[extensionId];
        }
        else {
            next[extensionId] = normalized;
        }
        await this.setAll(next);
    }
    getAllTagNames() {
        const names = new Set();
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
    "#70c0ff" // Bleu clair
];
function createColoredCircleSvg(color) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="${color}"/></svg>`;
}
function getCategoryIconUri(categoryName, allCategories) {
    const index = allCategories.indexOf(categoryName);
    const color = CATEGORY_COLORS_HEX[index % CATEGORY_COLORS_HEX.length];
    const svg = createColoredCircleSvg(color);
    const encoded = Buffer.from(svg).toString("base64");
    return vscode.Uri.parse(`data:image/svg+xml;base64,${encoded}`);
}
class ExtensionTagsViewProvider {
    constructor(store) {
        this.store = store;
        this.emitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.emitter.event;
    }
    refresh() {
        this.emitter.fire();
    }
    getTreeItem(element) {
        if (element.type === "tag") {
            // Compter les extensions dans ce tag
            const allExtensions = vscode.extensions.all.filter((ext) => !ext.id.startsWith("vscode."));
            let count;
            if (element.tag === "— Sans tag —") {
                const extensionsWithTags = new Set(Object.keys(this.store.getAll()));
                count = allExtensions.filter((ext) => !extensionsWithTags.has(ext.id)).length;
            }
            else {
                const tagsMap = this.store.getAll();
                count = Object.entries(tagsMap).filter(([, tags]) => tags.includes(element.tag)).length;
            }
            const item = new vscode.TreeItem(element.tag, vscode.TreeItemCollapsibleState.Expanded);
            item.description = `(${count})`;
            if (element.tag === "— Sans tag —") {
                item.iconPath = new vscode.ThemeIcon("question");
            }
            else {
                const allCategories = this.store.getAllTagNames();
                item.iconPath = getCategoryIconUri(element.tag, allCategories);
            }
            item.contextValue = "extensionTagGroup";
            return item;
        }
        if (element.type === "allExtension") {
            const label = element.extension.packageJSON.displayName ??
                element.extension.packageJSON.name ??
                element.extension.id;
            const tags = this.store.getTagsForExtension(element.extension.id);
            const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
            item.description = tags.length > 0 ? tags[0] : "";
            // Utiliser le vrai logo de l'extension si disponible
            const extensionIcon = element.extension.packageJSON.icon;
            item.iconPath = extensionIcon
                ? vscode.Uri.file(path.join(element.extension.extensionPath, extensionIcon))
                : new vscode.ThemeIcon("extensions");
            item.command = {
                command: "workbench.extensions.action.showExtensionsWithIds",
                title: "Show Extension",
                arguments: [[element.extension.id]]
            };
            item.contextValue = "extensionListItem";
            item.tooltip = `${element.extension.id}${tags.length > 0 ? `\nCatégorie: ${tags[0]}` : ""}`;
            return item;
        }
        const label = element.extension.packageJSON.displayName ??
            element.extension.packageJSON.name ??
            element.extension.id;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.description = element.extension.id;
        // Utiliser le vrai logo de l'extension si disponible
        const extIcon = element.extension.packageJSON.icon;
        item.iconPath = extIcon
            ? vscode.Uri.file(path.join(element.extension.extensionPath, extIcon))
            : new vscode.ThemeIcon("extensions");
        item.command = {
            command: "workbench.extensions.action.showExtensionsWithIds",
            title: "Show Extension",
            arguments: [[element.extension.id]]
        };
        item.contextValue = "extensionTagItem";
        return item;
    }
    getChildren(element) {
        const allExtensions = vscode.extensions.all.filter((ext) => !ext.id.startsWith("vscode."));
        if (!element) {
            // Niveau racine : afficher les tags + une section "Sans tag"
            const tagNames = this.store.getAllTagNames();
            const tagNodes = tagNames.map((tag) => ({
                type: "tag",
                tag
            }));
            // Trouver les extensions sans tag
            const extensionsWithTags = new Set(Object.keys(this.store.getAll()));
            const untaggedExtensions = allExtensions.filter((ext) => !extensionsWithTags.has(ext.id));
            // Ajouter une section "Sans tag" si nécessaire
            if (untaggedExtensions.length > 0) {
                tagNodes.push({ type: "tag", tag: "— Sans tag —" });
            }
            return tagNodes;
        }
        if (element.type === "tag") {
            // Sous un tag : afficher les extensions avec ce tag
            if (element.tag === "— Sans tag —") {
                // Extensions sans aucun tag
                const extensionsWithTags = new Set(Object.keys(this.store.getAll()));
                return allExtensions
                    .filter((ext) => !extensionsWithTags.has(ext.id))
                    .map((extension) => ({
                    type: "allExtension",
                    extension
                }))
                    .sort((a, b) => {
                    const nameA = a.extension.packageJSON.displayName ??
                        a.extension.packageJSON.name ??
                        a.extension.id;
                    const nameB = b.extension.packageJSON.displayName ??
                        b.extension.packageJSON.name ??
                        b.extension.id;
                    return nameA.localeCompare(nameB);
                });
            }
            // Extensions avec ce tag spécifique
            const tagsMap = this.store.getAll();
            const extensionIds = Object.entries(tagsMap)
                .filter(([, tags]) => tags.includes(element.tag))
                .map(([id]) => id);
            return allExtensions
                .filter((ext) => extensionIds.includes(ext.id))
                .map((extension) => ({
                type: "allExtension",
                extension
            }))
                .sort((a, b) => {
                const nameA = a.extension.packageJSON.displayName ??
                    a.extension.packageJSON.name ??
                    a.extension.id;
                const nameB = b.extension.packageJSON.displayName ??
                    b.extension.packageJSON.name ??
                    b.extension.id;
                return nameA.localeCompare(nameB);
            });
        }
        return [];
    }
}
function normalizeTag(tag) {
    const trimmed = tag.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
function uniqueTags(tags) {
    const seen = new Set();
    for (const tag of tags) {
        const normalized = normalizeTag(tag);
        if (normalized) {
            seen.add(normalized);
        }
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
}
function resolveExtensionId(arg) {
    if (!arg) {
        return undefined;
    }
    if (typeof arg === "string") {
        return arg;
    }
    const anyArg = arg;
    return anyArg.id ?? anyArg.identifier?.id ?? anyArg.extensionId;
}
async function pickExtension(arg) {
    // Gérer le cas où l'argument vient d'un nœud de la TreeView
    const nodeArg = arg;
    if (nodeArg && "type" in nodeArg && nodeArg.type === "allExtension") {
        return nodeArg.extension;
    }
    const extensionId = resolveExtensionId(arg);
    if (extensionId) {
        const resolved = vscode.extensions.all.find((ext) => ext.id === extensionId);
        if (resolved) {
            return resolved;
        }
    }
    if (arg && arg.packageJSON) {
        return arg;
    }
    const picks = vscode.extensions.all
        .filter((ext) => !ext.id.startsWith("vscode."))
        .map((extension) => ({
        label: extension.packageJSON.displayName ??
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
async function pickCategoryForExtension(store, extensionId) {
    const existingCategories = store.getAllTagNames();
    const currentCategory = store.getTagsForExtension(extensionId)[0];
    const items = [
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
async function promptNewTag() {
    return await vscode.window.showInputBox({
        prompt: "New tag name",
        placeHolder: "ai, syntax, theme"
    });
}
function pickGitHubRemoteUrl(remotes) {
    const origin = remotes.find((remote) => remote.name === "origin");
    const originUrl = origin?.fetchUrl ?? origin?.pushUrl ?? (origin ? undefined : undefined);
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
async function getGitHubRepoUrlFromGitApi() {
    const gitExtension = vscode.extensions.getExtension("vscode.git");
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
        .filter((item) => Boolean(item));
}
async function getGitHubRepoUrlFromRoot(workspaceRoot) {
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
    }
    catch {
        return undefined;
    }
    return undefined;
}
function activate(context) {
    const provider = new ProjectIconViewProvider();
    let watcher;
    const tagsStore = new ExtensionTagsStore(context);
    const tagsProvider = new ExtensionTagsViewProvider(tagsStore);
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
        watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceRoot, "icon.*"));
        watcher.onDidCreate(() => provider.refresh());
        watcher.onDidChange(() => provider.refresh());
        watcher.onDidDelete(() => provider.refresh());
        context.subscriptions.push(watcher);
    };
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, provider));
    const tagsTreeView = vscode.window.createTreeView(EXTENSION_TAGS_VIEW_ID, {
        treeDataProvider: tagsProvider,
        showCollapseAll: true
    });
    context.subscriptions.push(tagsTreeView);
    updateWorkspace();
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => updateWorkspace()));
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
        }
        finally {
            rootSizeInProgress = false;
        }
    };
    const refreshCmd = vscode.commands.registerCommand("revealInFinderButton.refreshRootSize", refreshRootSize);
    const manageCategoryCmd = vscode.commands.registerCommand("pkvsconf.addTagToExtension", async (arg) => {
        const extension = await pickExtension(arg);
        if (!extension) {
            return;
        }
        const newCategory = await pickCategoryForExtension(tagsStore, extension.id);
        if (newCategory === undefined) {
            return;
        }
        await tagsStore.setTagsForExtension(extension.id, newCategory);
        tagsProvider.refresh();
    });
    const openRepoCmd = vscode.commands.registerCommand("revealInFinderButton.openGitHubRepo", async () => {
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
            vscode.window.showInformationMessage("No GitHub remote found in this workspace.");
            return;
        }
        await vscode.env.openExternal(vscode.Uri.parse(repoUrl));
    });
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
    const searchExtensionsCmd = vscode.commands.registerCommand("pkvsconf.searchExtensions", async () => {
        const query = await vscode.window.showInputBox({
            prompt: "Rechercher des extensions",
            placeHolder: "Ex: python, prettier, docker..."
        });
        if (query) {
            await vscode.commands.executeCommand("workbench.extensions.search", query);
        }
    });
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
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void refreshRootSize();
    }));
}
function deactivate() { }
//# sourceMappingURL=extension.js.map