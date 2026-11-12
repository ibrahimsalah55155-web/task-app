/**
 * Client for the local companion service (companion/atheer_companion/app.py).
 * Every failure is mapped to a CompanionError with a code the UI can explain.
 */
import { errorMessage, logger } from "../core/log.ts";

const log = logger("companion");

export const EXPECTED_API_VERSION = 1;
export const DEFAULT_COMPANION_URL = "http://127.0.0.1:47820";

export type CompanionErrorCode =
  | "offline"
  | "timeout"
  | "unauthorized"
  | "origin_rejected"
  | "pairing_failed"
  | "api_mismatch"
  | "not_found"
  | "bad_request"
  | "server";

export class CompanionError extends Error {
  readonly code: CompanionErrorCode;
  readonly status: number | null;
  readonly detail: Record<string, unknown> | null;
  constructor(code: CompanionErrorCode, message: string, status: number | null = null,
              detail: Record<string, unknown> | null = null) {
    super(message);
    this.name = "CompanionError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export interface TokenStore {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryTokenStore implements TokenStore {
  private token: string | null = null;
  async get() {
    return this.token;
  }
  async set(t: string) {
    this.token = t;
  }
  async clear() {
    this.token = null;
  }
}

export interface Health {
  service: string;
  version: string;
  apiVersion: number;
  uptimeSeconds: number;
  ffprobeAvailable: boolean;
}

export interface Capabilities {
  platform: { system: string; release: string; machine: string };
  python: string;
  cpuCount: number | null;
  ramBytes: number | null;
  gpus: { vendor: string; name: string; memoryMB: number | null; cuda: boolean }[];
  tools: Record<"ffmpeg" | "ffprobe", { path: string | null; version: string | null }>;
  modules: Record<string, { available: boolean; purpose: string }>;
  jobKinds: string[];
  service: { version: string; apiVersion: number; dataDir: string; logPath: string };
  seenOrigins: string[];
}

export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface Job<R = unknown> {
  id: string;
  kind: string;
  state: JobState;
  progress: number;
  message: string | null;
  error: { type: string; message: string } | null;
  result?: R;
  seq: number;
}

export interface FrameRateJson {
  num: number;
  den: number;
  value: number;
}

export interface ProbeInfo {
  path: string;
  name: string;
  sizeBytes: number;
  kind: "video" | "audio" | "unknown";
  container: string | null;
  duration: number | null;
  timecode: string | null;
  timecodeSource: string | null;
  video: { codec: string | null; width: number | null; height: number | null; frameRate: FrameRateJson | null;
           variableFrameRate: boolean }[];
  audio: { codec: string | null; sampleRate: number | null; channels: number | null }[];
  warnings: { code: string; message: string }[];
}

export interface ProbeItem {
  path: string;
  ok: boolean;
  cached?: boolean;
  info?: ProbeInfo;
  error?: { code: string; message: string };
}

export interface ProbeResult {
  items: ProbeItem[];
  summary: {
    fileCount: number;
    okCount: number;
    failedCount: number;
    totalDuration: number;
    frameRates: FrameRateJson[];
    sampleRates: number[];
    warnings: { code: string; message: string; paths?: string[] }[];
  };
  cacheHits: number;
}

export const TERMINAL_STATES: ReadonlySet<JobState> = new Set(["succeeded", "failed", "cancelled"]);

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  baseUrl?: string;
  tokens?: TokenStore;
  fetchFn?: FetchFn;
  clientName?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class CompanionClient {
  baseUrl: string;
  readonly tokens: TokenStore;
  private readonly fetchFn: FetchFn;
  private readonly clientName: string;

  constructor(opts: ClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_COMPANION_URL).replace(/\/+$/, "");
    this.tokens = opts.tokens ?? new MemoryTokenStore();
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
    this.clientName = opts.clientName ?? "Premiere panel";
  }

  get wsUrl(): string {
    return this.baseUrl.replace(/^http/, "ws");
  }

