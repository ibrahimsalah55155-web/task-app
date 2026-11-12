/**
 * Demo host: a mock Premiere screen (project bins, program monitor, timeline)
 * around the REAL panel bundle. Premiere itself is simulated with the same fake
 * module the tests use (plugin/test/fakePremiere.ts); the engine, its graphics
 * and the panel code are the real ones. Used only to record the explainer video.
 */
import {
  FakeClip, FakeFolder, FakeProject, FakeSequence, FakeTrack, FakeTrackItem, TPS, buildFake,
} from "../../plugin/test/fakePremiere.ts";

declare const DEMO_MEDIA: string;
const TPF = 10160640000; // 25 fps
const SEQ_LEN = TPS * 11;

const media = (name: string) => `${DEMO_MEDIA}/${name}`;
const clip = (name: string) => new FakeClip(name, media(name));
const cams = { wide: clip("WIDE_CAM_C001.mov"), host: clip("HOST_CAM_B001.mov"), guest: clip("GUEST_CAM_A001.mov") };
const mics = { guest: clip("ZOOM_TR1_GUEST.wav"), host: clip("ZOOM_TR2_HOST.wav") };
const full = (c: FakeClip) => new FakeTrackItem(c, 0, SEQ_LEN, 0);

const seq = new FakeSequence("REEL_01_EDIT", [
  new FakeTrack("Wide Camera", [full(cams.wide)]),
  new FakeTrack("Host Camera", [full(cams.host)]),
  new FakeTrack("Guest Camera", [full(cams.guest)]),
], [
  new FakeTrack("Guest Mic", [full(mics.guest)]),
  new FakeTrack("Host Mic", [full(mics.host)]),
], TPF, TPS * 1);
seq.frameW = 1080;
seq.frameH = 1920;
seq.end = SEQ_LEN;

// buildFake() creates its own project; it must run BEFORE ours so the fake's
// "current root bin" (where new subclips land) is our project's root.
const fake = buildFake();
const project = new FakeProject(seq);
project.name = "Podcast EP12.prproj";
project.path = `${DEMO_MEDIA}/Podcast EP12.prproj`;
project.importLengthTicks = TPS * 6;
for (const c of [...Object.values(cams), ...Object.values(mics)]) project.root.items.push(c);

const mod = fake.module as Record<string, unknown> & { Project: { getActiveProject: () => Promise<unknown> } };
mod.Project = { getActiveProject: async () => project };
mod.MogrtText = function MogrtText() {};

let activeSeq: FakeSequence = seq;
const origOpen = project.openSequence.bind(project);
project.openSequence = async (s: FakeSequence) => {
  activeSeq = s;
  project.active = s;
  return origOpen(s);
};

// ---- the built-in engine is already running (started by the demo runner) ----
const addon = { start: () => 4242, isRunning: () => true, exitCode: () => -1, stop() {}, info: () => '{"addon":"demo"}' };
crypto.getRandomValues = (<T extends ArrayBufferView | null>(a: T): T => {
  if (a) new Uint8Array(a.buffer).fill(0);
  return a;
}) as typeof crypto.getRandomValues;

const secure = new Map<string, string>();
let pickCount = 0;
const uxp = {
  host: { name: "premierepro", version: "27.0.0", uiLocale: "en_US" },
  versions: { uxp: "9.4.0", plugin: "0.3.0" },
  storage: {
    secureStorage: {
      async getItem(k: string) { if (!secure.has(k)) throw new Error("none"); return secure.get(k); },
      async setItem(k: string, v: string) { secure.set(k, v); },
      async removeItem(k: string) { secure.delete(k); },
    },
    localFileSystem: {
      async getFileForOpening(o: { types?: string[]; allowMultiple?: boolean } = {}) {
        const types = o.types ?? [];
        if (types.includes("png")) return { nativePath: media("demo_logo.png") };
        if (types.includes("epr")) return { nativePath: "C:/Presets/YouTube 1080p.epr" };
        const all = ["GUEST_CAM_A001.mov", "HOST_CAM_B001.mov", "WIDE_CAM_C001.mov", "ZOOM_TR1_GUEST.wav", "ZOOM_TR2_HOST.wav"];
        const next = all[pickCount++ % all.length]!;
        return o.allowMultiple ? [{ nativePath: media(next) }] : { nativePath: media(next) };
      },
      async getFolder() { return { nativePath: `${DEMO_MEDIA}/exports`, isFolder: true }; },
    },
  },
  entrypoints: {
    setup(cfg: { panels: Record<string, { create(n: HTMLElement): void; show(n: HTMLElement): void }> }) {
      const p = cfg.panels["studioPanel"]!;
      setTimeout(() => { p.create(document.getElementById("app")!); p.show(document.getElementById("app")!); }, 50);
    },
  },
};
const os = { platform: () => "win32", release: () => "10.0.26100" };
(window as unknown as { require: (id: string) => unknown }).require = (id: string) =>
  ({ premierepro: mod, uxp, os, "mag_engine.uxpaddon": addon } as Record<string, unknown>)[id];
try { localStorage.clear(); } catch { /* */ }

// ---- mock Premiere UI -------------------------------------------------------------

const $ = (id: string) => document.getElementById(id)!;
const overlays = new Map<string, { url: string | null; pending: boolean }>();
let playing = false;
let lastTick = 0;

function overlayUrl(path: string): string | null {
  const o = overlays.get(path);
  if (o) return o.url;
  overlays.set(path, { url: null, pending: true });
  fetch(`/convert?path=${encodeURIComponent(path)}`).then((r) => r.text()).then((u) => overlays.set(path, { url: u, pending: false }));
  return null;
}

