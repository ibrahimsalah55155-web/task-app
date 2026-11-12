/**
 * Motion Library view: template picker with live preview, Arabic fields,
 * one-click insert at the playhead, and in-place text edits.
 */
import type { CompanionClient, GraphicRequest, GraphicResult, GraphicTemplate } from "../companion/client.ts";
import { errorMessage, logger } from "../core/log.ts";
import type { Prefs } from "../core/prefs.ts";
import { ticksToTimecode } from "../core/time.ts";
import { getActiveProject, type SequenceSnapshot } from "../ppro/project.ts";
import { insertGraphicAtPlayhead, relinkGraphic } from "../ppro/graphics.ts";
import { button, card, h, pill, progress, type Tone } from "./dom.ts";
import { pick, t } from "./i18n.ts";

declare const require: (id: string) => unknown;
const log = logger("motion");

export interface MotionHost {
  client(): CompanionClient;
  engineReady(): boolean;
  sequence(): SequenceSnapshot | null;
  projectPath(): string | null;
  prefs: Prefs;
  savePrefs(): void;
  rerender(): void;
  notify(tone: Tone, text: string): void;
}

interface Placed {
  template: string;
  fields: Record<string, string>;
  duration: number;
  path: string;
  at: string;
  track: number;
}

export class MotionView {
  private readonly host: MotionHost;
  private templates: GraphicTemplate[] | null = null;
  private loading = false;
  private loadError: string | null = null;
  private selected = "lower_third";
  private values: Record<string, Record<string, string>> = {};
  private durations: Record<string, number> = {};
  private previews: Record<string, string> = {};
  private thumbs: Record<string, string> = {};
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private progress = 0;
  private placed: Placed[] = [];
  private editing: number | null = null;

  constructor(host: MotionHost) {
    this.host = host;
  }

  // ---- data -------------------------------------------------------------------

  private frame(): { width: number; height: number; fps: number } {
    const seq = this.host.sequence();
    const fps = seq?.fps ? seq.fps.num / seq.fps.den : 25;
    return { width: seq?.width ?? 1080, height: seq?.height ?? 1920, fps };
  }

  private request(templateId: string, extra: Partial<GraphicRequest> = {}): GraphicRequest {
    const tpl = this.templates?.find((x) => x.id === templateId);
    return {
      template: templateId,
      fields: { ...(this.values[templateId] ?? {}) },
      ...this.frame(),
      duration: this.durations[templateId] ?? tpl?.defaultDuration,
      accent: this.host.prefs.accent,
      icon: this.host.prefs.logoPath ?? undefined,
      ...extra,
    };
  }

  async ensureLoaded(): Promise<void> {
    if (this.templates || this.loading || !this.host.engineReady()) return;
    this.loading = true;
    this.loadError = null;
    try {
      this.templates = await this.host.client().graphicTemplates();
      for (const tpl of this.templates) {
        this.values[tpl.id] = Object.fromEntries(tpl.fields.map((f) => [f.id, f.default]));
        this.durations[tpl.id] = tpl.defaultDuration;
      }
      this.loading = false;
      this.host.rerender();
      await this.loadThumbs();
    } catch (e) {
      this.loading = false;
      this.loadError = errorMessage(e);
      this.host.rerender();
    }
  }

  private async loadThumbs(): Promise<void> {
    for (const tpl of this.templates ?? []) {
      try {
        this.thumbs[tpl.id] = await this.host.client().graphicPreview(this.request(tpl.id, { crop: true }));
        this.host.rerender();
      } catch (e) {
        log.warn(`Preview of ${tpl.id} failed`, e);
      }
    }
    await this.refreshPreview();
  }

