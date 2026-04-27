"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const fs = require("fs/promises");
const path = require("path");
const cp = require("child_process");
const net = require("net");
const os = require("os");
const SIZE_UNITS = ["KB", "MB", "GB", "TB"];
const ICON_PREFIX = "icon.";
const VIEW_ID = "projectIconView";
const EXTENSION_TAGS_VIEW_ID = "extensionTagsView";
const LAUNCHPAD_EXPLORER_VIEW_ID = "launchpadExplorerView";
const PROJECT_NOTES_VIEW_ID = "projectNotesView";
const EXTENSION_TAGS_STORAGE_KEY = "extensionTags";
const WORKSPACE_TITLEBAR_COLOR_KEY = "workspaceTitlebarColor";
const WORKSPACE_TITLEBAR_COLOR_HISTORY_KEY = "workspaceTitlebarColorHistory";
const CODEX_RESUME_STORAGE_KEY = "codexResumeCommands";
const AGENT_HISTORY_STORAGE_KEY = "agentHistory";
const CODEX_HISTORY_LAST_TS_KEY = "codexHistoryLastTs";
function getAgentHistoryEntries(context) {
    const raw = context.globalState.get(AGENT_HISTORY_STORAGE_KEY);
    if (!Array.isArray(raw))
        return [];
    return raw
        .map((v) => v)
        .filter((v) => typeof v?.command === "string" && typeof v?.createdAt === "number")
        .map((v) => ({
        id: typeof v.id === "string" && v.id ? v.id : v.command.toLowerCase(),
        provider: v.provider ?? "unknown",
        command: v.command.trim(),
        cwd: typeof v.cwd === "string" ? v.cwd : undefined,
        label: typeof v.label === "string" ? v.label : undefined,
        createdAt: v.createdAt,
        lastRunAt: typeof v.lastRunAt === "number" ? v.lastRunAt : undefined
    }));
}
async function upsertAgentHistoryEntry(context, entry) {
    const existing = getAgentHistoryEntries(context);
    const command = entry.command.trim();
    const id = command.toLowerCase();
    const next = { ...entry, command, id };
    const deduped = existing.filter((e) => e.id !== id);
    deduped.unshift(next);
    await context.globalState.update(AGENT_HISTORY_STORAGE_KEY, deduped.slice(0, 200));
    return next;
}
function inferProviderFromCommand(command) {
    const c = command.trim().toLowerCase();
    if (c.startsWith("codex "))
        return "codex";
    if (c.startsWith("claude "))
        return "claude";
    if (c.startsWith("gemini "))
        return "gemini";
    if (c.startsWith("opencode "))
        return "opencode";
    return "unknown";
}
function formatRelativeTime(ts) {
    const diff = Date.now() - ts;
    const min = Math.round(diff / 60000);
    if (min < 1)
        return "just now";
    if (min < 60)
        return `${min}m ago`;
    const h = Math.round(min / 60);
    if (h < 48)
        return `${h}h ago`;
    const d = Math.round(h / 24);
    return `${d}d ago`;
}
class AgentHistoryItem extends vscode.TreeItem {
    constructor(entry) {
        const label = entry.label ? entry.label : entry.command;
        super(label, vscode.TreeItemCollapsibleState.None);
        this.entry = entry;
        this.description = entry.cwd ? entry.cwd : undefined;
        const last = entry.lastRunAt ?? entry.createdAt;
        this.tooltip = `${entry.provider.toUpperCase()} • ${formatRelativeTime(last)}\n${entry.command}`;
        this.contextValue = "agentHistoryItem";
        this.command = {
            command: "pkvsconf.agentHistoryRun",
            title: "Run",
            arguments: [entry]
        };
        this.iconPath = new vscode.ThemeIcon("history");
    }
}
class AgentHistoryProvider {
    constructor(context) {
        this.context = context;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    getTreeItem(element) {
        return element;
    }
    getChildren() {
        return getAgentHistoryEntries(this.context).map((e) => new AgentHistoryItem(e));
    }
}
function extractCodexResumeCommand(text) {
    const trimmed = text.trim();
    if (!trimmed)
        return null;
    const cmdMatch = trimmed.match(/\bcodex\s+resume\s+([^\s"'`]+)/i);
    if (cmdMatch?.[1]) {
        return `codex resume ${cmdMatch[1]}`;
    }
    // Allow pasting just the id/token
    const idMatch = trimmed.match(/^([^\s"'`]+)$/);
    if (idMatch?.[1]) {
        return `codex resume ${idMatch[1]}`;
    }
    return null;
}
function getCodexResumeEntries(context) {
    const raw = context.globalState.get(CODEX_RESUME_STORAGE_KEY);
    if (!Array.isArray(raw))
        return [];
    return raw
        .map((v) => v)
        .filter((v) => typeof v?.command === "string" && typeof v?.createdAt === "number")
        .map((v) => ({
        id: typeof v.id === "string" && v.id ? v.id : v.command.toLowerCase(),
        command: v.command.trim(),
        label: typeof v.label === "string" ? v.label : undefined,
        createdAt: v.createdAt
    }));
}
async function addCodexResumeEntry(context, entry) {
    const existing = getCodexResumeEntries(context);
    const command = entry.command.trim();
    const id = command.toLowerCase();
    const next = { ...entry, command, id };
    const deduped = existing.filter((e) => e.id !== id);
    deduped.unshift(next);
    await context.globalState.update(CODEX_RESUME_STORAGE_KEY, deduped.slice(0, 50));
    return next;
}
function tokenizeForMatch(text) {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .split(" ")
        .map((t) => t.trim())
        .filter((t) => t.length >= 3 && t.length <= 40);
}
function scoreSession(queryTokens, docTokens) {
    if (queryTokens.size === 0 || docTokens.length === 0)
        return 0;
    let hits = 0;
    const seen = new Set();
    for (const t of docTokens) {
        if (queryTokens.has(t) && !seen.has(t)) {
            hits++;
            seen.add(t);
        }
    }
    return hits;
}
async function readCodexHistory() {
    const historyPath = path.join(os.homedir(), ".codex", "history.jsonl");
    try {
        const content = await fs.readFile(historyPath, "utf8");
        const entries = [];
        for (const line of content.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            try {
                const obj = JSON.parse(trimmed);
                if (typeof obj?.session_id === "string" &&
                    obj.session_id &&
                    typeof obj?.ts === "number" &&
                    typeof obj?.text === "string") {
                    entries.push({
                        session_id: obj.session_id,
                        ts: obj.ts,
                        text: obj.text
                    });
                }
            }
            catch {
                // ignore malformed lines
            }
        }
        return entries;
    }
    catch {
        return [];
    }
}
function getCodexHistoryLastTs(context) {
    const raw = context.globalState.get(CODEX_HISTORY_LAST_TS_KEY);
    return typeof raw === "number" && isFinite(raw) ? raw : 0;
}
async function setCodexHistoryLastTs(context, ts) {
    await context.globalState.update(CODEX_HISTORY_LAST_TS_KEY, ts);
}
async function importCodexSessionsFromHistory(context, agentHistoryProvider) {
    const entries = await readCodexHistory();
    if (!entries.length) {
        return;
    }
    const lastSeen = getCodexHistoryLastTs(context);
    const fresh = entries
        .filter((e) => typeof e.ts === "number" && e.ts > lastSeen && typeof e.session_id === "string" && e.session_id)
        .sort((a, b) => a.ts - b.ts);
    if (!fresh.length) {
        return;
    }
    let maxTs = lastSeen;
    for (const e of fresh) {
        maxTs = Math.max(maxTs, e.ts);
        await upsertAgentHistoryEntry(context, {
            provider: "codex",
            command: `codex resume ${e.session_id}`,
            createdAt: Math.round(e.ts * 1000),
            label: `Codex session ${e.session_id.slice(0, 8)}`
        });
    }
    await setCodexHistoryLastTs(context, maxTs);
    agentHistoryProvider.refresh();
}
async function readCodexSessionIndex() {
    const sessionIndexPath = path.join(os.homedir(), ".codex", "session_index.jsonl");
    try {
        const content = await fs.readFile(sessionIndexPath, "utf8");
        const entries = [];
        for (const line of content.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            try {
                const obj = JSON.parse(trimmed);
                if (typeof obj?.id === "string" && obj.id) {
                    entries.push({
                        id: obj.id,
                        thread_name: typeof obj.thread_name === "string" ? obj.thread_name : undefined,
                        updated_at: typeof obj.updated_at === "string" ? obj.updated_at : undefined
                    });
                }
            }
            catch {
                // ignore malformed lines
            }
        }
        entries.sort((a, b) => {
            const ta = a.updated_at ? Date.parse(a.updated_at) : 0;
            const tb = b.updated_at ? Date.parse(b.updated_at) : 0;
            return tb - ta;
        });
        return entries;
    }
    catch {
        return [];
    }
}
async function suggestCodexSessions(query) {
    const [sessions, history] = await Promise.all([readCodexSessionIndex(), readCodexHistory()]);
    if (!sessions.length || !history.length)
        return [];
    const qTokens = new Set(tokenizeForMatch(query));
    if (!qTokens.size)
        return [];
    const sessionToName = new Map();
    for (const s of sessions)
        sessionToName.set(s.id, s);
    // Build a light per-session token bag from recent history lines
    const bySession = new Map();
    for (const h of history) {
        const existing = bySession.get(h.session_id);
        const tokens = tokenizeForMatch(h.text).slice(0, 120);
        if (!existing) {
            bySession.set(h.session_id, { tokens: [...tokens], lastTs: h.ts });
        }
        else {
            existing.tokens.push(...tokens);
            if (h.ts > existing.lastTs)
                existing.lastTs = h.ts;
            if (existing.tokens.length > 2000) {
                existing.tokens.splice(0, existing.tokens.length - 2000);
            }
        }
    }
    const scored = [];
    for (const [id, doc] of bySession) {
        const meta = sessionToName.get(id);
        const s = scoreSession(qTokens, doc.tokens);
        if (s <= 0)
            continue;
        scored.push({
            id,
            threadName: meta?.thread_name,
            updatedAt: meta?.updated_at,
            score: s
        });
    }
    scored.sort((a, b) => {
        if (b.score !== a.score)
            return b.score - a.score;
        const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
        const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
        return tb - ta;
    });
    return scored.slice(0, 50);
}
function isProjectInLaunchpad(projects, projectPath) {
    const normalized = path.normalize(projectPath);
    return projects.some((p) => path.normalize(p.path) === normalized);
}
function getLaunchpadProjects() {
    const cfg = vscode.workspace.getConfiguration("pkvsconf").get("launchpad.projects");
    if (!cfg || !Array.isArray(cfg)) {
        return [];
    }
    return cfg.filter((p) => p?.path);
}
async function addFolderToLaunchpad() {
    const pick = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Ajouter au Launchpad"
    });
    const folder = pick?.[0];
    if (!folder) {
        return;
    }
    const folderPath = folder.fsPath;
    const projects = getLaunchpadProjects();
    if (projects.some((p) => path.normalize(p.path) === path.normalize(folderPath))) {
        vscode.window.showInformationMessage("Ce projet est déjà dans le Launchpad.");
        return;
    }
    const defaultName = path.basename(folderPath);
    const name = await vscode.window.showInputBox({
        title: "Nom du projet",
        prompt: "Nom affiché dans le Launchpad",
        value: defaultName
    });
    if (name === undefined) {
        return;
    }
    projects.push({ name: name.trim() || defaultName, path: folderPath });
    await vscode.workspace
        .getConfiguration("pkvsconf")
        .update("launchpad.projects", projects, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage("Projet ajouté au Launchpad.");
}
function getLaunchpadViewMode() {
    const cfg = vscode.workspace.getConfiguration("pkvsconf").get("launchpad.viewMode");
    return cfg === "mini" ? "mini" : "grid";
}
async function setLaunchpadViewMode(mode) {
    await vscode.workspace
        .getConfiguration("pkvsconf")
        .update("launchpad.viewMode", mode, vscode.ConfigurationTarget.Global);
}
async function addCurrentWorkspaceToLaunchpad() {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
        vscode.window.showWarningMessage("Aucun workspace ouvert.");
        return;
    }
    const projects = getLaunchpadProjects();
    if (projects.some((p) => path.normalize(p.path) === path.normalize(ws.uri.fsPath))) {
        vscode.window.showInformationMessage("Ce workspace est déjà dans le Launchpad.");
        return;
    }
    projects.push({ name: path.basename(ws.uri.fsPath), path: ws.uri.fsPath });
    await vscode.workspace
        .getConfiguration("pkvsconf")
        .update("launchpad.projects", projects, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage("Projet ajouté au Launchpad.");
}
async function openLaunchpadQuickPick() {
    while (true) {
        const projects = getSortedLaunchpadProjects();
        const projectItems = await buildLaunchpadQuickPickItems(projects);
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const actionItems = [
            {
                label: "$(folder-add) Ajouter un dossier au Launchpad",
                description: "",
                action: "addFolder"
            }
        ];
        if (workspacePath) {
            const alreadyInLaunchpad = isProjectInLaunchpad(projects, workspacePath);
            actionItems.unshift({
                label: "$(add) Ajouter le projet courant au Launchpad",
                description: alreadyInLaunchpad
                    ? `${workspacePath} (déjà présent)`
                    : workspacePath,
                action: "addCurrent"
            });
        }
        const separator = {
            label: "Actions",
            kind: vscode.QuickPickItemKind.Separator
        };
        const items = [
            ...projectItems,
            ...(actionItems.length
                ? [separator, ...actionItems]
                : [])
        ];
        const pick = await vscode.window.showQuickPick(items, {
            placeHolder: "Ouvrir un projet du Launchpad ou en ajouter un"
        });
        if (!pick) {
            return;
        }
        if ("action" in pick) {
            if (pick.action === "addCurrent") {
                await addCurrentWorkspaceToLaunchpad();
            }
            else {
                await addFolderToLaunchpad();
            }
            continue;
        }
        if ("project" in pick) {
            await openProjectInNewWindow(pick.project.path);
            return;
        }
    }
}
async function openProjectInNewWindow(projectPath) {
    await recordLaunchpadOpen(projectPath);
    const uri = vscode.Uri.file(projectPath);
    await vscode.commands.executeCommand("vscode.openFolder", uri, true);
}
async function recordLaunchpadOpen(projectPath) {
    const projects = getLaunchpadProjects();
    const normalized = path.normalize(projectPath);
    const idx = projects.findIndex((p) => path.normalize(p.path) === normalized);
    if (idx !== -1) {
        projects[idx].lastOpened = Date.now();
        await vscode.workspace
            .getConfiguration("pkvsconf")
            .update("launchpad.projects", projects, vscode.ConfigurationTarget.Global);
    }
}
function getSortedLaunchpadProjects() {
    const projects = getLaunchpadProjects();
    return projects.sort((a, b) => {
        const ta = a.lastOpened ?? 0;
        const tb = b.lastOpened ?? 0;
        if (ta !== tb)
            return tb - ta;
        return a.name.localeCompare(b.name);
    });
}
async function revealProjectInFinder(project) {
    const target = project ?? (await pickProjectForAction("Révéler dans le Finder"));
    if (!target) {
        return;
    }
    await vscode.env.openExternal(vscode.Uri.file(target.path));
}
async function pickProjectForAction(placeHolder) {
    const projects = getSortedLaunchpadProjects();
    const items = await buildLaunchpadQuickPickItems(projects);
    const pick = await vscode.window.showQuickPick(items, { placeHolder });
    return pick?.project;
}
async function getProjectIconFileUri(project) {
    const candidates = [
        "icon.png",
        "icon.jpg",
        "icon.jpeg",
        "Icon.png",
        "Icon.jpg",
        "Icon.jpeg"
    ];
    for (const filename of candidates) {
        const candidatePath = path.join(project.path, filename);
        try {
            await fs.access(candidatePath);
            return vscode.Uri.file(candidatePath);
        }
        catch {
            // keep searching
        }
    }
    return undefined;
}
async function buildLaunchpadQuickPickItems(projects) {
    return Promise.all(projects.map(async (project) => ({
        label: project.name || path.basename(project.path),
        description: project.path,
        detail: project.lastOpened
            ? `Ouvert ${formatRelativeTime(project.lastOpened)}`
            : undefined,
        project,
        iconPath: await getProjectIconFileUri(project)
    })));
}
function toDataUriFromSvg(title, bg) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="110"><rect width="100%" height="100%" rx="12" ry="12" fill="${bg}"/><text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="36" fill="white">${title}</text></svg>`;
    const encoded = Buffer.from(svg).toString("base64");
    return `data:image/svg+xml;base64,${encoded}`;
}
async function getProjectIcon(project) {
    const candidate = path.join(project.path, "icon.png");
    try {
        const content = await fs.readFile(candidate);
        return `data:image/png;base64,${content.toString("base64")}`;
    }
    catch {
        const initials = (project.name || path.basename(project.path)).trim().slice(0, 2).toUpperCase();
        const palette = ["#2A9D8F", "#E76F51", "#264653", "#8AB17D", "#F4A261", "#6D597A", "#1D3557"];
        const color = palette[(project.name || project.path).length % palette.length];
        return toDataUriFromSvg(initials, color);
    }
}
function getNonce() {
    let text = "";
    const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
function getWorkspaceRootFsPath() {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws || ws.uri.scheme !== "file") {
        return undefined;
    }
    return ws.uri.fsPath;
}
async function ensureDir(dirPath) {
    try {
        await fs.mkdir(dirPath, { recursive: true });
    }
    catch {
        // ignore
    }
}
async function safeReadTextFile(filePath) {
    try {
        return await fs.readFile(filePath, "utf8");
    }
    catch {
        return "";
    }
}
async function safeWriteTextFile(filePath, content) {
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, content, "utf8");
}
async function buildLaunchpadHtml(webview, projects) {
    const cards = await Promise.all(projects.map(async (p) => ({
        name: p.name || path.basename(p.path),
        path: p.path,
        icon: await getProjectIcon(p),
        lastOpened: p.lastOpened
    })));
    const viewMode = getLaunchpadViewMode();
    const gridCardsHtml = cards
        .map((c) => `
        <button class="card${c.lastOpened ? ' recent' : ''}" data-path="${c.path}" title="${c.name}${c.lastOpened ? ' — ' + formatRelativeTime(c.lastOpened) : ''}">
          <img src="${c.icon}" alt="${c.name}" />
          <div class="name">${c.name}</div>
          ${c.lastOpened ? '<div class="badge recent">récent</div>' : ''}
        </button>`)
        .join("");
    const miniItemsHtml = cards
        .map((c) => `
        <button class="miniItem${c.lastOpened ? ' recent' : ''}" data-path="${c.path}" type="button" aria-label="${c.name}" title="${c.name}${c.lastOpened ? ' — ' + formatRelativeTime(c.lastOpened) : ''}">
          <img src="${c.icon}" alt="${c.name}" />
          ${c.lastOpened ? '<div class="miniBadge recent">●</div>' : ''}
        </button>`)
        .join("");
    const nonce = getNonce();
    return `<!DOCTYPE html>
  <html>
    <head>
      <meta charset="UTF-8" />
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';" />
      <style>
        :root {
          color-scheme: ${vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ? "dark" : "light"};
        }
        body {
          margin: 0;
          padding: 10px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          background: var(--vscode-sideBar-background);
        }
        .container {
          width: 100%;
          max-width: 760px;
          margin: 0 auto;
        }
        .topbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          margin-bottom: 8px;
        }
        .title {
          font-size: 12px;
          color: var(--vscode-descriptionForeground);
          letter-spacing: 0.2px;
          user-select: none;
        }
        .actions {
          display: inline-flex;
          gap: 6px;
          align-items: center;
        }
        .iconBtn {
          border: 1px solid var(--vscode-editorWidget-border, #4444);
          background: var(--vscode-editor-background);
          color: var(--vscode-foreground);
          border-radius: 10px;
          height: 26px;
          width: 26px;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          transition: transform 0.08s ease, box-shadow 0.08s ease;
        }
        .iconBtn:hover {
          transform: translateY(-1px);
          box-shadow: 0 8px 18px rgba(0,0,0,0.10);
        }
        .iconBtn:active {
          transform: translateY(0px);
          box-shadow: none;
        }
        .grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
          gap: 8px;
          width: 100%;
        }
        .card {
          border: none;
          background: var(--vscode-sideBar-background);
          border-radius: 12px;
          padding: 10px;
          text-align: center;
          cursor: pointer;
          transition: transform 0.08s ease, box-shadow 0.08s ease;
        }
        .card:hover {
          transform: translateY(-2px);
          box-shadow: 0 8px 18px rgba(0,0,0,0.12);
        }
        .card img {
          width: 72px;
          height: 72px;
          object-fit: contain;
          border-radius: 10px;
          background: transparent;
          margin-bottom: 6px;
        }
        .name {
          font-size: 12px;
          color: var(--vscode-foreground);
          word-break: break-word;
        }
        .miniRow {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
          overflow: hidden;
          padding: 2px 0;
        }
        .miniItem {
          border: none;
          background: transparent;
          height: 32px;
          width: 32px;
          padding: 0;
          border-radius: 8px;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .miniItem:hover {
          background: var(--vscode-list-hoverBackground);
        }
        .miniItem img {
          height: 32px;
          width: 32px;
          object-fit: contain;
          border-radius: 6px;
          background: transparent;
        }
        .miniAdd {
          border: 1px dashed var(--vscode-editorWidget-border, #4444);
          background: transparent;
          height: 32px;
          width: 32px;
          padding: 0;
          border-radius: 8px;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: var(--vscode-foreground);
          flex: 0 0 auto;
        }
        .miniAdd:hover {
          background: var(--vscode-list-hoverBackground);
        }
        .card.recent {
          background: var(--vscode-list-activeSelectionBackground, rgba(100,100,255,0.08));
        }
        .badge.recent {
          font-size: 9px;
          color: var(--vscode-descriptionForeground);
          margin-top: 2px;
          opacity: 0.7;
        }
        .miniItem.recent {
          position: relative;
        }
        .miniBadge.recent {
          position: absolute;
          top: 0;
          right: 0;
          font-size: 6px;
          color: var(--vscode-terminal-ansiGreen, #4ec9b0);
          line-height: 1;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="topbar">
          <div class="title">Projets (${viewMode === "mini" ? "mini" : "grille"})</div>
          <div class="actions">
            <button id="toggleBtn" class="iconBtn" type="button" aria-label="Basculer le mode d'affichage" title="Basculer le mode">≡</button>
            <button id="addBtn" class="iconBtn" type="button" aria-label="Ajouter un projet au Launchpad" title="Ajouter un projet">+</button>
          </div>
        </div>
        ${viewMode === "mini"
        ? `<div class="miniRow" role="list">
                ${miniItemsHtml}
              </div>`
        : `<div class="grid">
                ${gridCardsHtml}
              </div>`}
      </div>
      <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        document.getElementById('addBtn')?.addEventListener('click', () => {
          vscode.postMessage({ command: 'add' });
        });
        document.getElementById('toggleBtn')?.addEventListener('click', () => {
          vscode.postMessage({ command: 'toggleMode' });
        });
        document.querySelectorAll('[data-path]').forEach(el => {
          el.addEventListener('click', () => {
            vscode.postMessage({ command: 'open', path: el.dataset.path });
          });
          el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            vscode.postMessage({ command: 'reveal', path: el.dataset.path });
          });
        });
      </script>
    </body>
  </html>`;
}
async function buildProjectNotesHtml(webview, initialContent, filePath) {
    const nonce = getNonce();
    const escaped = initialContent
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    return `<!DOCTYPE html>
  <html>
    <head>
      <meta charset="UTF-8" />
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';" />
      <style>
        :root {
          color-scheme: ${vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ? "dark" : "light"};
        }
        body {
          margin: 0;
          padding: 10px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          background: var(--vscode-sideBar-background);
          color: var(--vscode-foreground);
        }
        .topbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          margin-bottom: 8px;
        }
        .title {
          font-size: 12px;
          color: var(--vscode-descriptionForeground);
          user-select: none;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        textarea {
          width: 100%;
          min-height: 240px;
          height: calc(100vh - 70px);
          resize: none;
          box-sizing: border-box;
          border: none;
          background: var(--vscode-editor-background);
          color: var(--vscode-foreground);
          border-radius: 12px;
          padding: 10px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
          font-size: 12px;
          line-height: 1.35;
          outline: none;
        }
        textarea:focus {
          outline: 1px solid var(--vscode-focusBorder);
          outline-offset: 2px;
        }
      </style>
    </head>
    <body>
      <div class="topbar">
        <div class="title" title="${filePath}">${path.basename(filePath)}</div>
      </div>
      <textarea id="notes" spellcheck="false" placeholder="Notes du projet (Markdown OK)…">${escaped}</textarea>
      <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const el = document.getElementById('notes');

        function isInsideFencedCodeBlock(text, cursorIndex) {
          // simple heuristic: count fences before cursor (avoid backticks in this template literal)
          const fence = String.fromCharCode(96, 96, 96);
          const before = text.slice(0, cursorIndex);
          const count = before.split(fence).length - 1;
          return count % 2 === 1;
        }

        el.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;

          const value = el.value;
          const start = el.selectionStart;
          const end = el.selectionEnd;
          if (start !== end) return; // don't interfere with multi-line replace
          if (isInsideFencedCodeBlock(value, start)) return;

          // current line boundaries
          const lineStart = value.lastIndexOf('\\n', start - 1) + 1;
          const lineEnd = value.indexOf('\\n', start);
          const currentLine = value.slice(lineStart, lineEnd === -1 ? value.length : lineEnd);

          const trimmed = currentLine.trim();
          if (!trimmed) return;

          // continue list if line already a bullet, otherwise create one by default
          const bulletMatch = currentLine.match(/^(\\s*)([-*]\\s+)/);
          const indent = bulletMatch ? bulletMatch[1] : "";
          const bullet = bulletMatch ? bulletMatch[2] : "- ";

          e.preventDefault();
          const insert = "\\n" + indent + bullet;
          el.value = value.slice(0, start) + insert + value.slice(start);
          const nextPos = start + insert.length;
          el.selectionStart = nextPos;
          el.selectionEnd = nextPos;

          el.dispatchEvent(new Event('input', { bubbles: true }));
        });

        let t = null;
        el.addEventListener('input', () => {
          if (t) clearTimeout(t);
          t = setTimeout(() => {
            vscode.postMessage({ command: 'save', content: el.value });
          }, 350);
        });
      </script>
    </body>
  </html>`;
}
class LaunchpadWebviewProvider {
    constructor(context) {
        this.context = context;
    }
    async resolveWebviewView(webviewView) {
        this.currentView = webviewView;
        webviewView.webview.options = {
            enableScripts: true
        };
        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (message.command === "open" && message.path) {
                await openProjectInNewWindow(message.path);
            }
            else if (message.command === "reveal" && message.path) {
                await revealProjectInFinder({ name: path.basename(message.path), path: message.path });
            }
            else if (message.command === "add") {
                await addFolderToLaunchpad();
                await this.render(webviewView);
            }
            else if (message.command === "toggleMode") {
                const nextMode = getLaunchpadViewMode() === "mini" ? "grid" : "mini";
                await setLaunchpadViewMode(nextMode);
                await this.render(webviewView);
            }
        });
        await this.render(webviewView);
    }
    async render(view) {
        const projects = getSortedLaunchpadProjects();
        view.webview.html = await buildLaunchpadHtml(view.webview, projects);
    }
    async refreshCurrentView() {
        if (!this.currentView) {
            return;
        }
        await this.render(this.currentView);
    }
}
class ProjectNotesViewProvider {
    async resolveWebviewView(webviewView) {
        this.currentView = webviewView;
        webviewView.webview.options = {
            enableScripts: true
        };
        webviewView.webview.onDidReceiveMessage(async (message) => {
            const workspaceRoot = getWorkspaceRootFsPath();
            if (!workspaceRoot) {
                vscode.window.showWarningMessage("Aucun workspace local ouvert pour enregistrer les notes.");
                return;
            }
            const notesPath = path.join(workspaceRoot, ".vscode", "pkvsconf-notes.md");
            if (message.command === "save" && typeof message.content === "string") {
                await safeWriteTextFile(notesPath, message.content);
            }
        });
        await this.render(webviewView);
    }
    async render(view) {
        const workspaceRoot = getWorkspaceRootFsPath();
        if (!workspaceRoot) {
            view.webview.html = await buildProjectNotesHtml(view.webview, "", ".vscode/pkvsconf-notes.md");
            return;
        }
        const notesPath = path.join(workspaceRoot, ".vscode", "pkvsconf-notes.md");
        const content = await safeReadTextFile(notesPath);
        view.webview.html = await buildProjectNotesHtml(view.webview, content, notesPath);
    }
}
const SECRET_PATTERNS = [
    // AWS
    { name: "AWS Access Key", pattern: /AKIA[0-9A-Z]{16}/g, description: "AWS Access Key ID" },
    { name: "AWS Secret Key", pattern: /aws_secret_access_key\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi, description: "AWS Secret Access Key" },
    // Generic API Keys
    { name: "API Key", pattern: /(?:api[_-]?key|apikey)\s*[=:]\s*['"]?[A-Za-z0-9_\-]{20,}['"]?/gi, description: "Generic API Key" },
    { name: "API Secret", pattern: /(?:api[_-]?secret|apisecret)\s*[=:]\s*['"]?[A-Za-z0-9_\-]{20,}['"]?/gi, description: "API Secret" },
    // GCP/Firebase
    { name: "GCP Service Account", pattern: /"type"\s*:\s*"service_account"/g, description: "GCP Service Account JSON" },
    { name: "Firebase API Key", pattern: /AIza[0-9A-Za-z\-_]{35}/g, description: "Firebase/GCP API Key" },
    // Azure
    { name: "Azure Storage Key", pattern: /AccountKey=[A-Za-z0-9+/=]{88}/g, description: "Azure Storage Account Key" },
    { name: "Azure Connection String", pattern: /DefaultEndpointsProtocol=https;AccountName=[^;]+;AccountKey=[A-Za-z0-9+/=]+/g, description: "Azure Connection String" },
    // JWT/OAuth/Bearer
    { name: "JWT Token", pattern: /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g, description: "JWT Token" },
    { name: "Bearer Token", pattern: /bearer\s+[A-Za-z0-9_\-.]+/gi, description: "Bearer Token" },
    { name: "OAuth Token", pattern: /oauth[_-]?token\s*[=:]\s*['"]?[A-Za-z0-9_\-]{20,}['"]?/gi, description: "OAuth Token" },
    // Passwords
    { name: "Password", pattern: /(?:password|passwd|pwd)\s*[=:]\s*['"]?[^\s'"]{4,}['"]?/gi, description: "Password in config" },
    { name: "DB Password", pattern: /(?:db_password|database_password|mysql_password|postgres_password)\s*[=:]\s*['"]?[^\s'"]+['"]?/gi, description: "Database Password" },
    // SSH/SSL Keys
    { name: "RSA Private Key", pattern: /-----BEGIN RSA PRIVATE KEY-----/g, description: "RSA Private Key" },
    { name: "DSA Private Key", pattern: /-----BEGIN DSA PRIVATE KEY-----/g, description: "DSA Private Key" },
    { name: "EC Private Key", pattern: /-----BEGIN EC PRIVATE KEY-----/g, description: "EC Private Key" },
    { name: "OpenSSH Private Key", pattern: /-----BEGIN OPENSSH PRIVATE KEY-----/g, description: "OpenSSH Private Key" },
    { name: "PGP Private Key", pattern: /-----BEGIN PGP PRIVATE KEY BLOCK-----/g, description: "PGP Private Key" },
    { name: "Private Key Generic", pattern: /-----BEGIN PRIVATE KEY-----/g, description: "Generic Private Key" },
    // Database Connection Strings
    { name: "MongoDB URI", pattern: /mongodb(?:\+srv)?:\/\/[^:]+:[^@]+@[^\s]+/g, description: "MongoDB Connection String" },
    { name: "PostgreSQL URI", pattern: /postgres(?:ql)?:\/\/[^:]+:[^@]+@[^\s]+/g, description: "PostgreSQL Connection String" },
    { name: "MySQL URI", pattern: /mysql:\/\/[^:]+:[^@]+@[^\s]+/g, description: "MySQL Connection String" },
    { name: "Redis URI", pattern: /redis:\/\/[^:]+:[^@]+@[^\s]+/g, description: "Redis Connection String" },
    // Platform-specific tokens
    { name: "GitHub Token", pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g, description: "GitHub Personal Access Token" },
    { name: "GitHub Classic Token", pattern: /github_pat_[A-Za-z0-9_]{22,}/g, description: "GitHub Fine-grained Token" },
    { name: "Slack Token", pattern: /xox[baprs]-[0-9A-Za-z\-]+/g, description: "Slack Token" },
    { name: "Slack Webhook", pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, description: "Slack Webhook URL" },
    { name: "Discord Webhook", pattern: /https:\/\/discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/g, description: "Discord Webhook" },
    { name: "Stripe Key", pattern: /sk_(?:live|test)_[A-Za-z0-9]{24,}/g, description: "Stripe Secret Key" },
    { name: "Twilio Token", pattern: /SK[0-9a-fA-F]{32}/g, description: "Twilio API Key" },
    { name: "SendGrid Key", pattern: /SG\.[A-Za-z0-9_-]{22,}\.[A-Za-z0-9_-]{43,}/g, description: "SendGrid API Key" },
    { name: "NPM Token", pattern: /npm_[A-Za-z0-9]{36}/g, description: "NPM Access Token" },
];
const SKIP_DIRECTORIES = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    "coverage",
    "__pycache__",
    ".pytest_cache",
    "venv",
    ".venv",
    "env",
    "vendor",
    "target",
    ".idea",
    ".vs",
]);
// Fichiers à ignorer (faux positifs courants)
const SKIP_FILES = new Set([
    ".env.example",
    ".env.sample",
    ".env.template",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
]);
// Extensions de fichiers à ignorer
const SKIP_EXTENSIONS = new Set([
    ".min.js",
    ".min.css",
    ".map",
    ".lock",
    ".svg",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".ico",
    ".woff",
    ".woff2",
    ".ttf",
    ".eot",
]);
// Patterns de noms de fichiers à ignorer (fichiers de config de sécurité)
function shouldSkipFile(filePath) {
    const fileName = path.basename(filePath).toLowerCase();
    const ext = path.extname(filePath).toLowerCase();
    // Fichiers spécifiques à ignorer
    if (SKIP_FILES.has(fileName)) {
        return true;
    }
    // Extensions à ignorer
    if (SKIP_EXTENSIONS.has(ext)) {
        return true;
    }
    // Fichiers minifiés
    if (fileName.endsWith(".min.js") || fileName.endsWith(".min.css")) {
        return true;
    }
    // Fichiers de test de sécurité / détection de secrets (faux positifs)
    if (fileName.includes("secret-pattern") ||
        fileName.includes("secret-detector") ||
        fileName.includes("secret-scanner")) {
        return true;
    }
    return false;
}
// Vérifie si une ligne est une définition de pattern/regex (faux positif)
function isPatternDefinition(line) {
    // Lignes qui définissent des patterns de regex
    if (/pattern\s*[:=]\s*\//.test(line)) {
        return true;
    }
    // Lignes avec new RegExp
    if (/new\s+RegExp\s*\(/.test(line)) {
        return true;
    }
    // Lignes de commentaires décrivant des patterns
    if (/^\s*(\/\/|\/\*|\*|#)/.test(line)) {
        return true;
    }
    // Lignes dans des objets de configuration de patterns (comme SECRET_PATTERNS)
    if (/name\s*:\s*["'].*["']\s*,\s*pattern\s*:/.test(line)) {
        return true;
    }
    // Lignes avec description de patterns
    if (/description\s*:\s*["']/.test(line)) {
        return true;
    }
    return false;
}
// Vérifie si un fichier est ignoré par git
async function isFileGitIgnored(filePath, workspaceRoot) {
    return new Promise((resolve) => {
        cp.exec(`git check-ignore -q "${filePath}"`, { cwd: workspaceRoot }, (error) => {
            // Exit code 0 = file is ignored, exit code 1 = file is not ignored
            resolve(error === null);
        });
    });
}
// Masque un secret pour l'affichage
function maskSecret(secret) {
    if (secret.length <= 8) {
        return "*".repeat(secret.length);
    }
    const visibleChars = Math.min(4, Math.floor(secret.length / 4));
    return secret.slice(0, visibleChars) + "..." + "*".repeat(8);
}
// Trouve les secrets dans un contenu
function findSecretsInContent(content) {
    const matches = [];
    const lines = content.split(/\r?\n/);
    for (const secretPattern of SECRET_PATTERNS) {
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            const line = lines[lineIndex];
            // Ignorer les lignes qui sont des définitions de patterns (faux positifs)
            if (isPatternDefinition(line)) {
                continue;
            }
            // Clone le pattern pour réinitialiser lastIndex
            const pattern = new RegExp(secretPattern.pattern.source, secretPattern.pattern.flags);
            let match;
            while ((match = pattern.exec(line)) !== null) {
                matches.push({
                    patternName: secretPattern.name,
                    description: secretPattern.description,
                    line: lineIndex + 1,
                    column: match.index + 1,
                    preview: maskSecret(match[0]),
                });
            }
        }
    }
    return matches;
}
class SecretScanner {
    constructor(statusBarItem) {
        this.scanState = {
            files: new Map(),
            isScanning: false,
            lastScanTime: null,
        };
        this.statusBarItem = statusBarItem;
    }
    setWorkspace(root) {
        this.workspaceRoot = root;
        this.scanState.files.clear();
        this.updateStatusBar("idle");
    }
    async fullScan() {
        if (!this.workspaceRoot || this.scanState.isScanning) {
            return;
        }
        this.scanState.isScanning = true;
        this.updateStatusBar("scanning");
        try {
            await this.scanDirectory(this.workspaceRoot);
            this.scanState.lastScanTime = new Date();
        }
        finally {
            this.scanState.isScanning = false;
            this.updateStatusBar("complete");
        }
    }
    async scanDirectory(dirPath) {
        const dirName = path.basename(dirPath);
        if (SKIP_DIRECTORIES.has(dirName)) {
            return;
        }
        let entries;
        try {
            entries = await fs.readdir(dirPath, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const entryPath = path.join(dirPath, entry.name);
            if (entry.isSymbolicLink()) {
                continue;
            }
            if (entry.isDirectory()) {
                await this.scanDirectory(entryPath);
            }
            else if (entry.isFile()) {
                await this.scanFile(entryPath);
            }
        }
    }
    async scanFile(filePath) {
        if (!this.workspaceRoot) {
            return;
        }
        // Ignorer certains fichiers (faux positifs)
        if (shouldSkipFile(filePath)) {
            return;
        }
        // Vérifier si le fichier est ignoré par git
        const isIgnored = await isFileGitIgnored(filePath, this.workspaceRoot);
        if (isIgnored) {
            this.scanState.files.delete(filePath);
            this.updateStatusBar("complete");
            return;
        }
        // Ignorer les fichiers trop volumineux (> 1MB)
        try {
            const stat = await fs.stat(filePath);
            if (stat.size > 1024 * 1024) {
                return;
            }
        }
        catch {
            return;
        }
        try {
            const content = await fs.readFile(filePath, "utf8");
            const matches = findSecretsInContent(content);
            if (matches.length > 0) {
                const relativePath = path.relative(this.workspaceRoot, filePath);
                this.scanState.files.set(filePath, {
                    filePath,
                    relativePath,
                    matches,
                });
            }
            else {
                this.scanState.files.delete(filePath);
            }
        }
        catch {
            // Impossible de lire le fichier (binaire, permissions, etc.)
        }
        this.updateStatusBar("complete");
    }
    removeFile(filePath) {
        this.scanState.files.delete(filePath);
        this.updateStatusBar("complete");
    }
    updateStatusBar(state) {
        const fileCount = this.scanState.files.size;
        const totalMatches = Array.from(this.scanState.files.values()).reduce((sum, file) => sum + file.matches.length, 0);
        if (state === "scanning") {
            this.statusBarItem.text = "$(sync~spin) Secrets...";
            this.statusBarItem.backgroundColor = undefined;
            this.statusBarItem.color = undefined;
            this.statusBarItem.tooltip = "Scan des secrets en cours...";
        }
        else if (state === "idle" || fileCount === 0) {
            this.statusBarItem.text = "$(shield) Secrets: OK";
            this.statusBarItem.backgroundColor = undefined;
            this.statusBarItem.color = new vscode.ThemeColor("charts.green");
            this.statusBarItem.tooltip = "Aucun secret exposé détecté";
        }
        else {
            // Secrets détectés = ALERTE VISIBLE
            this.statusBarItem.text = `🔴 SECRETS: ${totalMatches} 🔴`;
            this.statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
            this.statusBarItem.color = new vscode.ThemeColor("errorForeground");
            this.statusBarItem.tooltip = `⚠️ ${totalMatches} secret(s) exposé(s) dans ${fileCount} fichier(s) - CLIQUEZ POUR VOIR`;
        }
    }
    getResults() {
        return Array.from(this.scanState.files.values());
    }
    getFileCount() {
        return this.scanState.files.size;
    }
    isScanning() {
        return this.scanState.isScanning;
    }
}
// Affiche la liste des secrets détectés
async function showSecretsQuickPick(scanner) {
    const results = scanner.getResults();
    if (results.length === 0) {
        vscode.window.showInformationMessage("Aucun secret exposé détecté.");
        return;
    }
    const items = [];
    for (const fileResult of results) {
        for (const match of fileResult.matches) {
            items.push({
                label: `$(warning) ${match.patternName}`,
                description: fileResult.relativePath,
                detail: `Ligne ${match.line}: ${match.preview}`,
                filePath: fileResult.filePath,
                line: match.line,
            });
        }
    }
    const selection = await vscode.window.showQuickPick(items, {
        placeHolder: `${items.length} secret(s) exposé(s) - Cliquez pour ouvrir le fichier`,
        matchOnDescription: true,
        matchOnDetail: true,
    });
    if (selection) {
        const document = await vscode.workspace.openTextDocument(selection.filePath);
        const editor = await vscode.window.showTextDocument(document);
        const position = new vscode.Position(selection.line - 1, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }
}
// ═══════════════════════════════════════════════════════════════════════════════
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

    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      width: 100%;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    body {
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      background: var(--vscode-sideBar-background);
      color: var(--vscode-foreground);
    }

    .container {
      height: 100%;
      width: 100%;
      padding: 8px;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--vscode-sideBar-background);
    }

    .icon {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
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
  <div class="container">${bodyContent}</div>
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
const TITLEBAR_COLOR_PALETTE = [
    "#D62828", // red
    "#F77F00", // orange
    "#FCBF49", // amber
    "#F4A261", // peach
    "#E9C46A", // sand
    "#2A9D8F", // teal
    "#264653", // deep teal
    "#1D3557", // navy
    "#457B9D", // blue
    "#1D4ED8", // cobalt
    "#4CC9F0", // sky
    "#06B6D4", // cyan
    "#10B981", // green
    "#22C55E", // bright green
    "#65A30D", // olive
    "#84CC16", // lime
    "#6D597A", // purple
    "#7C3AED", // violet
    "#C026D3", // magenta
    "#E11D48", // rose
    "#EF4444", // coral red
    "#F97316", // vivid orange
    "#F59E0B", // gold
    "#14B8A6", // teal bright
    "#0EA5E9", // azure
    "#2563EB", // blue bright
    "#0F766E", // deep teal
    "#7F5539", // brown
    "#374151", // slate
    "#111827" // near-black
];
function pickRandom(items) {
    return items[Math.floor(Math.random() * items.length)];
}
function getTitlebarColorHistory(context) {
    const raw = context.workspaceState.get(WORKSPACE_TITLEBAR_COLOR_HISTORY_KEY);
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.filter((v) => typeof v === "string");
}
async function pickNextTitlebarColor(context) {
    const history = getTitlebarColorHistory(context);
    const recent = new Set(history.slice(0, 10).map((c) => c.toLowerCase()));
    const candidates = TITLEBAR_COLOR_PALETTE.filter((c) => !recent.has(c.toLowerCase()));
    const next = pickRandom(candidates.length ? candidates : TITLEBAR_COLOR_PALETTE);
    const nextHistory = [next, ...history.filter((c) => c.toLowerCase() !== next.toLowerCase())].slice(0, 25);
    await context.workspaceState.update(WORKSPACE_TITLEBAR_COLOR_HISTORY_KEY, nextHistory);
    return next;
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
// ═══════════════════════════════════════════════════════════════════════════════
// PRE-COMMIT SECRET CHECK
// ═══════════════════════════════════════════════════════════════════════════════
async function getGitApi() {
    const gitExtension = vscode.extensions.getExtension("vscode.git");
    if (!gitExtension) {
        return null;
    }
    return gitExtension.isActive
        ? gitExtension.exports.getAPI(1)
        : (await gitExtension.activate()).getAPI(1);
}
async function scanStagedFilesForSecrets() {
    const gitApi = await getGitApi();
    if (!gitApi || gitApi.repositories.length === 0) {
        return { hasSecrets: false, files: [], workspaceRoot: undefined };
    }
    const repo = gitApi.repositories[0];
    const workspaceRoot = repo.rootUri.fsPath;
    const stagedChanges = repo.state.indexChanges;
    if (!stagedChanges || stagedChanges.length === 0) {
        return { hasSecrets: false, files: [], workspaceRoot };
    }
    const filesWithSecrets = [];
    for (const change of stagedChanges) {
        const filePath = change.uri.fsPath;
        // Ignorer certains fichiers
        if (shouldSkipFile(filePath)) {
            continue;
        }
        // Ignorer les fichiers trop volumineux
        try {
            const stat = await fs.stat(filePath);
            if (stat.size > 1024 * 1024) {
                continue;
            }
        }
        catch {
            continue;
        }
        try {
            const content = await fs.readFile(filePath, "utf8");
            const secrets = findSecretsInContent(content);
            if (secrets.length > 0) {
                filesWithSecrets.push({
                    filePath,
                    relativePath: path.relative(workspaceRoot, filePath),
                    secrets,
                });
            }
        }
        catch {
            // Fichier illisible (binaire, permissions, etc.)
        }
    }
    return {
        hasSecrets: filesWithSecrets.length > 0,
        files: filesWithSecrets,
        workspaceRoot,
    };
}
async function addFilesToGitignore(workspaceRoot, filePaths) {
    const gitignorePath = path.join(workspaceRoot, ".gitignore");
    let existingContent = "";
    try {
        existingContent = await fs.readFile(gitignorePath, "utf8");
    }
    catch {
        // Le fichier n'existe pas, on va le créer
    }
    const existingLines = new Set(existingContent.split(/\r?\n/).map((line) => line.trim()));
    const newEntries = [];
    for (const filePath of filePaths) {
        const relativePath = path.relative(workspaceRoot, filePath);
        if (!existingLines.has(relativePath)) {
            newEntries.push(relativePath);
        }
    }
    if (newEntries.length === 0) {
        return;
    }
    const separator = existingContent.endsWith("\n") || existingContent === "" ? "" : "\n";
    const comment = existingContent === "" ? "" : "\n# Fichiers avec secrets (ajoutés automatiquement)\n";
    const newContent = existingContent + separator + comment + newEntries.join("\n") + "\n";
    await fs.writeFile(gitignorePath, newContent, "utf8");
}
async function unstageFiles(filePaths) {
    for (const filePath of filePaths) {
        try {
            await new Promise((resolve, reject) => {
                cp.exec(`git reset HEAD "${filePath}"`, (error) => {
                    if (error) {
                        reject(error);
                    }
                    else {
                        resolve();
                    }
                });
            });
        }
        catch {
            // Ignorer les erreurs d'unstage
        }
    }
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
        color = await pickNextTitlebarColor(context);
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
async function getGitRepoRootsFromGitApi() {
    const gitExtension = vscode.extensions.getExtension("vscode.git");
    if (!gitExtension) {
        return [];
    }
    const gitApi = gitExtension.isActive
        ? gitExtension.exports.getAPI(1)
        : (await gitExtension.activate()).getAPI(1);
    return gitApi.repositories.map((repo) => ({
        label: path.basename(repo.rootUri.fsPath),
        rootUri: repo.rootUri
    }));
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
    const launchpadProvider = new LaunchpadWebviewProvider(context);
    const notesProvider = new ProjectNotesViewProvider();
    const agentHistoryProvider = new AgentHistoryProvider(context);
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
        // Keep Launchpad ordering "most recent first" even when the workspace
        // was opened outside of the Launchpad UI (File > Open..., recent, etc.).
        await recordLaunchpadOpen(workspaceRoot);
        await ensureWorkspaceTitlebarColor(context);
        watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceRoot, "icon.*"));
        watcher.onDidCreate(() => provider.refresh());
        watcher.onDidChange(() => provider.refresh());
        watcher.onDidDelete(() => provider.refresh());
        context.subscriptions.push(watcher);
    };
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, provider));
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(EXTENSION_TAGS_VIEW_ID, categoriesProvider));
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(LAUNCHPAD_EXPLORER_VIEW_ID, launchpadProvider));
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(PROJECT_NOTES_VIEW_ID, notesProvider));
    context.subscriptions.push(vscode.window.registerTreeDataProvider("agentHistoryView", agentHistoryProvider));
    // Auto-import Codex sessions from ~/.codex/history.jsonl so sessions created
    // in any terminal show up in Agent History.
    const codexImportInterval = setInterval(() => {
        void importCodexSessionsFromHistory(context, agentHistoryProvider);
    }, 4000);
    context.subscriptions.push({ dispose: () => clearInterval(codexImportInterval) });
    void importCodexSessionsFromHistory(context, agentHistoryProvider);
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
    // Secrets Detection Status Bar Item
    const secretsItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
    secretsItem.text = "$(shield) Secrets: --";
    secretsItem.tooltip = "Détection des secrets exposés";
    secretsItem.command = "pkvsconf.showExposedSecrets";
    secretsItem.show();
    // Agent Skills Status Bar Item
    const skillsSymlinkItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 96);
    skillsSymlinkItem.text = "$(link) Agent Skills";
    skillsSymlinkItem.tooltip = "Créer un lien symbolique .agent vers le dossier -agent";
    skillsSymlinkItem.command = "pkvsconf.createSkillsSymlink";
    skillsSymlinkItem.show();
    const launchpadItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 95);
    launchpadItem.text = "$(rocket) Launchpad";
    launchpadItem.tooltip = "Ouvrir le Launchpad projets";
    launchpadItem.command = "pkvsconf.launchpadOpen";
    launchpadItem.show();
    const secretScanner = new SecretScanner(secretsItem);
    let secretsWatcher;
    const initSecretScanner = async () => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        secretScanner.setWorkspace(workspaceFolder?.uri.fsPath);
        if (workspaceFolder) {
            await secretScanner.fullScan();
        }
    };
    const setupSecretsWatcher = () => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (secretsWatcher) {
            secretsWatcher.dispose();
            secretsWatcher = undefined;
        }
        if (!workspaceFolder) {
            return;
        }
        secretsWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceFolder, "**/*"));
        secretsWatcher.onDidCreate(async (uri) => {
            await secretScanner.scanFile(uri.fsPath);
        });
        secretsWatcher.onDidChange(async (uri) => {
            await secretScanner.scanFile(uri.fsPath);
        });
        secretsWatcher.onDidDelete((uri) => {
            secretScanner.removeFile(uri.fsPath);
        });
        context.subscriptions.push(secretsWatcher);
    };
    // Initialiser le scanner de secrets
    void initSecretScanner();
    setupSecretsWatcher();
    // Réagir aux changements de workspace pour les secrets
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(async () => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        secretScanner.setWorkspace(workspaceFolder?.uri.fsPath);
        setupSecretsWatcher();
        if (workspaceFolder) {
            await secretScanner.fullScan();
        }
    }));
    // ═══════════════════════════════════════════════════════════════════════════════
    // SURVEILLANCE AUTOMATIQUE DES FICHIERS STAGED
    // ═══════════════════════════════════════════════════════════════════════════════
    let lastStagedSecretsWarning = 0;
    const STAGED_WARNING_COOLDOWN = 5000; // 5 secondes entre les warnings
    const checkStagedFilesForSecretsAutomatically = async () => {
        const now = Date.now();
        if (now - lastStagedSecretsWarning < STAGED_WARNING_COOLDOWN) {
            return; // Éviter le spam de warnings
        }
        const result = await scanStagedFilesForSecrets();
        if (result.hasSecrets && result.files.length > 0) {
            lastStagedSecretsWarning = now;
            const totalSecrets = result.files.reduce((sum, file) => sum + file.secrets.length, 0);
            const fileList = result.files
                .map((f) => f.relativePath)
                .slice(0, 3)
                .join(", ");
            const moreFiles = result.files.length > 3 ? ` (+${result.files.length - 3} autres)` : "";
            const choice = await vscode.window.showWarningMessage(`🔐 ${totalSecrets} secret(s) détecté(s) dans les fichiers staged : ${fileList}${moreFiles}`, "Voir les secrets", "Ajouter au .gitignore", "Ignorer");
            if (choice === "Voir les secrets") {
                const firstFile = result.files[0];
                const document = await vscode.workspace.openTextDocument(firstFile.filePath);
                const editor = await vscode.window.showTextDocument(document);
                const firstSecret = firstFile.secrets[0];
                const position = new vscode.Position(firstSecret.line - 1, firstSecret.column - 1);
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
            }
            else if (choice === "Ajouter au .gitignore" && result.workspaceRoot) {
                const filePaths = result.files.map((f) => f.filePath);
                await addFilesToGitignore(result.workspaceRoot, filePaths);
                await unstageFiles(filePaths);
                await secretScanner.fullScan();
                vscode.window.showInformationMessage(`${result.files.length} fichier(s) ajouté(s) au .gitignore et retiré(s) du staging.`);
            }
        }
    };
    // Surveiller les changements du repository Git
    const setupGitStagingWatcher = async () => {
        const gitApi = await getGitApi();
        if (!gitApi) {
            return;
        }
        // Surveiller chaque repository
        for (const repo of gitApi.repositories) {
            // L'API Git expose onDidChange sur le state
            if (repo.state && typeof repo.state.onDidChange === "function") {
                const disposable = repo.state.onDidChange(() => {
                    void checkStagedFilesForSecretsAutomatically();
                });
                context.subscriptions.push(disposable);
            }
        }
        // Surveiller les nouveaux repositories
        gitApi.onDidOpenRepository((repo) => {
            if (repo.state && typeof repo.state.onDidChange === "function") {
                const disposable = repo.state.onDidChange(() => {
                    void checkStagedFilesForSecretsAutomatically();
                });
                context.subscriptions.push(disposable);
            }
        });
    };
    // Initialiser la surveillance Git après un délai (laisser le temps à l'API Git de se charger)
    setTimeout(() => {
        void setupGitStagingWatcher();
    }, 2000);
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
    async function refreshLaunchpadViews() {
        await launchpadProvider.refreshCurrentView();
    }
    const launchpadOpenCmd = vscode.commands.registerCommand("pkvsconf.launchpadOpen", async (project) => {
        if (project) {
            await openProjectInNewWindow(project.path);
            return;
        }
        await openLaunchpadQuickPick();
    });
    const launchpadAddCmd = vscode.commands.registerCommand("pkvsconf.launchpadAddCurrent", async () => {
        await addCurrentWorkspaceToLaunchpad();
        await refreshLaunchpadViews();
    });
    const launchpadAddFolderCmd = vscode.commands.registerCommand("pkvsconf.launchpadAddFolder", async () => {
        await addFolderToLaunchpad();
        await refreshLaunchpadViews();
    });
    const launchpadToggleViewModeCmd = vscode.commands.registerCommand("pkvsconf.launchpadToggleViewMode", async () => {
        const nextMode = getLaunchpadViewMode() === "mini" ? "grid" : "mini";
        await setLaunchpadViewMode(nextMode);
        await refreshLaunchpadViews();
    });
    const launchpadRevealCmd = vscode.commands.registerCommand("pkvsconf.launchpadRevealInFinder", async (project) => {
        await revealProjectInFinder(project);
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
        let uri = activeEditorUri ?? activeTabUri;
        if (!uri) {
            // If there's no active editor (e.g. focus is in Explorer), prefer the Git repo root(s)
            // because workspace root can be a parent folder (like ~/Documents/GitHub).
            const repos = await getGitRepoRootsFromGitApi();
            if (repos.length === 1) {
                uri = repos[0].rootUri;
            }
            else if (repos.length > 1) {
                const pick = await vscode.window.showQuickPick(repos.map((r) => ({ label: r.label, description: r.rootUri.fsPath, repo: r })), { placeHolder: "Reveal which repository?" });
                uri = pick?.repo.rootUri;
            }
        }
        if (!uri) {
            const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
            if (workspaceFolders.length === 1) {
                uri = workspaceFolders[0].uri;
            }
            else if (workspaceFolders.length > 1) {
                const pick = await vscode.window.showQuickPick(workspaceFolders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })), { placeHolder: "Reveal which workspace folder?" });
                uri = pick?.folder.uri;
            }
        }
        if (!uri) {
            vscode.window.showInformationMessage("No active file or workspace folder to reveal.");
            return;
        }
        if (uri.scheme !== "file") {
            vscode.window.showWarningMessage("Reveal in Finder: cible non-fichier.");
            return;
        }
        try {
            const stat = await fs.stat(uri.fsPath);
            await new Promise((resolve, reject) => {
                const args = stat.isDirectory() ? [uri.fsPath] : ["-R", uri.fsPath];
                cp.execFile("/usr/bin/open", args, (error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });
        }
        catch (error) {
            vscode.window.showErrorMessage(`Reveal in Finder impossible: ${error}`);
        }
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
    const codexCaptureResumeCmd = vscode.commands.registerCommand("pkvsconf.codexCaptureResume", async () => {
        const clipboard = await vscode.env.clipboard.readText();
        const command = extractCodexResumeCommand(clipboard);
        if (!command) {
            vscode.window.showWarningMessage('Presse-papiers invalide. Copiez quelque chose comme "codex resume xxx" puis relancez la commande.');
            return;
        }
        const saved = await addCodexResumeEntry(context, {
            command,
            createdAt: Date.now()
        });
        await upsertAgentHistoryEntry(context, {
            provider: "codex",
            command: saved.command,
            createdAt: Date.now()
        });
        await vscode.env.clipboard.writeText(saved.command);
        vscode.window.showInformationMessage(`Saved: ${saved.command}`);
    });
    const codexSaveResumeCmd = vscode.commands.registerCommand("pkvsconf.codexSaveResume", async () => {
        const input = await vscode.window.showInputBox({
            title: "Save Codex resume",
            prompt: 'Collez "codex resume xxx" (ou juste le token)',
            placeHolder: "codex resume xxx"
        });
        if (input === undefined)
            return;
        const command = extractCodexResumeCommand(input);
        if (!command) {
            vscode.window.showWarningMessage('Entrée invalide. Attendu: "codex resume <id>" ou "<id>".');
            return;
        }
        const label = await vscode.window.showInputBox({
            title: "Label (optionnel)",
            prompt: "Ex: nom du repo / objectif",
            placeHolder: "debug-auth",
            value: ""
        });
        if (label === undefined)
            return;
        const saved = await addCodexResumeEntry(context, {
            command,
            label: label.trim() || undefined,
            createdAt: Date.now()
        });
        await upsertAgentHistoryEntry(context, {
            provider: "codex",
            command: saved.command,
            label: saved.label,
            createdAt: Date.now()
        });
        await vscode.env.clipboard.writeText(saved.command);
        vscode.window.showInformationMessage(`Saved: ${saved.command}`);
    });
    const codexPickResumeCmd = vscode.commands.registerCommand("pkvsconf.codexPickResume", async () => {
        const entries = getCodexResumeEntries(context);
        if (!entries.length) {
            vscode.window.showInformationMessage("Aucun resume Codex sauvegardé.");
            return;
        }
        const pick = await vscode.window.showQuickPick(entries.map((e) => {
            const when = new Date(e.createdAt).toLocaleString();
            return {
                label: e.label ? e.label : e.command,
                description: e.label ? e.command : undefined,
                detail: when,
                entry: e
            };
        }), { placeHolder: "Choisir un resume Codex (copie dans le presse-papiers)" });
        if (!pick?.entry)
            return;
        await vscode.env.clipboard.writeText(pick.entry.command);
        vscode.window.showInformationMessage(`Copied: ${pick.entry.command}`);
    });
    const agentHistoryAddFromClipboardCmd = vscode.commands.registerCommand("pkvsconf.agentHistoryAddFromClipboard", async () => {
        const clipboard = (await vscode.env.clipboard.readText()).trim();
        if (!clipboard) {
            vscode.window.showWarningMessage("Presse-papiers vide.");
            return;
        }
        const provider = inferProviderFromCommand(clipboard);
        const command = clipboard;
        const label = await vscode.window.showInputBox({
            title: "Agent History",
            prompt: "Label (optionnel)",
            placeHolder: "objectif / repo / note",
            value: ""
        });
        if (label === undefined)
            return;
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        await upsertAgentHistoryEntry(context, {
            provider,
            command,
            cwd: wsRoot,
            label: label.trim() || undefined,
            createdAt: Date.now()
        });
        agentHistoryProvider.refresh();
        vscode.window.showInformationMessage("Ajouté à l'historique.");
    });
    const agentHistoryRunCmd = vscode.commands.registerCommand("pkvsconf.agentHistoryRun", async (entry) => {
        const entries = getAgentHistoryEntries(context);
        const target = entry ?? (await vscode.window.showQuickPick(entries.map((e) => ({
            label: e.label ? e.label : e.command,
            description: `${e.provider}${e.cwd ? ` • ${e.cwd}` : ""}`,
            entry: e
        })), { placeHolder: "Lancer quelle session ?" }))?.entry;
        if (!target)
            return;
        const cwd = target.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const term = vscode.window.createTerminal({
            name: target.label ? `${target.provider}: ${target.label}` : `${target.provider}: agent`,
            cwd
        });
        term.show(true);
        term.sendText(target.command, true);
        await upsertAgentHistoryEntry(context, {
            provider: target.provider,
            command: target.command,
            cwd: target.cwd,
            label: target.label,
            createdAt: target.createdAt,
            lastRunAt: Date.now()
        });
        agentHistoryProvider.refresh();
    });
    const agentHistoryClearCmd = vscode.commands.registerCommand("pkvsconf.agentHistoryClear", async () => {
        const choice = await vscode.window.showWarningMessage("Vider tout l'historique Agent ?", "Vider", "Annuler");
        if (choice !== "Vider")
            return;
        await context.globalState.update(AGENT_HISTORY_STORAGE_KEY, []);
        agentHistoryProvider.refresh();
    });
    const codexPickRecentSessionCmd = vscode.commands.registerCommand("pkvsconf.codexPickRecentSession", async () => {
        const sessions = await readCodexSessionIndex();
        if (!sessions.length) {
            vscode.window.showInformationMessage("Aucune session Codex trouvée dans ~/.codex/session_index.jsonl.");
            return;
        }
        const pick = await vscode.window.showQuickPick(sessions.slice(0, 200).map((s) => {
            const when = s.updated_at ? new Date(s.updated_at).toLocaleString() : "";
            const title = s.thread_name?.trim() || "(sans titre)";
            return {
                label: title,
                description: when,
                detail: s.id,
                session: s
            };
        }), { placeHolder: "Choisir une session Codex récente (copie `codex resume <id>`)" });
        if (!pick?.session)
            return;
        const cmdToCopy = `codex resume ${pick.session.id}`;
        await vscode.env.clipboard.writeText(cmdToCopy);
        vscode.window.showInformationMessage(`Copié: ${cmdToCopy}`);
    });
    const codexSuggestSessionCmd = vscode.commands.registerCommand("pkvsconf.codexSuggestSession", async () => {
        const wsName = vscode.workspace.workspaceFolders?.[0]
            ? path.basename(vscode.workspace.workspaceFolders[0].uri.fsPath)
            : "";
        const query = await vscode.window.showInputBox({
            title: "Codex: retrouver la bonne session",
            prompt: "Mots-clés (repo, feature, erreur, fichier...)",
            value: wsName,
            placeHolder: "Ex: pkvsconf seeds resume session"
        });
        if (query === undefined)
            return;
        const results = await suggestCodexSessions(query);
        if (!results.length) {
            vscode.window.showInformationMessage("Aucune session trouvée via le transcript Codex.");
            return;
        }
        const pick = await vscode.window.showQuickPick(results.map((r) => {
            const when = r.updatedAt ? new Date(r.updatedAt).toLocaleString() : "";
            const title = r.threadName?.trim() || "(sans titre)";
            return {
                label: `${title}`,
                description: `score ${r.score}${when ? ` • ${when}` : ""}`,
                detail: r.id,
                id: r.id
            };
        }), { placeHolder: "Suggestion de session (copie `codex resume <id>`)" });
        if (!pick?.id)
            return;
        const cmdToCopy = `codex resume ${pick.id}`;
        await vscode.env.clipboard.writeText(cmdToCopy);
        vscode.window.showInformationMessage(`Copié: ${cmdToCopy}`);
    });
    const regenerateTitlebarColorCmd = vscode.commands.registerCommand("pkvsconf.regenerateWorkspaceTitlebarColor", async () => {
        await ensureWorkspaceTitlebarColor(context, true);
    });
    // Commandes pour la détection de secrets
    const showSecretsCmd = vscode.commands.registerCommand("pkvsconf.showExposedSecrets", () => showSecretsQuickPick(secretScanner));
    const rescanSecretsCmd = vscode.commands.registerCommand("pkvsconf.rescanSecrets", () => secretScanner.fullScan());
    // Commande de commit avec vérification des secrets
    const commitWithSecretCheckCmd = vscode.commands.registerCommand("pkvsconf.commitWithSecretCheck", async () => {
        const result = await scanStagedFilesForSecrets();
        if (!result.workspaceRoot) {
            vscode.window.showWarningMessage("Aucun repository Git trouvé.");
            return;
        }
        if (result.files.length === 0) {
            // Pas de secrets, on peut commit normalement
            await vscode.commands.executeCommand("git.commit");
            return;
        }
        // Secrets détectés - afficher le warning modal
        const totalSecrets = result.files.reduce((sum, file) => sum + file.secrets.length, 0);
        const fileList = result.files
            .map((f) => {
            const secretTypes = [...new Set(f.secrets.map((s) => s.patternName))].join(", ");
            return `• ${f.relativePath} (${secretTypes})`;
        })
            .join("\n");
        const message = `⚠️ ${totalSecrets} secret(s) détecté(s) dans ${result.files.length} fichier(s) staged !\n\n${fileList}`;
        const choice = await vscode.window.showWarningMessage(message, { modal: true }, "Voir les secrets", "Ajouter au .gitignore", "Commit quand même");
        if (choice === "Voir les secrets") {
            // Ouvrir le premier fichier avec des secrets
            const firstFile = result.files[0];
            const document = await vscode.workspace.openTextDocument(firstFile.filePath);
            const editor = await vscode.window.showTextDocument(document);
            const firstSecret = firstFile.secrets[0];
            const position = new vscode.Position(firstSecret.line - 1, firstSecret.column - 1);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        }
        else if (choice === "Ajouter au .gitignore") {
            const filePaths = result.files.map((f) => f.filePath);
            await addFilesToGitignore(result.workspaceRoot, filePaths);
            await unstageFiles(filePaths);
            // Rescanner les secrets après modification du gitignore
            await secretScanner.fullScan();
            vscode.window.showInformationMessage(`${result.files.length} fichier(s) ajouté(s) au .gitignore et retiré(s) du staging.`);
        }
        else if (choice === "Commit quand même") {
            await vscode.commands.executeCommand("git.commit");
        }
        // Si annulé (undefined), on ne fait rien
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
    // ═══════════════════════════════════════════════════════════════════════════════
    // AGENT SKILLS SYMLINK - Create symlink to central agent folder
    // ═══════════════════════════════════════════════════════════════════════════════
    const createSkillsSymlinkCmd = vscode.commands.registerCommand("pkvsconf.createSkillsSymlink", async () => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage("Aucun workspace ouvert.");
            return;
        }
        const workspaceRoot = workspaceFolder.uri.fsPath;
        const username = process.env.USER || process.env.USERNAME || "clm";
        const sourcePath = `/Users/${username}/Documents/GitHub/-agent`;
        const targetPath = path.join(workspaceRoot, ".agent");
        const gitignorePath = path.join(workspaceRoot, ".gitignore");
        const gitignoreEntries = [
            ".agent",
            "/AGENT.md",
            "/AGENTS.md",
            "/CLAUDE.md",
            "/CODEX.md",
            "/GEMINI.md",
            "/GLM.md",
            "/OPENCODE.md"
        ];
        const ensureGitignoreHasSkills = async () => {
            try {
                const existing = await fs.readFile(gitignorePath, "utf8");
                const existingLines = existing.split(/\r?\n/).map((l) => l.trim());
                const missing = gitignoreEntries.filter((e) => {
                    if (e === ".agent") {
                        return !existingLines.includes(".agent") && !existingLines.includes(".agent/");
                    }
                    return !existingLines.includes(e);
                });
                if (missing.length) {
                    const needsNewline = existing.length > 0 && !existing.endsWith("\n");
                    const updated = `${existing}${needsNewline ? "\n" : ""}${missing.join("\n")}\n`;
                    await fs.writeFile(gitignorePath, updated, "utf8");
                }
            }
            catch (error) {
                if (error.code === "ENOENT") {
                    await fs.writeFile(gitignorePath, `${gitignoreEntries.join("\n")}\n`, "utf8");
                }
                else {
                    throw error;
                }
            }
        };
        let symlinkCreated = false;
        let symlinkUpdated = false;
        let symlinkSkipped = false;
        let agentFilesLinked = false;
        // Vérifier si le symlink existe déjà et s'il pointe vers la bonne cible
        try {
            const targetStats = await fs.lstat(targetPath);
            if (!targetStats.isSymbolicLink()) {
                // Keep existing local .agent folder and still try running linker script from workspace.
                symlinkSkipped = true;
            }
            else {
                const existingLinkTarget = await fs.readlink(targetPath);
                if (existingLinkTarget !== sourcePath) {
                    await fs.unlink(targetPath);
                    await fs.symlink(sourcePath, targetPath, "dir");
                    symlinkUpdated = true;
                }
            }
        }
        catch (error) {
            if (error.code !== "ENOENT") {
                vscode.window.showErrorMessage(`Erreur lors de la vérification du lien symbolique: ${error}`);
                return;
            }
            // Créer le symlink
            try {
                await fs.symlink(sourcePath, targetPath, "dir");
                symlinkCreated = true;
            }
            catch (symlinkError) {
                vscode.window.showErrorMessage(`Erreur lors de la création du lien symbolique: ${symlinkError}`);
                return;
            }
        }
        try {
            await ensureGitignoreHasSkills();
        }
        catch (error) {
            vscode.window.showErrorMessage(`Erreur lors de la mise à jour du .gitignore: ${error}`);
            return;
        }
        // Link root-level agent instruction files without touching AGENTS.md (tracked in repo).
        try {
            const filesToLink = ["AGENT.md", "CLAUDE.md", "CODEX.md", "GEMINI.md", "GLM.md", "OPENCODE.md"];
            for (const filename of filesToLink) {
                const src = path.join(workspaceRoot, ".agent", "agents", filename);
                const dst = path.join(workspaceRoot, filename);
                try {
                    await fs.access(src);
                }
                catch {
                    continue;
                }
                try {
                    const st = await fs.lstat(dst);
                    if (st.isSymbolicLink()) {
                        const currentTarget = await fs.readlink(dst);
                        if (currentTarget === `.agent/agents/${filename}`) {
                            continue;
                        }
                        await fs.unlink(dst);
                    }
                    else {
                        // Don't overwrite real files (including AGENTS.md).
                        continue;
                    }
                }
                catch (error) {
                    if (error.code !== "ENOENT") {
                        continue;
                    }
                }
                await fs.symlink(`.agent/agents/${filename}`, dst);
            }
            agentFilesLinked = true;
        }
        catch (error) {
            vscode.window.showWarningMessage(`Link des fichiers agent en racine impossible: ${error}`);
        }
        const symlinkStatus = symlinkCreated
            ? "Lien symbolique '.agent' créé"
            : symlinkUpdated
                ? "Lien symbolique '.agent' mis à jour"
                : symlinkSkipped
                    ? "Dossier '.agent' local conservé (pas de symlink)"
                    : "Lien symbolique '.agent' déjà présent";
        if (agentFilesLinked) {
            vscode.window.showInformationMessage(`${symlinkStatus}, .gitignore mis à jour, et fichiers AGENT/LLM linkés.`);
        }
        else {
            vscode.window.showInformationMessage(`${symlinkStatus}, .gitignore mis à jour.`);
        }
    });
    const terminalSplitRightCmd = vscode.commands.registerCommand("pkvsconf.terminalSplitRight", async () => {
        await vscode.commands.executeCommand("workbench.action.terminal.split");
    });
    const terminalNewTabCmd = vscode.commands.registerCommand("pkvsconf.terminalNewTab", async () => {
        await vscode.commands.executeCommand("workbench.action.createTerminalEditor");
    });
    const terminalSplitBottomCmd = vscode.commands.registerCommand("pkvsconf.terminalSplitBottom", async () => {
        // VS Code can't split a *single* terminal buffer vertically like tmux.
        // Crée un terminal dans un panneau en dessous
        await vscode.commands.executeCommand("workbench.action.terminal.newInActiveGroup");
    });
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
    }), terminalSplitRightCmd, terminalNewTabCmd, terminalSplitBottomCmd);
}
function deactivate() { }
//# sourceMappingURL=extension.js.map