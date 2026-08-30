import { execFile } from "child_process";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

export interface AgentSessionHistoryEntry {
  source: "opencode" | "codex";
  id: string;
  title: string;
  updatedAt: number;
  detail: string;
  resumeCommand: string;
}

export const lastSessionCollectDiagnostics: Record<string, string | number> = {};

function runSqlite(
  db: string,
  sql: string,
  onResult: (err: Error | null, stdout: string) => void
): void {
  const tryBin = (bin: string) =>
    execFile(
      bin,
      ["-readonly", "-json", db, sql],
      { maxBuffer: 16 * 1024 * 1024, timeout: 5000 },
      (err, stdout) => {
        if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT" && bin === "sqlite3") {
          tryBin("/usr/bin/sqlite3");
          return;
        }
        onResult(err as Error | null, stdout ?? "");
      }
    );
  tryBin("sqlite3");
}

function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

function formatTokens(tokens: number): string {
  if (!tokens) return "";
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M tok`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k tok`;
  return `${tokens} tok`;
}

async function collectOpenCodeSessions(
  roots: string[]
): Promise<AgentSessionHistoryEntry[]> {
  const db = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
  lastSessionCollectDiagnostics.dbPath = db;
  try {
    await fsp.access(db, fs.constants.R_OK);
    lastSessionCollectDiagnostics.dbExists = 1;
  } catch {
    lastSessionCollectDiagnostics.dbExists = 0;
    return [];
  }
  const where = roots
    .map((root) => {
      const esc = sqlEscape(root);
      return `directory = '${esc}' OR directory LIKE '${esc}/%'`;
    })
    .join(" OR ");
  const sql =
    "SELECT id, title, time_updated, json_extract(model,'$.id') AS model, " +
    "tokens_input + tokens_output AS tokens " +
    `FROM session WHERE ${where} ` +
    "ORDER BY time_updated DESC LIMIT 50";
  return await new Promise((resolve) => {
    runSqlite(db, sql, (err, stdout) => {
      if (err) {
        lastSessionCollectDiagnostics.openCodeError = String(err.message || err).slice(0, 200);
        return resolve([]);
      }
      delete lastSessionCollectDiagnostics.openCodeError;
      if (!stdout.trim()) return resolve([]);
      try {
        const rows = JSON.parse(stdout) as Array<Record<string, unknown>>;
        resolve(
          rows.map((row) => {
            const id = String(row.id);
            const tokens = Number(row.tokens) || 0;
            const model = row.model ? String(row.model) : "";
            return {
              source: "opencode" as const,
              id,
              title: String(row.title || "(sans titre)"),
              updatedAt: Number(row.time_updated) || 0,
              detail: [model, formatTokens(tokens)].filter(Boolean).join(" · "),
              resumeCommand: `opencode -s ${id}`
            };
          })
        );
      } catch {
        resolve([]);
      }
    });
  });
}

function readFirstLine(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const chunk = 64 * 1024;
      let text = "";
      const buf = Buffer.alloc(chunk);
      while (text.length < 4 * 1024 * 1024) {
        const read = fs.readSync(fd, buf, 0, chunk, Buffer.byteLength(text));
        if (read <= 0) return text;
        text += buf.toString("utf8", 0, read);
        const nl = text.indexOf("\n");
        if (nl !== -1) return text.slice(0, nl);
      }
      return null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

async function readCodexThreadNames(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const raw = await fsp.readFile(
      path.join(os.homedir(), ".codex", "session_index.jsonl"),
      "utf8"
    );
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { id?: string; thread_name?: string };
        if (parsed.id) map.set(parsed.id, parsed.thread_name || "");
      } catch {
        /* ligne partielle, on ignore */
      }
    }
  } catch {
    /* pas d'index, on retombe sur (sans titre) */
  }
  return map;
}

