import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import * as readline from "readline";
import { spawnSync } from "child_process";

type CardStatus = "backlog" | "in_progress" | "in_review" | "done";

type CardEvent = {
  at: string;
  type: string;
  detail?: string;
};

type KanbanCard = {
  id: string;
  title: string;
  prompt: string;
  notes: string;
  status: CardStatus;
  createdAt: string;
  updatedAt: string;
  sessionName?: string;
  events: CardEvent[];
};

type KanbanBoard = {
  version: 1;
  cards: KanbanCard[];
};

const STATUSES: CardStatus[] = ["backlog", "in_progress", "in_review", "done"];
const STATUS_LABELS: Record<CardStatus, string> = {
  backlog: "BACKLOG",
  in_progress: "IN PROGRESS",
  in_review: "IN REVIEW",
  done: "DONE"
};
const COLORS: Record<CardStatus, string> = {
  backlog: "\u001b[38;5;250m",
  in_progress: "\u001b[38;5;45m",
  in_review: "\u001b[38;5;214m",
  done: "\u001b[38;5;78m"
};
const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const INVERSE = "\u001b[7m";

function now(): string {
  return new Date().toISOString();
}

function parseWorkspace(argv: string[]): string | undefined {
  const index = argv.indexOf("--workspace");
  return index >= 0 ? argv[index + 1] : undefined;
}

function truncate(value: string, width: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (width <= 1) return normalized.slice(0, Math.max(width, 0));
  return normalized.length > width ? `${normalized.slice(0, width - 1)}…` : normalized;
}

function splitCommandLine(command: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        result.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("Commande agent invalide: guillemet non ferme.");
  if (current) result.push(current);
  return result;
}

function shellQuoteToken(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

class KanbanStore {
  readonly directory: string;
  readonly filePath: string;
  readonly promptDirectory: string;

  constructor(readonly workspace: string) {
    this.directory = path.join(workspace, ".pkvsconf");
    this.filePath = path.join(this.directory, "kanban.json");
    this.promptDirectory = path.join(this.directory, "prompts");
  }

  async load(): Promise<KanbanBoard> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8")) as Partial<KanbanBoard>;
      if (parsed.version !== 1 || !Array.isArray(parsed.cards)) {
        throw new Error("format non pris en charge");
      }
      return { version: 1, cards: parsed.cards as KanbanCard[] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, cards: [] };
      }
      throw new Error(`Impossible de lire ${this.filePath}: ${(error as Error).message}`);
    }
  }

  async save(board: KanbanBoard): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(board, null, 2)}\n`, "utf8");
    await fs.rename(temporary, this.filePath);
  }

  async writePrompt(card: KanbanCard): Promise<string> {
    await fs.mkdir(this.promptDirectory, { recursive: true });
    const promptPath = path.join(this.promptDirectory, `${card.id}.md`);
    const content = `# ${card.title}\n\n${card.prompt}\n${card.notes ? `\n## Notes\n\n${card.notes}\n` : ""}`;
    await fs.writeFile(promptPath, content, "utf8");
    return promptPath;
  }
}

class Runtime {
  private readonly tmux = process.env.PK_KANBAN_TMUX_COMMAND?.trim() || "tmux";
  private readonly agentTemplate = process.env.PK_KANBAN_AGENT_COMMAND?.trim()
    || "opencode --prompt {prompt}";

  constructor(private readonly store: KanbanStore) {}

