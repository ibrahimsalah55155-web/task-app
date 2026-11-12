/**
 * Captions (and any timed stills) on the timeline: import transparent PNGs,
 * put them on one free track above everything, each at its exact start, then
 * trim/extend each to its exact end (stills can be any length).
 */
import type { ClipProjectItem, FolderItem, Project, ProjectItem, Sequence, VideoClipTrackItem } from "@adobe/premierepro";
import { logger } from "../core/log.ts";
import { parseTicks } from "../core/time.ts";
import { ppro } from "./api.ts";
import { CHILD_BINS, ROOT_BIN, ensureProjectBins, findChildBin } from "./edits.ts";
import { chooseTrack, type Interval } from "./graphics.ts";
import { secondsToTicks } from "./timeline.ts";
import { finishTransaction } from "./transaction.ts";

const log = logger("stills");

export interface TimedStill {
  path: string;
  start: number;
  end: number;
}

const samePath = (a: string, b: string) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();

async function subBin(project: Project, parentName: string, name: string): Promise<FolderItem> {
  await ensureProjectBins(project);
  const root = await project.getRootItem();
  const app = await findChildBin(root, ROOT_BIN);
  const parent = app ? await findChildBin(app, parentName) : null;
  if (!parent) throw new Error("Project bins are missing.");
  let bin = await findChildBin(parent, name);
  if (!bin) {
    const undo = "MAG: Create bin";
    let committed = false;
    project.lockedAccess(() => {
      const action = parent.createBinAction(name, false);
      committed = project.executeTransaction((compound) => {
        compound.addAction(action);
      }, undo);
    });
    finishTransaction(committed, undo, 1);
    bin = await findChildBin(parent, name);
  }
  if (!bin) throw new Error(`Bin ${name} not found`);
  return bin;
}

export async function placeStills(project: Project, seq: Sequence, stills: TimedStill[], binName: string): Promise<{ track: number; count: number }> {
  const P = ppro();
  if (!stills.length) throw new Error("Nothing to place.");
  const bin = await subBin(project, CHILD_BINS[4], binName);
  const ok = await project.importFiles(stills.map((s) => s.path), true, bin as unknown as ProjectItem, false);
  if (!ok) throw new Error("Premiere could not import the caption images.");
  const clips = new Map<string, ClipProjectItem>();
  for (const item of await bin.getItems()) {
    try {
      const c = P.ClipProjectItem.cast(item);
      const p = c ? await c.getMediaFilePath() : "";
      const s = stills.find((x) => samePath(x.path, p));
      if (c && s) clips.set(s.path, c);
    } catch {
      /* not a clip */
    }
  }
  const missing = stills.filter((s) => !clips.has(s.path));
  if (missing.length) throw new Error(`${missing.length} caption image(s) were not imported.`);

  const sorted = [...stills].sort((a, b) => a.start - b.start);
  const range = { start: secondsToTicks(sorted[0]!.start), end: secondsToTicks(Math.max(...sorted.map((s) => s.end))) };
  const CLIP = P.Constants.TrackItemType.CLIP;
  const busy: Interval[][] = [];
  for (let i = 0; i < (await seq.getVideoTrackCount()); i++) {
    const its = (await seq.getVideoTrack(i)).getTrackItems(CLIP, false) as VideoClipTrackItem[];
    const spans: Interval[] = [];
    for (const it of its) spans.push({ start: parseTicks((await it.getStartTime()).ticks), end: parseTicks((await it.getEndTime()).ticks) });
    busy.push(spans);
  }
  const { index, isNew } = chooseTrack(busy, range);
  const editor = P.SequenceEditor.getEditor(seq);
  const undo = "MAG: Add captions";
  const at = (s: TimedStill) => P.TickTime.createWithTicks(String(secondsToTicks(s.start)));
  const item = (s: TimedStill) => clips.get(s.path)! as unknown as ProjectItem;

  let rest = sorted;
  if (isNew) {
    let committed = false;
    project.lockedAccess(() => {
      const action = editor.createInsertProjectItemAction(item(sorted[0]!), at(sorted[0]!), index, 0, true);
      committed = project.executeTransaction((compound) => {
        compound.addAction(action);
      }, undo);
    });
    finishTransaction(committed, undo, 1);
    rest = sorted.slice(1);
  }
  if (rest.length) {
    let committed = false;
    project.lockedAccess(() => {
      const actions = rest.map((s) => editor.createOverwriteItemAction(item(s), at(s), index, 0));
      committed = project.executeTransaction((compound) => {
        for (const a of actions) compound.addAction(a);
      }, undo);
    });
    finishTransaction(committed, undo, rest.length);
  }

  // exact ends
  const placed = (await seq.getVideoTrack(index)).getTrackItems(CLIP, false) as VideoClipTrackItem[];
  const byStart = new Map<string, VideoClipTrackItem>();
  for (const it of placed) byStart.set(String(parseTicks((await it.getStartTime()).ticks)), it);
  const fixes: [VideoClipTrackItem, bigint][] = [];
  for (const s of sorted) {
    const it = byStart.get(String(secondsToTicks(s.start)));
    if (it) fixes.push([it, secondsToTicks(s.end)]);
  }
  if (fixes.length) {
    let committed = false;
    project.lockedAccess(() => {
      const actions = fixes.map(([it, end]) => it.createSetEndAction(P.TickTime.createWithTicks(String(end))));
      committed = project.executeTransaction((compound) => {
        for (const a of actions) compound.addAction(a);
      }, undo);
    });
    finishTransaction(committed, undo, fixes.length);
  }
  log.info(`Placed ${sorted.length} caption(s) on V${index + 1}`);
  return { track: index, count: fixes.length };
}
