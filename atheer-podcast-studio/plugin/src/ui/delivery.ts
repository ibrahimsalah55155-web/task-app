/** Stage views 4-6: Smart Captions, AI Viral Clip Finder, Review & Export. */
import type { Sequence } from "@adobe/premierepro";
import type { Caption, ProbeResult, Reel } from "../companion/client.ts";
import { errorMessage, logger } from "../core/log.ts";
import { ppro } from "../ppro/api.ts";
import { buildCutSequence, readLiveItems } from "../ppro/cutengine.ts";
import { getActiveProject } from "../ppro/project.ts";
import { ASPECTS, type ReframeTarget, exportSequences, reframe, setFrameSize } from "../ppro/reframe.ts";
import { srtToCaptionTrack } from "../ppro/finishing.ts";
import { placeStills } from "../ppro/stills.ts";
import { secondsToTicks } from "../ppro/timeline.ts";
import { button, card, h, pill, progress } from "./dom.ts";
import { type Key, getLang, t } from "./i18n.ts";
import { type PhaseHost, allWords, choice, fmtTime, joinPath, lines, liveSequence, numField, parseRules, pickFile, pickFolder,
  projectDir, toggle, transcribeActive } from "./kit.ts";

const log = logger("delivery");

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

  protected guid(): string | null {
    return this.host.snapshot()?.activeSequence?.guid ?? null;
  }
}

const MODEL_OPTIONS = ["large-v3-turbo", "large-v3", "medium", "small"];

// ---- 4. Smart Captions ---------------------------------------------------------------

export class CaptionsView extends Stage {
  private model = "large-v3-turbo";
  private language: "ar" | "en" | "auto" = "ar";
  private maxChars: number | null = null;
  private captions = new Map<string, Caption[]>();
  private translations = new Map<string, { lang: string; captions: Caption[] }>();
  private showing: "orig" | "tr" = "orig";
  private trTarget: "en" | "ar" = "en";
  private style = "podcast";
  private glossaryText: string | null = null;
  private rulesText: string | null = null;
  private wordsOpen = false;

  /** Captions currently shown/edited/exported: original or the translation. */
  private current(): Caption[] | undefined {
    const g = this.guid();
    if (!g) return undefined;
    if (this.showing === "tr") return this.translations.get(g)?.captions;
    return this.captions.get(g);
  }

  private saveWords(): void {
    if (this.glossaryText !== null) this.host.prefs.glossary = lines(this.glossaryText);
    if (this.rulesText !== null) this.host.prefs.rules = parseRules(this.rulesText);
    this.host.savePrefs();
    this.host.notify("ok", t("wordsSaved"));
  }

  private translate(): void {
    void this.run(async () => {
      const g = this.guid();
      const caps = g ? this.captions.get(g) : null;
      if (!g || !caps) return;
      const info = await this.host.client().analysisInfo();
      const src = this.trTarget === "en" ? "ar" : "en";
      if (info.translation && !info.translation.includes(`${src}-${this.trTarget}`)) throw new Error(t("translateMissing"));
      const res = await this.host.client().runJob<{ captions: Caption[] }>("translate",
        { captions: caps.map((c) => ({ ...c })), source: src, target: this.trTarget },
        (j) => { this.progress = j.progress; this.message = j.message; this.host.rerender(); });
      const out = res.captions.map((c) => ({ ...c, words: c.words ?? [], lowConfidence: c.lowConfidence ?? [] }));
      this.translations.set(g, { lang: this.trTarget, captions: out });
      this.showing = "tr";
      this.host.notify("ok", t("translated", { n: out.length, lang: t(`tr_${this.trTarget}` as Key) }));
    });
  }

  private native(): void {
    void this.run(async () => {
      const caps = this.current();
      const dir = projectDir(this.host.snapshot());
      const seq = this.host.snapshot()?.activeSequence;
      const live = await liveSequence();
      if (!caps || !dir || !seq || !live) return;
      const suffix = this.showing === "tr" ? `_${this.translations.get(this.guid()!)?.lang ?? "tr"}` : "";
      const path = await this.host.client().writeSrt(caps, joinPath(dir, "MAG Captions", `${seq.name}${suffix}_${Date.now().toString(36)}.srt`));
      const r = await srtToCaptionTrack(live.project, live.seq, path);
      this.host.notify(r.onTimeline ? "ok" : "warn", r.onTimeline ? t("nativeDone") : r.inBin ? t("nativeInBin") : t("srtSaved", { path }));
      await this.host.refresh();
    });
  }

