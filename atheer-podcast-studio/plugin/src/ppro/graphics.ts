/**
 * Put a rendered graphic (transparent ProRes 4444 .mov) on the timeline at the
 * playhead, on top of everything there, without overwriting any clip.
 *
 * Track rule: video tracks composite bottom (V1) to top. The graphic goes on
 * the first track ABOVE every track that has a clip in [playhead, playhead +
 * duration). That track is empty in the range by definition, so nothing is
 * replaced. When it does not exist yet, an insert at index = track count makes
 * Premiere create it (documented behaviour of createInsertProjectItemAction).
 */
import type { ClipProjectItem, FolderItem, Project, ProjectItem, Sequence, VideoClipTrackItem } from "@adobe/premierepro";
import { logger } from "../core/log.ts";
import { parseTicks } from "../core/time.ts";
import { ppro } from "./api.ts";
import { ROOT_BIN, ensureProjectBins, findChildBin } from "./edits.ts";
import { importAndFind } from "./importing.ts";
import { finishTransaction } from "./transaction.ts";

const log = logger("graphics");
export const GRAPHICS_BIN = "06 Graphics";

export interface Interval {
  start: bigint;
  end: bigint;
}

/** Pure rule, unit-tested: index of the track to use for [start, end). */
export function chooseTrack(trackClips: Interval[][], range: Interval): { index: number; isNew: boolean } {
  let highestBusy = -1;
  trackClips.forEach((clips, i) => {
    if (clips.some((c) => c.start < range.end && c.end > range.start)) highestBusy = i;
  });
  const index = highestBusy + 1;
  return { index, isNew: index >= trackClips.length };
}

const samePath = (a: string, b: string) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();

async function findClipByPath(bin: FolderItem, path: string): Promise<ClipProjectItem | null> {
  const P = ppro();
  for (const item of await bin.getItems()) {
    try {
      const clip = P.ClipProjectItem.cast(item);
      if (clip && samePath(await clip.getMediaFilePath(), path)) return clip;
    } catch {
      /* bins and other items */
    }
  }
  return null;
}

export async function graphicsBin(project: Project): Promise<FolderItem> {
  await ensureProjectBins(project);
  const root = await project.getRootItem();
  const app = await findChildBin(root, ROOT_BIN);
  const bin = app ? await findChildBin(app, GRAPHICS_BIN) : null;
  if (!bin) throw new Error("The Graphics bin is missing.");
  return bin;
}

/** Import (once) and return the project item for a rendered file. */
export async function importGraphic(project: Project, path: string): Promise<ClipProjectItem> {
  const bin = await graphicsBin(project);
  const existing = await findClipByPath(bin, path);
  if (existing) return existing;
  const found = await importAndFind(project, [path], bin);
  return found.get(path)!;
}

export interface Placement {
  trackIndex: number;
  newTrack: boolean;
  start: bigint;
}

export async function insertGraphicAtPlayhead(project: Project, sequence: Sequence, path: string,
                                              durationSeconds: number): Promise<Placement> {
  const P = ppro();
  const clip = await importGraphic(project, path);
  const start = parseTicks((await sequence.getPlayerPosition()).ticks);
  const end = start + BigInt(Math.round(durationSeconds * 254016000000));

  const CLIP = P.Constants.TrackItemType.CLIP;
  const tracks: Interval[][] = [];
  const count = await sequence.getVideoTrackCount();
  for (let i = 0; i < count; i++) {
    const items = (await sequence.getVideoTrack(i)).getTrackItems(CLIP, false) as VideoClipTrackItem[];
    const spans: Interval[] = [];
    for (const it of items) {
      spans.push({ start: parseTicks((await it.getStartTime()).ticks), end: parseTicks((await it.getEndTime()).ticks) });
    }
    tracks.push(spans);
  }
  const { index, isNew } = chooseTrack(tracks, { start, end });
  const editor = P.SequenceEditor.getEditor(sequence);
  const item = clip as unknown as ProjectItem;
  const undo = "MAG: Insert graphic";
  let committed = false;
  project.lockedAccess(() => {
    const time = P.TickTime.createWithTicks(String(start));
    const action = isNew
      ? editor.createInsertProjectItemAction(item, time, index, 0, true)
      : editor.createOverwriteItemAction(item, time, index, 0);
    committed = project.executeTransaction((compound) => {
      compound.addAction(action);
    }, undo);
  });
  finishTransaction(committed, undo, 1);
  log.info(`Graphic placed on V${index + 1}${isNew ? " (new track)" : ""}`);
  return { trackIndex: index, newTrack: isNew, start };
}

/**
 * Text edits: the graphic is re-rendered to a new file and the project item is
 * relinked to it, so every placed copy updates and keeps its position/effects.
 */
export async function relinkGraphic(project: Project, oldPath: string, newPath: string): Promise<void> {
  const bin = await graphicsBin(project);
  const clip = await findClipByPath(bin, oldPath);
  if (!clip) throw new Error("The graphic is no longer in the Graphics bin.");
  if (!(await clip.canChangeMediaPath())) throw new Error("Premiere does not allow relinking this item.");
  const ok = await clip.changeMediaFilePath(newPath, true);
  if (!ok) throw new Error("Premiere refused to relink the graphic.");
  await clip.refreshMedia();
}