const tc = (ticks: number) => {
  const f = Math.floor(ticks / TPF);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `00:${p2(Math.floor(f / 1500))}:${p2(Math.floor(f / 25) % 60)}:${p2(f % 25)}`;
};

function renderBins(): void {
  const lines: string[] = [];
  const walk = (folder: FakeFolder, depth: number) => {
    for (const it of folder.items) {
      const isBin = it instanceof FakeFolder;
      lines.push(`<div class="bin-row" style="padding-inline-start:${depth * 14 + 6}px">${isBin ? "▸ 📁" : "🎞"} ${it.name}</div>`);
      if (isBin) walk(it, depth + 1);
    }
  };
  walk(project.root, 0);
  for (const s of project.sequences) lines.push(`<div class="bin-row seqrow">▤ ${s.item?.name ?? s.name}</div>`);
  $("bins").innerHTML = lines.join("");
}

function renderTimeline(): void {
  const s = activeSeq;
  const len = Math.max(s.end, TPS * 11);
  const pct = (t: number) => `${(t / len) * 100}%`;
  const rows: string[] = [];
  const track = (label: string, name: string, items: FakeTrackItem[], kind: string) => {
    const blocks = items.map((i) => {
      const gfx = i.clip?.path.endsWith(".mov") && i.clip.path.includes("MAG Graphics");
      const cls = gfx ? "gfx" : kind;
      const nm = gfx ? "★ " + (i.clip!.name.replace(/^MAG_/, "").replace(/_[0-9a-f]{12}\.mov$/, "")) : i.clip?.name ?? "";
      return `<div class="clip ${cls}${i.disabled ? " off" : ""}" style="left:${pct(i.start)};width:${pct(i.end - i.start)}">${nm}</div>`;
    }).join("");
    rows.push(`<div class="trk"><div class="trk-h"><b>${label}</b> <span>${name}</span></div><div class="trk-b">${blocks}</div></div>`);
  };
  for (let i = s.video.length - 1; i >= 0; i--) track(`V${i + 1}`, s.video[i]!.name, s.video[i]!.items, "vid");
  s.audio.forEach((t, i) => track(`A${i + 1}`, t.name, t.items, "aud"));
  const io = s.outPoint > s.inPoint
    ? `<div class="inout" style="left:${pct(s.inPoint)};width:${pct(s.outPoint - s.inPoint)}"></div>` : "";
  $("tl-name").textContent = s.item?.name ?? s.name;
  $("tl-body").innerHTML = `${rows.join("")}<div class="tl-over">${io}<div class="playhead" style="left:${pct(s.playhead)}"></div></div>`;
  $("tc").textContent = tc(s.playhead);
}

function renderMonitor(): void {
  const s = activeSeq;
  const bg = $("bg") as HTMLVideoElement;
  const want = (s.playhead / TPS) % 11;
  if (!playing && Math.abs(bg.currentTime - want) > 0.08) bg.currentTime = want;
  const layer = $("overlays");
  const active: string[] = [];
  for (const t of s.video) {
    for (const i of t.items) {
      const p = i.clip?.path ?? "";
      if (!p.includes("MAG Graphics") || i.disabled) continue;
      if (s.playhead >= i.start && s.playhead < i.end) {
        const url = overlayUrl(p);
        if (url) active.push(`${url}#${(s.playhead - i.start) / TPS}`);
      }
    }
  }
  const vids = Array.from(layer.querySelectorAll("video")) as HTMLVideoElement[];
  if (vids.length !== active.length || vids.some((v, k) => v.dataset["src"] !== active[k]!.split("#")[0])) {
    layer.innerHTML = active.map((a) => `<video muted playsinline data-src="${a.split("#")[0]}" src="${a.split("#")[0]}"></video>`).join("");
  }
  (Array.from(layer.querySelectorAll("video")) as HTMLVideoElement[]).forEach((v, k) => {
    const want2 = Number(active[k]!.split("#")[1]);
    if (playing) {
      if (v.paused) { v.currentTime = want2; void v.play(); }
    } else {
      if (!v.paused) v.pause();
      if (Math.abs(v.currentTime - want2) > 0.05) v.currentTime = want2;
    }
  });
}

function tick(now: number): void {
  if (playing) {
    const dt = lastTick ? now - lastTick : 0;
    activeSeq.playhead = Math.min(activeSeq.end - TPF, activeSeq.playhead + (dt / 1000) * TPS);
  }
  lastTick = now;
  renderTimeline();
  renderMonitor();
  requestAnimationFrame(tick);
}

let binTimer = 0;
function binsLoop(): void {
  renderBins();
  binTimer = window.setTimeout(binsLoop, 400);
}

// ---- API for the recorder ------------------------------------------------------------

(window as unknown as { demo: unknown }).demo = {
  setPlayhead(sec: number) { activeSeq.playhead = Math.round(sec * 25) * TPF; },
  setInOut(a: number, b: number) { activeSeq.inPoint = Math.round(a * 25) * TPF; activeSeq.outPoint = Math.round(b * 25) * TPF; },
  play() { playing = true; void ($("bg") as HTMLVideoElement).play(); },
  pause() { playing = false; ($("bg") as HTMLVideoElement).pause(); },
  caption(text: string) { $("caption").textContent = text; $("caption").style.opacity = text ? "1" : "0"; },
  highlight(sel: string | null) {
    document.querySelectorAll(".hl").forEach((e) => e.classList.remove("hl"));
    if (sel) document.querySelector(sel)?.classList.add("hl");
  },
  activeName: () => activeSeq.item?.name ?? activeSeq.name,
  overlaysReady: () => [...overlays.values()].every((o) => !o.pending),
};

window.addEventListener("load", () => {
  void binTimer;
  binsLoop();
  requestAnimationFrame(tick);
});