  private defaultMax(): number {
    const s = this.host.snapshot()?.activeSequence;
    return s && s.height && s.width && s.height > s.width ? 32 : 42;
  }

  private transcribe(): void {
    void this.run(async () => {
      const { guid, transcript } = await transcribeActive(this.host, this.model, this.language === "auto" ? null : this.language,
        (f, m) => { this.progress = f; this.message = m; this.host.rerender(); });
      this.captions.set(guid, await this.host.client().buildCaptions(allWords(transcript), this.maxChars ?? this.defaultMax()));
      this.translations.delete(guid);
      this.showing = "orig";
      const fixed = (transcript as { corrected?: number }).corrected ?? 0;
      this.host.notify("ok", t("transcriptReady", { n: allWords(transcript).length, lang: transcript.language })
        + (fixed ? ` ${t("corrected", { n: fixed })}` : ""));
    });
  }

  private rebuild(): void {
    void this.run(async () => {
      const g = this.guid();
      const tr = g ? this.host.transcripts.get(g) : null;
      if (!g || !tr) return;
      // Re-apply the saved corrections to the words, then rebuild.
      const words = allWords(tr).map((w) => ({ ...w }));
      let fixed = 0;
      for (const [a, b] of this.host.prefs.rules) {
        for (const w of words) {
          const bare = w.word.replace(/[^\p{L}\p{N}]+$/u, "");
          if (bare === a) {
            w.word = b + w.word.slice(bare.length);
            fixed++;
          }
        }
      }
      this.captions.set(g, await this.host.client().buildCaptions(words, this.maxChars ?? this.defaultMax()));
      this.translations.delete(g);
      this.showing = "orig";
      if (fixed) this.host.notify("ok", t("corrected", { n: fixed }));
    });
  }

  private srt(): void {
    void this.run(async () => {
      const caps = this.current();
      const dir = projectDir(this.host.snapshot());
      const seq = this.host.snapshot()?.activeSequence;
      if (!caps || !dir || !seq) return;
      const suffix = this.showing === "tr" ? `_${this.translations.get(this.guid()!)?.lang ?? "tr"}` : "";
      const path = await this.host.client().writeSrt(caps, joinPath(dir, "MAG Captions", `${seq.name}${suffix}.srt`));
      this.host.notify("ok", t("srtSaved", { path }));
    });
  }

  private place(): void {
    void this.run(async () => {
      const caps = this.current();
      const snap = this.host.snapshot();
      const seq = snap?.activeSequence;
      const dir = projectDir(snap);
      const live = await liveSequence();
      if (!caps || !seq || !dir || !live) return;
      const res = await this.host.client().runJob<{ items: { path: string; start: number; end: number }[] }>("render_captions", {
        captions: caps, style: this.style, width: seq.width ?? 1080, height: seq.height ?? 1920, accent: this.host.prefs.accent,
        outDir: joinPath(dir, "MAG Captions", `${seq.name}_${this.style}_${Date.now().toString(36)}`),
      }, (j) => { this.progress = j.progress * 0.7; this.message = j.message; this.host.rerender(); });
      this.message = t("addCaptions");
      const r = await placeStills(live.project, live.seq, res.items, `${seq.name} ${this.style}`);
      this.host.notify("ok", t("captionsPlaced", { n: r.count, track: r.track + 1 }));
      await this.host.refresh();
    });
  }

