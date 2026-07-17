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
const kanban_1 = require("./kanban");
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
const LAUNCHPAD_LAYOUT_DEFAULTS = {
    columns: 8,
    rows: 4,
    iconSize: 76,
    focusColor: "#008CFF",
    theme: "sleek"
};
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
function getLaunchpadLayoutSettings() {
    const cfg = vscode.workspace.getConfiguration("pkvsconf");
    return {
        columns: clampNumber(cfg.get("launchpad.columns") ?? LAUNCHPAD_LAYOUT_DEFAULTS.columns, 3, 16),
        rows: clampNumber(cfg.get("launchpad.rows") ?? LAUNCHPAD_LAYOUT_DEFAULTS.rows, 2, 10),
        iconSize: clampNumber(cfg.get("launchpad.iconSize") ?? LAUNCHPAD_LAYOUT_DEFAULTS.iconSize, 42, 128),
        focusColor: normalizeCssHexColor(cfg.get("launchpad.focusColor") ?? LAUNCHPAD_LAYOUT_DEFAULTS.focusColor, LAUNCHPAD_LAYOUT_DEFAULTS.focusColor),
        theme: getLaunchpadTheme(),
        restorePanels: getLaunchpadRestorePanels()
    };
}
async function setLaunchpadLayoutSettings(settings) {
    const cfg = vscode.workspace.getConfiguration("pkvsconf");
    if (typeof settings.columns === "number") {
        await cfg.update("launchpad.columns", clampNumber(settings.columns, 3, 16), vscode.ConfigurationTarget.Global);
    }
    if (typeof settings.rows === "number") {
        await cfg.update("launchpad.rows", clampNumber(settings.rows, 2, 10), vscode.ConfigurationTarget.Global);
    }
    if (typeof settings.iconSize === "number") {
        await cfg.update("launchpad.iconSize", clampNumber(settings.iconSize, 42, 128), vscode.ConfigurationTarget.Global);
    }
    if (typeof settings.focusColor === "string") {
        await cfg.update("launchpad.focusColor", normalizeCssHexColor(settings.focusColor, LAUNCHPAD_LAYOUT_DEFAULTS.focusColor), vscode.ConfigurationTarget.Global);
    }
    if (settings.theme === "classic" || settings.theme === "sleek") {
        await cfg.update("launchpad.theme", settings.theme, vscode.ConfigurationTarget.Global);
    }
    if (settings.restorePanels === "none" || settings.restorePanels === "left" || settings.restorePanels === "right" || settings.restorePanels === "both") {
        await cfg.update("launchpad.restorePanels", settings.restorePanels, vscode.ConfigurationTarget.Global);
    }
}
function getLaunchpadTheme() {
    const value = vscode.workspace.getConfiguration("pkvsconf").get("launchpad.theme");
    return value === "classic" ? "classic" : "sleek";
}
function clampNumber(value, min, max) {
    if (!Number.isFinite(value)) {
        return min;
    }
    return Math.min(max, Math.max(min, Math.round(value)));
}
function normalizeCssHexColor(value, fallback) {
    const trimmed = value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
        return trimmed;
    }
    if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
        const [, r, g, b] = trimmed;
        return `#${r}${r}${g}${g}${b}${b}`;
    }
    return fallback;
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
async function removeProjectFromLaunchpad() {
    const projects = getLaunchpadProjects();
    if (projects.length === 0) {
        vscode.window.showInformationMessage("Le Launchpad est vide.");
        return;
    }
    const selected = await vscode.window.showQuickPick(projects.map((p) => ({
        label: p.name || path.basename(p.path),
        description: p.path,
        project: p
    })), { placeHolder: "Sélectionne le projet à retirer du Launchpad" });
    if (!selected) {
        return;
    }
    const updatedProjects = projects.filter((p) => path.normalize(p.path) !== path.normalize(selected.project.path));
    await vscode.workspace
        .getConfiguration("pkvsconf")
        .update("launchpad.projects", updatedProjects, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Projet "${selected.label}" retiré du Launchpad.`);
}
async function removeProjectFromLaunchpadByPath(projectPath) {
    const projects = getLaunchpadProjects();
    const normalized = path.normalize(projectPath);
    const target = projects.find((p) => path.normalize(p.path) === normalized);
    if (!target) {
        vscode.window.showInformationMessage("Ce projet n'est pas dans le Launchpad.");
        return;
    }
    const updatedProjects = projects.filter((p) => path.normalize(p.path) !== normalized);
    await vscode.workspace
        .getConfiguration("pkvsconf")
        .update("launchpad.projects", updatedProjects, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Projet "${target.name || path.basename(target.path)}" retiré du Launchpad.`);
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
async function maximizeEditorAreaForLaunchpad() {
    const commands = [
        "workbench.action.joinAllGroups",
        "workbench.action.closeSidebar",
        "workbench.action.closeAuxiliaryBar",
        "workbench.action.closePanel"
    ];
    for (const command of commands) {
        try {
            await vscode.commands.executeCommand(command);
        }
        catch {
            // Some commands are unavailable in older VS Code versions or inactive layouts.
        }
    }
}
function getLaunchpadRestorePanels() {
    const value = vscode.workspace.getConfiguration("pkvsconf").get("launchpad.restorePanels");
    if (value === "left" || value === "right" || value === "both")
        return value;
    return "none";
}
async function restorePanelsAfterLaunchpad() {
    const restore = getLaunchpadRestorePanels();
    if (restore === "none")
        return;
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (restore === "left" || restore === "both") {
        try {
            await vscode.commands.executeCommand("workbench.view.explorer");
        }
        catch {
            // ignore
        }
    }
    if (restore === "right" || restore === "both") {
        try {
            await vscode.commands.executeCommand("workbench.action.toggleAuxiliaryBar");
        }
        catch {
            // ignore
        }
    }
}
async function openProjectInNewWindow(projectPath) {
    await recordLaunchpadOpen(projectPath);
    const uri = vscode.Uri.file(projectPath);
    await vscode.commands.executeCommand("vscode.openFolder", uri, true);
}
function isCurrentWorkspacePath(projectPath) {
    const workspacePath = getWorkspaceRootFsPath();
    if (!workspacePath) {
        return false;
    }
    const normalizeForCompare = (value) => path.normalize(value).replace(/[\\/]+$/, "").toLowerCase();
    return normalizeForCompare(workspacePath) === normalizeForCompare(projectPath);
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
const ASCII_GLYPHS = {
    A: [" ### ", "#   #", "#####", "#   #", "#   #"],
    B: ["#### ", "#   #", "#### ", "#   #", "#### "],
    C: [" ####", "#    ", "#    ", "#    ", " ####"],
    D: ["#### ", "#   #", "#   #", "#   #", "#### "],
    E: ["#####", "#    ", "#### ", "#    ", "#####"],
    F: ["#####", "#    ", "#### ", "#    ", "#    "],
    G: [" ####", "#    ", "#  ##", "#   #", " ####"],
    H: ["#   #", "#   #", "#####", "#   #", "#   #"],
    I: ["#####", "  #  ", "  #  ", "  #  ", "#####"],
    J: ["#####", "   # ", "   # ", "#  # ", " ##  "],
    K: ["#   #", "#  # ", "###  ", "#  # ", "#   #"],
    L: ["#    ", "#    ", "#    ", "#    ", "#####"],
    M: ["#   #", "## ##", "# # #", "#   #", "#   #"],
    N: ["#   #", "##  #", "# # #", "#  ##", "#   #"],
    O: [" ### ", "#   #", "#   #", "#   #", " ### "],
    P: ["#### ", "#   #", "#### ", "#    ", "#    "],
    Q: [" ### ", "#   #", "# # #", "#  # ", " ## #"],
    R: ["#### ", "#   #", "#### ", "#  # ", "#   #"],
    S: [" ####", "#    ", " ### ", "    #", "#### "],
    T: ["#####", "  #  ", "  #  ", "  #  ", "  #  "],
    U: ["#   #", "#   #", "#   #", "#   #", " ### "],
    V: ["#   #", "#   #", "#   #", " # # ", "  #  "],
    W: ["#   #", "#   #", "# # #", "## ##", "#   #"],
    X: ["#   #", " # # ", "  #  ", " # # ", "#   #"],
    Y: ["#   #", " # # ", "  #  ", "  #  ", "  #  "],
    Z: ["#####", "   # ", "  #  ", " #   ", "#####"],
    "0": [" ### ", "#  ##", "# # #", "##  #", " ### "],
    "1": ["  #  ", " ##  ", "  #  ", "  #  ", "#####"],
    "2": [" ### ", "#   #", "   # ", "  #  ", "#####"],
    "3": ["#### ", "    #", " ### ", "    #", "#### "],
    "4": ["#   #", "#   #", "#####", "    #", "    #"],
    "5": ["#####", "#    ", "#### ", "    #", "#### "],
    "6": [" ####", "#    ", "#### ", "#   #", " ### "],
    "7": ["#####", "   # ", "  #  ", " #   ", "#    "],
    "8": [" ### ", "#   #", " ### ", "#   #", " ### "],
    "9": [" ### ", "#   #", " ####", "    #", "#### "]
};
function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}
function getProjectInitials(project) {
    const raw = (project.name || path.basename(project.path) || "PK").toUpperCase();
    const words = raw.match(/[A-Z0-9]+/g) ?? ["PK"];
    const initials = words.length > 1
        ? words.slice(0, 2).map((w) => w[0]).join("")
        : words[0].slice(0, 2);
    return initials.padEnd(2, "K").slice(0, 2);
}
function buildAsciiLogoLines(text) {
    const glyphs = text.split("").map((char) => ASCII_GLYPHS[char] ?? ASCII_GLYPHS.P);
    return Array.from({ length: 5 }, (_, row) => glyphs.map((glyph) => glyph[row]).join("  "));
}
function toDataUriFromSvg(title, colors) {
    const safeTitle = title.replace(/[^A-Z0-9]/g, "").slice(0, 2) || "PK";
    const lines = buildAsciiLogoLines(safeTitle);
    const tspans = lines
        .map((line, index) => `<tspan x="64" y="${32 + index * 16}">${line.replace(/ /g, "\u00A0")}</tspan>`)
        .join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><defs><linearGradient id="g" x1="10" y1="10" x2="118" y2="118"><stop offset="0" stop-color="${colors[0]}"/><stop offset="1" stop-color="${colors[1]}"/></linearGradient><filter id="glow"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><text font-family="ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace" font-size="14" font-weight="900" letter-spacing="0" text-anchor="middle" fill="url(#g)" filter="url(#glow)">${tspans}</text><text x="64" y="113" font-family="ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace" font-size="11" font-weight="700" text-anchor="middle" fill="${colors[1]}" opacity=".82">[${safeTitle}]</text></svg>`;
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
        const initials = getProjectInitials(project);
        const palettes = [
            ["#00D4FF", "#006BFF"],
            ["#FF4FD8", "#7C3AED"],
            ["#00FF88", "#00B37A"],
            ["#FFD166", "#FF6B35"],
            ["#7CFFCB", "#3A86FF"],
            ["#F72585", "#4CC9F0"],
            ["#D8F3DC", "#52B788"],
            ["#FDE047", "#F97316"],
            ["#A78BFA", "#22D3EE"],
            ["#FB7185", "#FACC15"]
        ];
        const palette = palettes[hashString(project.path || project.name) % palettes.length];
        return toDataUriFromSvg(initials, palette);
    }
}
function escapeAttr(value) {
    return escapeHtml(value);
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
        .map((c) => {
        const title = `${c.name}${c.lastOpened ? " - " + formatRelativeTime(c.lastOpened) : ""}`;
        return `
        <button class="card${c.lastOpened ? ' recent' : ''}" data-path="${escapeAttr(c.path)}" title="${escapeAttr(title)}">
          <img src="${escapeAttr(c.icon)}" alt="${escapeAttr(c.name)}" />
          <div class="name">${escapeHtml(c.name)}</div>
          ${c.lastOpened ? '<div class="badge recent">récent</div>' : ''}
        </button>`;
    })
        .join("");
    const miniItemsHtml = cards
        .map((c) => {
        const title = `${c.name}${c.lastOpened ? " - " + formatRelativeTime(c.lastOpened) : ""}`;
        return `
        <button class="miniItem${c.lastOpened ? ' recent' : ''}" data-path="${escapeAttr(c.path)}" type="button" aria-label="${escapeAttr(c.name)}" title="${escapeAttr(title)}">
          <img src="${escapeAttr(c.icon)}" alt="${escapeAttr(c.name)}" />
          ${c.lastOpened ? '<div class="miniBadge recent">●</div>' : ''}
        </button>`;
    })
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
async function buildLaunchpadPanelHtml(webview, projects) {
    const cards = await Promise.all(projects.map(async (p) => ({
        name: p.name || path.basename(p.path),
        path: p.path,
        icon: await getProjectIcon(p),
        lastOpened: p.lastOpened
    })));
    const nonce = getNonce();
    const currentWorkspace = getWorkspaceRootFsPath();
    const layout = getLaunchpadLayoutSettings();
    const cellSize = Math.max(layout.iconSize + 94, 136);
    const cardsHtml = cards
        .map((c, index) => {
        const title = `${c.name}\n${c.path}${c.lastOpened ? "\nOuvert " + formatRelativeTime(c.lastOpened) : ""}`;
        const initials = c.name.trim().slice(0, 2).toUpperCase();
        return `
        <button class="app" type="button" data-index="${index}" data-path="${escapeAttr(c.path)}" data-name="${escapeAttr(c.name.toLowerCase())}" title="${escapeAttr(title)}">
          <span class="iconWrap">
            <img class="icon" src="${escapeAttr(c.icon)}" alt="${escapeAttr(c.name)}" />
          </span>
          <span class="label">${escapeHtml(c.name || initials)}</span>
          ${c.lastOpened ? '<span class="lastOpened">recent</span>' : ""}
        </button>`;
    })
        .join("");
    const shortcuts = [
        ["Ouvrir Launchpad", "pkvsconf.launchpadOpen", "Cmd+Alt+L"],
        ["Ancienne liste projets", "pkvsconf.launchpadOpenList", "Cmd+Alt+P"],
        ["Ajouter workspace", "pkvsconf.launchpadAddCurrent", "Cmd+Alt+Shift+C"],
        ["Ajouter dossier", "pkvsconf.launchpadAddFolder", "Cmd+Alt+Shift+F"],
        ["Afficher dans Finder", "pkvsconf.launchpadRevealInFinder", "Cmd+Alt+Shift+R"],
        ["Retirer un projet", "pkvsconf.launchpadRemove", "Cmd+Alt+Shift+Backspace"]
    ];
    const shortcutsHtml = shortcuts
        .map(([label, command, defaultShortcut]) => `
            <div class="shortcutRow">
              <span class="shortcutLabel">${escapeHtml(label)}</span>
              <code>${escapeHtml(defaultShortcut)}</code>
              <button class="smallAction shortcutConfig" type="button" data-command="${escapeAttr(command)}">Configurer</button>
            </div>`)
        .join("");
    return `<!DOCTYPE html>
  <html lang="fr">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';" />
      <style>
        :root {
          color-scheme: ${vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ? "dark" : "light"};
          --cols: ${layout.columns};
          --visible-rows: ${layout.rows};
          --icon-size: ${layout.iconSize}px;
          --cell-size: ${cellSize}px;
          --focus-color: ${layout.focusColor};
          --bg: #08080a;
          --panel: rgba(255, 255, 255, 0.035);
          --panel-strong: rgba(255, 255, 255, 0.07);
          --panel-border: rgba(255, 255, 255, 0.09);
          --panel-border-strong: rgba(255, 255, 255, 0.16);
          --text: #f4f6fb;
          --muted: rgba(244, 246, 251, 0.62);
          --accent: #6366f1;
          --cyan: #06b6d4;
          --rose: #ec4899;
          --shadow: rgba(0, 0, 0, 0.32);
          --ring: var(--focus-color);
        }
        * { box-sizing: border-box; }
        html, body {
          width: 100%;
          height: 100%;
          min-height: 100%;
        }
        body {
          margin: 0;
          overflow: hidden;
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif;
          color: var(--text);
          background: var(--bg);
        }
        body::before {
          content: "";
          position: fixed;
          inset: -20%;
          z-index: -2;
          pointer-events: none;
          background:
            linear-gradient(115deg, rgba(99, 102, 241, 0.20), transparent 24%),
            linear-gradient(245deg, rgba(6, 182, 212, 0.16), transparent 28%),
            linear-gradient(20deg, rgba(236, 72, 153, 0.12), transparent 22%),
            #08080a;
          animation: ambientShift 24s ease-in-out infinite alternate;
        }
        body::after {
          content: "";
          position: fixed;
          inset: 0;
          z-index: -1;
          pointer-events: none;
          background:
            linear-gradient(rgba(255,255,255,0.028) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.022) 1px, transparent 1px);
          background-size: 44px 44px;
          mask-image: linear-gradient(to bottom, rgba(0,0,0,0.28), rgba(0,0,0,0.08) 45%, transparent);
        }
        @keyframes ambientShift {
          from { transform: translate3d(-2%, -1%, 0) scale(1); filter: saturate(1); }
          to { transform: translate3d(2%, 1%, 0) scale(1.04); filter: saturate(1.18); }
        }
        .screen {
          height: 100vh;
          width: 100vw;
          padding: clamp(18px, 4vh, 42px) clamp(18px, 5vw, 72px);
          display: grid;
          grid-template-rows: auto 1fr auto;
          gap: clamp(18px, 3vh, 34px);
          backdrop-filter: blur(18px) saturate(1.12);
        }
        .topbar {
          display: grid;
          grid-template-columns: minmax(170px, 1fr) minmax(240px, 620px) minmax(170px, 1fr);
          align-items: center;
          gap: 14px;
          min-height: 58px;
        }
        .title {
          min-width: 0;
        }
        h1 {
          margin: 0;
          font-size: clamp(28px, 4.8vw, 54px);
          line-height: 0.95;
          font-weight: 700;
          letter-spacing: 0;
        }
        .count {
          margin-top: 8px;
          color: var(--muted);
          font-size: 13px;
        }
        .searchWrap {
          position: relative;
          width: 100%;
        }
        .searchWrap::before {
          content: "";
          position: absolute;
          left: 20px;
          top: 50%;
          width: 15px;
          height: 15px;
          border: 2px solid var(--muted);
          border-radius: 50%;
          transform: translateY(-56%);
          pointer-events: none;
        }
        .searchWrap::after {
          content: "";
          position: absolute;
          left: 33px;
          top: 50%;
          width: 8px;
          height: 2px;
          border-radius: 2px;
          background: var(--muted);
          transform: translateY(5px) rotate(45deg);
          pointer-events: none;
        }
        .search {
          width: 100%;
          height: 52px;
          border-radius: 999px;
          border: 1px solid var(--panel-border);
          background: rgba(255, 255, 255, 0.04);
          color: var(--text);
          outline: none;
          padding: 0 54px 0 54px;
          font-size: 15px;
          box-shadow: 0 18px 48px rgba(0,0,0,0.24);
          backdrop-filter: blur(18px);
          transition: border-color 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
        }
        .search::placeholder {
          color: rgba(244, 246, 251, 0.45);
        }
        .search:focus {
          border-color: color-mix(in srgb, var(--focus-color) 54%, transparent);
          background: rgba(255, 255, 255, 0.07);
          box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-color) 22%, transparent), 0 18px 48px rgba(0,0,0,0.24);
        }
        .shortcutHint {
          position: absolute;
          right: 18px;
          top: 50%;
          transform: translateY(-50%);
          min-width: 22px;
          height: 22px;
          padding: 0 7px;
          border-radius: 7px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 1px solid rgba(255,255,255,0.11);
          background: rgba(255,255,255,0.06);
          color: var(--muted);
          font-size: 12px;
          pointer-events: none;
        }
        .apps {
          align-self: stretch;
          display: grid;
          grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
          grid-auto-rows: var(--cell-size);
          gap: clamp(14px, 2vw, 26px);
          overflow-y: auto;
          overflow-x: hidden;
          padding: 6px 4px 30px;
          scrollbar-width: thin;
          min-height: min(calc(var(--visible-rows) * var(--cell-size)), 100%);
          align-content: start;
        }
        .app {
          position: relative;
          border: 1px solid var(--panel-border);
          background: var(--panel);
          color: var(--text);
          min-width: 0;
          padding: 18px 14px 14px;
          border-radius: 20px;
          cursor: pointer;
          display: grid;
          grid-template-rows: var(--icon-size) auto auto;
          justify-items: center;
          align-items: center;
          gap: 10px;
          backdrop-filter: blur(14px);
          box-shadow: 0 14px 34px rgba(0,0,0,0.12);
          transition: transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1), background 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;
        }
        .app:hover {
          background: var(--panel-strong);
          border-color: var(--panel-border-strong);
          transform: translateY(-6px) scale(1.02);
          box-shadow: 0 22px 42px rgba(0,0,0,0.24), 0 0 24px rgba(255,255,255,0.025);
        }
        .app:active {
          transform: translateY(-1px) scale(0.99);
        }
        .app:focus-visible {
          outline: none;
          border-color: color-mix(in srgb, var(--focus-color) 72%, transparent);
          box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-color) 30%, transparent), 0 0 26px color-mix(in srgb, var(--focus-color) 46%, transparent), 0 22px 42px rgba(0,0,0,0.24);
        }
        .app:focus-visible .label {
          color: #ffffff;
        }
        .iconWrap {
          width: var(--icon-size);
          height: var(--icon-size);
          border-radius: 0;
          background: transparent;
          border: 0;
          box-shadow: none;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: transform 0.18s ease, filter 0.18s ease;
        }
        .app:hover .iconWrap,
        .app:focus-visible .iconWrap {
          transform: translateY(-2px);
          filter: drop-shadow(0 12px 18px rgba(0,0,0,0.28));
        }
        .icon {
          width: calc(var(--icon-size) * 0.82);
          height: calc(var(--icon-size) * 0.82);
          object-fit: contain;
          border-radius: 0;
        }
        .label {
          display: block;
          width: 100%;
          color: var(--text);
          text-align: center;
          font-size: 13px;
          font-weight: 550;
          line-height: 1.22;
          text-shadow: 0 1px 4px rgba(0,0,0,0.28);
          overflow-wrap: anywhere;
        }
        .lastOpened {
          color: var(--muted);
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.9px;
        }
        .empty {
          align-self: center;
          justify-self: center;
          max-width: 460px;
          padding: 28px;
          border-radius: 20px;
          background: var(--panel);
          text-align: center;
          color: var(--muted);
          border: 1px solid var(--panel-border);
          backdrop-filter: blur(14px);
        }
        .empty strong {
          color: var(--text);
          display: block;
          margin-bottom: 8px;
          font-size: 18px;
        }
        .dock {
          justify-self: center;
          display: flex;
          gap: 8px;
          padding: 8px;
          border-radius: 999px;
          background: rgba(25, 25, 30, 0.72);
          border: 1px solid var(--panel-border);
          box-shadow: 0 18px 50px rgba(0,0,0,0.34);
          backdrop-filter: blur(18px);
        }
        .dock button {
          border: 1px solid rgba(255,255,255,0.06);
          background: rgba(255, 255, 255, 0.045);
          color: var(--text);
          min-width: 48px;
          height: 48px;
          padding: 0 15px;
          border-radius: 999px;
          cursor: pointer;
          font-size: 12px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          transition: transform 0.18s ease, background 0.18s ease, border-color 0.18s ease;
        }
        .dock button:hover {
          background: rgba(255, 255, 255, 0.10);
          border-color: var(--panel-border-strong);
          transform: translateY(-3px);
        }
        .dock button:disabled {
          opacity: 0.46;
          cursor: not-allowed;
          transform: none;
        }
        .dock .glyph {
          font-size: 16px;
          line-height: 1;
        }
        .modalOverlay {
          position: fixed;
          inset: 0;
          z-index: 30;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 18px;
          background: rgba(0, 0, 0, 0.52);
          backdrop-filter: blur(10px);
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.18s ease;
        }
        .modalOverlay.visible {
          opacity: 1;
          pointer-events: auto;
        }
        .modal {
          width: min(460px, 100%);
          max-height: min(760px, calc(100vh - 36px));
          overflow-y: auto;
          border-radius: 24px;
          border: 1px solid var(--panel-border);
          background: rgba(18, 18, 23, 0.95);
          box-shadow: 0 24px 70px rgba(0,0,0,0.48);
          padding: 26px;
          transform: translateY(14px) scale(0.98);
          transition: transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .modalOverlay.visible .modal {
          transform: translateY(0) scale(1);
        }
        .modalHeader {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          margin-bottom: 22px;
        }
        .modalTitle {
          margin: 0;
          font-size: 20px;
          font-weight: 650;
        }
        .modalSection {
          margin: 22px 0 0;
          padding-top: 18px;
          border-top: 1px solid rgba(255,255,255,0.08);
        }
        .modalSectionTitle {
          margin: 0 0 14px;
          color: var(--text);
          font-size: 13px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.7px;
        }
        .modalClose {
          border: 0;
          width: 34px;
          height: 34px;
          border-radius: 50%;
          background: rgba(255,255,255,0.06);
          color: var(--muted);
          cursor: pointer;
          font-size: 22px;
          line-height: 1;
        }
        .modalClose:hover {
          color: var(--text);
          background: rgba(255,255,255,0.1);
        }
        .formGroup {
          margin-bottom: 20px;
        }
        .formLabel {
          display: flex;
          justify-content: space-between;
          align-items: center;
          color: var(--muted);
          font-size: 13px;
          margin-bottom: 8px;
        }
        .formValue {
          color: var(--focus-color);
          font-weight: 700;
        }
        .range {
          width: 100%;
          accent-color: var(--focus-color);
        }
        .colorInput {
          width: 100%;
          height: 38px;
          border-radius: 12px;
          border: 1px solid var(--panel-border);
          background: rgba(255,255,255,0.06);
          color: var(--text);
          padding: 0 12px;
          outline: none;
        }
        .colorInput:focus {
          border-color: color-mix(in srgb, var(--focus-color) 54%, transparent);
          box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-color) 22%, transparent);
        }
        .formSelect {
          width: 100%;
          height: 38px;
          border-radius: 12px;
          border: 1px solid var(--panel-border);
          background: rgba(255,255,255,0.06);
          color: var(--text);
          padding: 0 12px;
          outline: none;
        }
        .formSelect:focus {
          border-color: color-mix(in srgb, var(--focus-color) 54%, transparent);
          box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-color) 22%, transparent);
        }
        .settingsActions {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        .smallAction {
          border: 1px solid rgba(255,255,255,0.10);
          background: rgba(255,255,255,0.06);
          color: var(--text);
          min-height: 32px;
          border-radius: 10px;
          padding: 0 10px;
          cursor: pointer;
          font-size: 12px;
        }
        .smallAction:hover {
          background: rgba(255,255,255,0.11);
          border-color: rgba(255,255,255,0.18);
        }
        .shortcutList {
          display: grid;
          gap: 8px;
        }
        .shortcutRow {
          display: grid;
          grid-template-columns: minmax(120px, 1fr) auto auto;
          align-items: center;
          gap: 8px;
          min-height: 38px;
          padding: 6px 8px;
          border-radius: 12px;
          background: rgba(255,255,255,0.035);
          border: 1px solid rgba(255,255,255,0.06);
        }
        .shortcutLabel {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--text);
          font-size: 12px;
        }
        .shortcutRow code {
          color: var(--muted);
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 11px;
          background: rgba(0,0,0,0.18);
          border-radius: 7px;
          padding: 4px 6px;
        }
        .contextMenu {
          position: fixed;
          z-index: 40;
          min-width: 156px;
          padding: 6px;
          border-radius: 14px;
          background: rgba(18, 18, 23, 0.96);
          border: 1px solid var(--panel-border);
          box-shadow: 0 18px 40px rgba(0,0,0,0.28);
          display: none;
          backdrop-filter: blur(14px);
        }
        .contextMenu.visible {
          display: block;
        }
        .contextMenu button {
          width: 100%;
          border: 0;
          background: transparent;
          color: var(--text);
          min-height: 30px;
          padding: 0 10px;
          border-radius: 8px;
          text-align: left;
          cursor: pointer;
          font-size: 12px;
        }
        .contextMenu button:hover {
          background: rgba(255,255,255,0.09);
          color: var(--text);
        }
        .contextMenu .danger {
          color: var(--vscode-errorForeground);
        }
        body.theme-classic {
          color: var(--vscode-foreground);
          background:
            radial-gradient(circle at 18% 12%, rgba(42, 157, 143, 0.28), transparent 30%),
            radial-gradient(circle at 78% 16%, rgba(231, 111, 81, 0.22), transparent 32%),
            linear-gradient(135deg, color-mix(in srgb, var(--vscode-editor-background) 80%, #1f6feb 20%), var(--vscode-editor-background));
        }
        body.theme-classic::before,
        body.theme-classic::after {
          display: none;
        }
        body.theme-classic .screen {
          padding: clamp(14px, 3vh, 28px) clamp(18px, 4vw, 54px);
          gap: clamp(12px, 2vh, 22px);
          backdrop-filter: blur(28px) saturate(1.1);
        }
        body.theme-classic .topbar {
          grid-template-columns: minmax(170px, 1fr) minmax(220px, 360px) minmax(170px, 1fr);
          min-height: 46px;
        }
        body.theme-classic .search {
          height: 40px;
          border: 1px solid color-mix(in srgb, var(--vscode-editorWidget-border, #777) 60%, transparent);
          background: color-mix(in srgb, var(--vscode-editor-background) 58%, transparent);
          color: var(--vscode-foreground);
          padding: 0 42px;
          font-size: 14px;
          box-shadow: 0 12px 40px rgba(0,0,0,0.14);
          backdrop-filter: none;
        }
        body.theme-classic .search:focus {
          border-color: var(--vscode-focusBorder);
          box-shadow: 0 0 0 2px color-mix(in srgb, var(--vscode-focusBorder) 28%, transparent), 0 12px 40px rgba(0,0,0,0.14);
        }
        body.theme-classic .apps {
          gap: clamp(10px, 1.8vw, 24px) clamp(8px, 1.6vw, 20px);
          padding: 8px 2px 26px;
        }
        body.theme-classic .app {
          border: 0;
          background: transparent;
          box-shadow: none;
          padding: 0;
          border-radius: 0;
          grid-template-rows: var(--icon-size) auto auto;
          align-items: start;
          backdrop-filter: none;
          transform: none;
        }
        body.theme-classic .app:hover {
          background: transparent;
          border-color: transparent;
          box-shadow: none;
          transform: none;
        }
        body.theme-classic .app:hover .iconWrap,
        body.theme-classic .app:focus-visible .iconWrap {
          transform: translateY(-2px);
          filter: none;
        }
        body.theme-classic .app:focus-visible {
          border-color: transparent;
          box-shadow: none;
        }
        body.theme-classic .app:focus-visible .label {
          color: #ffffff;
          background: var(--focus-color);
          box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-color) 38%, transparent), 0 0 18px color-mix(in srgb, var(--focus-color) 72%, transparent);
          border-radius: 11px;
          padding: 4px 8px;
          margin-top: -4px;
          width: auto;
          max-width: min(calc(var(--icon-size) + 52px), 100%);
        }
        body.theme-classic .icon {
          width: calc(var(--icon-size) * 0.78);
          height: calc(var(--icon-size) * 0.78);
        }
        body.theme-classic .label {
          width: min(calc(var(--icon-size) + 44px), 100%);
          color: var(--vscode-foreground);
          font-weight: 400;
        }
        body.theme-classic .lastOpened {
          color: var(--vscode-descriptionForeground);
        }
        body.theme-classic .dock {
          border-radius: 24px;
          background: color-mix(in srgb, var(--vscode-editor-background) 58%, transparent);
          border: 1px solid color-mix(in srgb, var(--vscode-editorWidget-border, #777) 45%, transparent);
          box-shadow: 0 18px 50px rgba(0,0,0,0.20);
        }
        body.theme-classic .dock button {
          height: 38px;
          min-width: 104px;
          padding: 0 12px;
          border-radius: 16px;
          background: color-mix(in srgb, var(--vscode-editor-background) 42%, transparent);
        }
        body.theme-classic .modal {
          border-radius: 18px;
          background: color-mix(in srgb, var(--vscode-editor-background) 92%, transparent);
        }
        body.theme-classic .shortcutRow,
        body.theme-classic .smallAction,
        body.theme-classic .formSelect,
        body.theme-classic .colorInput {
          background: color-mix(in srgb, var(--vscode-editor-background) 74%, transparent);
          border-color: color-mix(in srgb, var(--vscode-editorWidget-border, #777) 48%, transparent);
        }
        body.theme-classic .contextMenu {
          background: color-mix(in srgb, var(--vscode-menu-background, var(--vscode-editor-background)) 94%, transparent);
          border: 1px solid var(--vscode-menu-border, var(--vscode-editorWidget-border, #777));
        }
        @media (max-width: 720px) {
          .screen {
            padding: 18px;
            gap: 18px;
          }
          .topbar {
            grid-template-columns: 1fr;
          }
          .searchWrap {
            grid-column: 1;
          }
          .apps {
            grid-template-columns: repeat(auto-fill, minmax(max(72px, var(--icon-size)), 1fr));
            gap: 16px 12px;
          }
          .dock span:not(.glyph) {
            display: none;
          }
          .shortcutRow {
            grid-template-columns: 1fr;
          }
        }
      </style>
    </head>
    <body class="theme-${layout.theme}">
      <main class="screen">
        <header class="topbar">
          <div class="title">
            <h1>Launchpad</h1>
            <div class="count"><span id="visibleCount">${cards.length}</span> projet${cards.length > 1 ? "s" : ""}</div>
          </div>
          <div class="searchWrap">
            <input id="search" class="search" type="search" autocomplete="off" spellcheck="false" placeholder="Rechercher un projet" aria-label="Rechercher un projet" />
            <span class="shortcutHint">/</span>
          </div>
          <div aria-hidden="true"></div>
        </header>
        ${cards.length
        ? `<section id="apps" class="apps" aria-label="Projets">${cardsHtml}</section>`
        : `<section class="empty"><strong>Launchpad vide</strong>Ajoute le workspace courant ou choisis un dossier pour créer ta grille de projets.</section>`}
        <footer class="dock" aria-label="Actions Launchpad">
          <button id="dockSettings" type="button" title="Réglages d'affichage" aria-label="Réglages d'affichage"><span class="glyph">⚙</span><span>Réglages</span></button>
          <button id="dockAddCurrent" type="button" title="Ajouter le workspace courant" aria-label="Ajouter le workspace courant"${currentWorkspace ? "" : " disabled"}><span class="glyph">⌂</span><span>Workspace</span></button>
          <button id="dockAddFolder" type="button" title="Ajouter un dossier" aria-label="Ajouter un dossier"><span class="glyph">+</span><span>Dossier</span></button>
          <button id="dockRefresh" type="button" title="Rafraîchir" aria-label="Rafraîchir"><span class="glyph">↻</span><span>Refresh</span></button>
        </footer>
      </main>
      <div id="settingsModal" class="modalOverlay" aria-hidden="true">
        <section class="modal" role="dialog" aria-modal="true" aria-label="Réglages Launchpad">
          <div class="modalHeader">
            <h2 class="modalTitle">Préférences Launchpad</h2>
            <button id="settingsClose" class="modalClose" type="button" aria-label="Fermer">×</button>
          </div>
          <div class="modalSection">
            <h3 class="modalSectionTitle">Apparence</h3>
          <div class="formGroup">
            <label class="formLabel" for="themeInput"><span>Thème</span><span id="themeValue" class="formValue">${layout.theme === "classic" ? "Classique" : "Sleek"}</span></label>
            <select id="themeInput" class="formSelect">
              <option value="sleek"${layout.theme === "sleek" ? " selected" : ""}>Sleek</option>
              <option value="classic"${layout.theme === "classic" ? " selected" : ""}>Classique</option>
            </select>
          </div>
          <div class="formGroup">
            <label class="formLabel" for="columnsInput"><span>Colonnes</span><span id="columnsValue" class="formValue">${layout.columns}</span></label>
            <input id="columnsInput" class="range" type="range" min="3" max="16" step="1" value="${layout.columns}" />
          </div>
          <div class="formGroup">
            <label class="formLabel" for="rowsInput"><span>Lignes visibles</span><span id="rowsValue" class="formValue">${layout.rows}</span></label>
            <input id="rowsInput" class="range" type="range" min="2" max="10" step="1" value="${layout.rows}" />
          </div>
          <div class="formGroup">
            <label class="formLabel" for="iconSizeInput"><span>Taille des pictos</span><span id="iconSizeValue" class="formValue">${layout.iconSize}px</span></label>
            <input id="iconSizeInput" class="range" type="range" min="42" max="128" step="2" value="${layout.iconSize}" />
          </div>
          <div class="formGroup">
            <label class="formLabel" for="focusColorInput"><span>Couleur du focus</span><span id="focusColorValue" class="formValue">${layout.focusColor}</span></label>
            <input id="focusColorInput" class="colorInput" type="text" spellcheck="false" value="${layout.focusColor}" placeholder="#008CFF" />
          </div>
          </div>
          <div class="modalSection">
            <h3 class="modalSectionTitle">Comportement</h3>
          <div class="formGroup">
            <label class="formLabel" for="restorePanelsInput"><span>Volets après fermeture</span><span id="restorePanelsValue" class="formValue">${layout.restorePanels === "both" ? "Les deux" : layout.restorePanels === "left" ? "Gauche" : layout.restorePanels === "right" ? "Droit" : "Fermés"}</span></label>
            <select id="restorePanelsInput" class="formSelect">
              <option value="none"${layout.restorePanels === "none" ? " selected" : ""}>Fermés</option>
              <option value="left"${layout.restorePanels === "left" ? " selected" : ""}>Volet gauche</option>
              <option value="right"${layout.restorePanels === "right" ? " selected" : ""}>Volet droit</option>
              <option value="both"${layout.restorePanels === "both" ? " selected" : ""}>Les deux volets</option>
            </select>
          </div>
          </div>
          <div class="modalSection">
            <h3 class="modalSectionTitle">Options extension</h3>
            <div class="settingsActions">
              <button id="openLaunchpadSettings" class="smallAction" type="button">Ouvrir les réglages PK VS Conf</button>
              <button id="openKeyboardSettings" class="smallAction" type="button">Ouvrir les raccourcis VS Code</button>
            </div>
          </div>
          <div class="modalSection">
            <h3 class="modalSectionTitle">Raccourcis Launchpad</h3>
            <div class="shortcutList">
${shortcutsHtml}
            </div>
          </div>
        </section>
      </div>
      <div id="contextMenu" class="contextMenu" role="menu" aria-hidden="true">
        <button id="contextOpen" type="button" role="menuitem">Ouvrir</button>
        <button id="contextReveal" type="button" role="menuitem">Afficher dans Finder</button>
        <button id="contextRemove" class="danger" type="button" role="menuitem">Retirer du Launchpad</button>
      </div>
      <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const search = document.getElementById('search');
        const visibleCount = document.getElementById('visibleCount');
        const apps = Array.from(document.querySelectorAll('.app'));
        const appsGrid = document.getElementById('apps');
        const columnsInput = document.getElementById('columnsInput');
        const rowsInput = document.getElementById('rowsInput');
        const iconSizeInput = document.getElementById('iconSizeInput');
        const themeInput = document.getElementById('themeInput');
        const focusColorInput = document.getElementById('focusColorInput');
        const restorePanelsInput = document.getElementById('restorePanelsInput');
        const columnsValue = document.getElementById('columnsValue');
        const rowsValue = document.getElementById('rowsValue');
        const iconSizeValue = document.getElementById('iconSizeValue');
        const themeValue = document.getElementById('themeValue');
        const focusColorValue = document.getElementById('focusColorValue');
        const restorePanelsValue = document.getElementById('restorePanelsValue');
        const settingsModal = document.getElementById('settingsModal');
        const settingsClose = document.getElementById('settingsClose');
        const contextMenu = document.getElementById('contextMenu');
        const contextOpen = document.getElementById('contextOpen');
        const contextReveal = document.getElementById('contextReveal');
        const contextRemove = document.getElementById('contextRemove');
        let layoutColumns = ${layout.columns};
        let layoutRows = ${layout.rows};
        let iconSize = ${layout.iconSize};
        let theme = '${layout.theme}';
        let focusColor = '${layout.focusColor}';
        let restorePanels = '${layout.restorePanels}';
        let focusedIndex = 0;
        let layoutSaveTimer = null;
        let contextPath = null;

        function post(command, payload = {}) {
          vscode.postMessage({ command, ...payload });
        }

        function clamp(value, min, max) {
          const n = Number.parseInt(String(value), 10);
          if (!Number.isFinite(n)) return min;
          return Math.min(max, Math.max(min, n));
        }

        function normalizeHexColor(value, fallback) {
          const trimmed = String(value || '').trim();
          if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed;
          if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
            return '#' + trimmed[1] + trimmed[1] + trimmed[2] + trimmed[2] + trimmed[3] + trimmed[3];
          }
          return fallback;
        }

        function visibleApps() {
          return apps.filter((el) => el.style.display !== 'none');
        }

        function focusApp(index) {
          const visible = visibleApps();
          if (!visible.length) return;
          focusedIndex = Math.min(Math.max(index, 0), visible.length - 1);
          visible[focusedIndex]?.focus({ preventScroll: false });
        }

        function applySearch() {
          const q = search?.value.trim().toLowerCase() || '';
          let shown = 0;
          apps.forEach((el) => {
            const haystack = ((el.dataset.name || '') + ' ' + (el.dataset.path || '').toLowerCase());
            const match = !q || haystack.includes(q);
            el.style.display = match ? '' : 'none';
            if (match) shown += 1;
          });
          if (visibleCount) visibleCount.textContent = String(shown);
          focusedIndex = 0;
        }

        function typeIntoSearch(value) {
          if (!search) return;
          search.value = value;
          applySearch();
        }

        function appendToSearch(char) {
          if (!search) return;
          search.value = search.value + char;
          applySearch();
        }

        function closeContextMenu() {
          contextPath = null;
          contextMenu?.classList.remove('visible');
          contextMenu?.setAttribute('aria-hidden', 'true');
        }

        function openContextMenu(event, path) {
          contextPath = path;
          if (!contextMenu) return;
          contextMenu.style.left = Math.min(event.clientX, window.innerWidth - 176) + 'px';
          contextMenu.style.top = Math.min(event.clientY, window.innerHeight - 118) + 'px';
          contextMenu.classList.add('visible');
          contextMenu.setAttribute('aria-hidden', 'false');
        }

        function openSettingsModal() {
          settingsModal?.classList.add('visible');
          settingsModal?.setAttribute('aria-hidden', 'false');
        }

        function closeSettingsModal() {
          settingsModal?.classList.remove('visible');
          settingsModal?.setAttribute('aria-hidden', 'true');
        }

        function applyLayout({ save = true } = {}) {
          layoutColumns = clamp(columnsInput?.value ?? layoutColumns, 3, 16);
          layoutRows = clamp(rowsInput?.value ?? layoutRows, 2, 10);
          iconSize = clamp(iconSizeInput?.value ?? iconSize, 42, 128);
          theme = themeInput?.value === 'classic' ? 'classic' : 'sleek';
          focusColor = normalizeHexColor(focusColorInput?.value ?? focusColor, focusColor);
          restorePanels = ['none','left','right','both'].includes(restorePanelsInput?.value) ? restorePanelsInput.value : 'none';
          const cellSize = Math.max(iconSize + 94, 136);
          document.documentElement.style.setProperty('--cols', String(layoutColumns));
          document.documentElement.style.setProperty('--visible-rows', String(layoutRows));
          document.documentElement.style.setProperty('--icon-size', iconSize + 'px');
          document.documentElement.style.setProperty('--cell-size', cellSize + 'px');
          document.documentElement.style.setProperty('--focus-color', focusColor);
          document.body.classList.toggle('theme-classic', theme === 'classic');
          document.body.classList.toggle('theme-sleek', theme === 'sleek');
          if (columnsInput) columnsInput.value = String(layoutColumns);
          if (rowsInput) rowsInput.value = String(layoutRows);
          if (iconSizeInput) iconSizeInput.value = String(iconSize);
          if (themeInput) themeInput.value = theme;
          if (focusColorInput) focusColorInput.value = focusColor;
          if (columnsValue) columnsValue.textContent = String(layoutColumns);
          if (rowsValue) rowsValue.textContent = String(layoutRows);
          if (iconSizeValue) iconSizeValue.textContent = iconSize + 'px';
          if (themeValue) themeValue.textContent = theme === 'classic' ? 'Classique' : 'Sleek';
          if (focusColorValue) focusColorValue.textContent = focusColor;
          if (restorePanelsInput) restorePanelsInput.value = restorePanels;
          if (restorePanelsValue) restorePanelsValue.textContent = restorePanels === 'both' ? 'Les deux' : restorePanels === 'left' ? 'Gauche' : restorePanels === 'right' ? 'Droit' : 'Fermés';
          if (!save) return;
          if (layoutSaveTimer) clearTimeout(layoutSaveTimer);
          layoutSaveTimer = setTimeout(() => {
            post('layout', {
              columns: layoutColumns,
              rows: layoutRows,
              iconSize,
              theme,
              focusColor,
              restorePanels
            });
          }, 250);
        }

        function wire(id, command) {
          document.getElementById(id)?.addEventListener('click', () => post(command));
        }

        document.getElementById('dockSettings')?.addEventListener('click', openSettingsModal);
        wire('dockAddCurrent', 'addCurrent');
        wire('dockAddFolder', 'addFolder');
        wire('dockRefresh', 'refresh');
        settingsClose?.addEventListener('click', closeSettingsModal);
        settingsModal?.addEventListener('click', (e) => {
          if (e.target === settingsModal) closeSettingsModal();
        });

        contextOpen?.addEventListener('click', () => {
          if (contextPath) post('open', { path: contextPath });
          closeContextMenu();
        });
        contextReveal?.addEventListener('click', () => {
          if (contextPath) post('reveal', { path: contextPath });
          closeContextMenu();
        });
        contextRemove?.addEventListener('click', () => {
          if (contextPath) post('removePath', { path: contextPath });
          closeContextMenu();
        });
        window.addEventListener('click', (e) => {
          if (!contextMenu?.contains(e.target)) closeContextMenu();
        });

        [columnsInput, rowsInput, iconSizeInput, themeInput, focusColorInput, restorePanelsInput].forEach((input) => {
          input?.addEventListener('input', () => applyLayout());
          input?.addEventListener('change', () => applyLayout());
        });

        document.getElementById('openLaunchpadSettings')?.addEventListener('click', () => {
          post('openSettings');
        });
        document.getElementById('openKeyboardSettings')?.addEventListener('click', () => {
          post('openKeyboardSettings');
        });
        document.querySelectorAll('.shortcutConfig').forEach((button) => {
          button.addEventListener('click', () => {
            post('configureShortcut', { commandId: button.dataset.command });
          });
        });

        apps.forEach((el) => {
          el.addEventListener('click', () => post('open', { path: el.dataset.path }));
          el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            openContextMenu(e, el.dataset.path);
          });
        });

        search?.addEventListener('input', () => {
          applySearch();
          if (visibleApps().length && document.activeElement !== search) {
            focusApp(0);
          }
        });

        window.addEventListener('keydown', (e) => {
          const target = e.target;
          const isSearch = target === search;
          const isInput = target?.tagName === 'INPUT' && !isSearch;
          if (e.key === 'Escape') {
            if (contextPath) {
              closeContextMenu();
            } else if (settingsModal?.classList.contains('visible')) {
              closeSettingsModal();
            } else if (search?.value) {
              typeIntoSearch('');
            } else {
              post('close');
            }
            return;
          }
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            search?.focus();
          }
          if (!isSearch && !isInput && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) {
            e.preventDefault();
            closeContextMenu();
            appendToSearch(e.key);
            focusApp(0);
            return;
          }
          if (!isSearch && !isInput && !e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'Backspace' && search?.value) {
            e.preventDefault();
            closeContextMenu();
            typeIntoSearch(search.value.slice(0, -1));
            focusApp(0);
            return;
          }
          if (isInput || (isSearch && !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key))) {
            return;
          }
          const visible = visibleApps();
          if (!visible.length) return;
          const activeVisibleIndex = visible.indexOf(document.activeElement);
          if (activeVisibleIndex >= 0) {
            focusedIndex = activeVisibleIndex;
          }
          if (e.key === 'ArrowRight') {
            e.preventDefault();
            focusApp(focusedIndex + 1);
          } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            focusApp(focusedIndex - 1);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            focusApp(focusedIndex + layoutColumns);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            focusApp(focusedIndex - layoutColumns);
          } else if (e.key === 'Enter' && document.activeElement?.classList?.contains('app')) {
            e.preventDefault();
            document.activeElement.click();
          }
        });

        applyLayout({ save: false });
        requestAnimationFrame(() => {
          if (apps.length) {
            focusApp(0);
          } else {
            search?.focus();
          }
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
class LaunchpadPanel {
    constructor(context, onDidChangeProjects) {
        this.context = context;
        this.onDidChangeProjects = onDidChangeProjects;
    }
    async open() {
        await maximizeEditorAreaForLaunchpad();
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.One);
            await this.render();
            return;
        }
        this.panel = vscode.window.createWebviewPanel("pkvsconfLaunchpad", "Launchpad", vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true
        });
        this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "icon.png");
        this.panel.onDidDispose(() => {
            this.panel = undefined;
            restorePanelsAfterLaunchpad();
        });
        this.panel.webview.onDidReceiveMessage(async (message) => {
            if (!message || typeof message.command !== "string") {
                return;
            }
            if (message.command === "open" && typeof message.path === "string") {
                if (isCurrentWorkspacePath(message.path)) {
                    await recordLaunchpadOpen(message.path);
                    this.panel?.dispose();
                    return;
                }
                await openProjectInNewWindow(message.path);
            }
            else if (message.command === "reveal" && typeof message.path === "string") {
                await revealProjectInFinder({ name: path.basename(message.path), path: message.path });
            }
            else if (message.command === "addCurrent") {
                await addCurrentWorkspaceToLaunchpad();
                await this.onDidChangeProjects();
                await this.render();
            }
            else if (message.command === "addFolder") {
                await addFolderToLaunchpad();
                await this.onDidChangeProjects();
                await this.render();
            }
            else if (message.command === "remove") {
                await removeProjectFromLaunchpad();
                await this.onDidChangeProjects();
                await this.render();
            }
            else if (message.command === "removePath" && typeof message.path === "string") {
                await removeProjectFromLaunchpadByPath(message.path);
                await this.onDidChangeProjects();
                await this.render();
            }
            else if (message.command === "refresh") {
                await this.render();
            }
            else if (message.command === "layout") {
                await setLaunchpadLayoutSettings({
                    columns: typeof message.columns === "number" ? message.columns : undefined,
                    rows: typeof message.rows === "number" ? message.rows : undefined,
                    iconSize: typeof message.iconSize === "number" ? message.iconSize : undefined,
                    focusColor: typeof message.focusColor === "string" ? message.focusColor : undefined,
                    theme: message.theme === "classic" || message.theme === "sleek" ? message.theme : undefined,
                    restorePanels: message.restorePanels === "none" || message.restorePanels === "left" || message.restorePanels === "right" || message.restorePanels === "both" ? message.restorePanels : undefined
                });
            }
            else if (message.command === "openSettings") {
                await vscode.commands.executeCommand("workbench.action.openSettings", "pkvsconf.launchpad");
            }
            else if (message.command === "openKeyboardSettings") {
                await vscode.commands.executeCommand("workbench.action.openGlobalKeybindings", "pkvsconf.launchpad");
            }
            else if (message.command === "configureShortcut" && typeof message.commandId === "string") {
                await vscode.commands.executeCommand("workbench.action.openGlobalKeybindings", `@command:${message.commandId}`);
            }
            else if (message.command === "close") {
                this.panel?.dispose();
            }
        });
        await this.render();
    }
    async render() {
        if (!this.panel) {
            return;
        }
        const projects = getSortedLaunchpadProjects();
        this.panel.webview.html = await buildLaunchpadPanelHtml(this.panel.webview, projects);
    }
    async refresh() {
        await this.render();
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
class GitignoreDecorationProvider {
    constructor(workspaceRoot) {
        this.workspaceRoot = workspaceRoot;
        this.ignoredPaths = new Set();
        this._onDidChangeFileDecorations = new vscode.EventEmitter();
        this.onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;
    }
    execGit(cmd) {
        return new Promise((resolve) => {
            cp.exec(cmd, { cwd: this.workspaceRoot, maxBuffer: 50 * 1024 * 1024 }, (_err, stdout) => {
                resolve(stdout || "");
            });
        });
    }
    async refresh() {
        const root = this.workspaceRoot;
        const newSet = new Set();
        const out = await this.execGit("git ls-files --others -i --exclude-standard --directory");
        for (const line of out.split("\n")) {
            const p = line.trim().replace(/\/+$/, "");
            if (p) {
                newSet.add(path.join(root, p));
            }
        }
        this.ignoredPaths = newSet;
        this._onDidChangeFileDecorations.fire(undefined);
    }
    provideFileDecoration(uri) {
        if (this.ignoredPaths.has(uri.fsPath)) {
            return {
                badge: "⊘",
                tooltip: "Ignoré par Git (.gitignore)",
                color: new vscode.ThemeColor("gitDecoration.ignoredResourceForeground"),
            };
        }
        return undefined;
    }
}
function activate(context) {
    (0, kanban_1.registerKanban)(context);
    // Gitignore decoration provider
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
        const gitignoreProvider = new GitignoreDecorationProvider(workspaceRoot);
        context.subscriptions.push(vscode.window.registerFileDecorationProvider(gitignoreProvider));
        void gitignoreProvider.refresh();
        const gitignoreWatcher = vscode.workspace.createFileSystemWatcher("**/.gitignore");
        gitignoreWatcher.onDidChange(() => void gitignoreProvider.refresh());
        gitignoreWatcher.onDidCreate(() => void gitignoreProvider.refresh());
        gitignoreWatcher.onDidDelete(() => void gitignoreProvider.refresh());
        context.subscriptions.push(gitignoreWatcher);
        // Refresh when files are created/deleted (new files may match ignore patterns)
        const fileWatcher = vscode.workspace.createFileSystemWatcher("**/*");
        let debounceTimer;
        fileWatcher.onDidCreate(() => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => void gitignoreProvider.refresh(), 500);
        });
        fileWatcher.onDidDelete(() => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => void gitignoreProvider.refresh(), 500);
        });
        context.subscriptions.push(fileWatcher);
    }
    const provider = new ProjectIconViewProvider();
    let watcher;
    const tagsStore = new ExtensionTagsStore(context);
    const categoriesProvider = new ExtensionCategoriesWebviewProvider(tagsStore, context.extensionUri);
    const launchpadProvider = new LaunchpadWebviewProvider(context);
    const launchpadPanel = new LaunchpadPanel(context, async () => {
        await launchpadProvider.refreshCurrentView();
    });
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
    rootSizeItem.tooltip = "Click to open the root folder in Finder";
    rootSizeItem.command = "revealInFinderButton.openRootFolderInFinder";
    rootSizeItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    rootSizeItem.show();
    const previewItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    previewItem.text = "$(open-preview) Preview";
    previewItem.tooltip = "Lancer une preview de la page en cours";
    previewItem.command = "pkvsconf.previewActivePage";
    previewItem.show();
    const titlebarColorItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
    titlebarColorItem.text = "$(symbol-color) Title Bar";
    titlebarColorItem.tooltip = "Changer la couleur de la barre de titre (aléatoire)";
    titlebarColorItem.command = "pkvsconf.regenerateWorkspaceTitlebarColor";
    titlebarColorItem.show();
    // Secrets Detection Status Bar Item
    const secretsItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 96);
    secretsItem.text = "$(shield) Secrets: --";
    secretsItem.tooltip = "Détection des secrets exposés";
    secretsItem.command = "pkvsconf.showExposedSecrets";
    secretsItem.show();
    // Agent Skills Status Bar Item
    const skillsSymlinkItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 95);
    skillsSymlinkItem.text = "$(link) Agent Skills";
    skillsSymlinkItem.tooltip = "Créer un lien symbolique .agent vers le dossier -agent";
    skillsSymlinkItem.command = "pkvsconf.createSkillsSymlink";
    skillsSymlinkItem.show();
    const launchpadListItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 94);
    launchpadListItem.text = "$(list-unordered) Projets";
    launchpadListItem.tooltip = "Ouvrir l'ancienne liste du Launchpad";
    launchpadListItem.command = "pkvsconf.launchpadOpenList";
    launchpadListItem.show();
    const launchpadItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 93);
    launchpadItem.text = "$(rocket) Launchpad";
    launchpadItem.tooltip = "Ouvrir le Launchpad projets en plein écran";
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
        rootSizeItem.tooltip = `Click to open in Finder\nRoot: ${workspaceUri.fsPath}`;
        try {
            const result = await getDirectorySizeBytes(workspaceUri.fsPath);
            const formatted = formatBytes(result.total);
            rootSizeItem.text = `Root size: ${formatted}`;
            if (result.hadError) {
                rootSizeItem.tooltip = `Click to open in Finder\nRoot: ${workspaceUri.fsPath}\nSome folders could not be read.`;
            }
            else {
                rootSizeItem.tooltip = `Click to open in Finder\nRoot: ${workspaceUri.fsPath}`;
            }
        }
        finally {
            rootSizeInProgress = false;
        }
    };
    const openRootFolderInFinder = async () => {
        const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!workspaceUri) {
            vscode.window.showWarningMessage("Aucun workspace ouvert.");
            return;
        }
        if (workspaceUri.scheme !== "file") {
            vscode.window.showWarningMessage("Ouverture Finder indisponible pour ce workspace distant ou virtuel.");
            return;
        }
        await vscode.env.openExternal(workspaceUri);
    };
    const refreshCmd = vscode.commands.registerCommand("revealInFinderButton.refreshRootSize", refreshRootSize);
    const openRootFolderCmd = vscode.commands.registerCommand("revealInFinderButton.openRootFolderInFinder", openRootFolderInFinder);
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
        await launchpadPanel.refresh();
    }
    const launchpadOpenCmd = vscode.commands.registerCommand("pkvsconf.launchpadOpen", async (project) => {
        if (project) {
            await openProjectInNewWindow(project.path);
            return;
        }
        await launchpadPanel.open();
    });
    const launchpadOpenListCmd = vscode.commands.registerCommand("pkvsconf.launchpadOpenList", async () => {
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
    const launchpadRemoveCmd = vscode.commands.registerCommand("pkvsconf.launchpadRemove", async () => {
        await removeProjectFromLaunchpad();
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
        let uri = vscode.window.activeTextEditor?.document.uri;
        if (!uri) {
            for (const group of vscode.window.tabGroups.all) {
                const tabUri = group.activeTab?.input?.uri;
                if (tabUri) {
                    uri = tabUri;
                    break;
                }
            }
        }
        if (!uri) {
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
            const folders = vscode.workspace.workspaceFolders;
            if (folders?.length === 1) {
                uri = folders[0].uri;
            }
            else if (folders && folders.length > 1) {
                const pick = await vscode.window.showQuickPick(folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })), { placeHolder: "Reveal which workspace folder?" });
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
    const openInDefaultBrowserCmd = vscode.commands.registerCommand("pkvsconf.openInDefaultBrowser", async (uri) => {
        const targetUri = uri || vscode.window.activeTextEditor?.document.uri;
        if (!targetUri) {
            vscode.window.showInformationMessage("Aucun fichier ouvert pour ouvrir dans le navigateur.");
            return;
        }
        const filePath = targetUri.fsPath;
        if (process.platform === "darwin") {
            cp.exec(`open -a "Google Chrome" "${filePath}"`, (err) => {
                if (err) {
                    cp.exec(`open -a "Chromium" "${filePath}"`, (err2) => {
                        if (err2) {
                            vscode.env.openExternal(targetUri);
                        }
                    });
                }
            });
        }
        else if (process.platform === "win32") {
            cp.exec(`start chrome "${filePath}"`, { shell: "cmd" }, (err) => {
                if (err) {
                    vscode.env.openExternal(targetUri);
                }
            });
        }
        else {
            cp.exec(`google-chrome "${filePath}" || chromium "${filePath}"`, (err) => {
                if (err) {
                    vscode.env.openExternal(targetUri);
                }
            });
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
            "/OPENCODE.md",
            // Additional patterns from VS_pkspecs
            ".*",
            ".DS_Store",
            "node_modules/",
            "dist/",
            "build/",
            ".env",
            ".venv/",
            "__pycache__/",
            "*.log"
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
        // Create VERSION file if it doesn't exist (from VS_pkspecs)
        let versionCreated = false;
        try {
            const versionPath = path.join(workspaceRoot, "VERSION");
            await fs.access(versionPath);
        }
        catch {
            try {
                await fs.writeFile(path.join(workspaceRoot, "VERSION"), "0.10", "utf8");
                versionCreated = true;
            }
            catch (error) {
                vscode.window.showWarningMessage(`Impossible de créer VERSION: ${error}`);
            }
        }
        // Create CHANGELOG.md if it doesn't exist (from VS_pkspecs)
        let changelogCreated = false;
        try {
            const changelogPath = path.join(workspaceRoot, "CHANGELOG.md");
            await fs.access(changelogPath);
        }
        catch {
            try {
                const today = new Date().toISOString().split("T")[0];
                const changelogContent = `# Changelog\n\n## [0.10] - ${today}\n### Added\n- Initial project scaffold\n`;
                await fs.writeFile(path.join(workspaceRoot, "CHANGELOG.md"), changelogContent, "utf8");
                changelogCreated = true;
            }
            catch (error) {
                vscode.window.showWarningMessage(`Impossible de créer CHANGELOG.md: ${error}`);
            }
        }
        const symlinkStatus = symlinkCreated
            ? "Lien symbolique '.agent' créé"
            : symlinkUpdated
                ? "Lien symbolique '.agent' mis à jour"
                : symlinkSkipped
                    ? "Dossier '.agent' local conservé (pas de symlink)"
                    : "Lien symbolique '.agent' déjà présent";
        const extraParts = [];
        if (agentFilesLinked)
            extraParts.push("fichiers AGENT/LLM linkés");
        if (versionCreated)
            extraParts.push("VERSION créé");
        if (changelogCreated)
            extraParts.push("CHANGELOG.md créé");
        const extraMsg = extraParts.length > 0 ? `, .gitignore mis à jour${extraParts.length ? ", " + extraParts.join(", ") : ""}` : "";
        if (extraParts.length > 0) {
            vscode.window.showInformationMessage(`${symlinkStatus}${extraMsg}.`);
        }
        else if (agentFilesLinked) {
            vscode.window.showInformationMessage(`${symlinkStatus}, .gitignore mis à jour, et fichiers AGENT/LLM linkés.`);
        }
        else {
            vscode.window.showInformationMessage(`${symlinkStatus}, .gitignore mis à jour.`);
        }
    });
    const addToGitignoreCmd = vscode.commands.registerCommand("pkvsconf.addToGitignore", async (uri) => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder || workspaceFolder.uri.scheme !== "file") {
            vscode.window.showErrorMessage("Ajout au .gitignore impossible : aucun workspace local ouvert.");
            return;
        }
        const targetUri = uri || vscode.window.activeTextEditor?.document.uri;
        if (!targetUri) {
            vscode.window.showErrorMessage("Aucun fichier ou dossier sélectionné pour ajouter au .gitignore.");
            return;
        }
        const workspaceRoot = workspaceFolder.uri.fsPath;
        const relativePath = path.relative(workspaceRoot, targetUri.fsPath).split(path.sep).join("/");
        const normalized = relativePath.replace(/\/+$/, "");
        const entry = normalized.endsWith("/") ? normalized : `${normalized}/`;
        const gitignorePath = path.join(workspaceRoot, ".gitignore");
        try {
            let existing = "";
            try {
                existing = await fs.readFile(gitignorePath, "utf8");
            }
            catch (error) {
                if (error && error.code !== "ENOENT") {
                    throw error;
                }
            }
            const lines = existing.split(/\r?\n/).map((line) => line.trim());
            if (lines.includes(entry) || lines.includes(entry.replace(/\/$/, ""))) {
                vscode.window.showInformationMessage(`${entry} est déjà présent dans .gitignore.`);
                return;
            }
            const needsNewline = existing.length > 0 && !existing.endsWith("\n");
            const updated = `${existing}${needsNewline ? "\n" : ""}${entry}\n`;
            await fs.writeFile(gitignorePath, updated, "utf8");
            vscode.window.showInformationMessage(`${entry} ajouté au .gitignore.`);
        }
        catch (error) {
            vscode.window.showErrorMessage(`Erreur lors de l'ajout au .gitignore : ${error}`);
        }
    });
    const terminalSplitRightCmd = vscode.commands.registerCommand("pkvsconf.terminalSplitRight", async () => {
        await vscode.commands.executeCommand("workbench.action.terminal.split");
    });
    const terminalNewTabCmd = vscode.commands.registerCommand("pkvsconf.terminalNewTab", async () => {
        await vscode.commands.executeCommand("workbench.action.terminal.new");
        await vscode.commands.executeCommand("workbench.action.terminal.moveToEditor");
    });
    const terminalSplitBottomCmd = vscode.commands.registerCommand("pkvsconf.terminalSplitBottom", async () => {
        // VS Code can't split a *single* terminal buffer vertically like tmux.
        // Crée un terminal dans un panneau en dessous
        await vscode.commands.executeCommand("workbench.action.terminal.newInActiveGroup");
    });
    const statusBarTerm = vscode.window.createStatusBarItem("pkvsconf.statusBarTerm", vscode.StatusBarAlignment.Left, 99);
    statusBarTerm.text = "$(terminal) Term";
    statusBarTerm.tooltip = "Open Terminal in New Editor Tab";
    statusBarTerm.command = "pkvsconf.terminalNewTab";
    statusBarTerm.show();
    context.subscriptions.push(statusBarTerm);
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
    }), refreshCmd, openRootFolderCmd, previewActivePageCmd, openInDefaultBrowserCmd, addToGitignoreCmd, terminalSplitRightCmd, terminalNewTabCmd, terminalSplitBottomCmd);
}
function deactivate() { }
//# sourceMappingURL=extension.js.map