  private async request<T>(method: string, path: string, opts: { body?: unknown; auth?: boolean; timeoutMs?: number } = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.auth !== false) {
      const token = await this.tokens.get();
      if (!token) throw new CompanionError("unauthorized", "Not paired with the companion yet.");
      headers["Authorization"] = `Bearer ${token}`;
    }
    const timeoutMs = opts.timeoutMs ?? 8000;
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(new CompanionError("timeout", `Companion did not answer within ${timeoutMs / 1000}s.`));
      }, timeoutMs);
    });

    let res: Response;
    try {
      res = await Promise.race([
        this.fetchFn(this.baseUrl + path, {
          method,
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: controller?.signal,
        }),
        timeout,
      ]);
    } catch (e) {
      if (e instanceof CompanionError) throw e;
      throw new CompanionError("offline",
        `Companion is not reachable at ${this.baseUrl}. (${errorMessage(e)})`);
    } finally {
      clearTimeout(timer);
    }

    let data: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if (res.ok) return data as T;

    const err = ((data as { error?: Record<string, unknown> } | null)?.error ?? {}) as Record<string, unknown>;
    const message = typeof err["message"] === "string" ? err["message"] : `HTTP ${res.status}`;
    if (res.status === 401) {
      throw new CompanionError("unauthorized", message, 401, err);
    }
    if (res.status === 403 && err["code"] === "origin_rejected") {
      throw new CompanionError("origin_rejected",
        `The companion refused this panel's origin "${String(err["origin"])}". Restart it with --allow-origin ${String(err["origin"])} and report this value.`,
        403, err);
    }
    if (err["code"] === "pairing_failed") throw new CompanionError("pairing_failed", message, res.status, err);
    if (res.status === 404) throw new CompanionError("not_found", message, 404, err);
    if (res.status === 400 || res.status === 422) throw new CompanionError("bad_request", message, res.status, err);
    throw new CompanionError("server", message, res.status, err);
  }

  async health(): Promise<Health> {
    const h = await this.request<Health>("GET", "/api/v1/health", { auth: false, timeoutMs: 3000 });
    if (h.service !== "atheer-companion") {
      throw new CompanionError("api_mismatch", `Port is used by another program (${h.service ?? "unknown"}).`);
    }
    if (h.apiVersion !== EXPECTED_API_VERSION) {
      throw new CompanionError("api_mismatch",
        `Companion API v${h.apiVersion} does not match this panel (v${EXPECTED_API_VERSION}). Update both to the same release.`);
    }
    return h;
  }

  async pair(code: string): Promise<void> {
    const res = await this.request<{ token: string }>("POST", "/api/v1/pair", {
      auth: false,
      body: { code, client: this.clientName },
    });
    await this.tokens.set(res.token);
    log.info("Paired with the companion");
  }

  async isPaired(): Promise<boolean> {
    return (await this.tokens.get()) != null;
  }

  async forget(): Promise<void> {
    await this.tokens.clear();
  }

  capabilities(): Promise<Capabilities> {
    return this.request<Capabilities>("GET", "/api/v1/capabilities", { timeoutMs: 20000 });
  }

  async submitProbe(paths: string[]): Promise<Job<ProbeResult>> {
    const res = await this.request<{ job: Job<ProbeResult> }>("POST", "/api/v1/jobs/probe", { body: { paths } });
    return res.job;
  }

  async getJob<R>(id: string): Promise<Job<R>> {
    return (await this.request<{ job: Job<R> }>("GET", `/api/v1/jobs/${encodeURIComponent(id)}`)).job;
  }

  async cancelJob(id: string): Promise<void> {
    await this.request("POST", `/api/v1/jobs/${encodeURIComponent(id)}/cancel`);
  }

  async logs(tail = 200): Promise<string[]> {
    return (await this.request<{ lines: string[] }>("GET", `/api/v1/logs?tail=${tail}`)).lines;
  }

  async clearCache(): Promise<number> {
    return (await this.request<{ removed: number }>("DELETE", "/api/v1/cache")).removed;
  }

  /**
   * Follow a job until it ends. Polls over HTTP (works in every UXP build);
   * `cancelled()` lets the UI stop following without cancelling the job.
   */
  async waitForJob<R>(id: string, onUpdate: (job: Job<R>) => void,
                      opts: { intervalMs?: number; stopFollowing?: () => boolean } = {}): Promise<Job<R>> {
    const interval = opts.intervalMs ?? 400;
    let lastSeq = -1;
    let failures = 0;
    for (;;) {
      if (opts.stopFollowing?.()) throw new CompanionError("timeout", "Stopped following the job.");
      try {
        const job = await this.getJob<R>(id);
        failures = 0;
        if (job.seq !== lastSeq) {
          lastSeq = job.seq;
          onUpdate(job);
        }
        if (TERMINAL_STATES.has(job.state)) return job;
      } catch (e) {
        // A brief hiccup is tolerated; a companion restart loses in-memory jobs (404).
        if (e instanceof CompanionError && e.code === "not_found") throw e;
        if (++failures >= 10) throw e;
      }
      await sleep(interval);
    }
  }
}