  sessionName(card: KanbanCard): string {
    if (card.sessionName) return card.sessionName;
    const project = path.basename(this.store.workspace).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 18);
    const digest = crypto.createHash("sha1").update(this.store.workspace).digest("hex").slice(0, 6);
    return `pk-${project}-${digest}-${card.id.slice(0, 8)}`.slice(0, 64);
  }

  hasSession(card: KanbanCard): boolean {
    const result = spawnSync(this.tmux, ["has-session", "-t", this.sessionName(card)], {
      stdio: "ignore"
    });
    return result.status === 0;
  }

  activeSessions(): Set<string> {
    const result = spawnSync(this.tmux, ["list-sessions", "-F", "#{session_name}"], {
      encoding: "utf8"
    });
    if (result.status !== 0) return new Set();
    return new Set(result.stdout.split("\n").map((name) => name.trim()).filter(Boolean));
  }

  async ensureSession(card: KanbanCard): Promise<{ created: boolean; message: string }> {
    const sessionName = this.sessionName(card);
    card.sessionName = sessionName;
    if (this.hasSession(card)) return { created: false, message: "Session existante conservee." };

    const promptFile = await this.store.writePrompt(card);
    const command = splitCommandLine(this.agentTemplate).map((argument) => argument
      .split("{prompt}").join(card.prompt)
      .split("{promptFile}").join(promptFile)
      .split("{title}").join(card.title));
    if (command.length === 0) throw new Error("La commande agent est vide.");
    const shellCommand = command.map(shellQuoteToken).join(" ");

    const result = spawnSync(this.tmux, [
      "new-session", "-d", "-s", sessionName, "-c", this.store.workspace, shellCommand
    ], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(result.stderr?.trim() || `Impossible de lancer ${this.tmux}.`);
    }
    return { created: true, message: `Session ${sessionName} lancee.` };
  }

  attach(card: KanbanCard): void {
    if (!this.hasSession(card)) throw new Error("Aucune session active pour cette carte.");
    spawnSync(this.tmux, ["attach-session", "-t", this.sessionName(card)], { stdio: "inherit" });
  }

  feedback(card: KanbanCard, message: string): void {
    if (!this.hasSession(card)) throw new Error("Aucune session active pour cette carte.");
    const result = spawnSync(this.tmux, [
      "send-keys", "-t", this.sessionName(card), "--", message, "Enter"
    ], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr?.trim() || "Envoi impossible.");
  }

  kill(card: KanbanCard): boolean {
    if (!this.hasSession(card)) return false;
    const result = spawnSync(this.tmux, ["kill-session", "-t", this.sessionName(card)], {
      encoding: "utf8"
    });
    if (result.status !== 0) throw new Error(result.stderr?.trim() || "Arret impossible.");
    return true;
  }
}

class KanbanTui {
  private board: KanbanBoard = { version: 1, cards: [] };
  private column = 0;
  private row = 0;
  private busy = false;
  private handlingKey = false;
  private message = "";
  private readonly runtime: Runtime;

  constructor(private readonly store: KanbanStore) {
    this.runtime = new Runtime(store);
  }

  async run(): Promise<void> {
    this.board = await this.store.load();
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", this.onKeypress);
    process.stdout.on("resize", this.render);
    process.on("SIGINT", this.exit);
    this.render();
  }

