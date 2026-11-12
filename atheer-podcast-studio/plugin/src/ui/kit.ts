/** Shared pieces for the stage views: host interface, form controls, file pickers, transcription. */
import type { Sequence } from "@adobe/premierepro";
import type { CompanionClient, Transcript } from "../companion/client.ts";
import type { Prefs } from "../core/prefs.ts";
import { getActiveProject, type ProjectSnapshot } from "../ppro/project.ts";
import { guessRoles, readTimeline, type TimelineSpec } from "../ppro/timeline.ts";
import { h, type Tone } from "./dom.ts";

declare const require: (id: string) => unknown;

export interface PhaseHost {
  client(): CompanionClient;
  engineReady(): boolean;
  snapshot(): ProjectSnapshot | null;
  rerender(): void;
  notify(tone: Tone, text: string): void;
  refresh(): Promise<void>;
  transcripts: Map<string, Transcript>;
  prefs: Prefs;
}

export async function liveSequence(): Promise<{ project: NonNullable<Awaited<ReturnType<typeof getActiveProject>>>; seq: Sequence } | null> {
  const project = await getActiveProject();
  const seq = project ? await project.getActiveSequence() : null;
  return project && seq ? { project, seq } : null;
}

export function projectDir(snap: ProjectSnapshot | null): string | null {
  const p = snap?.path;
  if (!p) return null;
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : null;
}

export function joinPath(dir: string, ...parts: string[]): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return [dir, ...parts].join(sep);
}

export function fmtTime(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  const h0 = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  const ss = r.toFixed(1).padStart(4, "0");
  return h0 ? `${h0}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ---- form controls (UXP-safe: no native checkboxes, plain inputs) --------------

export function numField(label: string, value: number, onChange: (v: number) => void, step = 0.05, min = 0, max = 10000): HTMLElement {
  return h("div", { class: "frow" }, h("span", { class: "frow-k" }, label),
    h("input", { class: "input frow-num ltr", type: "number", step, min, max, value: String(value),
      onchange: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value);
        if (Number.isFinite(v)) onChange(v);
      } }));
}

export function choice<T extends string>(label: string, options: { value: T; label: string }[], value: T, onChange: (v: T) => void): HTMLElement {
  return h("div", { class: "frow" }, h("span", { class: "frow-k" }, label),
    h("div", { class: "seg" }, options.map((o) => h("div", {
      class: `seg-item${o.value === value ? " is-active" : ""}`, role: "button", tabindex: 0, onclick: () => onChange(o.value),
    }, o.label))));
}

export function trackSelect(label: string, tracks: { index: number; label: string; name: string }[], value: number | null,
                            onChange: (v: number | null) => void): HTMLElement {
  return h("div", { class: "frow" }, h("span", { class: "frow-k" }, label),
    h("select", { class: "select", onchange: (e: Event) => {
      const v = (e.target as HTMLSelectElement).value;
      onChange(v === "" ? null : Number(v));
    } },
    h("option", { value: "", selected: value == null }, "—"),
    tracks.map((t) => h("option", { value: String(t.index), selected: t.index === value }, `${t.label} ${t.name}`))));
}

export function toggle(label: string, on: boolean, onChange: (v: boolean) => void): HTMLElement {
  return h("div", { class: "frow toggle", role: "button", tabindex: 0, onclick: () => onChange(!on) },
    h("span", { class: `tick${on ? " on" : ""}` }, on ? "✓" : ""), h("span", { class: "frow-k wide" }, label));
}

// ---- files ---------------------------------------------------------------------------

interface Entry { nativePath: string; isFolder?: boolean }
interface Lfs {
  getFileForOpening(o: unknown): Promise<Entry | Entry[] | null>;
  getFolder(o?: unknown): Promise<Entry | null>;
}

function lfs(): Lfs {
  return (require("uxp") as { storage: { localFileSystem: Lfs } }).storage.localFileSystem;
}

export async function pickFiles(types: string[]): Promise<string[]> {
  const r = await lfs().getFileForOpening({ allowMultiple: true, types });
  if (!r) return [];
  return (Array.isArray(r) ? r : [r]).map((e) => e.nativePath);
}

export async function pickFile(types: string[]): Promise<string | null> {
  const r = await lfs().getFileForOpening({ allowMultiple: false, types });
  const e = Array.isArray(r) ? r[0] : r;
  return e?.nativePath ?? null;
}

export async function pickFolder(): Promise<string | null> {
  return (await lfs().getFolder())?.nativePath ?? null;
}

export const MEDIA_TYPES = ["mov", "mp4", "mxf", "m4v", "avi", "mts", "m2ts", "braw", "wav", "mp3", "m4a", "aac", "aif", "aiff", "bwf", "flac"];

// ---- transcription shared by Captions and Reels -----------------------------------

export async function transcribeActive(host: PhaseHost, model: string, language: string | null,
                                       onProgress: (f: number, msg: string | null) => void): Promise<{ guid: string; transcript: Transcript; tl: TimelineSpec }> {
  const live = await liveSequence();
  if (!live) throw new Error("no sequence");
  const tl = await readTimeline(live.seq);
  const roles = guessRoles(tl);
  const mics = tl.audio.filter((t) => t.pieces.length);
  const pick = [roles.guestMic, roles.hostMic].filter((x): x is number => x != null);
  const chosen = (pick.length ? tl.audio.filter((t) => pick.includes(t.index)) : mics).map((t) => ({
    name: t.name, role: t.index === roles.guestMic ? "guest" : t.index === roles.hostMic ? "host" : "other", pieces: t.pieces,
  }));
  if (!chosen.length) throw new Error("The sequence has no audio.");
  const transcript = await host.client().runJob<Transcript>("transcribe",
    { tracks: chosen, duration: tl.duration, model, language }, (j) => onProgress(j.progress, j.message));
  const guid = live.seq.guid.toString();
  host.transcripts.set(guid, transcript);
  return { guid, transcript, tl };
}

export const allWords = (t: Transcript) => t.segments.flatMap((s) => s.words);
