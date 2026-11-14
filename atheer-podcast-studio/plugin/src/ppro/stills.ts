/**
 * Captions (and any timed stills) on the timeline: import transparent PNGs,
 * put them on one free track above everything, each at its exact start, then
 * trim/extend each to its exact end (stills can be any length).
 */
import type { FolderItem, Project, Sequence, VideoClipTrackItem } from "@adobe/premierepro";
import { logger } from "../core/log.ts";
import { parseTicks } from "../core/time.ts";
import { ppro } from "./api.ts";
import { CHILD_BINS, ROOT_BIN, ensureProjectBins, findChildBin } from "./edits.ts";
import { chooseTrack, type Interval } from "./graphics.ts";
import { secondsToTicks } from "./timeline.ts";
import { importAndFind } from "./importing.ts";
import { finishTransaction } from "./transaction.ts";

const log = logger("stills");

export interface TimedStill {
  path: string;
  start: number;
  end: number;
}


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
  const clips = await importAndFind(project, stills.map((s) => s.path), bin);

  // Premiere snaps clip starts/ends to frames: work in whole frames so every placed still is found again.
  let tpf = 0n;
  try {
    tpf = parseTicks(await seq.getTimebase());
  } catch {
    tpf = 0n;
  }
  const snap = (sec: number): bigint => {
    const t = secondsToTicks(sec);
    return tpf > 0n ? ((t + tpf / 2n) / tpf) * tpf : t;
  };
  const sorted = [...stills].sort((a, b) => a.start - b.start)
    .map((s) => ({ ...s, s0: snap(s.start), s1: snap(s.end) }))
    .filter((s, i, arr) => s.s1 > s.s0 && (i === 0 || s.s0 !== arr[i - 1]!.s0));
  if (!sorted.length) throw new Error("Nothing to place.");
  const range = { start: sorted[0]!.s0, end: sorted.reduce((m, s) => (s.s1 > m ? s.s1 : m), 0n) };
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
  const at = (s: { s0: bigint }) => P.TickTime.createWithTicks(String(s.s0));
  const item = (s: TimedStill) => clips.get(s.path)!.item;

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
  const starts: [bigint, VideoClipTrackItem][] = [];
  for (const it of placed) starts.push([parseTicks((await it.getStartTime()).ticks), it]);
  const tol = tpf > 0n ? tpf / 2n : 1n;
  const fixes: [VideoClipTrackItem, bigint][] = [];
  for (const s of sorted) {
    const hit = starts.find(([t]) => (t > s.s0 ? t - s.s0 : s.s0 - t) <= tol);
    if (hit) fixes.push([hit[1], s.s1]);
  }
  if (fixes.length < sorted.length) log.warn(`${sorted.length - fixes.length} caption(s) not found again for their exact end`);
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
