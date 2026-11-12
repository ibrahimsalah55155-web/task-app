/**
 * Built-in engine start-up logic, with a stand-in for the Windows addon that
 * launches the REAL Python engine the same way (same arguments, token in env).
 */
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { CompanionError } from "../src/companion/client.ts";
import { ENGINE_PORTS, type EngineAddon, newSessionToken, startBuiltInEngine } from "../src/companion/engine.ts";

const COMPANION_DIR = resolve(import.meta.dirname, "../../companion");
const PY = process.env.PYTHON ?? "python3";
const dir = mkdtempSync(join(tmpdir(), "mag-engine-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function pythonReady(): boolean {
  try {
    execFileSync(PY, ["-c", "import fastapi, uvicorn"], { cwd: COMPANION_DIR, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Behaves like native/engine_launcher/module.cpp, but with child_process. */
class FakeAddon implements EngineAddon {
  proc: ChildProcess | null = null;
  code = -1;
  starts: number[] = [];
  start(port: number, token: string): number {
    if (this.isRunning()) return this.proc!.pid!;
    if (token.length < 16) throw new Error("token must be 16-200 characters without spaces");
    this.starts.push(port);
    this.code = -1;
    this.proc = spawn(PY, ["-m", "atheer_companion", "--port", String(port), "--parent-pid", String(process.pid),
      "--token-env", "MAG_ENGINE_TOKEN", "--data-dir", join(dir, "data")], {
      cwd: COMPANION_DIR, env: { ...process.env, MAG_ENGINE_TOKEN: token }, stdio: "ignore",
    });
    this.proc.on("exit", (c) => (this.code = c ?? -1));
    return this.proc.pid!;
  }
  isRunning() {
    return this.proc != null && this.proc.exitCode === null && this.proc.signalCode === null;
  }
  exitCode() {
    return this.isRunning() ? -1 : this.code;
  }
  stop() {
    this.proc?.kill();
  }
  info() {
    return "{}";
  }
  async stopAndWait() {
    if (!this.isRunning()) return;
    const p = this.proc!;
    const exited = new Promise((r) => p.once("exit", r));
    p.kill();
    await exited;
  }
}

const skip = !pythonReady() && "python engine dependencies missing";

test("session tokens are long and random", () => {
  const a = newSessionToken();
  assert.match(a, /^[0-9a-f]{48}$/);
  assert.notEqual(a, newSessionToken());
});

test("starts the engine without pairing and talks to it", { skip }, async () => {
  const addon = new FakeAddon();
  try {
    const engine = await startBuiltInEngine(addon, { timeoutMs: 20000, pollMs: 100 });
    assert.equal(engine.port, ENGINE_PORTS[0]);
    const caps = await engine.client.capabilities();
    assert.ok(caps.jobKinds.includes("probe"));
  } finally {
    await addon.stopAndWait();
  }
});

test("moves to the next port when one is taken by another program", { skip }, async () => {
  const blocker: Server = createServer();
  await new Promise<void>((r) => blocker.listen(ENGINE_PORTS[0], "127.0.0.1", r));
  const addon = new FakeAddon();
  try {
    const engine = await startBuiltInEngine(addon, { timeoutMs: 20000, pollMs: 100 });
    assert.equal(engine.port, ENGINE_PORTS[1]);
    assert.deepEqual(addon.starts, [ENGINE_PORTS[0], ENGINE_PORTS[1]]);
  } finally {
    await addon.stopAndWait();
    blocker.close();
  }
});

test("an old engine left on the port is skipped, not trusted", { skip }, async () => {
  const stale = new FakeAddon();
  const addon = new FakeAddon();
  try {
    await startBuiltInEngine(stale, { timeoutMs: 20000, pollMs: 100 }); // owns the first port, other token
    const engine = await startBuiltInEngine(addon, { timeoutMs: 20000, pollMs: 100 });
    assert.equal(engine.port, ENGINE_PORTS[1]);
  } finally {
    await stale.stopAndWait();
    await addon.stopAndWait();
  }
});

test("an engine that crashes at start-up is reported with its exit code", async () => {
  const crashing: EngineAddon = {
    running: true,
    start() {
      setTimeout(() => (this.running = false), 50);
      return 1234;
    },
    isRunning() {
      return this.running;
    },
    exitCode() {
      return 1;
    },
    stop() {},
    info() {
      return '{"lastError":""}';
    },
  } as EngineAddon & { running: boolean };
  await assert.rejects(startBuiltInEngine(crashing, { timeoutMs: 3000, pollMs: 20 }),
    (e: unknown) => e instanceof CompanionError && /code 1/.test(e.message));
});

test("addon refusing to start is surfaced", async () => {
  const broken: EngineAddon = {
    start() {
      throw new Error("Engine not found at C:\\x\\engine\\python\\pythonw.exe");
    },
    isRunning: () => false,
    exitCode: () => -1,
    stop() {},
    info: () => "{}",
  };
  await assert.rejects(startBuiltInEngine(broken), /Engine not found/);
});
