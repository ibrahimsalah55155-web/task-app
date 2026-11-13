/** Finishing: voice clean-up, camera colour match, Premiere Multi-Camera; and the MOGRT library. */
import type { ClipProjectItem, Component, Project } from "@adobe/premierepro";
import type { CleanResult, ColorMeasure, ColorStatsJson } from "../companion/client.ts";
import { type SolverState, KEYS, error, good, neutral, startSolver, step } from "../core/colorsolve.ts";
import { errorMessage, logger } from "../core/log.ts";
import { ppro } from "../ppro/api.ts";
import {
  clipsUsingFile, ensureLumetri, exportFrame, freeVideoTrack, insertMogrt, isAudioFile, lumetriParams, mogrtFields, nestForMulticam,
  probeSequence, setLumetri, setMogrtText, swapMedia, type MogrtField,
} from "../ppro/finishing.ts";
import { guessRoles, readTimeline, type TimelineSpec } from "../ppro/timeline.ts";
import { button, card, h, pill } from "./dom.ts";
import { type Key, t } from "./i18n.ts";
import { type PhaseHost, choice, joinPath, liveSequence, pickFolder, projectDir, toggle, trackSelect } from "./kit.ts";
import { Stage } from "./production.ts";

const log = logger("finishing");
const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

export class FinishView extends Stage {
  private tl: TimelineSpec | null = null;
  private mics: number[] | null = null;
  private preset: "light" | "standard" | "strong" = "standard";
  private target: "podcast" | "social" | "broadcast" = "podcast";
  private ref: number | null = null;
  private lines: string[] = [];

  constructor(host: PhaseHost) {
    super(host);
  }

  private async ensureTimeline(): Promise<TimelineSpec> {
    const live = await liveSequence();
    if (!live) throw new Error(t("needSeqFirst"));
    this.tl = await readTimeline(live.seq);
    const r = guessRoles(this.tl);
    this.mics ??= [r.guestMic, r.hostMic].filter((x): x is number => x != null);
    this.ref ??= r.wideCam ?? this.tl.video.find((v) => v.pieces.length)?.index ?? null;
    return this.tl;
  }

  // ---- voice clean-up ----------------------------------------------------------------

  private clean(): void {
    void this.run(async () => {
      const tl = await this.ensureTimeline();
      const dir = projectDir(this.host.snapshot());
      if (!dir) throw new Error(t("needProjectSaved"));
      const live = await liveSequence();
      if (!live) throw new Error(t("needSeqFirst"));
      const files = [...new Set(tl.audio.filter((a) => this.mics!.includes(a.index)).flatMap((a) => a.pieces.map((p) => p.path)))];
      const video = files.filter((f) => !isAudioFile(f));
      for (const v of video) this.host.notify("warn", t("cleanVideoSkip", { name: base(v) }));
      const audio = files.filter(isAudioFile).filter((f) => !this.host.prefs.cleanMap[f]); // already-clean files are not cleaned twice
      if (!audio.length) throw new Error(t("cleanNoMics"));
      const res = await this.host.client().runJob<{ files: CleanResult[] }>("cleanup", {
        files: audio, preset: this.preset, target: this.target, outDir: joinPath(dir, "MAG Clean Audio"),
      }, this.onJob);
      this.message = t("working");
      const reports = await swapMedia(live.project, res.files.map((f) => ({ from: f.source, to: f.output })));
      let clips = 0;
      for (const r of reports) {
        clips += r.clips;
        if (r.clips) this.host.prefs.cleanMap[r.to] = r.file;
        for (const f of r.failed) this.host.notify("warn", t("cleanFailed", { name: base(r.file), why: f }));
      }
      this.host.savePrefs();
      const lufs = res.files.length ? (res.files.reduce((a, f) => a + f.lufsAfter, 0) / res.files.length).toFixed(1) : "–";
      this.lines = res.files.map((f) => `${base(f.source)}: ${f.lufsBefore.toFixed(1)} → ${f.lufsAfter.toFixed(1)} LUFS · ${f.humHz} Hz · Δt ${f.lagMs} ms`);
      this.host.notify("ok", t("cleanDone", { n: res.files.length, clips, lufs }));
      await this.host.refresh();
    });
  }

