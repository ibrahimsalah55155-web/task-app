/**
 * Panel controller: state, navigation and views, in Arabic or English.
 *
 * Working today:
 *  - Premiere status, project/sequence reader, undoable bins and marker;
 *  - the built-in engine (Windows package) starts by itself, no window, no code;
 *    development builds fall back to an engine started by hand + pairing;
 *  - media inspection through the engine;
 *  - the cut engine test: remove In→Out into a new, verified sequence.
 */
import { CompanionClient, CompanionError, type Capabilities, type Health, type Job, type ProbeResult,
  type TokenStore } from "../companion/client.ts";
import { type PluginFiles, canAutostart, connectAutostart, portReport, tryPorts, uxpPluginFiles } from "../companion/autostart.ts";
import { type EngineAddon, loadAddonAsync, startBuiltInEngine } from "../companion/engine.ts";
import { transportInfo } from "../companion/client.ts";
import { errorMessage, formatEntry, getEntries, logger, onLog, setLogLevel } from "../core/log.ts";
import { type Prefs, loadPrefs, savePrefs } from "../core/prefs.ts";
import { formatDuration, formatFps, ticksToTimecode } from "../core/time.ts";
import { atLeast } from "../core/version.ts";
import { hostInfo, ppro, type UxpHostInfo } from "../ppro/api.ts";
import { type CapabilityResult, capability, detectCapabilities } from "../ppro/capabilities.ts";
import { type CutReport, buildCutSequence, sequenceInOut } from "../ppro/cutengine.ts";
import { CHILD_BINS, ROOT_BIN, addMarkerAtPlayhead, ensureProjectBins } from "../ppro/edits.ts";
import { type ProjectSnapshot, getActiveProject, readProjectSnapshot } from "../ppro/project.ts";
import { button, card, h, pill, progress, replace, row, type Tone } from "./dom.ts";
import { type Key, type Lang, defaultLang, getLang, isRtl, pick, setLang, t } from "./i18n.ts";
import type { Transcript } from "../companion/client.ts";
import { CaptionsView, ExportView, ReelsView } from "./delivery.ts";
import { FinishView, MogrtView } from "./finishing.ts";
import type { PhaseHost } from "./kit.ts";
import { MotionView } from "./motion.ts";
import { DirectorView, SilenceView, SyncView } from "./production.ts";
import { STAGES } from "./stages.ts";

declare const __PLUGIN_VERSION__: string;
const VERSION = typeof __PLUGIN_VERSION__ === "string" ? __PLUGIN_VERSION__ : "dev";
const RECOMMENDED_MIN = "26.3";
const log = logger("panel");

type EngineStatus = "starting" | "running" | "unpaired" | "offline" | "error";

interface State {
  view: string;
  host: UxpHostInfo | null;
  caps: CapabilityResult[];
  project: ProjectSnapshot | null;
  projectError: string | null;
  reading: boolean;
  busy: string | null;
  notice: { tone: Tone; text: string } | null;
  engine: {
    mode: "builtin" | "autostart" | "external";
    status: EngineStatus;
    health: Health | null;
    caps: Capabilities | null;
    error: string | null;
    pairCode: string;
    pairing: boolean;
  };
  probe: { job: Job<ProbeResult> | null; result: ProbeResult | null; error: string | null; following: boolean };
  cut: { running: boolean; step: string | null; fraction: number; report: CutReport | null; error: string | null };
}

export class PanelApp {
  private readonly root: HTMLElement;
  private readonly prefs: Prefs;
  private readonly tokens: TokenStore;
  private client: CompanionClient;
  private addon: EngineAddon | null = null;
  private addonProblem: string | null = null;
  private files: PluginFiles | null = null;
  private state: State;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeLog: (() => void) | null = null;
  private visible = true;
  private readonly expanded = new Set<string>();
  private renderedView: string | null = null;
  private readonly motion: MotionView;
  private readonly stageViews: Record<string, { render(): HTMLElement[] }>;
  private readonly transcripts = new Map<string, Transcript>();
  private readonly speakers: PhaseHost["speakers"] = new Map();
  private readonly mogrt: MogrtView;