  private cards(status = STATUSES[this.column]): KanbanCard[] {
    return this.board.cards
      .filter((card) => card.status === status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private selected(): KanbanCard | undefined {
    return this.cards()[this.row];
  }

  private normalizeSelection(): void {
    const count = this.cards().length;
    this.row = Math.max(0, Math.min(this.row, Math.max(0, count - 1)));
  }

  private render = (): void => {
    const width = process.stdout.columns || 120;
    const height = process.stdout.rows || 36;
    const gap = 1;
    const columnWidth = Math.max(18, Math.floor((width - gap * 3) / 4));
    const visibleRows = Math.max(3, Math.min(12, height - 14));
    const lines: string[] = [
      "\u001b[2J\u001b[H",
      `${BOLD}PK KANBAN${RESET}  ${DIM}${truncate(this.store.workspace, Math.max(20, width - 12))}${RESET}`,
      ""
    ];
    const columns = STATUSES.map((status) => this.cards(status));
    const activeSessions = this.runtime.activeSessions();

    lines.push(STATUSES.map((status, index) => {
      const active = index === this.column ? INVERSE : "";
      const title = ` ${STATUS_LABELS[status]} ${columns[index].length} `;
      return `${COLORS[status]}${active}${truncate(title, columnWidth).padEnd(columnWidth)}${RESET}`;
    }).join(" "));

    for (let line = 0; line < visibleRows; line += 1) {
      lines.push(STATUSES.map((status, columnIndex) => {
        const card = columns[columnIndex][line];
        if (!card) return " ".repeat(columnWidth);
        const selected = columnIndex === this.column && line === this.row;
        const runtime = card.sessionName && activeSessions.has(card.sessionName) ? "●" : " ";
        const text = `${runtime} ${card.title}`;
        return `${selected ? INVERSE : ""}${truncate(text, columnWidth).padEnd(columnWidth)}${RESET}`;
      }).join(" "));
    }

    const card = this.selected();
    lines.push("", `${DIM}${"─".repeat(Math.min(width, 120))}${RESET}`);
    if (card) {
      lines.push(`${BOLD}${truncate(card.title, width)}${RESET}`);
      lines.push(`${DIM}Prompt:${RESET} ${truncate(card.prompt || "-", width - 8)}`);
      lines.push(`${DIM}Notes:${RESET} ${truncate(card.notes || "-", width - 7)}`);
      lines.push(`${DIM}Session:${RESET} ${card.sessionName || "non demarree"}`);
    } else {
      lines.push(`${DIM}Aucune carte dans cette colonne.${RESET}`);
    }
    lines.push(
      "",
      `${BOLD}N${RESET} nouvelle  ${BOLD}E${RESET} modifier  ${BOLD}[ ]${RESET} deplacer  ${BOLD}Enter${RESET} ouvrir  ${BOLD}R${RESET} revue  ${BOLD}X${RESET} arreter  ${BOLD}Q${RESET} quitter`,
      this.message ? `${COLORS.in_review}${truncate(this.message, width)}${RESET}` : ""
    );
    process.stdout.write(lines.join("\n"));
  };

  private onKeypress = async (_text: string, key: readline.Key): Promise<void> => {
    if (this.busy || this.handlingKey) return;
    this.handlingKey = true;
    if (key.ctrl && key.name === "c") return this.exit();
    try {
      this.message = "";
      if (key.name === "q" || key.name === "escape") return this.exit();
      if (key.name === "left" || key.name === "h") {
        this.column = Math.max(0, this.column - 1);
        this.row = 0;
      } else if (key.name === "right" || key.name === "l") {
        this.column = Math.min(STATUSES.length - 1, this.column + 1);
        this.row = 0;
      } else if (key.name === "up" || key.name === "k") {
        this.row = Math.max(0, this.row - 1);
      } else if (key.name === "down" || key.name === "j") {
        this.row += 1;
        this.normalizeSelection();
      } else if (key.name === "n") await this.createCard();
      else if (key.name === "e") await this.editCard();
      else if (key.name === "delete" || key.name === "backspace") await this.deleteCard();
      else if (key.sequence === "[") await this.moveCard(-1);
      else if (key.sequence === "]") await this.moveCard(1);
      else if (key.name === "return") await this.openCard();
      else if (key.name === "r") await this.reviewMenu();
      else if (key.name === "x") await this.stopRuntime();
    } catch (error) {
      this.message = (error as Error).message;
    }
    this.normalizeSelection();
    this.render();
    this.handlingKey = false;
  };

  private async question(label: string, value = ""): Promise<string | undefined> {
    this.busy = true;
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write("\u001b[2J\u001b[H");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${label}${value ? ` [${value}]` : ""}: `, resolve);
    });
    rl.close();
    process.stdin.resume();
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    this.busy = false;
    const trimmed = answer.trim();
    return trimmed || value || undefined;
  }

  private async confirm(label: string): Promise<boolean> {
    const answer = await this.question(`${label} (o/N)`);
    return answer?.toLowerCase() === "o" || answer?.toLowerCase() === "oui";
  }

  private async mutate(action: (board: KanbanBoard) => void | Promise<void>): Promise<void> {
    this.board = await this.store.load();
    await action(this.board);
    await this.store.save(this.board);
  }

  private async createCard(): Promise<void> {
    const title = await this.question("Titre de la feature");
    if (!title) return;
    const prompt = await this.question("Prompt pour l'agent", title) || title;
    const notes = await this.question("Notes (optionnel)") || "";
    const timestamp = now();
    const card: KanbanCard = {
      id: crypto.randomUUID(), title, prompt, notes, status: "backlog",
      createdAt: timestamp, updatedAt: timestamp,
      events: [{ at: timestamp, type: "created", detail: "Carte creee dans Backlog" }]
    };
    await this.mutate((board) => {
      board.cards.push(card);
    });
    this.column = 0;
    this.row = 0;
    this.message = "Carte ajoutee au Backlog.";
  }

  private async editCard(): Promise<void> {
    const selected = this.selected();
    if (!selected) return;
    const title = await this.question("Titre", selected.title);
    if (!title) return;
    const prompt = await this.question("Prompt", selected.prompt) || selected.prompt;
    const notes = await this.question("Notes", selected.notes) || "";
    await this.mutate((board) => {
      const card = board.cards.find((item) => item.id === selected.id);
      if (!card) return;
      card.title = title;
      card.prompt = prompt;
      card.notes = notes;
      card.updatedAt = now();
      card.events.push({ at: card.updatedAt, type: "edited" });
    });
    this.message = "Carte mise a jour.";
  }

  private async deleteCard(): Promise<void> {
    const card = this.selected();
    if (!card || !(await this.confirm(`Supprimer definitivement « ${card.title} » ?`))) return;
    if (this.runtime.hasSession(card)) {
      if (!(await this.confirm("Une session est active. La tuer aussi ?"))) return;
      this.runtime.kill(card);
    }
    await this.mutate((board) => {
      board.cards = board.cards.filter((item) => item.id !== card.id);
    });
    this.message = "Carte supprimee.";
  }

  private async moveCard(direction: -1 | 1): Promise<void> {
    const selected = this.selected();
    if (!selected) return;
    const currentIndex = STATUSES.indexOf(selected.status);
    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= STATUSES.length) return;
    const target = STATUSES[nextIndex];
    if (target === "done" && !(await this.confirm("Passer en Done et fermer sa session ?"))) return;

    await this.mutate(async (board) => {
      const card = board.cards.find((item) => item.id === selected.id);
      if (!card) return;
      if (target === "in_progress") {
        const runtime = await this.runtime.ensureSession(card);
        card.events.push({ at: now(), type: "runtime_started", detail: runtime.message });
      }
      if (target === "done") {
        const killed = this.runtime.kill(card);
        card.events.push({ at: now(), type: "runtime_cleaned", detail: killed ? "Session fermee" : "Aucune session active" });
      }
      const previous = card.status;
      card.status = target;
      card.updatedAt = now();
      card.events.push({ at: card.updatedAt, type: "moved", detail: `${previous} -> ${target}` });
    });
    this.column = nextIndex;
    this.row = 0;
    this.message = `Carte deplacee vers ${STATUS_LABELS[target]}.`;
  }

  private async openCard(): Promise<void> {
    const selected = this.selected();
    if (!selected) return;
    if (selected.status === "backlog") {
      this.message = "Deplacez d'abord la carte vers In Progress avec ].";
      return;
    }
    if (!this.runtime.hasSession(selected)) {
      await this.mutate(async (board) => {
        const card = board.cards.find((item) => item.id === selected.id);
        if (!card) return;
        const runtime = await this.runtime.ensureSession(card);
        card.events.push({ at: now(), type: "runtime_restarted", detail: runtime.message });
      });
      this.board = await this.store.load();
    }
    const card = this.board.cards.find((item) => item.id === selected.id);
    if (!card) return;
    this.busy = true;
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write("\u001b[2J\u001b[H");
    this.runtime.attach(card);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    this.busy = false;
    this.message = "Retour au Kanban.";
  }

  private async reviewMenu(): Promise<void> {
    const card = this.selected();
    if (!card) return;
    const action = await this.question("Revue: (d)iff, (f)eedback, (c)ommit, (p)ush, (h)istorique");
    if (!action) return;
    if (action.toLowerCase() === "d") {
      await this.runVisible("git", ["diff", "--stat", "--", "."]);
      await this.runVisible("git", ["diff", "--", "."]);
    } else if (action.toLowerCase() === "f") {
      const feedback = await this.question("Feedback a envoyer a l'agent");
      if (!feedback) return;
      this.runtime.feedback(card, feedback);
      await this.record(card.id, "feedback", feedback);
      this.message = "Feedback envoye.";
    } else if (action.toLowerCase() === "c") {
      const commitMessage = await this.question("Message de commit", card.title);
      if (!commitMessage || !(await this.confirm("Indexer tous les changements et creer le commit ?"))) return;
      this.runChecked("git", ["add", "-A"]);
      this.runChecked("git", ["commit", "-m", commitMessage]);
      await this.record(card.id, "commit", commitMessage);
      this.message = "Commit cree.";
    } else if (action.toLowerCase() === "p") {
      if (!(await this.confirm("Pousser la branche courante ?"))) return;
      this.runChecked("git", ["push"]);
      await this.record(card.id, "push", "git push termine");
      this.message = "Push termine.";
    } else if (action.toLowerCase() === "h") {
      await this.showHistory(card);
    }
  }

  private async stopRuntime(): Promise<void> {
    const card = this.selected();
    if (!card || !this.runtime.hasSession(card)) {
      this.message = "Aucune session active.";
      return;
    }
    if (!(await this.confirm(`Arreter la session ${card.sessionName} ?`))) return;
    this.runtime.kill(card);
    await this.record(card.id, "runtime_stopped", "Session arretee manuellement");
    this.message = "Session arretee; la carte est conservee.";
  }

  private async record(cardId: string, type: string, detail?: string): Promise<void> {
    await this.mutate((board) => {
      const card = board.cards.find((item) => item.id === cardId);
      if (!card) return;
      card.updatedAt = now();
      card.events.push({ at: card.updatedAt, type, detail });
    });
  }

  private runChecked(command: string, args: string[]): void {
    const result = spawnSync(command, args, { cwd: this.store.workspace, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr?.trim() || `${command} a echoue.`);
  }

  private async runVisible(command: string, args: string[]): Promise<void> {
    this.busy = true;
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write("\u001b[2J\u001b[H");
    spawnSync(command, args, { cwd: this.store.workspace, stdio: "inherit" });
    await this.waitForEnter();
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    this.busy = false;
  }

  private async showHistory(card: KanbanCard): Promise<void> {
    this.busy = true;
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write("\u001b[2J\u001b[H");
    process.stdout.write(`${BOLD}${card.title}${RESET}\n\n`);
    for (const event of card.events) {
      process.stdout.write(`${event.at}  ${event.type}${event.detail ? `  ${event.detail}` : ""}\n`);
    }
    await this.waitForEnter();
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    this.busy = false;
  }

  private async waitForEnter(): Promise<void> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise<void>((resolve) => rl.question("\nEntree pour revenir au Kanban...", () => resolve()));
    rl.close();
    process.stdin.resume();
  }

  private exit = (): never => {
    process.stdin.removeListener("keypress", this.onKeypress);
    process.stdout.removeListener("resize", this.render);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write("\u001b[2J\u001b[H");
    process.exit(0);
  };
}

async function main(): Promise<void> {
  const workspace = parseWorkspace(process.argv.slice(2));
  if (!workspace) throw new Error("Usage: kanbanTui.js --workspace <dossier>");
  const stat = await fs.stat(workspace);
  if (!stat.isDirectory()) throw new Error(`Workspace invalide: ${workspace}`);
  await new KanbanTui(new KanbanStore(path.resolve(workspace))).run();
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`PK Kanban: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
