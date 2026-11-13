/**
 * Built-in engine: started by the plugin itself through the UXP Hybrid addon
 * (Windows package). No window, no pairing code; it stops with Premiere.
 *
 * When the addon is not present (development build, macOS), the panel falls
 * back to an externally started engine with a pairing code.
 */
import { errorMessage, logger } from "../core/log.ts";
import { CompanionClient, CompanionError, type FetchFn, MemoryTokenStore } from "./client.ts";

declare const require: (id: string) => unknown;
const log = logger("engine");

export const ENGINE_PORTS = [47820, 47821, 47822, 47823];
const ADDON = "mag_engine.uxpaddon";
const PORT_IN_USE_EXIT = 2;

export interface EngineAddon {
  start(port: number, token: string): number;
  isRunning(): boolean;
  exitCode(): number;
  stop(): void;
  info(): string;
}

let addonOverride: EngineAddon | null | undefined;

export function __setAddonForTests(addon: EngineAddon | null): void {
  addonOverride = addon;
}

const ADDON_FUNCTIONS = ["start", "isRunning", "exitCode", "stop", "info"] as const;

function isEngineAddon(x: unknown): x is EngineAddon {
  return !!x && (typeof x === "object" || typeof x === "function") &&
    ADDON_FUNCTIONS.every((f) => typeof (x as Record<string, unknown>)[f] === "function");
}

/** What came back from require(), for the log when it is not usable. */
export function describeAddon(x: unknown): string {
  if (x === null || x === undefined) return String(x);
  const own = Object.getOwnPropertyNames(x as object);
  let proto: string[] = [];
  try {
    proto = Object.getOwnPropertyNames(Object.getPrototypeOf(x) ?? {});
  } catch {
    /* ignore */
  }
  return `${typeof x} own=[${own.slice(0, 20).join(", ")}] proto=[${proto.slice(0, 20).join(", ")}]`;
}

export interface AddonLoad {
  addon: EngineAddon | null;
  /** Why the addon cannot be used (null when it loaded fine or is simply not part of this build). */
  problem: string | null;
}

/**
 * Loads the native launcher. Accepts the exports object directly, a promise of it, or the
 * functions under `default`/`exports`; anything else is reported, not called.
 */
export async function loadAddonAsync(): Promise<AddonLoad> {
  if (addonOverride !== undefined) return { addon: addonOverride, problem: null };
  let raw: unknown;
  try {
    raw = require(ADDON);
  } catch (e) {
    log.info(`Built-in engine launcher not loaded: ${errorMessage(e)}`);
    return { addon: null, problem: `require failed: ${errorMessage(e)}` };
  }
  try {
    if (raw && typeof (raw as { then?: unknown }).then === "function") raw = await (raw as Promise<unknown>);
  } catch (e) {
    return { addon: null, problem: `addon promise rejected: ${errorMessage(e)}` };
  }
  for (const c of [raw, (raw as { default?: unknown } | null)?.default, (raw as { exports?: unknown } | null)?.exports]) {
    if (isEngineAddon(c)) return { addon: c, problem: null };
  }
  const problem = `Premiere loaded the launcher but did not expose its functions (${describeAddon(raw)}).`;
  log.warn(problem);
  return { addon: null, problem };
}

/** @deprecated synchronous variant kept for tests. */
export function loadAddon(): EngineAddon | null {
  if (addonOverride !== undefined) return addonOverride;
  try {
    const raw = require(ADDON);
    return isEngineAddon(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function newSessionToken(): string {
  const bytes = new Uint8Array(24);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface StartedEngine {
  port: number;
  pid: number;
  client: CompanionClient;
}

/**
 * Start (or reconnect to) the built-in engine and return a client that is
 * already authorised. Tries the next port when one is taken by another program.
 */
export async function startBuiltInEngine(
  addon: EngineAddon,
  opts: { timeoutMs?: number; pollMs?: number; onStep?: (msg: string) => void; fetchFn?: FetchFn } = {},
): Promise<StartedEngine> {
  const timeoutMs = opts.timeoutMs ?? 45000; // first launch can be slow while antivirus scans the engine
  const pollMs = opts.pollMs ?? 300;
  let lastProblem = "";
  for (const port of ENGINE_PORTS) {
    if (addon.isRunning()) addon.stop(); // a stale engine whose token we no longer know
    const token = newSessionToken();
    const tokens = new MemoryTokenStore();
    await tokens.set(token);
    const client = new CompanionClient({ baseUrl: `http://127.0.0.1:${port}`, tokens, fetchFn: opts.fetchFn });
    let pid: number;
    try {
      pid = addon.start(port, token);
    } catch (e) {
      throw new CompanionError("server", `The built-in engine could not start: ${errorMessage(e)}`);
    }
    opts.onStep?.(`port ${port}`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      if (!addon.isRunning()) {
        const code = addon.exitCode();
        if (code === PORT_IN_USE_EXIT) {
          lastProblem = `port ${port} is in use`;
          log.warn(`Port ${port} is busy, trying the next one`);
          break;
        }
        throw new CompanionError("server", `The built-in engine stopped during start-up (code ${code}). Details: ${addon.info()}`);
      }
      try {
        await client.health();
        await client.capabilities(); // proves the token is accepted
        log.info(`Built-in engine running on port ${port} (pid ${pid})`);
        return { port, pid, client };
      } catch (e) {
        // offline/timeout: still booting. unauthorized/api_mismatch: something else (e.g. an engine
        // left over from an earlier session) owns this port; ours will exit with PORT_IN_USE_EXIT.
        if (e instanceof CompanionError &&
            ["offline", "timeout", "unauthorized", "api_mismatch"].includes(e.code)) {
          lastProblem = e.message;
          continue;
        }
        addon.stop();
        throw e;
      }
    }
    if (addon.isRunning()) {
      addon.stop();
      throw new CompanionError("timeout", `The built-in engine did not answer within ${Math.round(timeoutMs / 1000)} s.`);
    }
  }
  throw new CompanionError("offline", `No free port for the built-in engine (${lastProblem}). Close other programs using ports ${ENGINE_PORTS.join(", ")}.`);
}