  private revert(): void {
    void this.run(async () => {
      const live = await liveSequence();
      if (!live) throw new Error(t("needSeqFirst"));
      const pairs = Object.entries(this.host.prefs.cleanMap).map(([to, from]) => ({ from: to, to: from }));
      if (!pairs.length) throw new Error(t("cleanNothing"));
      const reports = await swapMedia(live.project, pairs);
      let n = 0;
      for (const r of reports) {
        n += r.clips;
        if (!r.failed.length) delete this.host.prefs.cleanMap[r.file];
      }
      this.host.savePrefs();
      if (!n) throw new Error(t("cleanNothing"));
      this.lines = [];
      this.host.notify("ok", t("cleanReverted", { n }));
      await this.host.refresh();
    });
  }

  // ---- colour match --------------------------------------------------------------------

  private async masterClip(project: Project, path: string): Promise<ClipProjectItem[]> {
    const clips = await clipsUsingFile(project, path);
    const name = base(path);
    // Master clip first (its name is the file name), then subclips (cut pieces) of the same file.
    return clips.sort((a, b) => Number((b as unknown as { name: string }).name === name) - Number((a as unknown as { name: string }).name === name));
  }

  private color(): void {
    void this.run(async () => {
      const tl = await this.ensureTimeline();
      const dir = projectDir(this.host.snapshot());
      if (!dir) throw new Error(t("needProjectSaved"));
      const live = await liveSequence();
      if (!live) throw new Error(t("needSeqFirst"));
      const cams = tl.video.filter((v) => v.pieces.length);
      if (cams.length < 2 || this.ref == null) throw new Error(t("colorNeedCams"));
      // Sample each camera across its longest piece.
      const cameras = cams.map((v) => {
        const p = [...v.pieces].sort((a, b) => b.dur - a.dur)[0]!;
        const times = Array.from({ length: 6 }, (_, k) => p.srcIn + (p.dur * (k + 0.5)) / 6);
        return { id: String(v.index), path: p.path, times, name: v.name || v.label };
      });
      const lutDir = joinPath(dir, "MAG Colour");
      const res = await this.host.client().runJob<ColorMeasure>("color", {
        cameras: cameras.map(({ id, path, times }) => ({ id, path, times })), reference: String(this.ref), lutDir,
      }, (j) => { this.progress = j.progress * 0.25; this.message = j.message; this.host.rerender(); });
      const target = res.stats[String(this.ref)]!;
      this.lines = [t("lutsSaved", { dir: lutDir })];
      const others = cameras.filter((c) => c.id !== String(this.ref));
      for (let ci = 0; ci < others.length; ci++) {
        const cam = others[ci]!;
        const clips = await this.masterClip(live.project, cam.path);
        if (!clips.length) continue;
        const comp = await ensureLumetri(live.project, clips[0]!);
        const missing = KEYS.filter((k) => !lumetriParams(comp)[k]);
        if (missing.length) {
          this.host.notify("warn", t("colorMissing", { names: missing.join(", "), path: res.luts?.[cam.id] ?? lutDir }));
          continue;
        }
        const probe = await probeSequence(live.project, clips[0]!, `MAG colour probe ${cam.name}`);
        const before = res.delta[cam.id]?.error ?? 0;
        let state: SolverState = startSolver();
        let last: ColorStatsJson | null = null;
        try {
          for (let round = 1; round <= 5; round++) {
            await setLumetri(live.project, comp, state.values);
            last = await this.measure(probe, cam, lutDir, round);
            this.message = t("colorRound", { cam: cam.name, n: round, err: error(last, target).toFixed(1) });
            this.progress = 0.25 + (0.75 * (ci + round / 5)) / others.length;
            this.host.rerender();
            if (good(last, target)) break;
            state = step(state, last, target);
          }
        } finally {
          try {
            await live.project.deleteSequence(probe);
          } catch (e) {
            log.warn(`probe sequence not deleted: ${errorMessage(e)}`);
          }
        }
        // Same look on every clip of this camera (cut pieces are subclips of the master).
        for (const c of clips.slice(1)) await setLumetri(live.project, await ensureLumetri(live.project, c), state.values);
        const after = last ? error(last, target) : before;
        this.lines.push(t(last && good(last, target) ? "colorDone" : "colorPartial",
          { cam: cam.name, before: before.toFixed(1), after: after.toFixed(1) }));
      }
      this.host.notify("ok", this.lines.slice(1).join(" ") || t("lutsSaved", { dir: lutDir }));
    });
  }