function extractCodexFirstUserMessage(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 20 * 1024 * 1024) return "";
    const raw = fs.readFileSync(filePath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.includes('"user"')) continue;
      let parsed: {
        type?: string;
        payload?: {
          role?: string;
          content?: Array<{ type?: string; text?: string }>;
        };
      };
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = parsed.payload;
      if (parsed.type !== "response_item" || payload?.role !== "user") continue;
      const text = (payload.content || [])
        .filter((c) => typeof c.text === "string")
        .map((c) => c.text as string)
        .join(" ")
        .trim();
      if (!text || text.startsWith("#") || text.startsWith("<")) continue;
      return text.replace(/\s+/g, " ").slice(0, 70);
    }
  } catch {
    /* fichier illisible, titre vide */
  }
  return "";
}

async function collectCodexSessions(
  roots: string[],
  rootReals: string[]
): Promise<AgentSessionHistoryEntry[]> {
  const sessionsDir = path.join(os.homedir(), ".codex", "sessions");
  const threadNames = await readCodexThreadNames();
  const out: AgentSessionHistoryEntry[] = [];
  let years: string[];
  try {
    years = await fsp.readdir(sessionsDir);
  } catch {
    return [];
  }
  for (const year of years) {
    const months = await fsp
      .readdir(path.join(sessionsDir, year))
      .catch(() => [] as string[]);
    for (const month of months) {
      const days = await fsp
        .readdir(path.join(sessionsDir, year, month))
        .catch(() => [] as string[]);
      for (const day of days) {
        const files = await fsp
          .readdir(path.join(sessionsDir, year, month, day))
          .catch(() => [] as string[]);
        for (const file of files) {
          if (!file.startsWith("rollout-") || !file.endsWith(".jsonl")) continue;
          const full = path.join(sessionsDir, year, month, day, file);
          const firstLine = readFirstLine(full);
          if (!firstLine) continue;
          let cwd: string | undefined;
          try {
            const meta = JSON.parse(firstLine) as {
              type?: string;
              payload?: { cwd?: string };
            };
            if (meta.type === "session_meta") cwd = meta.payload?.cwd;
          } catch {
            continue;
          }
          if (!cwd) continue;
          let cwdReal = cwd;
          try {
            cwdReal = await fsp.realpath(cwd);
          } catch {
            /* dossier supprimé, on compare la valeur brute */
          }
          if (!roots.includes(cwd) && !rootReals.includes(cwdReal)) continue;
          const id =
            file.match(
              /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/
            )?.[1] ?? "";
          if (!id) continue;
          const stat = await fsp.stat(full).catch(() => null);
          const title =
            threadNames.get(id) ||
            extractCodexFirstUserMessage(full) ||
            "(sans titre)";
          out.push({
            source: "codex",
            id,
            title,
            updatedAt: stat ? stat.mtimeMs : 0,
            detail: stat ? `codex · ${Math.max(1, Math.round(stat.size / 1024))} Ko` : "codex",
            resumeCommand: `codex resume ${id}`
          });
        }
      }
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50);
}

export async function collectProjectSessionHistory(
  rootInput: string | string[]
): Promise<AgentSessionHistoryEntry[]> {
  const roots = [...new Set(Array.isArray(rootInput) ? rootInput : [rootInput])];
  lastSessionCollectDiagnostics.roots = roots.join(" | ");
  const rootReals: string[] = [];
  for (const root of roots) {
    try {
      const real = await fsp.realpath(root);
      if (!roots.includes(real)) rootReals.push(real);
    } catch {
      /* on garde root */
    }
  }
  const [openCode, codex] = await Promise.all([
    collectOpenCodeSessions(roots.concat(rootReals)),
    collectCodexSessions(roots, rootReals)
  ]);
  lastSessionCollectDiagnostics.openCodeFound = openCode.length;
  lastSessionCollectDiagnostics.codexFound = codex.length;
  return [...openCode, ...codex].sort((a, b) => b.updatedAt - a.updatedAt);
}