  render(): HTMLElement[] {
    const gate = this.gate();
    const g = this.guid();
    const caps = this.current();
    const hasTr = !!(g && this.translations.get(g));
    const editor = caps ? h("div", { class: "rows caps" }, caps.slice(0, 400).map((c, i) => {
      const low = (c.lowConfidence ?? []).map((k) => c.words?.[k]?.word).filter(Boolean);
      return h("div", { class: "cap-row" },
        h("div", { class: "cap-times ltr" },
          h("input", { class: "input frow-num", type: "number", step: 0.05, value: c.start.toFixed(2),
            onchange: (e: Event) => { c.start = Number((e.target as HTMLInputElement).value); } }),
          h("input", { class: "input frow-num", type: "number", step: 0.05, value: c.end.toFixed(2),
            onchange: (e: Event) => { c.end = Number((e.target as HTMLInputElement).value); } }),
          h("span", { class: `spk spk-${c.speaker ?? "x"}`, role: "button", tabindex: 0, onclick: () => {
            c.speaker = c.speaker === "host" ? "guest" : "host";
            this.host.rerender();
          } }, c.speaker === "host" ? t("camShort_host") : t("camShort_guest"))),
        h("input", { class: `input cap-text${low.length ? " warn" : ""}`, type: "text", dir: "auto", value: c.text,
          oninput: (e: Event) => { caps[i]!.text = (e.target as HTMLInputElement).value; } }),
        low.length ? h("div", { class: "tone-warn small" }, t("lowConf", { words: low.join("، ") })) : null);
    })) : null;
    const styles: { value: string; label: string }[] = [
      { value: "podcast", label: getLang() === "ar" ? "بودكاست" : "Podcast" },
      { value: "clean", label: getLang() === "ar" ? "وثائقي" : "Clean" },
      { value: "word", label: getLang() === "ar" ? "إبراز الكلمة" : "Word" },
      { value: "minimal", label: getLang() === "ar" ? "مودرن" : "Minimal" },
    ];
    return [card(t("captionsTitle"), caps ? pill(String(caps.length), "info") : null,
      h("p", { class: "muted small" }, t("captionsHelp")),
      gate,
      choice(t("model"), MODEL_OPTIONS.map((m) => ({ value: m, label: m })), this.model, (v) => { this.model = v; this.host.rerender(); }),
      choice(t("language"), (["ar", "en", "auto"] as const).map((v) => ({ value: v, label: t(`lang_${v}` as Key) })), this.language,
        (v) => { this.language = v; this.host.rerender(); }),
      numField(t("maxChars"), this.maxChars ?? this.defaultMax(), (v) => { this.maxChars = Math.round(v); }, 1, 10, 80),
      h("p", { class: "muted small" }, t("firstRunModel")),
      toggle(`${t("glossary")} · ${t("rules")} (${this.host.prefs.glossary.length} · ${this.host.prefs.rules.length})`, this.wordsOpen,
        (v) => { this.wordsOpen = v; this.host.rerender(); }),
      this.wordsOpen ? [
        h("div", { class: "field" }, h("div", { class: "field-label" }, t("glossary")),
          h("textarea", { class: "input textarea", dir: "auto", rows: 4, placeholder: t("glossaryHelp"),
            oninput: (e: Event) => { this.glossaryText = (e.target as HTMLTextAreaElement).value; } },
          this.glossaryText ?? this.host.prefs.glossary.join("\n"))),
        h("div", { class: "field" }, h("div", { class: "field-label" }, t("rules")),
          h("textarea", { class: "input textarea", dir: "auto", rows: 4, placeholder: t("rulesHelp"),
            oninput: (e: Event) => { this.rulesText = (e.target as HTMLTextAreaElement).value; } },
          this.rulesText ?? this.host.prefs.rules.map(([a, b]) => `${a} => ${b}`).join("\n"))),
        h("p", { class: "muted small" }, t("rulesHelp")),
        h("div", { class: "actions" }, button(t("saveWords"), () => this.saveWords(), { kind: "secondary" })),
      ] : null,
      g && this.host.speakers.get(g) ? h("p", { class: "muted small" }, t("speakersFromSeparation")) : null,
      ...this.status(),
      h("div", { class: "actions" },
        button(t("transcribe"), () => this.transcribe(), { kind: caps ? "secondary" : "primary", disabled: this.busy || !!gate }),
        caps ? button(t("rebuild"), () => this.rebuild(), { disabled: this.busy }) : null),
      g && this.captions.get(g) ? [
        choice(t("translateTo"), (["en", "ar"] as const).map((v) => ({ value: v, label: t(`tr_${v}` as Key) })), this.trTarget,
          (v) => { this.trTarget = v; this.host.rerender(); }),
        h("div", { class: "actions" }, button(t("translateRun"), () => this.translate(), { disabled: this.busy })),
        hasTr ? choice(t("showing"), (["orig", "tr"] as const).map((v) => ({ value: v, label: t(`show_${v}` as Key) })), this.showing,
          (v) => { this.showing = v; this.host.rerender(); }) : null,
      ] : null,
      caps ? choice(t("style"), styles, this.style, (v) => { this.style = v; this.host.rerender(); }) : null,
      caps ? h("div", { class: "actions" },
        button(t("exportSrt"), () => this.srt(), { disabled: this.busy }),
        button(t("nativeCaptions"), () => this.native(), { disabled: this.busy }),
        button(t("addCaptions"), () => this.place(), { kind: "primary", disabled: this.busy })) : null,
      editor)];
  }
}