  constructor(root: HTMLElement, tokens: TokenStore) {
    this.root = root;
    this.tokens = tokens;
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
      engine: { mode: "external", status: "starting", health: null, caps: null, error: null, pairCode: "", pairing: false },
      probe: { job: null, result: null, error: null, following: false },
      cut: { running: false, step: null, fraction: 0, report: null, error: null },
    };
    this.motion = new MotionView({
      client: () => this.client,
      engineReady: () => this.state.engine.status === "running",
      sequence: () => this.state.project?.activeSequence ?? null,
      projectPath: () => this.state.project?.path ?? null,
      prefs: this.prefs,
      savePrefs: () => savePrefs(this.prefs),
      rerender: () => this.render(),
      notify: (tone, text) => this.notify(tone, text),
    });
    const host: PhaseHost = {
      client: () => this.client,
      engineReady: () => this.state.engine.status === "running",
      snapshot: () => this.state.project,
      rerender: () => this.render(),
      notify: (tone, text) => this.notify(tone, text),
      refresh: () => this.refreshProject(),
      transcripts: this.transcripts,
      speakers: this.speakers,
      prefs: this.prefs,
      savePrefs: () => savePrefs(this.prefs),
    };
    this.mogrt = new MogrtView(host);
    this.stageViews = {
      sync: new SyncView(host),
      silence: new SilenceView(host),
      director: new DirectorView(host),
      finish: new FinishView(host),
      captions: new CaptionsView(host),
      reels: new ReelsView(host),
      export: new ExportView(host),
    };
  }

  // ---- lifecycle ------------------------------------------------------------

  start(): void {
    try {
      const host = hostInfo();
      this.state.host = host;
      this.state.caps = detectCapabilities(host.version);
      setLang(this.prefs.lang ?? defaultLang(host.uiLocale));
      log.info(`${host.name} ${host.version}, UXP ${host.uxpVersion}, panel ${VERSION}`);
    } catch (e) {
      setLang(this.prefs.lang ?? "en");
      log.error("Could not read host information", e);
    }
    this.state.engine.mode = "builtin";
    this.unsubscribeLog = onLog(() => this.renderLog());
    this.listenToPremiere();
    this.render();
    void this.refreshProject();
    void this.startEngine();
    this.healthTimer = setInterval(() => {
      if (this.visible) void this.checkEngine(true);
    }, 5000);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) {
      void this.refreshProject();
      void this.checkEngine(true);
    }
  }

  destroy(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.unsubscribeLog?.();
    this.state.probe.following = false;
    // The addon's terminate() and the Windows job object stop the engine with the plugin.
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
    for (const ev of events) {
      if (ev == null) continue;
      try {
        P.EventManager.addGlobalEventListener(ev as string, refresh);
      } catch (e) {
        log.debug(`Event listener not available: ${errorMessage(e)}`);
      }
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refreshProject(), 300);
  }

  private set(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    this.render();
  }

  private setEngine(patch: Partial<State["engine"]>, rerender = true): void {
    this.state.engine = { ...this.state.engine, ...patch };
    if (rerender) this.render();
  }

  private notify(tone: Tone, text: string): void {
    this.set({ notice: { tone, text } });
  }

  private setLanguage(lang: Lang): void {
    setLang(lang);
    this.prefs.lang = lang;
    savePrefs(this.prefs);
    this.render();
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

  private async runEdit(what: Key, fn: () => Promise<string>): Promise<void> {
    if (this.state.busy) return;
    this.set({ busy: what, notice: null });
    try {
      this.notify("ok", await fn());
      void this.refreshProject();
    } catch (e) {
      log.error(`${what} failed`, e);
      this.notify("bad", t("failed", { what: t(what), msg: errorMessage(e) }));
    } finally {
      this.set({ busy: null });
    }
  }

  private createBins(): void {
    void this.runEdit("createBins", async () => {
      const project = await getActiveProject();
      if (!project) throw new Error(t("noProjectOpen"));
      const r = await ensureProjectBins(project);
      return r.created.length ? t("binsCreated", { n: r.created.length }) : t("binsExist");
    });
  }

  private addMarker(): void {
    void this.runEdit("addMarker", async () => {
      const project = await getActiveProject();
      if (!project) throw new Error(t("noProjectOpen"));
      await addMarkerAtPlayhead(project, "MAG check", "Added by Multimedia & AI Group panel");
      return t("markerAdded");
    });
  }

  private async runCutTest(): Promise<void> {
    if (this.state.cut.running) return;
    const project = await getActiveProject();
    const seq = project ? await project.getActiveSequence() : null;
    if (!project || !seq) {
      this.notify("warn", t("needSequence"));
      return;
    }
    const range = await sequenceInOut(seq);
    if (!range) {
      this.notify("warn", t("cutNeedInOut"));
      return;
    }
    const stamp = new Date();
    const hhmmss = [stamp.getHours(), stamp.getMinutes(), stamp.getSeconds()].map((n) => String(n).padStart(2, "0")).join("");
    const name = `${seq.name}_CUT_TEST_${hhmmss}`;
    this.state.cut = { running: true, step: "read", fraction: 0, report: null, error: null };
    this.set({ notice: null });
    try {
      const report = await buildCutSequence(project, seq, {
        remove: [range],
        newName: name,
        onProgress: (step, fraction) => {
          this.state.cut.step = step;
          this.state.cut.fraction = fraction;
          this.render();
        },
      });
      this.state.cut = { running: false, step: "done", fraction: 1, report, error: null };
    } catch (e) {
      log.error("Cut test failed", e);
      this.state.cut = { running: false, step: null, fraction: 0, report: null, error: errorMessage(e) };
    }
    this.render();
    void this.refreshProject();
  }

  // ---- engine ---------------------------------------------------------------

  /**
   * Which way the engine runs, decided once: the native launcher (normal), Windows (when
   * Premiere does not run the launcher, e.g. installed without Creative Cloud), or an engine
   * started by hand (development builds).
   */
  private async chooseEngineMode(): Promise<void> {
    if (this.addon || this.state.engine.mode === "external" || this.state.engine.mode === "autostart") return;
    const load = await loadAddonAsync();
    this.addon = load.addon;
    this.addonProblem = load.problem;
    if (this.addon) {
      this.state.engine.mode = "builtin";
      return;
    }
    try {
      this.files = uxpPluginFiles();
      if (await canAutostart(this.files)) {
        this.state.engine.mode = "autostart";
        if (load.problem) log.info("Using the engine started by Windows instead of the native launcher.");
        return;
      }
    } catch (e) {
      log.debug(`autostart check failed: ${errorMessage(e)}`);
    }
    this.state.engine.mode = "external";
  }

  private async startEngine(): Promise<void> {
    await this.chooseEngineMode();
    const mode = this.state.engine.mode;
    if (mode === "external") {
      await this.checkEngine(false);
      return;
    }
    this.setEngine({ status: "starting", error: null });
    try {
      if (mode === "builtin") {
        try {
          this.client = (await startBuiltInEngine(this.addon!)).client;
        } catch (e) {
          // The launcher loaded but cannot start the engine here: use Windows instead when possible.
          this.files ??= uxpPluginFiles();
          if (!(await canAutostart(this.files))) throw e;
          log.warn(`Native launcher failed (${errorMessage(e)}); starting the engine through Windows.`);
          this.addonProblem = errorMessage(e);
          this.addon = null;
          this.state.engine.mode = "autostart";
        }
      }
      if (this.state.engine.mode === "autostart") {
        this.client = (await connectAutostart(this.files!)).client;
      }
      const health = await this.client.health();
      const caps = await this.client.capabilities();
      this.setEngine({ status: "running", health, caps, error: null });
    } catch (e) {
      log.error("Built-in engine did not start", e);
      this.setEngine({ status: "error", error: errorMessage(e) });
    }
  }

  private async restartEngine(): Promise<void> {
    if (this.addon) {
      try {
        this.addon.stop();
      } catch (e) {
        log.debug(`stop failed: ${errorMessage(e)}`);
      }
    }
    await this.startEngine();
  }

  async checkEngine(quiet = false): Promise<void> {
    const e = this.state.engine;
    if (e.mode === "builtin" || e.mode === "autostart") {
      if (e.status !== "running") {
        // Engine started by Windows may come up later (first start, antivirus scan, log-on): keep looking.
        if (e.mode === "autostart" && e.status !== "starting" && this.files) {
          const tok = (await this.files.read(["engine", "autostart.token"]))?.trim() ?? "";
          const found = await tryPorts(tok);
          if (found) {
            this.client = found.client;
            try {
              this.setEngine({ status: "running", health: await this.client.health(), caps: await this.client.capabilities(), error: null });
              log.info(`Engine (started by Windows) is now answering on port ${found.port}`);
            } catch (err) {
              log.debug(`engine found but not ready: ${errorMessage(err)}`);
            }
          }
        }
        return;
      }
      try {
        this.setEngine({ health: await this.client.health() }, false);
      } catch (err) {
        log.warn("Built-in engine stopped responding", err);
        this.setEngine({ status: "error", error: errorMessage(err) });
      }
      return;
    }
    // external engine (development builds)
    const before = e.status;
    if (!quiet) this.setEngine({ status: "starting" });
    try {
      const health = await this.client.health();
      if (!(await this.client.isPaired())) {
        this.setEngine({ status: "unpaired", health, error: null }, before !== "unpaired" || !quiet);
        return;
      }
      if (before !== "running" || !e.caps) {
        const caps = await this.client.capabilities();
        this.setEngine({ status: "running", health, caps, error: null });
      } else {
        this.setEngine({ health }, false);
      }
    } catch (err) {
      const ce = err instanceof CompanionError ? err : new CompanionError("server", errorMessage(err));
      if (ce.code === "unauthorized") {
        await this.client.forget();
        this.setEngine({ status: "unpaired", error: ce.message });
        return;
      }
      const status: EngineStatus = ce.code === "offline" || ce.code === "timeout" ? "offline" : "error";
      if (status !== before || !quiet) this.setEngine({ status, error: ce.message, caps: null });
    }
  }

  private async pair(): Promise<void> {
    const code = this.state.engine.pairCode.trim();
    if (!code) return;
    this.setEngine({ pairing: true, error: null });
    try {
      await this.client.pair(code);
      this.setEngine({ pairing: false, pairCode: "", status: "starting" });
      await this.checkEngine();
      this.notify("ok", t("paired"));
    } catch (e) {
      this.setEngine({ pairing: false, error: errorMessage(e) });
    }
  }

  private async inspectMedia(): Promise<void> {
    const seq = this.state.project?.activeSequence;
    if (!seq || seq.media.length === 0) {
      this.notify("warn", t("noMediaToInspect"));
      return;
    }
    const paths = seq.media.map((m) => m.path);
    this.state.probe = { job: null, result: null, error: null, following: true };
    this.render();
    try {
      const job = await this.client.submitProbe(paths);
      this.state.probe.job = job;
      this.render();
      const final = await this.client.waitForJob<ProbeResult>(job.id, (j) => {
        this.state.probe.job = j;
        this.render();
      }, { stopFollowing: () => !this.state.probe.following });
      this.state.probe.following = false;
      if (final.state === "succeeded" && final.result) this.state.probe.result = final.result;
      else this.state.probe.error = final.error?.message ?? final.state;
    } catch (e) {
      this.state.probe.following = false;
      this.state.probe.error = errorMessage(e);
    }
    this.render();
  }

  private async cancelProbe(): Promise<void> {
    if (!this.state.probe.job) return;
    try {
      await this.client.cancelJob(this.state.probe.job.id);
    } catch (e) {
      log.warn("Cancel failed", e);
    }
  }

  private async copyDiagnostics(): Promise<void> {
    const s = this.state;
    const cut = s.cut.report
      ? `${s.cut.report.verified}/${s.cut.report.plan.pieces.length} verified; ${s.cut.report.mismatches.slice(0, 5).join(" | ")}`
      : s.cut.error ?? "none";
    const lines = [
      `Multimedia & AI Group panel ${VERSION} (${s.engine.mode} engine)`,
      `Host: ${s.host?.name} ${s.host?.version} | UXP ${s.host?.uxpVersion} | ${s.host?.os} | locale ${s.host?.uiLocale}`,
      `Engine: ${s.engine.status} ${s.engine.health?.version ?? ""} ${s.engine.error ?? ""}`,
      `Engine addon: ${this.addon ? this.safeAddonInfo() : `not used${this.addonProblem ? ` (${this.addonProblem})` : ""}`}`,
      `Origins seen by engine: ${(s.engine.caps?.seenOrigins ?? []).join(", ") || "n/a"}`,
      `Engine ports: ${portReport()}`,
      `Transport: ${transportInfo.used} (fetch error: ${transportInfo.fetchError || "none"}; xhr error: ${transportInfo.xhrError || "none"})`,
      "Capabilities:",
      ...s.caps.map((c) => `  ${c.status.padEnd(24)} ${c.minVersion.padEnd(5)} ${c.label}`),
      `Project: ${s.project?.name ?? "none"} | sequence: ${s.project?.activeSequence?.name ?? "none"}`,
      `Last cut test: ${cut}`,
      "Log:",
      ...getEntries().slice(-150).map(formatEntry),
    ];
    const text = lines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      this.notify("ok", t("diagCopied"));
    } catch {
      console.log(text);
      this.notify("warn", t("diagConsole"));
    }
  }

  private safeAddonInfo(): string {
    try {
      return this.addon?.info() ?? "";
    } catch (e) {
      return `info() failed: ${errorMessage(e)}`;
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
      ["dashboard", t("navDashboard")],
      ...STAGES.map((st) => [st.id, pick({ en: `${st.step} ${st.short.en}`, ar: `${st.step} ${st.short.ar}` })] as [string, string]),
      ["settings", t("navSettings")],
    ];
    const view = views.some(([id]) => id === s.view) ? s.view : "dashboard";
    const oldContent = this.root.querySelector(".content");
    const keepScroll = oldContent && this.renderedView === view ? oldContent.scrollTop : 0;
    this.renderedView = view;

    replace(this.root,
      // No dir="rtl": UXP has no CSS direction support, so .rtl mirrors rows explicitly (see styles.css).
      h("div", { class: `app${isRtl() ? " rtl" : ""}`, lang: getLang() },
        this.renderHeader(),
        h("div", { class: "nav" }, views.map(([id, label]) =>
          h("div", { class: `nav-item${id === view ? " is-active" : ""}`, role: "tab", tabindex: 0,
                     onclick: () => this.go(id) }, label))),
        s.notice ? h("div", { class: `notice notice-${s.notice.tone}` }, h("span", { class: "notice-text" }, s.notice.text),
          h("span", { class: "notice-x", onclick: () => this.set({ notice: null }) }, "×")) : null,
        h("div", { class: "content" },
          view === "dashboard" ? this.renderDashboard()
            : view === "settings" ? this.renderSettings()
              : view === "motion" ? [...this.motion.render(), ...this.mogrt.render()]
                : this.stageViews[view] ? this.stageViews[view]!.render()
                  : this.renderStage(view)),
        h("div", { class: "log", id: "log" })));
    const content = this.root.querySelector(".content");
    if (content && keepScroll) content.scrollTop = keepScroll;
    this.renderLog();
  }

  private renderHeader(): HTMLElement {
    const s = this.state;
    const prTone: Tone = !s.host ? "bad" : atLeast(s.host.version, RECOMMENDED_MIN) ? "ok" : "warn";
    const e = s.engine.status;
    const eTone: Tone = e === "running" ? "ok" : e === "starting" ? "muted" : e === "unpaired" ? "warn" : "bad";
    return h("div", { class: "header" },
      h("div", { class: "brand" },
        h("span", { class: "brand-mark" }, t("appName")),
        h("span", { class: "brand-sub" }, t("appSub"))),
      h("div", { class: "header-right" },
        pill(s.host ? `Pr ${s.host.version}` : "Pr ?", prTone),
        pill(t("engine"), eTone),
        h("div", { class: "lang-btn", role: "button", tabindex: 0, title: t("langButtonTitle"),
                   onclick: () => this.setLanguage(getLang() === "ar" ? "en" : "ar") }, t("langButton"))));
  }

  private renderDashboard(): HTMLElement[] {
    return [this.renderProjectCard(), this.renderCutCard(), this.renderEngineCard(), this.renderProbeCard(), this.renderPremiereCard()];
  }

  private collapsible(id: string, title: string, body: () => (HTMLElement | null)[]): HTMLElement {
    const open = this.expanded.has(id);
    return h("div", { class: "fold" },
      h("div", { class: "fold-head", role: "button", tabindex: 0, onclick: () => {
        if (open) this.expanded.delete(id);
        else this.expanded.add(id);
        this.render();
      } }, `${open ? "▾" : isRtl() ? "◂" : "▸"} ${title}`),
      open ? h("div", { class: "fold-body" }, body()) : null);
  }

  private renderPremiereCard(): HTMLElement {
    const s = this.state;
    if (!s.host) return card(t("premiere"), pill("?", "bad"), h("p", { class: "muted" }, t("hostUnknown")));
    const ok = s.caps.filter((c) => c.status === "available").length;
    const old = !atLeast(s.host.version, RECOMMENDED_MIN);
    return card(t("premiere"), pill(t("apis", { ok, all: s.caps.length }), ok === s.caps.length ? "ok" : "info"),
      row(t("version"), `${s.host.version}`, old ? "warn" : undefined),
      row(t("uxp"), s.host.uxpVersion),
      row(t("system"), s.host.os),
      old ? h("p", { class: "tone-warn small" }, t("oldPremiere", { min: RECOMMENDED_MIN })) : null,
      this.collapsible("caps", t("apiAvailability"), () => s.caps.map((c) => h("div", { class: "cap" },
        pill(c.status === "available" ? t("yes") : c.status === "requires_newer_premiere" ? `${c.minVersion}+` : t("missing"),
             c.status === "available" ? "ok" : c.status === "requires_newer_premiere" ? "muted" : "bad"),
        h("span", { class: "cap-label" }, c.label)))));
  }

  private renderProjectCard(): HTMLElement {
    const s = this.state;
    const busy = s.busy != null;
    const actions = h("div", { class: "actions" },
      button(s.reading ? t("reading") : t("refresh"), () => void this.refreshProject(), { disabled: s.reading }),
      button(t("createBins"), () => this.createBins(), {
        disabled: busy || !s.project, title: `${ROOT_BIN}: ${CHILD_BINS.join(", ")}`,
      }),
      button(t("addMarker"), () => this.addMarker(), { disabled: busy || !s.project?.activeSequence, title: t("addMarkerTitle") }));

    if (s.projectError) return card(t("project"), pill(t("error"), "bad"), h("p", { class: "tone-bad" }, s.projectError), actions);
    if (!s.project) return card(t("project"), pill(t("none"), "muted"), h("p", { class: "muted" }, t("noProject")), actions);

    const p = s.project;
    const seq = p.activeSequence;
    const body: (HTMLElement | null)[] = [row(t("project"), p.name), row(t("file"), h("span", { class: "path ltr", title: p.path }, p.path)),
      row(t("sequences"), p.sequenceCount)];
    if (!seq) {
      body.push(h("p", { class: "muted" }, t("noSequence")));
    } else {
      body.push(
        h("div", { class: "subhead" }, seq.name),
        row(t("frame"), seq.width && seq.height ? `${seq.width}×${seq.height}` : "—"),
        row(t("frameRate"), seq.fps ? `${formatFps(seq.fps)} fps` : "—"),
        row(t("duration"), formatDuration(seq.durationSeconds)),
        row(t("playhead"), h("span", { class: "ltr" }, seq.playheadTimecode ?? "—")),
        row(t("captions"), t("captionTracks", { n: seq.captionTrackCount })),
        h("div", { class: "tracks" }, [...seq.videoTracks, ...seq.audioTracks].map((tr) =>
          h("div", { class: "track" },
            h("span", { class: `track-id ${tr.kind}` }, tr.label),
            h("span", { class: "track-name" }, tr.name || "—"),
            h("span", { class: "track-n muted" }, t("clips", { n: tr.clipCount }))))),
        row(t("mediaFiles"), `${seq.media.length} ${seq.skippedItems ? t("noFileItems", { n: seq.skippedItems }) : ""}`,
          seq.media.some((m) => m.offline) ? "warn" : undefined));
    }
    return card(t("project"), s.reading ? pill(t("reading"), "muted") : pill(t("connected"), "ok"), ...body, actions);
  }

  private renderCutCard(): HTMLElement {
    const c = this.state.cut;
    const hasSubclips = capability(this.state.caps, "subclips");
    const seq = this.state.project?.activeSequence;
    const body: (HTMLElement | null)[] = [h("p", { class: "muted small" }, t("cutHelp"))];
    if (!hasSubclips) body.push(h("p", { class: "tone-warn small" }, t("cutNeed263")));
    if (c.running && c.step) body.push(progress(c.fraction, t(`cutStep_${c.step}` as Key)));
    if (c.report) {
      const r = c.report;
      const fps = seq?.fps ?? { num: 25, den: 1 };
      body.push(r.mismatches.length === 0
        ? h("p", { class: "tone-ok small" }, t("cutResultOk", { name: r.newSequenceName, n: r.verified,
            removed: ticksToTimecode(r.plan.removedTicks, fps) }))
        : h("p", { class: "tone-warn small" }, t("cutResultBad", { name: r.newSequenceName, bad: r.mismatches.length,
            n: r.plan.pieces.length, first: r.mismatches[0] ?? "" })));
    }
    if (c.error) body.push(h("p", { class: "tone-bad small" }, t("cutFailed", { msg: c.error })));
    body.push(h("div", { class: "actions" }, button(t("cutRun"), () => void this.runCutTest(), {
      kind: "primary", disabled: c.running || !hasSubclips || !seq,
    })));
    return card(t("cutTitle"), c.report ? pill(c.report.mismatches.length ? "!" : "✓", c.report.mismatches.length ? "warn" : "ok") : null, ...body);
  }

  private renderEngineCard(): HTMLElement {
    const e = this.state.engine;
    const tone: Record<EngineStatus, Tone> = { running: "ok", starting: "muted", unpaired: "warn", offline: "bad", error: "bad" };
    const label: Record<EngineStatus, string> = {
      running: t("engineRunning"), starting: t("engineStartingPill"), unpaired: t("pair"), offline: t("engineStopped"), error: t("error"),
    };
    const body: (HTMLElement | null)[] = [];
    if (e.mode === "builtin") body.push(h("p", { class: "muted small" }, t("engineBuiltIn")));
    if (e.mode === "autostart") body.push(h("p", { class: "muted small" }, t("engineAutostart")));
    if (e.status === "starting") body.push(h("p", { class: "small" }, t("engineStarting")));
    if (e.status === "offline" || e.status === "error") {
      body.push(h("p", { class: "tone-bad small" }, e.error ?? t("engineOffline")));
      if (e.mode === "external") body.push(h("p", { class: "muted small" }, t("engineExternalHelp")));
    }
    if (e.health) {
      body.push(row(t("version"), e.health.version),
        row(t("ffprobe"), e.health.ffprobeAvailable ? t("found") : t("missing"), e.health.ffprobeAvailable ? undefined : "bad"));
    }
    if (e.status === "unpaired") {
      body.push(h("p", { class: "small" }, t("pairPrompt")),
        e.error ? h("p", { class: "tone-warn small" }, e.error) : null,
        h("div", { class: "pair" },
          h("input", { class: "input", type: "text", placeholder: "K7P 2QX", value: e.pairCode, maxlength: 12,
                       oninput: (ev: Event) => { this.state.engine.pairCode = (ev.target as HTMLInputElement).value; } }),
          button(e.pairing ? t("pairing") : t("pair"), () => void this.pair(), { kind: "primary", disabled: e.pairing })));
    }
    if (e.status === "running" && e.caps) {
      const caps = e.caps;
      const ram = caps.ramBytes ? ` · ${(caps.ramBytes / 1024 ** 3).toFixed(0)} GB RAM` : "";
      body.push(
        row(t("machine"), h("span", { class: "ltr" }, `${caps.platform.system} · ${caps.cpuCount ?? "?"} CPU${ram}`)),
        row(t("gpu"), caps.gpus.length ? caps.gpus.map((g) => g.name).join(", ") : t("gpuNone")),
        this.collapsible("modules", t("aiPackages"), () => Object.entries(caps.modules).map(([name, m]) => h("div", { class: "cap" },
          pill(m.available ? t("yes") : t("no"), m.available ? "ok" : "muted"),
          h("span", { class: "cap-label" }, name)))));
    }
    const actions = e.mode !== "external"
      ? button(t("restartEngine"), () => void this.restartEngine(), { disabled: e.status === "starting" })
      : button(t("retry"), () => void this.checkEngine());
    return card(t("engine"), pill(label[e.status], tone[e.status]), ...body, h("div", { class: "actions" }, actions));
  }

  private renderProbeCard(): HTMLElement {
    const s = this.state;
    const seq = s.project?.activeSequence;
    const ready = s.engine.status === "running";
    const pr = s.probe;
    const running = pr.following && pr.job != null && !["succeeded", "failed", "cancelled"].includes(pr.job.state);
    const body: (HTMLElement | null)[] = [h("p", { class: "muted small" }, t("inspectHelp"))];
    if (pr.following && pr.job) body.push(progress(pr.job.progress, pr.job.message ?? pr.job.state));
    if (pr.error) body.push(h("p", { class: "tone-bad small" }, pr.error));
    if (pr.result) body.push(this.renderProbeResult(pr.result));
    body.push(h("div", { class: "actions" }, running
      ? button(t("cancel"), () => void this.cancelProbe(), { kind: "danger" })
      : button(t("inspect"), () => void this.inspectMedia(), {
        kind: "primary", disabled: !ready || !seq || seq.media.length === 0,
        title: !ready ? t("needEngine") : !seq ? t("needSequence") : undefined,
      })));
    return card(t("inspectTitle"), pr.result ? pill(t("okCount", { ok: pr.result.summary.okCount, all: pr.result.summary.fileCount }),
      pr.result.summary.failedCount ? "warn" : "ok") : null, ...body);
  }

  private renderProbeResult(r: ProbeResult): HTMLElement {
    return h("div", { class: "probe" },
      r.summary.warnings.map((w) => h("div", { class: "warn-line" }, pill(t("check"), "warn"), h("span", { class: "ltr-text" }, w.message))),
      r.items.map((it) => {
        const name = it.path.split(/[\\/]/).pop() ?? it.path;
        if (!it.ok || !it.info) {
          return h("div", { class: "file" }, h("div", { class: "file-name tone-bad ltr" }, name),
            h("div", { class: "file-meta tone-bad ltr" }, it.error?.message ?? "unreadable"));
        }
        const i = it.info;
        const v = i.video[0];
        const a = i.audio[0];
        const meta = [
          v ? `${v.width}×${v.height}` : i.kind,
          v?.frameRate ? `${formatFps(v.frameRate)} fps${v.variableFrameRate ? " VFR" : ""}` : null,
          a ? `${a.sampleRate ? a.sampleRate / 1000 : "?"} kHz ${a.channels ?? "?"}ch` : null,
          i.timecode ? `TC ${i.timecode}` : null,
          formatDuration(i.duration),
        ].filter(Boolean).join(" · ");
        return h("div", { class: "file" },
          h("div", { class: "file-name ltr", title: it.path }, name),
          h("div", { class: "file-meta muted ltr" }, meta),
          i.warnings.filter((w) => w.code !== "no_timecode").map((w) => h("div", { class: "file-warn tone-warn ltr" }, w.message)));
      }));
  }

  private renderStage(id: string): HTMLElement[] {
    const st = STAGES.find((x) => x.id === id);
    if (!st) return [];
    const ready = this.state.engine.status === "running";
    const modules = this.state.engine.caps?.modules;
    const tools = this.state.engine.caps?.tools;
    const need = st.engineNeeds.map((n) => {
      const have = n === "ffmpeg" || n === "ffprobe" ? !!tools?.[n]?.path : !!modules?.[n]?.available;
      return h("div", { class: "cap" }, pill(!ready ? "?" : have ? t("yes") : t("no"), !ready ? "muted" : have ? "ok" : "muted"),
        h("span", { class: "cap-label" }, n));
    });
    return [
      card(pick({ en: `${st.step}. ${st.title.en}`, ar: `${st.step}. ${st.title.ar}` }), pill(t("stageNotBuilt", { n: st.phase }), "muted"),
        h("p", null, pick(st.goal)),
        st.approach.length ? h("div", { class: "subhead" }, t("stageHow")) : null,
        st.approach.length ? h("ul", { class: "list" }, st.approach.map((a) => h("li", null, pick(a)))) : null,
        st.limits.length ? h("div", { class: "subhead" }, t("stageLimits")) : null,
        st.limits.length ? h("ul", { class: "list" }, st.limits.map((a) => h("li", { class: "tone-warn" }, pick(a)))) : null,
        need.length ? h("div", { class: "subhead" }, t("stageNeeds")) : null,
        need,
        h("p", { class: "muted small" }, t("stageNoButtons"))),
    ];
  }

  private renderSettings(): HTMLElement[] {
    const e = this.state.engine;
    return [
      card(t("panel"), null,
        row(t("version"), VERSION),
        h("div", { class: "kv" }, h("span", { class: "kv-k" }, t("language")),
          h("div", { class: "seg" },
            (["ar", "en"] as const).map((l) => h("div", { class: `seg-item${getLang() === l ? " is-active" : ""}`, role: "button",
              tabindex: 0, onclick: () => this.setLanguage(l) }, l === "ar" ? "العربية" : "English")))),
        h("div", { class: "kv" }, h("span", { class: "kv-k" }, t("logLevel")),
          h("select", { class: "select", onchange: (ev: Event) => {
            const lvl = (ev.target as HTMLSelectElement).value as Prefs["logLevel"];
            this.prefs.logLevel = lvl;
            setLogLevel(lvl);
            savePrefs(this.prefs);
          } }, (["debug", "info", "warn", "error"] as const).map((l) => h("option", { value: l, selected: l === this.prefs.logLevel }, l)))),
        h("div", { class: "actions" }, button(t("copyDiagnostics"), () => void this.copyDiagnostics()))),
      card(t("logo"), null,
        row(t("logo"), h("span", { class: "path ltr" }, this.prefs.logoPath ?? t("defaultIcon"))),
        h("p", { class: "muted small" }, t("logoHint")),
        h("div", { class: "kv" }, h("span", { class: "kv-k" }, t("accentColor")),
          h("input", { class: "input field-num ltr", type: "text", value: this.prefs.accent, maxlength: 7,
            onchange: (ev: Event) => {
              const v = (ev.target as HTMLInputElement).value.trim();
              if (/^#[0-9a-fA-F]{6}$/.test(v)) {
                this.prefs.accent = v;
                savePrefs(this.prefs);
                this.motion.invalidateAll();
              }
            } })),
        h("div", { class: "actions" },
          button(t("chooseLogo"), () => void this.motion.chooseLogo()),
          button(t("clearLogo"), () => this.motion.clearLogo(), { disabled: !this.prefs.logoPath }))),
      card(t("settingsEngine"), pill(e.status, e.status === "running" ? "ok" : "warn"),
        row(t("address"), h("span", { class: "ltr" }, this.client.baseUrl)),
        h("div", { class: "actions" },
          e.mode === "external"
            ? button(t("forgetPairing"), () => void this.tokens.clear().then(() => this.setEngine({ status: "unpaired", caps: null })),
              { kind: "danger", disabled: e.status === "unpaired" })
            : button(t("restartEngine"), () => void this.restartEngine()),
          button(t("clearCache"), () => void this.runEdit("clearCache", async () =>
            t("cacheCleared", { n: await this.client.clearCache() })), { disabled: e.status !== "running" }),
          button(t("showEngineLog"), () => void this.runEdit("showEngineLog", async () => {
            const lines = await this.client.logs(40);
            lines.forEach((l) => console.log(l));
            return t("logShown", { n: lines.length });
          }), { disabled: e.status !== "running" }))),
    ];
  }

  private renderLog(): void {
    const el = this.root.querySelector("#log");
    if (!el) return;
    replace(el, getEntries().slice(-5).map((e) => h("div", { class: `log-line log-${e.level}` }, formatEntry(e))));
  }
}
