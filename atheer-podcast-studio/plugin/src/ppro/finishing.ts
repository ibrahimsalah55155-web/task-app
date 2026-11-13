/**
 * Premiere side of the finishing tools:
 *   - swap microphone media for cleaned files (and back), sample-aligned, nothing moves;
 *   - Lumetri on a camera's master clip (applies to every use of that camera) + frame export;
 *   - multicam: nest the synced sequence so Premiere's Multi-Camera mode can be switched on;
 *   - SRT onto a real Premiere caption track (verified), with a safe fallback;
 *   - MOGRT templates: insert at the playhead and edit their text fields.
 *
 * All edits follow lockedAccess + executeTransaction; every change is undoable.
 */
import type {
  ClipProjectItem, Component, ComponentParam, FolderItem, Project, ProjectItem, Sequence, VideoClipTrackItem, VideoComponentChain,
} from "@adobe/premierepro";
import type { LumetriKey, LumetriValues } from "../core/colorsolve.ts";
import { errorMessage, logger } from "../core/log.ts";
import { ppro } from "./api.ts";
import { parseTicks } from "../core/time.ts";
import { CHILD_BINS, ROOT_BIN, ensureProjectBins, findChildBin } from "./edits.ts";
import { type Interval, chooseTrack } from "./graphics.ts";
import { secondsToTicks } from "./timeline.ts";
import { finishTransaction } from "./transaction.ts";

const log = logger("finishing");
const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();

async function walk(folder: FolderItem, visit: (item: ProjectItem) => Promise<void>, depth = 0): Promise<void> {
  const P = ppro();
  for (const item of await folder.getItems()) {
    await visit(item);
    if (depth > 12) continue;
    try {
      const sub = P.FolderItem.cast(item);
      if (sub && item.name) await walk(sub, visit, depth + 1);
    } catch {
      /* not a bin */
    }
  }
}

/** Every clip in the project whose media file is `path` (subclips included). */
export async function clipsUsingFile(project: Project, path: string): Promise<ClipProjectItem[]> {
  const P = ppro();
  const want = norm(path);
  const out: ClipProjectItem[] = [];
  await walk(await project.getRootItem(), async (item) => {
    try {
      const clip = P.ClipProjectItem.cast(item);
      if (!clip || (await clip.isSequence())) return;
      if (norm(await clip.getMediaFilePath()) === want) out.push(clip);
    } catch {
      /* bins, sequences */
    }
  });
  return out;
}

// ---- voice clean-up: media swap ------------------------------------------------------

export const AUDIO_EXT = ["wav", "bwf", "aif", "aiff", "mp3", "m4a", "aac", "flac"];
export const isAudioFile = (p: string) => AUDIO_EXT.includes((p.split(".").pop() ?? "").toLowerCase());

export interface SwapReport { file: string; to: string; clips: number; failed: string[] }

/**
 * Point every project clip that uses `from` at `to`. The files have the same length and timing
 * (the engine checks this), so nothing moves on any timeline. Audio-only files only: a video file's
 * clip would lose its picture.
 */
export async function swapMedia(project: Project, pairs: { from: string; to: string }[]): Promise<SwapReport[]> {
  const out: SwapReport[] = [];
  for (const { from, to } of pairs) {
    if (!isAudioFile(from)) {
      out.push({ file: from, to, clips: 0, failed: ["not an audio-only file"] });
      continue;
    }
    const clips = await clipsUsingFile(project, from);
    const failed: string[] = [];
    let n = 0;
    for (const c of clips) {
      try {
        if (!(await c.canChangeMediaPath())) throw new Error("locked");
        if (!(await c.changeMediaFilePath(to, false))) throw new Error("refused");
        await c.refreshMedia();
        n++;
      } catch (e) {
        failed.push(`${(c as unknown as ProjectItem).name}: ${errorMessage(e)}`);
      }
    }
    out.push({ file: from, to, clips: n, failed });
  }
  return out;
}

// ---- Lumetri ---------------------------------------------------------------------------

/** Lumetri slider display names in Premiere's English UI (the parameter list is the same in every language). */
export const LUMETRI_NAMES: Record<LumetriKey, string[]> = {
  exposure: ["Exposure"],
  temperature: ["Temperature", "Temp"],
  tint: ["Tint"],
  contrast: ["Contrast"],
  saturation: ["Saturation"],
};

async function lumetriMatchName(): Promise<string> {
  const names = await ppro().VideoFilterFactory.getMatchNames();
  const m = names.find((n) => n === "AE.ADBE Lumetri") ?? names.find((n) => /lumetri/i.test(n));
  if (!m) throw new Error("Lumetri Color is not available in this Premiere.");
  return m;
}

