/** Stage views 1-3: Sync & Build, Smart Silence Cut, AI Auto Director. */
import type { SilenceCandidate, Shot, SyncResultRow } from "../companion/client.ts";
import { errorMessage, logger } from "../core/log.ts";
import { ticksToTimecode } from "../core/time.ts";
import { ppro } from "../ppro/api.ts";
import { type BuildItem, type Role, buildSyncedSequence } from "../ppro/build.ts";
import { type CutReport, buildCutSequence } from "../ppro/cutengine.ts";
import { getActiveProject } from "../ppro/project.ts";
import { finishTransaction } from "../ppro/transaction.ts";
import { guessRoles, readTimeline, secondsToTicks, type TimelineSpec } from "../ppro/timeline.ts";
import { button, card, h, pill, progress } from "./dom.ts";
import { type Key, t } from "./i18n.ts";
import { MEDIA_TYPES, type PhaseHost, choice, fmtTime, liveSequence, numField, pickFiles, toggle, trackSelect } from "./kit.ts";

const log = logger("stages");
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

function cutMessage(r: CutReport, fps: { num: number; den: number }): [("ok" | "warn"), string] {
  return r.mismatches.length === 0
    ? ["ok", t("cutDone", { name: r.newSequenceName, n: r.verified, removed: ticksToTimecode(r.plan.removedTicks, fps) })]
    : ["warn", t("cutIssues", { name: r.newSequenceName, bad: r.mismatches.length, first: r.mismatches[0] ?? "" })];
}

abstract class Stage {
  protected busy = false;
  protected progress = 0;
  protected message: string | null = null;
  protected error: string | null = null;
  protected readonly host: PhaseHost;
  constructor(host: PhaseHost) {
    this.host = host;
  }

  protected async run(fn: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.progress = 0;
    this.error = null;
    this.message = null;
    this.host.rerender();
    try {
      await fn();
    } catch (e) {
      log.error("Stage action failed", e);
      this.error = errorMessage(e);
    } finally {
      this.busy = false;
      this.host.rerender();
    }
  }

  protected onJob = (j: { progress: number; message: string | null }) => {
    this.progress = j.progress;
    this.message = j.message;
    this.host.rerender();
  };

  protected status(): (HTMLElement | null)[] {
    return [
      this.busy ? progress(this.progress, this.message ?? t("working")) : null,
      this.error ? h("p", { class: "tone-bad small" }, this.error) : null,
    ];
  }

  protected gate(): HTMLElement | null {
    if (!this.host.engineReady()) return h("p", { class: "tone-warn small" }, t("motionNeedEngine"));
    if (!this.host.snapshot()?.activeSequence) return h("p", { class: "tone-warn small" }, t("needSeqFirst"));
    return null;
  }
}

// ---- 1. Sync & Build -----------------------------------------------------------------

const ROLES: { role: Role; key: Key }[] = [
  { role: "guest_cam", key: "roleGuestCam" }, { role: "host_cam", key: "roleHostCam" }, { role: "wide_cam", key: "roleWideCam" },
  { role: "guest_mic", key: "roleGuestMic" }, { role: "host_mic", key: "roleHostMic" }, { role: "extra", key: "roleExtra" },
];

export class SyncView extends Stage {
  private files: { path: string; role: Role }[] = [];
  private results: SyncResultRow[] | null = null;
  private manual: Record<string, string> = {};
  private name = "PODCAST_01_SYNC";

  private async add(role: Role): Promise<void> {
    const paths = await pickFiles(MEDIA_TYPES);
    for (const p of paths) if (!this.files.some((f) => f.path === p)) this.files.push({ path: p, role });
    this.results = null;
    this.host.rerender();
  }

  private analyze(): void {
    void this.run(async () => {
      if (!this.files.length) throw new Error(t("syncNeedFiles"));
      this.results = (await this.host.client().runJob<{ results: SyncResultRow[] }>("sync", { files: this.files }, this.onJob)).results;
    });
  }

