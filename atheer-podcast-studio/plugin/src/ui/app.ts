/**
 * Panel controller: state, navigation and views.
 * Phase 1 functionality: Premiere/companion status, project + sequence read,
 * undoable bins/marker writes, companion pairing and media inspection.
 */
import { CompanionClient, CompanionError, type Capabilities, type Health, type Job, type ProbeResult,
  type TokenStore } from "../companion/client.ts";
import { errorMessage, formatEntry, getEntries, logger, onLog, setLogLevel } from "../core/log.ts";
import { type Prefs, loadPrefs, savePrefs } from "../core/prefs.ts";
import { formatDuration, formatFps } from "../core/time.ts";
import { atLeast } from "../core/version.ts";
import { hostInfo, ppro, type UxpHostInfo } from "../ppro/api.ts";
import { type CapabilityResult, detectCapabilities } from "../ppro/capabilities.ts";
import { CHILD_BINS, ROOT_BIN, addMarkerAtPlayhead, ensureAtheerBins } from "../ppro/edits.ts";
import { type ProjectSnapshot, getActiveProject, readProjectSnapshot } from "../ppro/project.ts";
import { button, card, h, pill, progress, replace, row, type Tone } from "./dom.ts";
import { STAGES } from "./stages.ts";

declare const __PLUGIN_VERSION__: string;
const VERSION = typeof __PLUGIN_VERSION__ === "string" ? __PLUGIN_VERSION__ : "dev";
const RECOMMENDED_MIN = "26.3";
const log = logger("panel");

type CompanionStatus = "checking" | "offline" | "unpaired" | "ready" | "error";

interface State {
  view: string;
  host: UxpHostInfo | null;
  caps: CapabilityResult[];
  project: ProjectSnapshot | null;
  projectError: string | null;
  reading: boolean;
  busy: string | null;
  notice: { tone: Tone; text: string } | null;
  companion: {
    status: CompanionStatus;
    health: Health | null;
    caps: Capabilities | null;
    error: string | null;
    pairCode: string;
    pairing: boolean;
  };
  probe: { job: Job<ProbeResult> | null; result: ProbeResult | null; error: string | null; following: boolean };
}

export class PanelApp {
  private readonly root: HTMLElement;
  private readonly prefs: Prefs;
  private readonly client: CompanionClient;
  private state: State;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeLog: (() => void) | null = null;
  private visible = true;
  private readonly expanded = new Set<string>();
  private renderedView: string | null = null;

  constructor(root: HTMLElement, tokens: TokenStore) {
    this.root = root;
    this.prefs = loadPrefs();
    setLogLevel(this.prefs.logLevel);
    this.client = new CompanionClient({ baseUrl: this.prefs.companionUrl, tokens });
    this.state = {
      view: this.prefs.lastView,
      host: null,
      caps: [],
      project: null,
      projectError: null,
      reading: false,
      busy: null,
      notice: null,
      companion: { status: "checking", health: null, caps: null, error: null, pairCode: "", pairing: false },
      probe: { job: null, result: null, error: null, following: false },
    };
  }

  // ---- lifecycle ------------------------------------------------------------