// ---- 5. AI Viral Clip Finder ----------------------------------------------------------

export class ReelsView extends Stage {
  private count = 10;
  private range = "30-60";
  private aspect = "9:16";
  private reels = new Map<string, Reel[]>();
  private approved = new Set<number>();

  private find(): void {
    void this.run(async () => {
      const g = this.guid();
      let tr = g ? this.host.transcripts.get(g) : undefined;
      if (!tr) {
        tr = (await transcribeActive(this.host, "large-v3-turbo", "ar", (f, m) => {
          this.progress = f * 0.9; this.message = m; this.host.rerender();
        })).transcript;
      }
      const [a, b] = this.range.split("-").map(Number) as [number, number];
      const list = await this.host.client().findReels(allWords(tr), this.count, a, b);
      this.reels.set(this.guid()!, list);
      this.approved = new Set(list.map((_, i) => i).slice(0, 3));
    });
  }

  private async seek(sec: number): Promise<void> {
    const live = await liveSequence();
    if (live) await live.seq.setPlayerPosition(ppro().TickTime.createWithTicks(String(secondsToTicks(sec))));
  }

  private create(): void {
    void this.run(async () => {
      const live = await liveSequence();
      const g = this.guid();
      const list = g ? this.reels.get(g) : null;
      if (!live || !list) return;
      // Premiere invalidates sequence objects after another sequence is opened (each reel opens),
      // so the source is looked up again, by its id, for every reel.
      const sourceGuid = live.seq.guid.toString();
      let project = live.project;
      const existing = new Set((await project.getSequences()).map((s) => s.name));
      const total = this.host.snapshot()?.activeSequence?.durationSeconds ?? 0;
      const chosen = list.filter((_, i) => this.approved.has(i)).sort((x, y) => x.start - y.start);
      const [fw, fh] = ASPECTS[this.aspect] ?? [1080, 1920];
      let n = 1;
      let made = 0;
      const issues: string[] = [];
      for (const r of chosen) {
        while (existing.has(`REEL_${String(n).padStart(2, "0")}_EDIT`)) n++;
        const name = `REEL_${String(n).padStart(2, "0")}_EDIT`;
        existing.add(name);
        this.message = name;
        const remove = [{ start: 0n, end: secondsToTicks(r.start) }, { start: secondsToTicks(Math.min(r.end, total)), end: secondsToTicks(total + 1) }]
          .filter((x) => x.end > x.start);
        let report;
        let reel: Sequence | undefined;
        try {
          project = (await getActiveProject()) ?? project;
          const source = (await project.getSequences()).find((s) => s.guid.toString() === sourceGuid);
          if (!source) throw new Error("The source sequence is no longer in the project.");
          report = await buildCutSequence(project, source, { remove, newName: name,
            onProgress: (_s, f) => { this.progress = (made + f * 0.7) / chosen.length; this.host.rerender(); } });
          reel = (await project.getSequences()).find((s) => s.name === name) ?? (await project.getActiveSequence()) ?? undefined;
        } catch (e) {
          issues.push(`${name}: ${errorMessage(e)}`);
          continue;
        }
        if (!reel) continue;
        if (this.aspect !== "16:9") {
          try {
            await setFrameSize(project, reel, fw, fh);
            const res = await this.reframeReel(project, reel, report.plan.pieces.filter((p) => p.kind === "video"), fw, fh);
            if (res.failed.length) issues.push(...res.failed);
          } catch (e) {
            issues.push(errorMessage(e));
          }
        }
        made++;
      }
      this.host.notify(issues.length ? "warn" : "ok", issues.length
        ? `${t("reelsCreated", { n: made })} ${t("reframeIssue", { done: made, first: issues[0] ?? "" })}`
        : t("reelsCreated", { n: made }));
      await this.host.refresh();
    });
  }