  private build(): void {
    void this.run(async () => {
      const items: BuildItem[] = [];
      for (const f of this.files) {
        const r = this.results?.find((x) => x.path === f.path);
        const manual = this.manual[f.path];
        const start = manual !== undefined && manual !== "" ? Number(manual) : r?.seqStart;
        if (start == null || !Number.isFinite(start)) throw new Error(t("syncNeedOffsets"));
        items.push({ path: f.path, role: f.role, seqStart: start });
      }
      const project = await getActiveProject();
      if (!project) throw new Error(t("noProjectOpen"));
      await buildSyncedSequence(project, { name: this.name, items, trackNames: {
        wide: t("roleWideCam"), host: t("roleHostCam"), guest: t("roleGuestCam"), guestMic: t("roleGuestMic"),
        hostMic: t("roleHostMic"), extra: t("roleExtra"), camAudio: t("camAudio") } });
      this.host.notify("ok", t("built", { name: this.name, n: items.length }));
      await this.host.refresh();
    });
  }

  render(): HTMLElement[] {
    const engineOk = this.host.engineReady();
    const groups = ROLES.map(({ role, key }) => {
      const list = this.files.filter((f) => f.role === role);
      return h("div", { class: "slot" },
        h("div", { class: "slot-h" }, h("span", { class: "slot-t" }, t(key)),
          button(t("addFiles"), () => void this.add(role), { kind: "ghost", disabled: this.busy })),
        list.map((f) => {
          const r = this.results?.find((x) => x.path === f.path);
          return h("div", { class: "slot-file" },
            h("span", { class: "slot-name ltr" }, fileName(f.path)),
            r ? pill(t(`conf_${r.confidence}` as Key), r.confidence === "high" ? "ok" : r.confidence === "medium" ? "info" : "bad") : null,
            r?.seqStart != null ? h("span", { class: "slot-off ltr" }, `+${r.seqStart.toFixed(3)} s`) : null,
            r ? h("input", { class: "input frow-num ltr", type: "number", step: 0.001, placeholder: t("manualOffset"),
              value: this.manual[f.path] ?? "", oninput: (e: Event) => { this.manual[f.path] = (e.target as HTMLInputElement).value; } }) : null,
            button("×", () => { this.files = this.files.filter((x) => x !== f); this.host.rerender(); }, { kind: "ghost" }),
            r ? h("div", { class: "slot-meta muted small" },
              `${t(`m_${r.method}` as Key)}${r.driftPpm != null ? ` · ${t("drift")} ${r.driftPpm} ppm (${r.driftFrames} f)` : ""}`) : null,
            r && r.warnings.length ? h("div", { class: "tone-warn small" }, r.warnings.join(" ")) : null);
        }));
    });
    return [card(t("syncTitle"), this.results ? pill("✓", "ok") : null,
      h("p", { class: "muted small" }, t("syncHelp")),
      engineOk ? null : h("p", { class: "tone-warn small" }, t("motionNeedEngine")),
      groups,
      h("div", { class: "frow" }, h("span", { class: "frow-k" }, t("newSeqName")),
        h("input", { class: "input ltr", type: "text", value: this.name, oninput: (e: Event) => { this.name = (e.target as HTMLInputElement).value || "PODCAST_01_SYNC"; } })),
      ...this.status(),
      h("div", { class: "actions" },
        button(t("analyzeSync"), () => this.analyze(), { kind: "primary", disabled: this.busy || !engineOk || !this.files.length }),
        button(t("buildSeq"), () => this.build(), { disabled: this.busy || !this.results })))];
  }
}

// ---- 2. Smart Silence Cut ------------------------------------------------------------

export class SilenceView extends Stage {
  private tl: TimelineSpec | null = null;
  private tracks: number[] | null = null;
  private preset: "conservative" | "balanced" | "aggressive" = "balanced";
  private params: Record<string, number> = {};
  private laughter = true;
  private breath = false;
  private cands: SilenceCandidate[] | null = null;
  private approved = new Set<number>();
  private stats: { removable: number; count: number; newDuration: number } | null = null;

  private async ensureTimeline(): Promise<TimelineSpec> {
    const live = await liveSequence();
    if (!live) throw new Error(t("needSeqFirst"));
    this.tl = await readTimeline(live.seq);
    if (!this.tracks) {
      const r = guessRoles(this.tl);
      this.tracks = [r.guestMic, r.hostMic].filter((x): x is number => x != null);
    }
    return this.tl;
  }