async function findLumetri(clip: ClipProjectItem): Promise<{ chain: VideoComponentChain; comp: Component | null }> {
  const chain = (await clip.getComponentChain(ppro().Constants.MediaType.VIDEO)) as VideoComponentChain | null;
  if (!chain) throw new Error("This clip has no video effects chain.");
  for (let i = 0; i < chain.getComponentCount(); i++) {
    const comp = chain.getComponentAtIndex(i);
    if (/lumetri/i.test(await comp.getMatchName())) return { chain, comp };
  }
  return { chain, comp: null };
}

/** The camera's master clip gets one Lumetri (added if missing). Every use of the camera shows it. */
export async function ensureLumetri(project: Project, clip: ClipProjectItem): Promise<Component> {
  const found = await findLumetri(clip);
  if (found.comp) return found.comp;
  const comp = await ppro().VideoFilterFactory.createComponent(await lumetriMatchName());
  const undo = "MAG: Colour match (Lumetri)";
  let committed = false;
  project.lockedAccess(() => {
    const action = found.chain.createAppendComponentAction(comp);
    committed = project.executeTransaction((compound) => {
      compound.addAction(action);
    }, undo);
  });
  finishTransaction(committed, undo, 1);
  const again = await findLumetri(clip);
  if (!again.comp) throw new Error("Lumetri was added but cannot be found on the clip.");
  return again.comp;
}

export function lumetriParams(comp: Component): Partial<Record<LumetriKey, ComponentParam>> {
  const out: Partial<Record<LumetriKey, ComponentParam>> = {};
  for (let i = 0; i < comp.getParamCount(); i++) {
    const p = comp.getParam(i);
    const name = (p.displayName ?? "").trim();
    for (const [k, names] of Object.entries(LUMETRI_NAMES) as [LumetriKey, string[]][]) {
      // First match wins: Basic Correction comes before Creative/Curves in Lumetri's list.
      if (!out[k] && names.some((n) => n.toLowerCase() === name.toLowerCase())) out[k] = p;
    }
  }
  return out;
}

export async function setLumetri(project: Project, comp: Component, values: Partial<LumetriValues>): Promise<string[]> {
  const params = lumetriParams(comp);
  const missing = (Object.keys(values) as LumetriKey[]).filter((k) => !params[k]);
  const undo = "MAG: Colour match (Lumetri)";
  let committed = false;
  project.lockedAccess(() => {
    const actions = (Object.entries(values) as [LumetriKey, number][])
      .filter(([k]) => params[k])
      .map(([k, v]) => params[k]!.createSetValueAction(params[k]!.createKeyframe(Number(v.toFixed(3))), true));
    committed = project.executeTransaction((compound) => {
      for (const a of actions) compound.addAction(a);
    }, undo);
  });
  finishTransaction(committed, undo, Object.keys(values).length - missing.length);
  return missing;
}

/** A sequence holding just this camera, for rendering test frames (deleted afterwards by the caller). */
export async function probeSequence(project: Project, clip: ClipProjectItem, name: string): Promise<Sequence> {
  return await project.createSequenceFromMedia(name, [clip]);
}

export async function exportFrame(seq: Sequence, sec: number, dir: string, file: string, width: number, height: number): Promise<string> {
  const P = ppro();
  const ok = await P.Exporter.exportSequenceFrame(seq, P.TickTime.createWithTicks(String(secondsToTicks(sec))), file, dir, width, height);
  if (!ok) throw new Error("Premiere could not export a test frame.");
  const sep = dir.includes("\\") ? "\\" : "/";
  return `${dir}${dir.endsWith(sep) ? "" : sep}${file}`;
}

// ---- multicam -------------------------------------------------------------------------

/**
 * Puts the synced (stacked) sequence inside a new sequence as one nested clip. Premiere can switch
 * any nested multi-track sequence to Multi-Camera (right-click the clip > Multi-Camera > Enable),
 * after which the Multi-Camera monitor cuts between the camera tracks live.
 */