  /** Two frames rendered by Premiere through the camera's Lumetri, measured by the engine. */
  private async measure(probe: import("@adobe/premierepro").Sequence, cam: { id: string; times: number[] }, dir: string, round: number): Promise<ColorStatsJson> {
    const picks = [cam.times[1]!, cam.times[4]!];
    const stats: ColorStatsJson[] = [];
    for (let i = 0; i < picks.length; i++) {
      const png = await exportFrame(probe, picks[i]!, dir, `probe_${cam.id}_${round}_${i}.png`, 480, 270);
      stats.push((await this.host.client().colorCompare(png, { L: 0, Lstd: 0, a: 0, b: 0, chroma: 0 })).stats);
    }
    const avg = (k: keyof ColorStatsJson) => stats.reduce((a, s) => a + s[k], 0) / stats.length;
    return { L: avg("L"), Lstd: avg("Lstd"), a: avg("a"), b: avg("b"), chroma: avg("chroma") };
  }

  private resetColor(): void {
    void this.run(async () => {
      const tl = await this.ensureTimeline();
      const live = await liveSequence();
      if (!live) throw new Error(t("needSeqFirst"));
      let n = 0;
      for (const v of tl.video.filter((x) => x.pieces.length)) {
        for (const c of await this.masterClip(live.project, v.pieces[0]!.path)) {
          const comp: Component = await ensureLumetri(live.project, c);
          await setLumetri(live.project, comp, neutral());
        }
        n++;
      }
      this.lines = [];
      this.host.notify("ok", t("colorResetDone", { n }));
    });
  }

  // ---- multicam ------------------------------------------------------------------------

  private multicam(): void {
    void this.run(async () => {
      const live = await liveSequence();
      if (!live) throw new Error(t("needSeqFirst"));
      const r = await nestForMulticam(live.project, live.seq);
      this.host.notify("ok", t("mcDone", { name: r.name }));
      await this.host.refresh();
    });
  }

  render(): HTMLElement[] {
    const gate = this.gate();
    if (!this.tl && !gate && !this.busy) void this.ensureTimeline().then(() => this.host.rerender()).catch(() => undefined);
    const tl = this.tl;
    const audio = tl?.audio.filter((a) => a.pieces.length) ?? [];
    const cams = tl?.video.filter((v) => v.pieces.length) ?? [];
    const cleaned = Object.keys(this.host.prefs.cleanMap).length;
    return [
      card(t("audioTitle"), cleaned ? pill(String(cleaned), "ok") : null,
        h("p", { class: "muted small" }, t("audioHelp")),
        gate,
        h("div", { class: "subhead" }, t("micsToClean")),
        audio.map((a) => toggle(`${a.label} ${a.name}`, !!this.mics?.includes(a.index), (on) => {
          this.mics = (this.mics ?? []).filter((i) => i !== a.index).concat(on ? [a.index] : []);
          this.host.rerender();
        })),
        choice(t("cleanPreset"), (["light", "standard", "strong"] as const).map((v) => ({ value: v, label: t(`clean_${v}` as Key) })),
          this.preset, (v) => { this.preset = v; this.host.rerender(); }),
        choice(t("loudTarget"), (["podcast", "social", "broadcast"] as const).map((v) => ({ value: v, label: t(`target_${v}` as Key) })),
          this.target, (v) => { this.target = v; this.host.rerender(); }),
        h("div", { class: "actions" },
          button(t("cleanRun"), () => this.clean(), { kind: "primary", disabled: this.busy || !!gate }),
          cleaned ? button(t("cleanRevert"), () => this.revert(), { disabled: this.busy || !!gate }) : null)),
      card(t("colorTitle"), null,
        h("p", { class: "muted small" }, t("colorHelp")),
        tl ? trackSelect(t("refCam"), cams, this.ref, (v) => { this.ref = v; this.host.rerender(); }) : null,
        h("div", { class: "actions" },
          button(t("colorRun"), () => this.color(), { kind: "primary", disabled: this.busy || !!gate || cams.length < 2 }),
          button(t("colorReset"), () => this.resetColor(), { kind: "ghost", disabled: this.busy || !!gate }))),
      card(t("mcTitle"), null,
        h("p", { class: "muted small" }, t("mcHelp")),
        h("div", { class: "actions" }, button(t("mcRun"), () => this.multicam(), { disabled: this.busy || !this.host.snapshot()?.activeSequence }))),
      ...(this.busy || this.error || this.lines.length
        ? [card(this.busy ? t("working") : t("resultsTitle"), null, ...this.status(), this.lines.map((l) => h("p", { class: "small ltr-mixed" }, l)))]
        : []),
    ];
  }
}