  private analyze(): void {
    void this.run(async () => {
      const tl = await this.ensureTimeline();
      const tracks = tl.audio.filter((x) => this.tracks!.includes(x.index) && x.pieces.length).map((x) => ({ name: x.name, pieces: x.pieces }));
      if (!tracks.length) throw new Error(t("tracksToUse"));
      const res = await this.host.client().runJob<{ candidates: SilenceCandidate[]; stats: { removable: number; count: number; newDuration: number } }>(
        "silence", { tracks, duration: tl.duration, params: { preset: this.preset, ...this.params, preserveLaughter: this.laughter, preserveBreath: this.breath } }, this.onJob);
      this.cands = res.candidates;
      this.stats = res.stats;
      this.approved = new Set(res.candidates.map((_, i) => i));
    });
  }

  private async seek(sec: number): Promise<void> {
    const live = await liveSequence();
    if (live) await live.seq.setPlayerPosition(ppro().TickTime.createWithTicks(String(secondsToTicks(sec))));
  }

  private markers(): void {
    void this.run(async () => {
      const live = await liveSequence();
      if (!live || !this.cands) return;
      const P = ppro();
      const m = await P.Markers.getMarkers(live.seq);
      const chosen = this.cands.filter((_, i) => this.approved.has(i));
      const undo = "MAG: Pause markers";
      let committed = false;
      live.project.lockedAccess(() => {
        const actions = chosen.map((c) => m.createAddMarkerAction("MAG pause", "Comment",
          P.TickTime.createWithTicks(String(secondsToTicks(c.start))), P.TickTime.createWithTicks(String(secondsToTicks(c.dur))),
          `${c.dur.toFixed(2)} s`));
        committed = live.project.executeTransaction((compound) => {
          for (const a of actions) compound.addAction(a);
        }, undo);
      });
      finishTransaction(committed, undo, chosen.length);
      this.host.notify("ok", t("markersAdded", { n: chosen.length }));
    });
  }

  private apply(): void {
    void this.run(async () => {
      const live = await liveSequence();
      if (!live || !this.cands) return;
      const remove = this.cands.filter((_, i) => this.approved.has(i)).map((c) => ({ start: secondsToTicks(c.start), end: secondsToTicks(c.end) }));
      const report = await buildCutSequence(live.project, live.seq, { remove, newName: `${live.seq.name}_SILENCE_CUT`,
        onProgress: (_s, f) => { this.progress = f; this.host.rerender(); } });
      const fps = this.host.snapshot()?.activeSequence?.fps ?? { num: 25, den: 1 };
      this.host.notify(...cutMessage(report, fps));
      this.cands = null;
      await this.host.refresh();
    });
  }