export async function nestForMulticam(project: Project, seq: Sequence): Promise<{ sequence: Sequence; name: string }> {
  const P = ppro();
  const item = await seq.getProjectItem();
  const clip = P.ClipProjectItem.cast(item);
  if (!clip) throw new Error("The sequence cannot be nested.");
  await ensureProjectBins(project);
  const app = await findChildBin(await project.getRootItem(), ROOT_BIN);
  const bin = app ? await findChildBin(app, CHILD_BINS[2]!) : null;
  const name = `${item.name}_MULTICAM`;
  const out = await project.createSequenceFromMedia(name, [clip], (bin ?? undefined) as never);
  // Verify: one nested sequence clip on V1.
  const v1 = await out.getVideoTrack(0);
  const items = v1.getTrackItems(P.Constants.TrackItemType.CLIP, false) as VideoClipTrackItem[];
  const nested = items.length ? P.ClipProjectItem.cast(await items[0]!.getProjectItem()) : null;
  if (!nested || !(await nested.isSequence())) throw new Error("Premiere did not nest the sequence as expected.");
  await project.openSequence(out);
  return { sequence: out, name };
}

// ---- captions ---------------------------------------------------------------------------

/**
 * Imports an .srt (Premiere turns it into a captions item) and tries to put it on a caption track.
 * The insert goes on a NEW video-track index, so if Premiere does not treat it as captions nothing
 * existing is touched; that stray item is then removed again and the caller falls back.
 */
export async function srtToCaptionTrack(project: Project, seq: Sequence, srtPath: string): Promise<{ onTimeline: boolean; inBin: boolean }> {
  const P = ppro();
  await ensureProjectBins(project);
  const app = await findChildBin(await project.getRootItem(), ROOT_BIN);
  const bin = app ? await findChildBin(app, CHILD_BINS[4]!) : null;
  const ok = await project.importFiles([srtPath], true, (bin ?? undefined) as never, false);
  if (!ok) return { onTimeline: false, inBin: false };
  const fileName = srtPath.split(/[\\/]/).pop()!;
  let item: ProjectItem | null = null;
  await walk(await project.getRootItem(), async (it) => {
    if (!item && it.name === fileName) item = it;
  });
  if (!item) return { onTimeline: false, inBin: false };
  const capsBefore = await seq.getCaptionTrackCount();
  const vBefore = await seq.getVideoTrackCount();
  const editor = P.SequenceEditor.getEditor(seq);
  const undo = "MAG: Captions (SRT)";
  let committed = false;
  try {
    project.lockedAccess(() => {
      const action = editor.createInsertProjectItemAction(item!, P.TickTime.createWithTicks("0"), vBefore, 0, true);
      committed = project.executeTransaction((compound) => {
        compound.addAction(action);
      }, undo);
    });
  } catch (e) {
    log.info(`SRT insert refused: ${errorMessage(e)}`);
    return { onTimeline: false, inBin: true };
  }
  if (!committed) return { onTimeline: false, inBin: true };
  if ((await seq.getCaptionTrackCount()) > capsBefore) return { onTimeline: true, inBin: true };
  // Landed on a video track instead: take it off again.
  if ((await seq.getVideoTrackCount()) > vBefore) {
    const track = await seq.getVideoTrack(vBefore);
    const stray = track.getTrackItems(P.Constants.TrackItemType.CLIP, false) as VideoClipTrackItem[];
    if (stray.length) {
      let removed = false;
      project.lockedAccess(() => {
        P.TrackItemSelection.createEmptySelection((sel) => {
          for (const s of stray) sel.addItem(s, true);
          const action = editor.createRemoveItemsAction(sel, false, P.Constants.MediaType.ANY, false);
          removed = project.executeTransaction((compound) => {
            compound.addAction(action);
          }, undo);
        });
      });
      finishTransaction(removed, undo, stray.length);
    }
  }
  return { onTimeline: false, inBin: true };
}

// ---- MOGRT ---------------------------------------------------------------------------------

/** Lowest video track that is free from `startSec` for `durSec` (a new track index if none is). */
export async function freeVideoTrack(seq: Sequence, startSec: number, durSec: number): Promise<number> {
  const P = ppro();
  const start = secondsToTicks(startSec);
  const end = start + secondsToTicks(durSec);
  const tracks: Interval[][] = [];
  for (let i = 0; i < (await seq.getVideoTrackCount()); i++) {
    const items = (await seq.getVideoTrack(i)).getTrackItems(P.Constants.TrackItemType.CLIP, false) as VideoClipTrackItem[];
    const spans: Interval[] = [];
    for (const it of items) spans.push({ start: parseTicks((await it.getStartTime()).ticks), end: parseTicks((await it.getEndTime()).ticks) });
    tracks.push(spans);
  }
  return chooseTrack(tracks, { start, end }).index;
}

export interface MogrtField { index: number; param: ComponentParam; name: string; text: string; raw: string; json: boolean }

