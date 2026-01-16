"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const fs = require("fs/promises");
const path = require("path");
const cp = require("child_process");
const net = require("net");
const SIZE_UNITS = ["KB", "MB", "GB", "TB"];
const ICON_PREFIX = "icon.";
const VIEW_ID = "projectIconView";
const EXTENSION_TAGS_VIEW_ID = "extensionTagsView";
const EXTENSION_TAGS_STORAGE_KEY = "extensionTags";
const WORKSPACE_TITLEBAR_COLOR_KEY = "workspaceTitlebarColor";
const TITLEBAR_COLOR_KEYS = {
    activeBackground: "titleBar.activeBackground",
    inactiveBackground: "titleBar.inactiveBackground",
    activeForeground: "titleBar.activeForeground",
    inactiveForeground: "titleBar.inactiveForeground",
    border: "titleBar.border"
};
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
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
function toHex(value) {
    return clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");
}
function hexToRgb(hex) {
    const match = hex.trim().match(/^#?([0-9a-fA-F]{6})$/);
    if (!match) {
        return undefined;
    }
    const value = match[1];
    return {
        r: parseInt(value.slice(0, 2), 16),
        g: parseInt(value.slice(2, 4), 16),
        b: parseInt(value.slice(4, 6), 16)
    };
}
function rgbToHex(r, g, b) {
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
function mixWith(color, target, amount) {
    const clamped = clamp(amount, 0, 1);
    return {
        r: color.r + (target.r - color.r) * clamped,
        g: color.g + (target.g - color.g) * clamped,
        b: color.b + (target.b - color.b) * clamped
    };
}
function adjustColor(hex, amount) {
    const rgb = hexToRgb(hex);
    if (!rgb) {
        return hex;
    }
    const target = amount >= 0
        ? { r: 255, g: 255, b: 255 }
        : { r: 0, g: 0, b: 0 };
    const mixed = mixWith(rgb, target, Math.abs(amount));
    return rgbToHex(mixed.r, mixed.g, mixed.b);
}
function relativeLuminance(rgb) {
    const toLinear = (value) => {
        const normalized = value / 255;
        return normalized <= 0.03928
            ? normalized / 12.92
            : Math.pow((normalized + 0.055) / 1.055, 2.4);
    };
    const r = toLinear(rgb.r);
    const g = toLinear(rgb.g);
    const b = toLinear(rgb.b);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function getReadableTextColor(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) {
        return "#FFFFFF";
    }
    return relativeLuminance(rgb) > 0.5 ? "#1F1F1F" : "#FFFFFF";
}
function randomHslColor() {
    const hue = Math.floor(Math.random() * 360);
    const saturation = 68;
    const lightness = 44;
    const c = (1 - Math.abs(2 * lightness / 100 - 1)) * (saturation / 100);
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = lightness / 100 - c / 2;
    let r = 0;
    let g = 0;
    let b = 0;
    if (hue < 60) {
        r = c;
        g = x;
    }
    else if (hue < 120) {
        r = x;
        g = c;
    }
    else if (hue < 180) {
        g = c;
        b = x;
    }
    else if (hue < 240) {
        g = x;
        b = c;
    }
    else if (hue < 300) {
        r = x;
        b = c;
    }
    else {
        r = c;
        b = x;
    }
    return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
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
function getCategoryColor(categoryName, allCategories) {
    const index = allCategories.indexOf(categoryName);
    return CATEGORY_COLORS_HEX[index % CATEGORY_COLORS_HEX.length];
}
class ExtensionCategoriesWebviewProvider {
    constructor(store, extensionUri) {
        this.store = store;
        this.extensionUri = extensionUri;
        this.collapsedCategories = new Set();
    }
    refresh() {
        if (this.view) {
            this.render();
        }
    }
    resolveWebviewView(webviewView) {
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
                    }
                    else {
                        this.collapsedCategories.add(message.category);
                    }
                    this.render();
                    break;
                case "openExtension":
                    vscode.commands.executeCommand("workbench.extensions.action.showExtensionsWithIds", [message.extensionId]);
                    break;
                case "setCategory":
                    this.handleSetCategory(message.extensionId);
                    break;
            }
        });
        this.render();
    }
    async handleSetCategory(extensionId) {
        const extension = vscode.extensions.all.find(ext => ext.id === extensionId);
        if (!extension)
            return;
        const existingCategories = this.store.getAllTagNames();
        const currentCategory = this.store.getTagsForExtension(extensionId)[0];
        const items = [
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
        if (!selection)
            return;
        if (selection.action === "none") {
            await this.store.setTagsForExtension(extensionId, []);
        }
        else if (selection.action === "new") {
            const newCategory = await vscode.window.showInputBox({
                prompt: "Nom de la nouvelle catégorie",
                placeHolder: "AI, Theme, Language..."
            });
            if (newCategory && newCategory.trim()) {
                await this.store.setTagsForExtension(extensionId, [newCategory.trim()]);
            }
        }
        else {
            await this.store.setTagsForExtension(extensionId, [selection.label]);
        }
        this.refresh();
    }
    getExtensionsByCategory() {
        const allExtensions = vscode.extensions.all.filter((ext) => !ext.id.startsWith("vscode."));
        const tagsMap = this.store.getAll();
        const categories = new Map();
        // Grouper par catégorie
        for (const ext of allExtensions) {
            const category = tagsMap[ext.id]?.[0] || "— Sans catégorie —";
            if (!categories.has(category)) {
                categories.set(category, []);
            }
            const iconPath = ext.packageJSON.icon
                ? this.view?.webview.asWebviewUri(vscode.Uri.file(path.join(ext.extensionPath, ext.packageJSON.icon)))?.toString()
                : undefined;
            categories.get(category).push({
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
        const sortedCategories = new Map();
        const sortedKeys = Array.from(categories.keys()).sort((a, b) => {
            if (a === "— Sans catégorie —")
                return 1;
            if (b === "— Sans catégorie —")
                return -1;
            return a.localeCompare(b);
        });
        for (const key of sortedKeys) {
            sortedCategories.set(key, categories.get(key));
        }
        return sortedCategories;
    }
    render() {
        if (!this.view)
            return;
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
async function applyWorkspaceTitlebarColor(colorHex) {
    const inactiveBackground = adjustColor(colorHex, -0.18);
    const border = adjustColor(colorHex, -0.28);
    const foreground = getReadableTextColor(colorHex);
    const workbenchConfig = vscode.workspace.getConfiguration("workbench");
    const existing = workbenchConfig.get("colorCustomizations") ?? {};
    const base = typeof existing === "object" && existing !== null ? existing : {};
    const next = {
        ...base,
        [TITLEBAR_COLOR_KEYS.activeBackground]: colorHex,
        [TITLEBAR_COLOR_KEYS.inactiveBackground]: inactiveBackground,
        [TITLEBAR_COLOR_KEYS.activeForeground]: foreground,
        [TITLEBAR_COLOR_KEYS.inactiveForeground]: foreground,
        [TITLEBAR_COLOR_KEYS.border]: border
    };
    await workbenchConfig.update("colorCustomizations", next, vscode.ConfigurationTarget.Workspace);
}
async function ensureWorkspaceTitlebarColor(context, forceNew = false) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return;
    }
    let color = context.workspaceState.get(WORKSPACE_TITLEBAR_COLOR_KEY);
    if (!color || forceNew) {
        color = randomHslColor();
        await context.workspaceState.update(WORKSPACE_TITLEBAR_COLOR_KEY, color);
    }
    await applyWorkspaceTitlebarColor(color);
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
    const categoriesProvider = new ExtensionCategoriesWebviewProvider(tagsStore, context.extensionUri);
    const updateWorkspace = async () => {
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
        await ensureWorkspaceTitlebarColor(context);
        watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceRoot, "icon.*"));
        watcher.onDidCreate(() => provider.refresh());
        watcher.onDidChange(() => provider.refresh());
        watcher.onDidDelete(() => provider.refresh());
        context.subscriptions.push(watcher);
    };
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, provider));
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(EXTENSION_TAGS_VIEW_ID, categoriesProvider));
    void updateWorkspace();
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void updateWorkspace();
    }));
    const rootSizeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    rootSizeItem.text = "Root size: --";
    rootSizeItem.tooltip = "Click to refresh root folder size";
    rootSizeItem.command = "revealInFinderButton.refreshRootSize";
    rootSizeItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    rootSizeItem.show();
    const previewItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    previewItem.text = "$(open-preview) Preview";
    previewItem.tooltip = "Lancer une preview de la page en cours";
    previewItem.command = "pkvsconf.previewActivePage";
    previewItem.show();
    const titlebarColorItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    titlebarColorItem.text = "$(symbol-color) Title Bar";
    titlebarColorItem.tooltip = "Changer la couleur de la barre de titre (aléatoire)";
    titlebarColorItem.command = "pkvsconf.regenerateWorkspaceTitlebarColor";
    titlebarColorItem.show();
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
        categoriesProvider.refresh();
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
    const regenerateTitlebarColorCmd = vscode.commands.registerCommand("pkvsconf.regenerateWorkspaceTitlebarColor", async () => {
        await ensureWorkspaceTitlebarColor(context, true);
    });
    const previewActivePageCmd = vscode.commands.registerCommand("pkvsconf.previewActivePage", async () => {
        const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
        const activeTabUri = vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri;
        const uri = activeEditorUri ?? activeTabUri;
        if (!uri) {
            vscode.window.showInformationMessage("Aucun fichier ouvert pour preview.");
            return;
        }
        // Créer un WebviewPanel (onglet) pour la preview
        const fileName = path.basename(uri.fsPath);
        const fileExt = path.extname(uri.fsPath).toLowerCase();
        const isPhpFile = fileExt === '.php';
        const panel = vscode.window.createWebviewPanel('pagePreview', `Preview: ${fileName}`, vscode.ViewColumn.Active, {
            enableScripts: true,
            retainContextWhenHidden: true
        });
        let phpServerProcess = null;
        let phpServerPort = null;
        // Nettoyer le serveur PHP quand le panneau est fermé
        panel.onDidDispose(() => {
            if (phpServerProcess) {
                phpServerProcess.kill();
                phpServerProcess = null;
            }
        });
        try {
            if (isPhpFile && uri.scheme === 'file') {
                // Lancer un serveur PHP pour les fichiers PHP
                phpServerPort = await findAvailablePort(8000, 8100);
                if (!phpServerPort) {
                    panel.webview.html = getErrorWebviewContent("Impossible de trouver un port disponible pour le serveur PHP.");
                    return;
                }
                const fileDir = path.dirname(uri.fsPath);
                const fileNameOnly = path.basename(uri.fsPath);
                const serverUrl = `http://localhost:${phpServerPort}/${fileNameOnly}`;
                // Lancer le serveur PHP
                phpServerProcess = cp.spawn('php', ['-S', `localhost:${phpServerPort}`, '-t', fileDir], {
                    cwd: fileDir,
                    stdio: 'pipe'
                });
                phpServerProcess.on('error', (error) => {
                    panel.webview.html = getErrorWebviewContent(`Erreur lors du lancement du serveur PHP: ${error.message}. Assurez-vous que PHP est installé et dans votre PATH.`);
                });
                // Attendre un peu que le serveur démarre
                await new Promise(resolve => setTimeout(resolve, 500));
                // Vérifier si le processus est toujours actif
                if (phpServerProcess && phpServerProcess.killed) {
                    panel.webview.html = getErrorWebviewContent("Le serveur PHP n'a pas pu démarrer. Vérifiez que PHP est installé.");
                    return;
                }
                // Afficher l'URL du serveur dans la webview
                panel.webview.html = getPhpServerWebviewContent(serverUrl);
            }
            else {
                // Pour les autres fichiers, afficher le contenu directement
                const document = await vscode.workspace.openTextDocument(uri);
                const content = document.getText();
                // Afficher dans la webview
                panel.webview.html = getWebviewContent(content);
            }
        }
        catch (error) {
            panel.webview.html = getErrorWebviewContent(`Erreur lors de la lecture du fichier: ${error}`);
        }
    });
    function findAvailablePort(startPort, endPort) {
        return new Promise((resolve) => {
            let currentPort = startPort;
            const tryPort = () => {
                if (currentPort > endPort) {
                    resolve(null);
                    return;
                }
                const server = net.createServer();
                server.listen(currentPort, () => {
                    server.once('close', () => {
                        resolve(currentPort);
                    });
                    server.close();
                });
                server.on('error', () => {
                    currentPort++;
                    tryPort();
                });
            };
            tryPort();
        });
    }
    function getWebviewContent(content) {
        return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      margin: 0;
      padding: 20px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
    }
  </style>
</head>
<body>
  ${content}
</body>
</html>`;
    }
    function getErrorWebviewContent(errorMessage) {
        return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      margin: 0;
      padding: 20px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      color: var(--vscode-errorForeground);
    }
  </style>
</head>
<body>
  <h1>Erreur de preview</h1>
  <p>${errorMessage}</p>
</body>
</html>`;
    }
    function getPhpServerWebviewContent(serverUrl) {
        return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
    }
    iframe {
      width: 100%;
      height: 100vh;
      border: none;
    }
  </style>
</head>
<body>
  <iframe src="${serverUrl}" sandbox="allow-same-origin allow-scripts allow-forms allow-popups"></iframe>
</body>
</html>`;
    }
    context.subscriptions.push(cmd, refreshCmd, openRepoCmd, rootSizeItem, previewItem, titlebarColorItem);
    context.subscriptions.push(manageCategoryCmd, searchExtensionsCmd, regenerateTitlebarColorCmd, previewActivePageCmd);
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