  render(): HTMLElement[] {
    const gate = this.gate();
    if (!this.tl && !gate && !this.busy) void this.ensureTimeline().then(() => this.host.rerender()).catch(() => undefined);
    const p = { minSilence: 0.7, padBefore: 0.12, padAfter: 0.2, keepPause: 0.3, threshold: 0.5, ...this.params };
    const audio = this.tl?.audio.filter((x) => x.pieces.length) ?? [];
    const list = this.cands ? h("div", { class: "rows" }, this.cands.map((c, i) => h("div", {
      class: `row${this.approved.has(i) ? "" : " off"}`, role: "button", tabindex: 0,
    },
      h("span", { class: `tick${this.approved.has(i) ? " on" : ""}`, onclick: (e: Event) => {
        e.stopPropagation();
        if (this.approved.has(i)) this.approved.delete(i); else this.approved.add(i);
        this.host.rerender();
      } }, this.approved.has(i) ? "✓" : ""),
      h("span", { class: "row-t ltr", onclick: () => void this.seek(c.start) }, `${fmtTime(c.start)} → ${fmtTime(c.end)}`),
      h("span", { class: "row-d ltr" }, `${c.dur.toFixed(2)} s`)))) : null;
    return [card(t("silenceTitle"), this.cands ? pill(String(this.approved.size), "info") : null,
      h("p", { class: "muted small" }, t("silenceHelp")),
      gate,
      h("div", { class: "subhead" }, t("tracksToUse")),
      audio.map((x) => toggle(`${x.label} ${x.name}`, !!this.tracks?.includes(x.index), (on) => {
        this.tracks = (this.tracks ?? []).filter((i) => i !== x.index).concat(on ? [x.index] : []);
        this.host.rerender();
      })),
      choice(t("preset"), (["conservative", "balanced", "aggressive"] as const).map((v) => ({ value: v, label: t(`preset_${v}` as Key) })),
        this.preset, (v) => { this.preset = v; this.params = {}; this.host.rerender(); }),
      numField(t("minSilence"), p.minSilence, (v) => { this.params.minSilence = v; }),
      numField(t("padBefore"), p.padBefore, (v) => { this.params.padBefore = v; }),
      numField(t("padAfter"), p.padAfter, (v) => { this.params.padAfter = v; }),
      numField(t("keepPause"), p.keepPause, (v) => { this.params.keepPause = v; }),
      numField(t("threshold"), p.threshold, (v) => { this.params.threshold = v; }, 0.05, 0.05, 0.95),
      toggle(t("keepLaughter"), this.laughter, (v) => { this.laughter = v; this.host.rerender(); }),
      toggle(t("keepBreath"), this.breath, (v) => { this.breath = v; this.host.rerender(); }),
      ...this.status(),
      this.stats ? h("p", { class: "small" }, t("pauses", { n: this.stats.count, sec: this.stats.removable.toFixed(1), len: fmtTime(this.stats.newDuration) })) : null,
      this.cands ? h("div", { class: "actions" },
        button(t("selectAll"), () => { this.approved = new Set(this.cands!.map((_, i) => i)); this.host.rerender(); }, { kind: "ghost" }),
        button(t("selectNone"), () => { this.approved.clear(); this.host.rerender(); }, { kind: "ghost" })) : null,
      list,
      h("div", { class: "actions" },
        button(t("analyze"), () => this.analyze(), { kind: this.cands ? "secondary" : "primary", disabled: this.busy || !!gate }),
        this.cands ? button(t("addMarkers"), () => this.markers(), { disabled: this.busy || !this.approved.size }) : null,
        this.cands ? button(t("applyCut"), () => this.apply(), { kind: "primary", disabled: this.busy || !this.approved.size }) : null),
      h("p", { class: "muted small" }, t("undoHint")))];
  }
}

// ---- 3. AI Auto Director -------------------------------------------------------------

type Cam = "guest" | "host" | "wide";

export class DirectorView extends Stage {
  private tl: TimelineSpec | null = null;
  private map: { guestMic: number | null; hostMic: number | null; guestCam: number | null; hostCam: number | null; wideCam: number | null } | null = null;
  private params = { minShot: 2.0, maxShot: 0, both: "wide", silence: "hold", sensitivity: 0.5, delay: 0 };
  private shots: Shot[] | null = null;

  private async ensureTimeline(): Promise<void> {
    const live = await liveSequence();
    if (!live) return;
    this.tl = await readTimeline(live.seq);
    this.map ??= guessRoles(this.tl);
  }

  private analyze(): void {
    void this.run(async () => {
      await this.ensureTimeline();
      const tl = this.tl!;
      const m = this.map!;
      const g = tl.audio.find((x) => x.index === m.guestMic);
      const hh = tl.audio.find((x) => x.index === m.hostMic);
      if (!g || !hh) throw new Error(`${t("guestMicTrack")} / ${t("hostMicTrack")}`);
      const res = await this.host.client().runJob<{ shots: Shot[] }>("director", {
        guest: { name: g.name, pieces: g.pieces }, host: { name: hh.name, pieces: hh.pieces }, duration: tl.duration, params: this.params,
      }, this.onJob);
      this.shots = res.shots;
    });
  }

  private apply(): void {
    void this.run(async () => {
      const live = await liveSequence();
      const m = this.map;
      if (!live || !this.shots || !m) return;
      if (m.guestCam == null || m.hostCam == null || m.wideCam == null) throw new Error(t("needCamTracks"));
      const role: Record<number, Cam> = { [m.guestCam]: "guest", [m.hostCam]: "host", [m.wideCam]: "wide" };
      const shots = this.shots;
      const camAt = (sec: number) => (shots.find((s) => sec >= s.start && sec < s.end) ?? shots[shots.length - 1]!).camera;
      const report = await buildCutSequence(live.project, live.seq, {
        splitAt: shots.slice(1).map((s) => secondsToTicks(s.start)),
        newName: `${live.seq.name}_DIRECTOR`,
        disable: (p) => {
          if (p.kind !== "video" || !(p.track in role)) return null;
          const mid = Number(p.dest + (p.srcOut - p.srcIn) / 2n) / 254016000000;
          return role[p.track] !== camAt(mid);
        },
        onProgress: (_s, f) => { this.progress = f; this.host.rerender(); },
      });
      if (report.mismatches.length) {
        const fps = this.host.snapshot()?.activeSequence?.fps ?? { num: 25, den: 1 };
        this.host.notify(...cutMessage(report, fps));
      } else {
        this.host.notify("ok", t("directorDone", { name: report.newSequenceName, n: shots.length }));
      }
      await this.host.refresh();
    });
  }