/** Insert a .mogrt at the playhead on the first video track that is free there (new track if none). */
export async function insertMogrt(project: Project, seq: Sequence, path: string, atSec: number, freeTrack: number): Promise<VideoClipTrackItem | null> {
  const P = ppro();
  const editor = P.SequenceEditor.getEditor(seq);
  const at = P.TickTime.createWithTicks(String(secondsToTicks(atSec)));
  let items: unknown[] = [];
  // insertMogrtFromPath edits immediately (it is not an Action). Adobe does not document whether it
  // needs the project lock, so try without it and fall back to calling it inside lockedAccess.
  try {
    items = editor.insertMogrtFromPath(path, at, freeTrack, 0);
  } catch (first) {
    log.info(`insertMogrtFromPath without lock failed (${errorMessage(first)}); retrying inside lockedAccess`);
    project.lockedAccess(() => {
      items = editor.insertMogrtFromPath(path, at, freeTrack, 0);
    });
  }
  const v = (items as VideoClipTrackItem[]).find((x) => typeof (x as { getComponentChain?: unknown }).getComponentChain === "function");
  return v ?? null;
}

/** Text fields of an inserted template: every string parameter (Premiere stores some as JSON with textEditValue). */
export async function mogrtFields(item: VideoClipTrackItem): Promise<MogrtField[]> {
  const chain = await item.getComponentChain();
  const out: MogrtField[] = [];
  for (let c = 0; c < chain.getComponentCount(); c++) {
    const comp = chain.getComponentAtIndex(c);
    for (let i = 0; i < comp.getParamCount(); i++) {
      const param = comp.getParam(i);
      let raw: unknown;
      try {
        raw = (await param.getStartValue()).value.value;
      } catch {
        continue;
      }
      if (typeof raw !== "string") continue;
      let text = raw;
      let json = false;
      try {
        const j = JSON.parse(raw) as { textEditValue?: string };
        if (j && typeof j.textEditValue === "string") {
          text = j.textEditValue;
          json = true;
        }
      } catch {
        /* plain string */
      }
      out.push({ index: out.length, param, name: param.displayName || `Text ${out.length + 1}`, text, raw, json });
    }
  }
  return out;
}

export async function setMogrtText(project: Project, field: MogrtField, text: string): Promise<boolean> {
  let value = text;
  if (field.json) {
    const j = JSON.parse(field.raw) as Record<string, unknown>;
    j.textEditValue = text;
    value = JSON.stringify(j);
  }
  const undo = "MAG: Template text";
  let committed = false;
  project.lockedAccess(() => {
    const action = field.param.createSetValueAction(field.param.createKeyframe(value), true);
    committed = project.executeTransaction((compound) => {
      compound.addAction(action);
    }, undo);
  });
  finishTransaction(committed, undo, 1);
  // Read back.
  const now = (await field.param.getStartValue()).value.value;
  const got = typeof now === "string" && field.json ? (JSON.parse(now) as { textEditValue?: string }).textEditValue : now;
  return got === text;
}

// ---- voice clean-up for sound recorded inside video files ------------------------------

export const CLEAN_TRACK_SUFFIX = " · MAG clean";

/**
 * Sound that lives inside camera files cannot be swapped (the picture would go). Instead the
 * cleaned audio is laid on a new audio track under each original one, piece for piece at the
 * same frames (subclips of the cleaned WAV with the clip's own in point), and the original
 * track is muted. Undo: removeCleanTracks().
 */