  start(): void {
    try {
      const host = hostInfo();
      this.state.host = host;
      this.state.caps = detectCapabilities(host.version);
      log.info(`${host.name} ${host.version}, UXP ${host.uxpVersion}, panel ${VERSION}`);
      if (!atLeast(host.version, RECOMMENDED_MIN)) {
        log.warn(`Premiere ${host.version} is older than ${RECOMMENDED_MIN}; some modules will be unavailable.`);
      }
    } catch (e) {
      log.error("Could not read host information", e);
    }
    this.unsubscribeLog = onLog(() => this.renderLog());
    this.listenToPremiere();
    this.render();
    void this.refreshProject();
    void this.checkCompanion();
    this.healthTimer = setInterval(() => {
      if (this.visible) void this.checkCompanion(true);
    }, 5000);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) {
      void this.refreshProject();
      void this.checkCompanion(true);
    }
  }

  destroy(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.unsubscribeLog?.();
    this.state.probe.following = false;
  }

  private listenToPremiere(): void {
    const P = ppro();
    const refresh = () => this.scheduleRefresh();
    const events: unknown[] = [
      P.Constants.SequenceEvent?.ACTIVATED,
      P.Constants.SequenceEvent?.CLOSED,
      P.Constants.ProjectEvent?.OPENED,
      P.Constants.ProjectEvent?.CLOSED,
      P.Constants.ProjectEvent?.ACTIVATED,
    ];
    let n = 0;
    for (const ev of events) {
      if (ev == null) continue;
      try {
        P.EventManager.addGlobalEventListener(ev as string, refresh);
        n++;
      } catch (e) {
        log.debug(`Event listener not available: ${errorMessage(e)}`);
      }
    }
    log.debug(`Listening to ${n} Premiere events`);
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refreshProject(), 300);
  }

  private set(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    this.render();
  }

  private setCompanion(patch: Partial<State["companion"]>, rerender = true): void {
    this.state.companion = { ...this.state.companion, ...patch };
    if (rerender) this.render();
  }

  private notify(tone: Tone, text: string): void {
    this.set({ notice: { tone, text } });
  }

  // ---- Premiere -------------------------------------------------------------

  async refreshProject(): Promise<void> {
    if (this.state.reading) return;
    this.set({ reading: true });
    try {
      const project = await readProjectSnapshot();
      this.set({ project, projectError: null, reading: false });
    } catch (e) {
      log.error("Reading the project failed", e);
      this.set({ projectError: errorMessage(e), reading: false });
    }
  }

  private async runEdit(label: string, fn: () => Promise<string>): Promise<void> {
    if (this.state.busy) return;
    this.set({ busy: label, notice: null });
    try {
      const msg = await fn();
      this.notify("ok", msg);
      void this.refreshProject();
    } catch (e) {
      log.error(`${label} failed`, e);
      this.notify("bad", `${label} failed: ${errorMessage(e)}`);
    } finally {
      this.set({ busy: null });
    }
  }

  private createBins(): void {
    void this.runEdit("Create bins", async () => {
      const project = await getActiveProject();
      if (!project) throw new Error("No project is open.");
      const r = await ensureAtheerBins(project);
      return r.created.length
        ? `Created ${r.created.length} bin(s). Undo with Ctrl/Cmd+Z (${r.undoSteps} step${r.undoSteps > 1 ? "s" : ""}).`
        : "The ATHEER bins already exist. Nothing changed.";
    });
  }

  private addMarker(): void {
    void this.runEdit("Add marker", async () => {
      const project = await getActiveProject();
      if (!project) throw new Error("No project is open.");
      await addMarkerAtPlayhead(project, "ATHEER check", "Added by ATHEER Podcast Studio connection test");
      return "Marker added at the playhead. Undo with Ctrl/Cmd+Z.";
    });
  }

  // ---- companion ------------------------------------------------------------

  async checkCompanion(quiet = false): Promise<void> {
    const before = this.state.companion.status;
    if (!quiet) this.setCompanion({ status: "checking" });
    try {
      const health = await this.client.health();
      if (!(await this.client.isPaired())) {
        this.setCompanion({ status: "unpaired", health, error: null }, before !== "unpaired" || !quiet);
        return;
      }
      if (before !== "ready" || !this.state.companion.caps) {
        const caps = await this.client.capabilities();
        this.setCompanion({ status: "ready", health, caps, error: null });
        if (before !== "ready") log.info(`Companion ${health.version} connected`);
      } else {
        this.setCompanion({ health }, false);
      }
    } catch (e) {
      const err = e instanceof CompanionError ? e : new CompanionError("server", errorMessage(e));
      if (err.code === "unauthorized") {
        await this.client.forget();
        this.setCompanion({ status: "unpaired", error: "The companion no longer recognises this panel. Pair again." });
        return;
      }
      const status: CompanionStatus = err.code === "offline" || err.code === "timeout" ? "offline" : "error";
      if (status !== before || !quiet) {
        if (before === "ready") log.warn(`Companion connection lost: ${err.message}`);
        this.setCompanion({ status, error: err.message, caps: status === "offline" ? null : this.state.companion.caps });
      }
    }
  }

  private async pair(): Promise<void> {
    const code = this.state.companion.pairCode.trim();
    if (!code) return;
    this.setCompanion({ pairing: true, error: null });
    try {
      await this.client.pair(code);
      this.setCompanion({ pairing: false, pairCode: "", status: "checking" });
      await this.checkCompanion();
      this.notify("ok", "Paired with the companion.");
    } catch (e) {
      this.setCompanion({ pairing: false, error: errorMessage(e) });
    }
  }

  private async unpair(): Promise<void> {
    await this.client.forget();
    this.setCompanion({ status: "unpaired", caps: null });
    log.info("Forgot the companion pairing");
  }

  private async inspectMedia(): Promise<void> {
    const seq = this.state.project?.activeSequence;
    if (!seq || seq.media.length === 0) {
      this.notify("warn", "The active sequence has no media files to inspect.");
      return;
    }
    const paths = seq.media.map((m) => m.path);
    this.state.probe = { job: null, result: null, error: null, following: true };
    this.render();
    try {
      const job = await this.client.submitProbe(paths);
      log.info(`Inspecting ${paths.length} file(s) (job ${job.id})`);
      this.state.probe.job = job;
      this.render();
      const final = await this.client.waitForJob<ProbeResult>(job.id, (j) => {
        this.state.probe.job = j;
        this.render();
      }, { stopFollowing: () => !this.state.probe.following });
      this.state.probe.following = false;
      if (final.state === "succeeded" && final.result) {
        this.state.probe.result = final.result;
        const s = final.result.summary;
        log.info(`Inspection done: ${s.okCount}/${s.fileCount} readable, ${final.result.cacheHits} from cache`);
      } else if (final.state === "failed") {
        this.state.probe.error = final.error?.message ?? "Inspection failed";
      } else {
        this.state.probe.error = "Inspection cancelled.";
      }
    } catch (e) {
      this.state.probe.following = false;
      this.state.probe.error = errorMessage(e);
    }
    this.render();
  }

  private async cancelProbe(): Promise<void> {
    const job = this.state.probe.job;
    if (!job) return;
    try {
      await this.client.cancelJob(job.id);
    } catch (e) {
      log.warn("Cancel failed", e);
    }
  }

  private async copyDiagnostics(): Promise<void> {
    const s = this.state;
    const lines = [
      `ATHEER Podcast Studio panel ${VERSION}`,
      `Host: ${s.host?.name} ${s.host?.version} | UXP ${s.host?.uxpVersion} | ${s.host?.os} | locale ${s.host?.uiLocale}`,
      `Companion: ${s.companion.status} ${s.companion.health?.version ?? ""} ${s.companion.error ?? ""}`,
      `Companion origins seen: ${(s.companion.caps?.seenOrigins ?? []).join(", ") || "n/a"}`,
      "Capabilities:",
      ...s.caps.map((c) => `  ${c.status.padEnd(24)} ${c.minVersion.padEnd(5)} ${c.label}`),
      `Project: ${s.project?.name ?? "none"} | sequence: ${s.project?.activeSequence?.name ?? "none"}`,
      "Log:",
      ...getEntries().slice(-120).map(formatEntry),
    ];
    const text = lines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      this.notify("ok", "Diagnostics copied to the clipboard.");
    } catch (e) {
      log.warn("Clipboard unavailable; diagnostics written to the UXP console instead", e);
      console.log(text);
      this.notify("warn", "Clipboard unavailable. Diagnostics were written to the UXP Developer Tool console.");
    }
  }

  // ---- rendering ------------------------------------------------------------

  private go(view: string): void {
    this.prefs.lastView = view;
    savePrefs(this.prefs);
    this.set({ view, notice: null });
  }

  render(): void {
    const s = this.state;
    const views: [string, string][] = [
      ["dashboard", "Dashboard"],
      ...STAGES.map((st) => [st.id, `${st.step} ${st.short}`] as [string, string]),
      ["settings", "Settings"],
    ];
    const known = views.some(([id]) => id === s.view);
    const view = known ? s.view : "dashboard";
    // Re-rendering replaces the DOM; keep the reader's place within the same view.
    const oldContent = this.root.querySelector(".content");
    const keepScroll = oldContent && this.renderedView === view ? oldContent.scrollTop : 0;
    this.renderedView = view;

    replace(this.root,
      h("div", { class: "app" },
        this.renderHeader(),
        h("div", { class: "nav" }, views.map(([id, label]) =>
          h("div", { class: `nav-item${id === view ? " is-active" : ""}`, role: "tab", tabindex: 0,
                     onclick: () => this.go(id) }, label))),
        s.notice ? h("div", { class: `notice notice-${s.notice.tone}` }, s.notice.text,
          h("span", { class: "notice-x", onclick: () => this.set({ notice: null }) }, "×")) : null,
        h("div", { class: "content" },
          view === "dashboard" ? this.renderDashboard()
            : view === "settings" ? this.renderSettings()
              : this.renderStage(view)),
        h("div", { class: "log", id: "log" })));
    const content = this.root.querySelector(".content");
    if (content && keepScroll) content.scrollTop = keepScroll;
    this.renderLog();
  }

  private renderHeader(): HTMLElement {
    const s = this.state;
    const pv = s.host ? `Pr ${s.host.version}` : "Pr ?";
    const prTone: Tone = !s.host ? "bad" : atLeast(s.host.version, RECOMMENDED_MIN) ? "ok" : "warn";
    const c = s.companion.status;
    const cTone: Tone = c === "ready" ? "ok" : c === "checking" ? "muted" : c === "unpaired" ? "warn" : "bad";
    const cText = { ready: "Companion", checking: "Companion…", unpaired: "Not paired", offline: "Companion off",
                    error: "Companion error" }[c];
    return h("div", { class: "header" },
      h("div", { class: "brand" }, h("span", { class: "brand-mark" }, "ATHEER"), h("span", { class: "brand-sub" }, "Podcast Studio")),
      h("div", { class: "header-pills" }, pill(pv, prTone), pill(cText, cTone)));
  }

  private renderDashboard(): HTMLElement[] {
    return [this.renderPremiereCard(), this.renderProjectCard(), this.renderCompanionCard(), this.renderProbeCard()];
  }

  private renderPremiereCard(): HTMLElement {
    const s = this.state;
    if (!s.host) return card("Premiere", pill("unknown", "bad"), h("p", { class: "muted" }, "Host information unavailable."));
    const ok = s.caps.filter((c) => c.status === "available").length;
    const old = !atLeast(s.host.version, RECOMMENDED_MIN);
    return card("Premiere", pill(`${ok}/${s.caps.length} APIs`, ok === s.caps.length ? "ok" : "info"),
      row("Version", `${s.host.name} ${s.host.version}`, old ? "warn" : undefined),
      row("UXP", s.host.uxpVersion),
      row("System", s.host.os),
      old ? h("p", { class: "tone-warn small" },
        `Premiere ${RECOMMENDED_MIN}+ is recommended. Older 26.x builds miss track renaming, preset sequences and subclip actions.`) : null,
      this.collapsible("caps", "API availability",
        () => s.caps.map((c) => h("div", { class: "cap" },
          pill(c.status === "available" ? "yes" : c.status === "requires_newer_premiere" ? `${c.minVersion}+` : "missing",
               c.status === "available" ? "ok" : c.status === "requires_newer_premiere" ? "muted" : "bad"),
          h("span", { class: "cap-label" }, c.label),
          h("span", { class: "cap-used muted" }, c.usedBy)))));
  }

  private collapsible(id: string, title: string, body: () => (HTMLElement | null)[]): HTMLElement {
    const open = this.expanded.has(id);
    return h("div", { class: "fold" },
      h("div", { class: "fold-head", role: "button", tabindex: 0, onclick: () => {
        if (open) this.expanded.delete(id);
        else this.expanded.add(id);
        this.render();
      } }, `${open ? "▾" : "▸"} ${title}`),
      open ? h("div", { class: "fold-body" }, body()) : null);
  }

  private renderProjectCard(): HTMLElement {
    const s = this.state;
    const busy = s.busy != null;
    const actions = h("div", { class: "actions" },
      button(s.reading ? "Reading…" : "Refresh", () => void this.refreshProject(), { disabled: s.reading }),
      button("Create ATHEER bins", () => this.createBins(), {
        disabled: busy || !s.project,
        title: `${ROOT_BIN} with ${CHILD_BINS.join(", ")}`,
      }),
      button("Add test marker", () => this.addMarker(), {
        disabled: busy || !s.project?.activeSequence,
        title: "Adds a comment marker at the playhead (undoable) to verify timeline writes",
      }));

    if (s.projectError) return card("Project", pill("error", "bad"), h("p", { class: "tone-bad" }, s.projectError), actions);
    if (!s.project) return card("Project", pill("none", "muted"), h("p", { class: "muted" }, "Open a project in Premiere."), actions);

    const p = s.project;
    const seq = p.activeSequence;
    const body: (HTMLElement | null)[] = [
      row("Project", p.name),
      row("File", h("span", { class: "path", title: p.path }, p.path)),
      row("Sequences", p.sequenceCount),
    ];
    if (!seq) {
      body.push(h("p", { class: "muted" }, "No active sequence. Open one in the Timeline."));
    } else {
      body.push(
        h("div", { class: "subhead" }, seq.name),
        row("Frame", seq.width && seq.height ? `${seq.width}×${seq.height}` : "—"),
        row("Frame rate", seq.fps ? `${formatFps(seq.fps)} fps` : "—"),
        row("Duration", formatDuration(seq.durationSeconds)),
        row("Playhead", seq.playheadTimecode ?? "—"),
        row("Captions", `${seq.captionTrackCount} track(s)`),
        h("div", { class: "tracks" },
          [...seq.videoTracks, ...seq.audioTracks].map((t) =>
            h("div", { class: "track" },
              h("span", { class: `track-id ${t.kind}` }, t.label),
              h("span", { class: "track-name" }, t.name || "—"),
              h("span", { class: "track-n muted" }, `${t.clipCount} clip${t.clipCount === 1 ? "" : "s"}`)))),
        row("Media files", `${seq.media.length}${seq.skippedItems ? ` (+${seq.skippedItems} items without a file)` : ""}`,
          seq.media.some((m) => m.offline) ? "warn" : undefined),
      );
    }
    return card("Project", s.reading ? pill("reading", "muted") : pill("connected", "ok"), ...body, actions);
  }

  private renderCompanionCard(): HTMLElement {
    const c = this.state.companion;
    const toneFor: Record<CompanionStatus, Tone> = { ready: "ok", checking: "muted", unpaired: "warn", offline: "bad", error: "bad" };
    const body: (HTMLElement | null)[] = [];
    if (c.status === "offline" || c.status === "error") {
      body.push(h("p", { class: "tone-bad small" }, c.error ?? "Not reachable."),
        h("p", { class: "muted small" }, "Start the companion (see INSTALL.md), keep its window open, then press Retry."));
    }
    if (c.health) body.push(row("Version", c.health.version), row("FFprobe", c.health.ffprobeAvailable ? "found" : "missing",
      c.health.ffprobeAvailable ? undefined : "bad"));
    if (c.status === "unpaired") {
      body.push(
        h("p", { class: "small" }, "Enter the pairing code shown in the companion window."),
        c.error ? h("p", { class: "tone-warn small" }, c.error) : null,
        h("div", { class: "pair" },
          h("input", { class: "input", type: "text", placeholder: "e.g. K7P 2QX", value: c.pairCode, maxlength: 12,
                       oninput: (e: Event) => { this.state.companion.pairCode = (e.target as HTMLInputElement).value; } }),
          button(c.pairing ? "Pairing…" : "Pair", () => void this.pair(), { kind: "primary", disabled: c.pairing })));
    }
    if (c.status === "ready" && c.caps) {
      const caps = c.caps;
      const ramGb = caps.ramBytes ? `${(caps.ramBytes / 1024 ** 3).toFixed(0)} GB RAM` : "";
      body.push(
        row("Machine", `${caps.platform.system} ${caps.platform.machine} · ${caps.cpuCount ?? "?"} CPU ${ramGb}`),
        row("GPU", caps.gpus.length ? caps.gpus.map((g) => g.name).join(", ") : "none detected (CPU mode)"),
        row("FFmpeg", caps.tools.ffmpeg.version ? caps.tools.ffmpeg.version.replace(/ Copyright.*/, "") : "missing",
          caps.tools.ffmpeg.path ? undefined : "bad"),
        this.collapsible("modules", "AI packages (needed from Phase 2)",
          () => Object.entries(caps.modules).map(([name, m]) => h("div", { class: "cap" },
            pill(m.available ? "yes" : "no", m.available ? "ok" : "muted"),
            h("span", { class: "cap-label" }, name), h("span", { class: "cap-used muted" }, m.purpose)))));
    }
    return card("Companion", pill(c.status, toneFor[c.status]), ...body,
      h("div", { class: "actions" }, button("Retry", () => void this.checkCompanion())));
  }

  private renderProbeCard(): HTMLElement {
    const s = this.state;
    const seq = s.project?.activeSequence;
    const ready = s.companion.status === "ready";
    const pr = s.probe;
    const running = pr.following && pr.job != null && !["succeeded", "failed", "cancelled"].includes(pr.job.state);
    const body: (HTMLElement | null)[] = [
      h("p", { class: "muted small" },
        "Sends the file paths used in the active sequence to the companion, which reads them with FFprobe: frame rate, timecode, audio, and sync risks."),
    ];
    if (pr.following && pr.job) body.push(progress(pr.job.progress, pr.job.message ?? pr.job.state));
    if (pr.error) body.push(h("p", { class: "tone-bad small" }, pr.error));
    if (pr.result) body.push(this.renderProbeResult(pr.result));
    body.push(h("div", { class: "actions" },
      running
        ? button("Cancel", () => void this.cancelProbe(), { kind: "danger" })
        : button("Inspect sequence media", () => void this.inspectMedia(), {
          kind: "primary",
          disabled: !ready || !seq || seq.media.length === 0,
          title: !ready ? "Connect the companion first" : !seq ? "Open a sequence first" : undefined,
        })));
    return card("Media inspection", pr.result ? pill(`${pr.result.summary.okCount}/${pr.result.summary.fileCount} ok`,
      pr.result.summary.failedCount ? "warn" : "ok") : null, ...body);
  }

  private renderProbeResult(r: ProbeResult): HTMLElement {
    return h("div", { class: "probe" },
      r.summary.warnings.map((w) => h("div", { class: "warn-line" }, pill("check", "warn"), h("span", null, w.message))),
      r.items.map((it) => {
        const name = it.path.split(/[\\/]/).pop() ?? it.path;
        if (!it.ok || !it.info) {
          return h("div", { class: "file" }, h("div", { class: "file-name tone-bad" }, name),
            h("div", { class: "file-meta tone-bad" }, it.error?.message ?? "unreadable"));
        }
        const i = it.info;
        const v = i.video[0];
        const a = i.audio[0];
        const meta = [
          i.kind,
          v ? `${v.width}×${v.height}` : null,
          v?.frameRate ? `${formatFps(v.frameRate)} fps${v.variableFrameRate ? " VFR" : ""}` : null,
          a ? `${a.sampleRate ? a.sampleRate / 1000 : "?"} kHz ${a.channels ?? "?"}ch` : null,
          i.timecode ? `TC ${i.timecode}` : null,
          formatDuration(i.duration),
          it.cached ? "cached" : null,
        ].filter(Boolean).join(" · ");
        return h("div", { class: "file" },
          h("div", { class: "file-name", title: it.path }, name),
          h("div", { class: "file-meta muted" }, meta),
          i.warnings.filter((w) => w.code !== "no_timecode").map((w) => h("div", { class: "file-warn tone-warn" }, w.message)));
      }));
  }

  private renderStage(id: string): HTMLElement[] {
    const st = STAGES.find((x) => x.id === id);
    if (!st) return [];
    const modules = this.state.companion.caps?.modules;
    const tools = this.state.companion.caps?.tools;
    const need = st.companionNeeds.map((n) => {
      const have = n === "ffmpeg" || n === "ffprobe" ? !!tools?.[n]?.path : !!modules?.[n]?.available;
      return h("div", { class: "cap" }, pill(this.state.companion.status !== "ready" ? "?" : have ? "yes" : "no",
        this.state.companion.status !== "ready" ? "muted" : have ? "ok" : "muted"), h("span", { class: "cap-label" }, n));
    });
    return [
      card(`${st.step}. ${st.title}`, pill(`Phase ${st.phase} · not built yet`, "muted"),
        h("p", null, st.goal),
        h("div", { class: "subhead" }, "How it will work"),
        h("ul", { class: "list" }, st.approach.map((a) => h("li", null, a))),
        st.limits.length ? h("div", { class: "subhead" }, "Premiere API limits found in the audit") : null,
        st.limits.length ? h("ul", { class: "list" }, st.limits.map((a) => h("li", { class: "tone-warn" }, a))) : null,
        need.length ? h("div", { class: "subhead" }, "Companion requirements") : null,
        need,
        h("p", { class: "muted small" }, "This stage has no buttons until it works in Premiere. See docs/FEASIBILITY_AUDIT.md.")),
    ];
  }

  private renderSettings(): HTMLElement[] {
    const c = this.state.companion;
    return [
      card("Companion", pill(c.status, c.status === "ready" ? "ok" : "warn"),
        row("Address", this.client.baseUrl),
        h("p", { class: "muted small" }, "The address is fixed by the plugin manifest's network permission (port 47820)."),
        h("div", { class: "actions" },
          button("Forget pairing", () => void this.unpair(), { kind: "danger", disabled: c.status === "unpaired" }),
          button("Clear analysis cache", () => void this.runEdit("Clear cache", async () =>
            `Removed ${await this.client.clearCache()} cached result(s).`), { disabled: c.status !== "ready" }),
          button("Show companion log", () => void this.runEdit("Companion log", async () => {
            const lines = await this.client.logs(40);
            lines.forEach((l) => console.log(l));
            return `Last ${lines.length} companion log lines written to the UXP console.`;
          }), { disabled: c.status !== "ready" }))),
      card("Panel", null,
        row("Version", VERSION),
        h("div", { class: "kv" }, h("span", { class: "kv-k" }, "Log level"),
          h("select", { class: "select", onchange: (e: Event) => {
            const lvl = (e.target as HTMLSelectElement).value as Prefs["logLevel"];
            this.prefs.logLevel = lvl;
            setLogLevel(lvl);
            savePrefs(this.prefs);
          } }, (["debug", "info", "warn", "error"] as const).map((l) =>
            h("option", { value: l, selected: l === this.prefs.logLevel }, l)))),
        h("div", { class: "actions" }, button("Copy diagnostics", () => void this.copyDiagnostics()))),
    ];
  }

  private renderLog(): void {
    const el = this.root.querySelector("#log");
    if (!el) return;
    const recent = getEntries().slice(-6);
    replace(el, recent.map((e) => h("div", { class: `log-line log-${e.level}` }, formatEntry(e))));
  }
}
