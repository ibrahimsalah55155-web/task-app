/**
 * Panel client against the REAL companion process (Python), not a mock.
 * Skipped when Python or the companion's dependencies are not installed.
 */
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { CompanionClient, CompanionError, type ProbeResult } from "../src/companion/client.ts";

const COMPANION_DIR = resolve(import.meta.dirname, "../../companion");
const PORT = 47899;
const PY = process.env.PYTHON ?? "python3";

function available(): boolean {
  try {
    execFileSync(PY, ["-c", "import fastapi, uvicorn, websockets"], { cwd: COMPANION_DIR, stdio: "ignore" });
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const skip = !available() && "python companion deps or ffmpeg missing";
let proc: ChildProcess | null = null;
let code = "";
let dir = "";

before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), "atheer-it-"));
  proc = spawn(PY, ["-m", "atheer_companion", "--port", String(PORT), "--data-dir", join(dir, "data")], {
    cwd: COMPANION_DIR,
    env: { ...process.env, PYTHONUNBUFFERED: "1", NO_PROXY: "127.0.0.1,localhost" },
  });
  let out = "";
  proc.stdout?.on("data", (d: Buffer) => (out += d.toString()));
  proc.stderr?.on("data", (d: Buffer) => (out += d.toString()));
  for (let i = 0; i < 100 && !/Pairing code:\s+(\w{3}) (\w{3})/.test(out); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const m = /Pairing code:\s+(\w{3}) (\w{3})/.exec(out);
  if (!m) throw new Error(`companion did not start:\n${out}`);
  code = `${m[1]} ${m[2]}`.toLowerCase(); // as a user might type it
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25",
    "-f", "lavfi", "-i", "sine=sample_rate=48000", "-t", "1", "-timecode", "10:00:00:00", "-c:v", "mpeg4",
    "-c:a", "pcm_s16le", join(dir, "CAM_A.mov")]);
});

after(() => {
  proc?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("pair, inspect media and error mapping against the real companion", { skip }, async () => {
  const client = new CompanionClient({ baseUrl: `http://127.0.0.1:${PORT}` });
  const health = await client.health();
  assert.equal(health.apiVersion, 1);

  await assert.rejects(client.capabilities(), (e: unknown) => e instanceof CompanionError && e.code === "unauthorized");
  await assert.rejects(client.pair("WRONG1"), (e: unknown) => e instanceof CompanionError && e.code === "pairing_failed");
  await client.pair(code);
  const caps = await client.capabilities();
  assert.ok(caps.tools.ffprobe.path);

  const job = await client.submitProbe([join(dir, "CAM_A.mov"), join(dir, "missing.mov")]);
  const updates: string[] = [];
  const done = await client.waitForJob<ProbeResult>(job.id, (j) => updates.push(j.state), { intervalMs: 50 });
  assert.equal(done.state, "succeeded");
  assert.equal(updates.at(-1), "succeeded");
  const [ok, missing] = done.result!.items;
  assert.equal(ok?.info?.timecode, "10:00:00:00");
  assert.equal(missing?.error?.code, "missing");

  await assert.rejects(client.getJob("nope"), (e: unknown) => e instanceof CompanionError && e.code === "not_found");
});

test("offline companion is reported as offline", async () => {
  const client = new CompanionClient({ baseUrl: "http://127.0.0.1:1" });
  await assert.rejects(client.health(), (e: unknown) => e instanceof CompanionError && e.code === "offline");
});

test("another service on the port is not mistaken for the companion", async () => {
  const fetchFn = async () => new Response(JSON.stringify({ service: "something-else", apiVersion: 1 }), { status: 200 });
  const client = new CompanionClient({ fetchFn });
  await assert.rejects(client.health(), (e: unknown) => e instanceof CompanionError && e.code === "api_mismatch");
});

test("origin rejection is explained with the origin value", async () => {
  const fetchFn = async () => new Response(JSON.stringify({ error: { code: "origin_rejected", origin: "http://x" } }),
    { status: 403 });
  const client = new CompanionClient({ fetchFn });
  await client.tokens.set("t");
  await assert.rejects(client.capabilities(), (e: unknown) =>
    e instanceof CompanionError && e.code === "origin_rejected" && /--allow-origin http:\/\/x/.test(e.message));
});

test("a hung companion times out instead of freezing the panel", async () => {
  const fetchFn = () => new Promise<Response>(() => {});
  const client = new CompanionClient({ fetchFn });
  await client.tokens.set("t");
  const t0 = Date.now();
  await assert.rejects(client.health(), (e: unknown) => e instanceof CompanionError && e.code === "timeout");
  assert.ok(Date.now() - t0 < 5000);
});