export async function placeCleanAudio(project: Project, seq: Sequence, cleanBySource: Map<string, string>,
                                      bin: FolderItem): Promise<{ tracks: number; pieces: number; muted: number[] }> {
  const P = ppro();
  const { readLiveItems } = await import("./cutengine.ts");
  const { importAndFind, walk } = await import("./importing.ts");
  const live = (await readLiveItems(seq)).filter((l) => l.src.kind === "audio");
  const pieces: { l: (typeof live)[number]; clean: string; media: string }[] = [];
  for (const l of live) {
    const media = norm(await l.clip.getMediaFilePath());
    const clean = [...cleanBySource].find(([src]) => norm(src) === media)?.[1];
    if (clean && l.src.speed === 1) pieces.push({ l, clean, media });
  }
  if (!pieces.length) return { tracks: 0, pieces: 0, muted: [] };
  const imported = await importAndFind(project, [...new Set(pieces.map((p) => p.clean))], bin);

  // subclips: exact media range of every piece
  const run = Math.random().toString(36).slice(2, 7).toUpperCase();
  const undo = "MAG: Clean audio";
  let committed = false;
  project.lockedAccess(() => {
    const actions = pieces.map((p, i) => imported.get(p.clean)!.clip.createSubClipAction(
      `${p.clean.split(/[\\/]/).pop()} [${run}-${i}]`,
      P.TickTime.createWithTicks(String(p.l.src.inPoint)),
      P.TickTime.createWithTicks(String(p.l.src.inPoint + (p.l.src.end - p.l.src.start))),
      true, { takeVideo: false, takeAudio: true }));
    committed = project.executeTransaction((compound) => {
      for (const a of actions) compound.addAction(a);
    }, undo);
  });
  finishTransaction(committed, undo, pieces.length);
  const subs = new Map<number, ProjectItem>();
  const tag = new RegExp(`\\[${run}-(\\d+)\\]$`);
  const deadline = Date.now() + 10000;
  while (subs.size < pieces.length && Date.now() < deadline) {
    await walk(await project.getRootItem(), async (item) => {
      const m = tag.exec(item.name);
      if (m) subs.set(Number(m[1]), item);
    });
    if (subs.size < pieces.length) await new Promise((r) => setTimeout(r, 300));
  }
  if (subs.size < pieces.length) throw new Error(`Premiere made ${subs.size} of ${pieces.length} clean-audio pieces.`);

  // one new track per original audio track, then mute the original
  const editor = P.SequenceEditor.getEditor(seq);
  const byTrack = new Map<number, number[]>();
  pieces.forEach((p, i) => byTrack.set(p.l.src.track, [...(byTrack.get(p.l.src.track) ?? []), i]));
  const muted: number[] = [];
  for (const [track, idxs] of byTrack) {
    const target = await seq.getAudioTrackCount();
    const [first, ...rest] = idxs;
    const at = (i: number) => P.TickTime.createWithTicks(String(pieces[i]!.l.src.start));
    committed = false;
    project.lockedAccess(() => {
      const action = editor.createInsertProjectItemAction(subs.get(first!)!, at(first!), 0, target, true);
      committed = project.executeTransaction((compound) => {
        compound.addAction(action);
      }, undo);
    });
    finishTransaction(committed, undo, 1);
    if (rest.length) {
      committed = false;
      project.lockedAccess(() => {
        const actions = rest.map((i) => editor.createOverwriteItemAction(subs.get(i)!, at(i), 0, target));
        committed = project.executeTransaction((compound) => {
          for (const a of actions) compound.addAction(a);
        }, undo);
      });
      finishTransaction(committed, undo, rest.length);
    }
    const orig = await seq.getAudioTrack(track);
    const added = await seq.getAudioTrack(target);
    try {
      let named = false;
      const origName = (orig as unknown as { name?: string }).name ?? `A${track + 1}`;
      project.lockedAccess(() => {
        const action = (added as unknown as { createSetNameAction(s: string): import("@adobe/premierepro").Action })
          .createSetNameAction(`${origName}${CLEAN_TRACK_SUFFIX}`);
        named = project.executeTransaction((compound) => {
          compound.addAction(action);
        }, undo);
      });
      finishTransaction(named, undo, 1);
    } catch (e) {
      log.debug(`clean track not renamed: ${errorMessage(e)}`);
    }
    await orig.setMute(true);
    muted.push(track);
  }
  return { tracks: byTrack.size, pieces: pieces.length, muted };
}

/** Remove the clean-audio tracks' clips and unmute the given original tracks. */
export async function removeCleanAudio(project: Project, seq: Sequence, unmute: number[]): Promise<number> {
  const P = ppro();
  const victims: unknown[] = [];
  for (let i = 0; i < (await seq.getAudioTrackCount()); i++) {
    const tr = await seq.getAudioTrack(i);
    const name = (tr as unknown as { name?: string }).name ?? "";
    if (name.endsWith(CLEAN_TRACK_SUFFIX)) victims.push(...tr.getTrackItems(P.Constants.TrackItemType.CLIP, false));
  }
  if (victims.length) {
    const editor = P.SequenceEditor.getEditor(seq);
    const undo = "MAG: Original audio";
    let committed = false;
    project.lockedAccess(() => {
      P.TrackItemSelection.createEmptySelection((sel) => {
        for (const v of victims) sel.addItem(v as never, true);
        const action = editor.createRemoveItemsAction(sel, false, P.Constants.MediaType.ANY, false);
        committed = project.executeTransaction((compound) => {
          compound.addAction(action);
        }, undo);
      });
    });
    finishTransaction(committed, undo, victims.length);
  }
  for (const i of unmute) {
    try {
      await (await seq.getAudioTrack(i)).setMute(false);
    } catch {
      /* track gone */
    }
  }
  return victims.length;
}
