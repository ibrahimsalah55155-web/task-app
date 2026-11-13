/** Engine started by Windows (no native launcher), and tolerant loading of the launcher. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type PluginFiles, canAutostart, connectAutostart } from "../src/companion/autostart.ts";
import { __setAddonForTests, describeAddon, loadAddonAsync } from "../src/companion/engine.ts";

const TOKEN = "a".repeat(48);

/** A stand-in for the engine: answers on one port, accepts one token. */
function fakeEngine(state: { port: number | null; token: string }) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    if (state.port === null || Number(u.port) !== state.port) throw new TypeError("Network request failed");
    if (u.pathname.endsWith("/health")) {
      return new Response(JSON.stringify({ service: "atheer-companion", version: "0.4.0", apiVersion: 1, uptimeSeconds: 1, ffprobeAvailable: true }), { status: 200 });
    }
    const auth = new Headers(init?.headers).get("Authorization");
    if (auth !== `Bearer ${state.token}`) {
      return new Response(JSON.stringify({ error: { code: "unauthorized", message: "no" } }), { status: 401 });
    }
    return new Response(JSON.stringify({ service: "atheer-companion", version: "0.4.0", modules: {}, gpus: [], platform: { system: "Windows" } }), { status: 200 });
  };
}

function files(over: Partial<PluginFiles> & { token?: () => string | null; script?: boolean; opened?: string[] }): PluginFiles {
  return {
    read: async (parts) => (parts.join("/") === "engine/autostart.token" ? over.token?.() ?? null : null),
    path: async (parts) => (parts.join("/") === "engine/start-engine.vbs" && over.script !== false ? "C:\\Plugin\\engine\\start-engine.vbs" : null),
    open: async (p) => {
      over.opened?.push(p);
      return "";
    },
    ...over,
  };
}

test("connects to an engine Windows already started (no launch)", async () => {
  const opened: string[] = [];
  const f = files({ token: () => TOKEN, opened });
  assert.equal(await canAutostart(f), true);
  const r = await connectAutostart(f, { fetchFn: fakeEngine({ port: 47821, token: TOKEN }) });
  assert.equal(r.port, 47821);
  assert.deepEqual(opened, [], "nothing launched when it already runs");
});

test("an engine on our port with another token is not ours", async () => {
  const f = files({ token: () => TOKEN });
  await assert.rejects(connectAutostart(f, { launch: false, fetchFn: fakeEngine({ port: 47820, token: "b".repeat(48) }) }));
});

test("starts the engine through Windows and waits for its token file", async () => {
  const opened: string[] = [];
  const state = { port: null as number | null, token: TOKEN };
  let tokenWritten = false;
  const f = files({ token: () => (tokenWritten ? TOKEN : null), opened });
  const pending = connectAutostart(f, { fetchFn: fakeEngine(state), pollMs: 10, timeoutMs: 3000 });
  setTimeout(() => { tokenWritten = true; state.port = 47823; }, 60);
  const r = await pending;
  assert.equal(r.port, 47823);
  assert.deepEqual(opened, ["C:\\Plugin\\engine\\start-engine.vbs"]);
});

test("a refused launch is reported with what to do", async () => {
  const f = files({ token: () => null, open: async () => "Permission denied" });
  await assert.rejects(connectAutostart(f, { fetchFn: fakeEngine({ port: null, token: TOKEN }), pollMs: 10, timeoutMs: 100 }),
    /did not allow.*Permission denied.*restart Windows/s);
});

test("launcher exports are found directly, in a promise or under default; anything else is described", async () => {
  const fns = { start: () => 1, isRunning: () => false, exitCode: () => -1, stop: () => undefined, info: () => "{}" };
  for (const shape of [fns, Promise.resolve(fns), { default: fns }]) {
    __setAddonForTests(undefined as never);
    (globalThis as { require?: unknown }).require = () => shape;
    const r = await loadAddonAsync();
    assert.ok(r.addon && r.problem === null);
  }
  (globalThis as { require?: unknown }).require = () => ({ something: 1 });
  const bad = await loadAddonAsync();
  assert.equal(bad.addon, null);
  assert.match(bad.problem!, /did not expose its functions.*own=\[something\]/);
  assert.match(describeAddon(Promise.resolve(1)), /proto=\[.*then/);
  delete (globalThis as { require?: unknown }).require;
});