  private schedulePreview(): void {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => void this.refreshPreview(), 450);
  }

  private async refreshPreview(): Promise<void> {
    const id = this.selected;
    try {
      this.previews[id] = await this.host.client().graphicPreview(this.request(id));
      this.host.rerender();
    } catch (e) {
      log.warn("Preview failed", e);
    }
  }

  invalidateAll(): void {
    this.thumbs = {};
    this.previews = {};
    if (this.templates) void this.loadThumbs();
  }

  // ---- actions --------------------------------------------------------------------

  private outDir(): string | undefined {
    const p = this.host.projectPath();
    if (!p) return undefined;
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    const sep = p.includes("\\") ? "\\" : "/";
    return i > 0 ? `${p.slice(0, i)}${sep}MAG Graphics` : undefined;
  }

  private async renderFile(req: GraphicRequest): Promise<GraphicResult> {
    const client = this.host.client();
    const job = await client.submitRender(req);
    const done = await client.waitForJob<GraphicResult>(job.id, (j) => {
      this.progress = j.progress;
      this.host.rerender();
    });
    if (done.state !== "succeeded" || !done.result) throw new Error(done.error?.message ?? done.state);
    return done.result;
  }

  private async insert(): Promise<void> {
    if (this.busy) return;
    const seq = this.host.sequence();
    const project = await getActiveProject();
    const live = project ? await project.getActiveSequence() : null;
    if (!seq || !project || !live) {
      this.host.notify("warn", t("motionNeedSequence"));
      return;
    }
    this.busy = true;
    this.progress = 0;
    this.host.rerender();
    try {
      const req = this.request(this.selected, { outDir: this.outDir() });
      const result = await this.renderFile(req);
      const placement = await insertGraphicAtPlayhead(project, live, result.path, result.duration);
      const tc = seq.fps ? ticksToTimecode(placement.start, seq.fps) : "";
      this.placed.unshift({ template: this.selected, fields: { ...req.fields }, duration: result.duration,
        path: result.path, at: tc, track: placement.trackIndex + 1 });
      this.host.notify("ok", t("inserted", { track: placement.trackIndex + 1, tc }));
    } catch (e) {
      log.error("Insert graphic failed", e);
      this.host.notify("bad", t("failed", { what: t("insertAtPlayhead"), msg: errorMessage(e) }));
    } finally {
      this.busy = false;
      this.host.rerender();
    }
  }

  private async update(): Promise<void> {
    const idx = this.editing;
    if (idx == null || this.busy) return;
    const item = this.placed[idx];
    const project = await getActiveProject();
    if (!item || !project) return;
    this.busy = true;
    this.host.rerender();
    try {
      const result = await this.renderFile(this.request(item.template, { duration: item.duration, outDir: this.outDir() }));
      if (result.path !== item.path) await relinkGraphic(project, item.path, result.path);
      item.path = result.path;
      item.fields = { ...(this.values[item.template] ?? {}) };
      this.editing = null;
      this.host.notify("ok", t("updated"));
    } catch (e) {
      log.error("Update graphic failed", e);
      this.host.notify("bad", t("failed", { what: t("updateGraphic"), msg: errorMessage(e) }));
    } finally {
      this.busy = false;
      this.host.rerender();
    }
  }

  private startEdit(i: number): void {
    const item = this.placed[i];
    if (!item) return;
    this.editing = i;
    this.selected = item.template;
    this.values[item.template] = { ...item.fields };
    this.schedulePreview();
    this.host.rerender();
  }

  async chooseLogo(): Promise<void> {
    try {
      const uxp = require("uxp") as { storage: { localFileSystem: { getFileForOpening(o: unknown): Promise<{ nativePath: string } | null> } } };
      const file = await uxp.storage.localFileSystem.getFileForOpening({ types: ["png", "jpg", "jpeg"] });
      if (!file) return;
      this.host.prefs.logoPath = file.nativePath;
      this.host.savePrefs();
      this.invalidateAll();
      this.host.rerender();
    } catch (e) {
      this.host.notify("bad", errorMessage(e));
    }
  }

  clearLogo(): void {
    this.host.prefs.logoPath = null;
    this.host.savePrefs();
    this.invalidateAll();
    this.host.rerender();
  }

  // ---- view -----------------------------------------------------------------------

  render(): HTMLElement[] {
    if (!this.host.engineReady()) {
      return [card(t("motionTitle"), pill("…", "muted"), h("p", { class: "muted small" }, t("motionNeedEngine")))];
    }
    if (!this.templates) {
      void this.ensureLoaded();
      return [card(t("motionTitle"), null,
        h("p", { class: this.loadError ? "tone-bad small" : "muted small" }, this.loadError ?? t("motionLoading")))];
    }
    const tpl = this.templates.find((x) => x.id === this.selected) ?? this.templates[0]!;
    const seq = this.host.sequence();
    const vals = this.values[tpl.id] ?? {};
    const preview = this.previews[tpl.id];
    const portrait = (seq?.height ?? 1920) >= (seq?.width ?? 1080);

    const grid = h("div", { class: "tpl-grid" }, this.templates.map((x) =>
      h("div", { class: `tpl${x.id === tpl.id ? " is-active" : ""}`, role: "button", tabindex: 0, onclick: () => {
        this.selected = x.id;
        if (this.editing != null && this.placed[this.editing]?.template !== x.id) this.editing = null;
        if (!this.previews[x.id]) this.schedulePreview();
        this.host.rerender();
      } },
        h("div", { class: "tpl-thumb" },
          this.thumbs[x.id] ? h("img", { class: "tpl-img", src: `data:image/png;base64,${this.thumbs[x.id]}` }) : null),
        h("div", { class: "tpl-name" }, pick(x.title)))));

    const fields = tpl.fields.map((f) => h("div", { class: "field" },
      h("div", { class: "field-label" }, pick(f.label)),
      f.kind === "choice"
        ? h("div", { class: "seg" }, (f.options ?? []).map((o) => h("div", {
            class: `seg-item${vals[f.id] === o.value ? " is-active" : ""}`, role: "button", tabindex: 0,
            onclick: () => { vals[f.id] = o.value; this.schedulePreview(); this.host.rerender(); },
          }, pick(o.label))))
        : h("input", { class: "input field-input", type: "text", value: vals[f.id] ?? "", dir: "auto",
            oninput: (e: Event) => { vals[f.id] = (e.target as HTMLInputElement).value; this.schedulePreview(); } })));

    const durInput = h("div", { class: "field" },
      h("div", { class: "field-label" }, t("duration_s")),
      h("input", { class: "input field-num", type: "number", min: 1, max: 60, step: 0.5,
        value: String(this.durations[tpl.id] ?? tpl.defaultDuration), disabled: this.editing != null,
        oninput: (e: Event) => {
          const v = Number((e.target as HTMLInputElement).value);
          if (v >= 0.5 && v <= 60) this.durations[tpl.id] = v;
        } }));

    const editingNow = this.editing != null;
    const actions = h("div", { class: "actions" },
      editingNow
        ? [button(t("updateGraphic"), () => void this.update(), { kind: "primary", disabled: this.busy }),
           button(t("cancelEdit"), () => { this.editing = null; this.host.rerender(); }, { disabled: this.busy })]
        : button(t("insertAtPlayhead"), () => void this.insert(), { kind: "primary", disabled: this.busy || !seq }),
      button(t("preview"), () => void this.refreshPreview(), { disabled: this.busy }));

    const editor = card(pick(tpl.title), editingNow ? pill(t("edit"), "info") : null,
      h("div", { class: `preview${portrait ? "" : " wide"}` },
        preview ? h("img", { class: "preview-img", src: `data:image/png;base64,${preview}` }) : null),
      fields,
      durInput,
      !seq ? h("p", { class: "tone-warn small" }, t("motionNeedSequence")) : null,
      this.busy ? progress(this.progress, t("rendering")) : null,
      actions,
      h("p", { class: "muted small" }, t("editableNote")));

    const placed = this.placed.length
      ? card(t("placedTitle"), pill(String(this.placed.length), "muted"), this.placed.map((p, i) => {
          const tp = this.templates?.find((x) => x.id === p.template);
          const label = Object.values(p.fields).filter((v) => v && v.length > 1).join(" · ");
          return h("div", { class: "placed" },
            h("span", { class: "placed-tc ltr" }, `V${p.track} ${p.at}`),
            h("span", { class: "placed-label" }, `${tp ? pick(tp.title) : p.template}: ${label}`),
            button(t("edit"), () => this.startEdit(i), { kind: "ghost", disabled: this.busy }));
        }))
      : null;

    return [card(t("motionTitle"), null, h("p", { class: "muted small" }, t("motionHelp")), grid), editor,
      ...(placed ? [placed] : [])];
  }
}