  private async reframeReel(project: NonNullable<Awaited<ReturnType<typeof getActiveProject>>>, reel: Sequence,
                            pieces: { track: number; dest: bigint; srcIn: bigint; srcOut: bigint; media: string }[], fw: number, fh: number) {
    const live = await readLiveItems(reel);
    const videos = live.filter((l) => l.src.kind === "video");
    const paths = new Map<string, string>();
    for (const v of videos) paths.set(v.src.key, await v.clip.getMediaFilePath());
    const unique = [...new Set(paths.values())].filter(Boolean);
    const probe = await this.host.client().runJob<ProbeResult>("probe", { paths: unique });
    const dims = new Map(probe.items.filter((i) => i.ok && i.info?.video[0]).map((i) => [i.path.replace(/\\/g, "/").toLowerCase(),
      { w: i.info!.video[0]!.width ?? 1920, h: i.info!.video[0]!.height ?? 1080 }]));
    const targets: ReframeTarget[] = [];
    for (const v of videos) {
      const path = paths.get(v.src.key) ?? "";
      const d = dims.get(path.replace(/\\/g, "/").toLowerCase());
      if (!d || d.w / d.h <= fw / fh + 0.01) continue; // already fits
      const piece = pieces.find((p) => p.track === v.src.track && p.dest === v.src.start);
      let faceX: number | null = null;
      if (piece) {
        const a = Number(piece.srcIn) / 254016000000;
        const b = Number(piece.srcOut) / 254016000000;
        try {
          const f = await this.host.client().runJob<{ faces: { x: number | null }[] }>("faces", { path, ranges: [[a, Math.min(b, a + 20)]] });
          faceX = f.faces[0]?.x ?? null;
        } catch {
          faceX = null;
        }
      }
      targets.push({ item: v.ref as never, srcW: d.w, srcH: d.h, faceX });
    }
    return reframe(project, fw, fh, targets);
  }

  render(): HTMLElement[] {
    const gate = this.gate();
    const g = this.guid();
    const list = g ? this.reels.get(g) : undefined;
    const hasTranscript = !!(g && this.host.transcripts.get(g));
    const cards = list ? list.map((r, i) => h("div", { class: `reel${this.approved.has(i) ? " on" : ""}` },
      h("div", { class: "reel-h" },
        h("span", { class: `tick${this.approved.has(i) ? " on" : ""}`, role: "button", tabindex: 0, onclick: () => {
          if (this.approved.has(i)) this.approved.delete(i); else this.approved.add(i);
          this.host.rerender();
        } }, this.approved.has(i) ? "✓" : ""),
        h("span", { class: "reel-title" }, r.title),
        pill(`${r.scores.overall}`, r.scores.overall >= 60 ? "ok" : "info")),
      h("div", { class: "reel-meta ltr muted small" }, `${fmtTime(r.start)} → ${fmtTime(r.end)} · ${r.duration.toFixed(0)} s`),
      h("div", { class: "reel-hook" }, `“${r.hook}”`),
      h("div", { class: "reel-scores small" },
        h("span", null, `${t("hookScore")} ${r.scores.hook}`), h("span", null, `${t("relevanceScore")} ${r.scores.relevance}`),
        h("span", null, `${t("contextScore")} ${r.scores.context}`)),
      r.notes.length ? h("div", { class: "tone-warn small" }, r.notes.join(" · ")) : null,
      h("div", { class: "reel-text muted small" }, r.transcript.length > 220 ? `${r.transcript.slice(0, 220)}…` : r.transcript),
      h("div", { class: "actions" }, button(t("preview_"), () => void this.seek(r.start), { kind: "ghost" })))) : null;
    return [card(t("reelsTitle"), list ? pill(String(list.length), "info") : null,
      h("p", { class: "muted small" }, t("reelsHelp")),
      gate,
      hasTranscript ? null : h("p", { class: "tone-warn small" }, t("needTranscript")),
      choice(t("howMany"), [5, 10, 15, 20].map((v) => ({ value: String(v), label: String(v) })), String(this.count),
        (v) => { this.count = Number(v); this.host.rerender(); }),
      choice(t("durationRange"), ["15-30", "30-60", "60-90"].map((v) => ({ value: v, label: `${v} s` })), this.range,
        (v) => { this.range = v; this.host.rerender(); }),
      choice(t("aspect"), Object.keys(ASPECTS).map((v) => ({ value: v, label: v })), this.aspect, (v) => { this.aspect = v; this.host.rerender(); }),
      ...this.status(),
      h("div", { class: "actions" },
        button(t("findReels"), () => this.find(), { kind: list ? "secondary" : "primary", disabled: this.busy || !!gate }),
        list ? button(t("createReels"), () => this.create(), { kind: "primary", disabled: this.busy || !this.approved.size }) : null),
      cards)];
  }
}