// ---- MOGRT library ---------------------------------------------------------------------

export class MogrtView extends Stage {
  private files: string[] | null = null;
  private source: "folder" | "installed" = "folder";
  private placed: { name: string; fields: MogrtField[]; values: string[] } | null = null;

  private async load(): Promise<void> {
    let dir = this.host.prefs.mogrtDir;
    if (this.source === "installed") dir = await ppro().SequenceEditor.getInstalledMogrtPath();
    if (!dir) {
      this.files = [];
      return;
    }
    this.files = await this.host.client().listFiles(dir, ["mogrt"], this.source === "installed");
  }

  private chooseFolder(): void {
    void this.run(async () => {
      const d = await pickFolder();
      if (!d) return;
      this.host.prefs.mogrtDir = d;
      this.host.savePrefs();
      this.source = "folder";
      await this.load();
    });
  }

  private insert(path: string): void {
    void this.run(async () => {
      const live = await liveSequence();
      if (!live) throw new Error(t("needSeqFirst"));
      const at = Number(BigInt((await live.seq.getPlayerPosition()).ticks)) / 254016000000;
      const track = await freeVideoTrack(live.seq, at, 5);
      const item = await insertMogrt(live.project, live.seq, path, at, track);
      const name = base(path).replace(/\.mogrt$/i, "");
      this.host.notify("ok", t("mogrtInserted", { name, track: track + 1 }));
      if (!item) {
        this.placed = { name, fields: [], values: [] };
        return;
      }
      const fields = await mogrtFields(item);
      this.placed = { name, fields, values: fields.map((f) => f.text) };
      await this.host.refresh();
    });
  }

  private applyText(): void {
    void this.run(async () => {
      const live = await liveSequence();
      const p = this.placed;
      if (!live || !p) return;
      let bad = 0;
      for (let i = 0; i < p.fields.length; i++) {
        if (p.values[i] === p.fields[i]!.text) continue;
        const ok = await setMogrtText(live.project, p.fields[i]!, p.values[i]!);
        if (!ok) {
          bad++;
          this.host.notify("warn", t("mogrtSetFail", { name: p.fields[i]!.name }));
        } else {
          p.fields[i]!.text = p.values[i]!;
        }
      }
      if (!bad) this.host.notify("ok", t("mogrtSet"));
    });
  }

  render(): HTMLElement[] {
    if (this.host.engineReady() && this.files === null && !this.busy) void this.run(() => this.load());
    const list = this.files?.length
      ? h("div", { class: "rows" }, this.files.slice(0, 300).map((f) => h("div", { class: "row" },
          h("span", { class: "row-t" }, base(f).replace(/\.mogrt$/i, "")),
          button(t("mogrtInsert"), () => this.insert(f), { kind: "ghost", disabled: this.busy || !this.host.snapshot()?.activeSequence }))))
      : this.files ? h("p", { class: "muted small" }, t("mogrtNone")) : null;
    const p = this.placed;
    return [card(t("mogrtTitle"), this.files ? pill(String(this.files.length), "muted") : null,
      h("p", { class: "muted small" }, t("mogrtHelp")),
      h("div", { class: "actions" },
        button(t("mogrtFolder"), () => this.chooseFolder(), { kind: this.source === "folder" ? "secondary" : "ghost", disabled: this.busy }),
        button(t("mogrtInstalled"), () => { this.source = "installed"; void this.run(() => this.load()); },
          { kind: this.source === "installed" ? "secondary" : "ghost", disabled: this.busy || !this.host.engineReady() })),
      this.source === "folder" && this.host.prefs.mogrtDir ? h("p", { class: "muted small ltr" }, this.host.prefs.mogrtDir) : null,
      ...this.status(),
      list),
      ...(p ? [card(`${t("mogrtFields")}: ${p.name}`, null,
        p.fields.length
          ? p.fields.map((f, i) => h("div", { class: "field" },
              h("div", { class: "field-label" }, f.name),
              h("input", { class: "input field-input", type: "text", dir: "auto", value: p.values[i] ?? "",
                oninput: (e: Event) => { p.values[i] = (e.target as HTMLInputElement).value; } })))
          : h("p", { class: "muted small" }, t("mogrtNoText")),
        p.fields.length ? h("div", { class: "actions" }, button(t("mogrtApply"), () => this.applyText(), { kind: "primary", disabled: this.busy })) : null)] : [])];
  }
}
