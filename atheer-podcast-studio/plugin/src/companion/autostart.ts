/**
 * Engine started by Windows instead of by the native launcher.
 *
 * Used when Premiere does not run the plugin's native launcher (for example a plugin
 * installed without Creative Cloud). The package carries engine/start-engine.vbs, which
 * starts the bundled engine hidden on ports 47820-47823 with a token kept in
 * engine/autostart.token (created by the engine on first start). The installer runs it
 * at logon and right after installing; the panel can also ask Windows to run it.
 */
import { errorMessage, logger } from "../core/log.ts";
import { CompanionClient, type FetchFn, MemoryTokenStore } from "./client.ts";
import { ENGINE_PORTS, type StartedEngine } from "./engine.ts";

declare const require: (id: string) => unknown;
const log = logger("engine");

export interface PluginFiles {
  /** Text of a file inside the plugin folder, or null. */
  read(parts: string[]): Promise<string | null>;
  /** Native path of a file inside the plugin folder, or null when it does not exist. */
  path(parts: string[]): Promise<string | null>;
  /** Ask Windows to open a file (runs a .vbs). Resolves to "" on success, else an error text. */
  open(nativePath: string): Promise<string>;
}

interface UxpEntry { isFolder?: boolean; nativePath: string; getEntry(name: string): Promise<UxpEntry>; read(o?: unknown): Promise<string> }

export function uxpPluginFiles(): PluginFiles {
  const uxp = require("uxp") as {
    storage: { localFileSystem: { getPluginFolder(): Promise<UxpEntry> }; formats: { utf8: unknown } };
    shell?: { openPath(p: string, why?: string): Promise<string> };
  };
  const walk = async (parts: string[]): Promise<UxpEntry | null> => {
    try {
      let e: UxpEntry = await uxp.storage.localFileSystem.getPluginFolder();
      for (const p of parts) e = await e.getEntry(p);
      return e;
    } catch {
      return null;
    }
  };
  return {
    async read(parts) {
      const e = await walk(parts);
      if (!e) return null;
      try {
        return String(await e.read({ format: uxp.storage.formats.utf8 }));
      } catch {
        return null;
      }
    },
    async path(parts) {
      return (await walk(parts))?.nativePath ?? null;
    },
    async open(p) {
      if (!uxp.shell?.openPath) return "shell.openPath is not available";
      try {
        return (await uxp.shell.openPath(p, "Starts the Multimedia & AI Group engine (no window).")) ?? "";
      } catch (e) {
        return errorMessage(e);
      }
    },
  };
}

const TOKEN = ["engine", "autostart.token"];
const SCRIPT = ["engine", "start-engine.vbs"];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True when this package can run its engine through Windows. */
export async function canAutostart(files: PluginFiles): Promise<boolean> {
  return (await files.path(SCRIPT)) !== null;
}

async function tryPorts(token: string, fetchFn?: FetchFn): Promise<StartedEngine | null> {
  for (const port of ENGINE_PORTS) {
    const tokens = new MemoryTokenStore();
    await tokens.set(token);
    const client = new CompanionClient({ baseUrl: `http://127.0.0.1:${port}`, tokens, fetchFn });
    try {
      await client.health();
      await client.capabilities(); // proves this engine is ours (accepts our token)
      return { port, pid: 0, client };
    } catch {
      /* not here */
    }
  }
  return null;
}

export async function connectAutostart(files: PluginFiles, opts: { launch?: boolean; timeoutMs?: number; pollMs?: number;
  fetchFn?: FetchFn; onStep?: (m: string) => void } = {}): Promise<StartedEngine> {
  const timeoutMs = opts.timeoutMs ?? 60000;
  const pollMs = opts.pollMs ?? 700;
  let token = (await files.read(TOKEN))?.trim() ?? "";
  if (token) {
    const found = await tryPorts(token, opts.fetchFn);
    if (found) {
      log.info(`Engine (started by Windows) found on port ${found.port}`);
      return found;
    }
  }
  if (opts.launch === false) throw new Error("The engine is not running.");
  const script = await files.path(SCRIPT);
  if (!script) throw new Error("This package has no engine start script.");
  opts.onStep?.("launch");
  const err = await files.open(script);
  if (err) log.warn(`Windows did not run the engine start script: ${err}`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    token = (await files.read(TOKEN))?.trim() ?? token;
    if (!token) continue;
    const found = await tryPorts(token, opts.fetchFn);
    if (found) {
      log.info(`Engine started through Windows on port ${found.port}`);
      return found;
    }
  }
  throw new Error(err
    ? `Premiere did not allow the panel to start the engine (${err}). Run "Start engine" from the install folder, or restart Windows.`
    : `The engine did not answer within ${Math.round(timeoutMs / 1000)} s.`);
}
