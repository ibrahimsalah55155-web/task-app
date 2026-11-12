/** Small in-memory logger. Entries are shown in the panel and copied into diagnostics. */

export type Level = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  t: number;
  level: Level;
  scope: string;
  message: string;
}

const MAX_ENTRIES = 500;
const entries: LogEntry[] = [];
const listeners = new Set<(e: LogEntry) => void>();
const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
let minLevel: Level = "info";

export function setLogLevel(level: Level): void {
  minLevel = level;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function logger(scope: string) {
  const write = (level: Level, message: string, err?: unknown) => {
    const text = err === undefined ? message : `${message}: ${errorMessage(err)}`;
    const entry: LogEntry = { t: Date.now(), level, scope, message: text };
    if (order[level] >= order[minLevel]) {
      entries.push(entry);
      if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
      listeners.forEach((l) => {
        try {
          l(entry);
        } catch {
          /* a broken listener must not break logging */
        }
      });
    }
    const line = `[${scope}] ${text}`;
    if (level === "error") console.error(line, err ?? "");
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };
  return {
    debug: (m: string) => write("debug", m),
    info: (m: string) => write("info", m),
    warn: (m: string, err?: unknown) => write("warn", m, err),
    error: (m: string, err?: unknown) => write("error", m, err),
  };
}

export function getEntries(): readonly LogEntry[] {
  return entries;
}

export function onLog(listener: (e: LogEntry) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function formatEntry(e: LogEntry): string {
  const d = new Date(e.t);
  const ts = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(
    d.getSeconds(),
  ).padStart(2, "0")}`;
  return `${ts} ${e.level.toUpperCase().padEnd(5)} [${e.scope}] ${e.message}`;
}