// ---- 6. Review & Export ---------------------------------------------------------------

export class ExportView extends Stage {
  private seqs: { name: string; guid: string }[] | null = null;
  private selected = new Set<string>();
  private preset: string | null = null;
  private outDir: string | null = null;
  private mode: "queue" | "now" = "queue";

  private async load(): Promise<void> {
    const project = await getActiveProject();
    if (!project) return;
    this.seqs = (await project.getSequences()).map((s) => ({ name: s.name, guid: s.guid.toString() }));
    if (!this.selected.size) for (const s of this.seqs) if (/^REEL_|_CUT|_DIRECTOR/.test(s.name)) this.selected.add(s.guid);
    this.host.rerender();
  }

  private exportNow(): void {
    void this.run(async () => {
      if (!this.preset || !this.outDir) throw new Error(t("needPreset"));
      const project = await getActiveProject();
      if (!project) return;
      const seqs = (await project.getSequences()).filter((s) => this.selected.has(s.guid.toString()));
      const outs = await exportSequences(seqs, this.preset, this.outDir, this.mode);
      this.host.notify("ok", t("exported", { n: outs.length }));
    });
  }

  render(): HTMLElement[] {
    if (!this.seqs && !this.busy) void this.load();
    return [card(t("exportTitle"), this.selected.size ? pill(String(this.selected.size), "info") : null,
      h("p", { class: "muted small" }, t("exportHelp")),
      (this.seqs ?? []).map((s) => toggle(s.name, this.selected.has(s.guid), (on) => {
        if (on) this.selected.add(s.guid); else this.selected.delete(s.guid);
        this.host.rerender();
      })),
      h("div", { class: "frow" }, h("span", { class: "frow-k" }, t("preset_file")),
        h("span", { class: "path ltr" }, this.preset ?? "—"),
        button(t("choose"), () => void pickFile(["epr"]).then((p) => { if (p) this.preset = p; this.host.rerender(); }), { kind: "ghost" })),
      h("div", { class: "frow" }, h("span", { class: "frow-k" }, t("outFolder")),
        h("span", { class: "path ltr" }, this.outDir ?? "—"),
        button(t("choose"), () => void pickFolder().then((p) => { if (p) this.outDir = p; this.host.rerender(); }), { kind: "ghost" })),
      choice(t("mode"), (["queue", "now"] as const).map((v) => ({ value: v, label: t(`mode_${v}` as Key) })), this.mode,
        (v) => { this.mode = v; this.host.rerender(); }),
      ...this.status(),
      h("div", { class: "actions" },
        button(t("refresh"), () => { this.seqs = null; this.host.rerender(); }, { kind: "ghost" }),
        button(t("exportApproved"), () => this.exportNow(), { kind: "primary", disabled: this.busy || !this.selected.size })))];
  }
}