  render(): HTMLElement[] {
    const gate = this.gate();
    if (!this.tl && !gate && !this.busy) void this.ensureTimeline().then(() => this.host.rerender()).catch(() => undefined);
    const tl = this.tl;
    const m = this.map;
    const pol = (keys: string[]) => keys.map((k) => ({ value: k, label: t(`pol_${k}` as Key) }));
    const total = tl?.duration ?? 1;
    const strip = this.shots ? h("div", { class: "shotstrip" }, this.shots.map((s, i) => h("div", {
      class: `shot cam-${s.camera}`, style: `width: ${Math.max(0.3, ((s.end - s.start) / total) * 100)}%`,
      title: `${fmtTime(s.start)} ${t(`camShort_${s.camera}` as Key)}`,
      onclick: () => {
        const order: Cam[] = ["guest", "host", "wide"];
        this.shots![i] = { ...s, camera: order[(order.indexOf(s.camera) + 1) % 3]! };
        this.host.rerender();
      },
    }))) : null;
    const counts = this.shots ? { g: this.shots.filter((s) => s.camera === "guest").length, h: this.shots.filter((s) => s.camera === "host").length,
      w: this.shots.filter((s) => s.camera === "wide").length } : null;
    return [card(t("directorTitle"), this.shots ? pill(String(this.shots.length), "info") : null,
      h("p", { class: "muted small" }, t("directorHelp")),
      gate,
      tl && m ? [
        trackSelect(t("guestMicTrack"), tl.audio, m.guestMic, (v) => { m.guestMic = v; this.host.rerender(); }),
        trackSelect(t("hostMicTrack"), tl.audio, m.hostMic, (v) => { m.hostMic = v; this.host.rerender(); }),
        trackSelect(t("guestCamTrack"), tl.video, m.guestCam, (v) => { m.guestCam = v; this.host.rerender(); }),
        trackSelect(t("hostCamTrack"), tl.video, m.hostCam, (v) => { m.hostCam = v; this.host.rerender(); }),
        trackSelect(t("wideCamTrack"), tl.video, m.wideCam, (v) => { m.wideCam = v; this.host.rerender(); }),
      ] : null,
      numField(t("minShot"), this.params.minShot, (v) => { this.params.minShot = v; }, 0.5, 0.5, 30),
      numField(t("maxShot"), this.params.maxShot, (v) => { this.params.maxShot = v; }, 1, 0, 120),
      choice(t("bothTalk"), pol(["wide", "hold", "louder"]), this.params.both, (v) => { this.params.both = v; this.host.rerender(); }),
      choice(t("silencePolicy"), pol(["hold", "wide"]), this.params.silence, (v) => { this.params.silence = v; this.host.rerender(); }),
      numField(t("sensitivity"), this.params.sensitivity, (v) => { this.params.sensitivity = v; }, 0.1, 0, 1),
      numField(t("delay"), this.params.delay, (v) => { this.params.delay = v; }, 0.04, -1, 1),
      ...this.status(),
      counts ? h("p", { class: "small" }, t("shots", { n: this.shots!.length, g: counts.g, h: counts.h, w: counts.w })) : null,
      strip,
      this.shots ? h("div", { class: "legend small" },
        (["guest", "host", "wide"] as Cam[]).map((c) => h("span", { class: `lg cam-${c}` }, t(`camShort_${c}` as Key))),
        h("span", { class: "muted" }, t("shotHint"))) : null,
      h("div", { class: "actions" },
        button(t("analyze"), () => this.analyze(), { kind: this.shots ? "secondary" : "primary", disabled: this.busy || !!gate }),
        this.shots ? button(t("applyDirector"), () => this.apply(), { kind: "primary", disabled: this.busy }) : null),
      h("p", { class: "muted small" }, t("undoHint")))];
  }
}
