/**
 * Cut engine: builds an edited copy of a sequence from a CutPlan, without a
 * razor API and without touching the original sequence.
 *
 *   1. Read every clip of the source sequence (start, end, in point, media).
 *   2. Plan the pieces (core/cutplan.ts): exact, frame-aligned.
 *   3. Create one subclip per distinct media range (ClipProjectItem
 *      .createSubClipAction, Premiere 26.3+), video-only or audio-only.
 *   4. Clone the source sequence (keeps settings, tracks and names) and clear it.
 *   5. Overwrite every piece at its exact time on its original track.
 *   6. Restore disabled states, rename, file into bins, then VERIFY by reading
 *      the new sequence back and comparing it with the plan.
 *
 * Every Premiere change follows the lockedAccess/executeTransaction pattern and
 * shows up as named Undo steps. By default the source sequence is only read;
 * with `inPlace` the clone is kept as a backup and the source itself is rebuilt.
 */
import type {
  AudioClipTrackItem, ClipProjectItem, FolderItem, Project, ProjectItem, Sequence, VideoClipTrackItem,
} from "@adobe/premierepro";
import { type CutPlan, type Piece, type Range, type SourceItem, planCuts, segmentId, uniqueSegments } from "../core/cutplan.ts";
import { errorMessage, logger } from "../core/log.ts";
import { type Rational, frameRateFromTicksPerFrame, parseTicks, ticksPerFrame, ticksToTimecode } from "../core/time.ts";
import { ppro } from "./api.ts";
import { ROOT_BIN, ensureProjectBins, findChildBin } from "./edits.ts";
import { finishTransaction } from "./transaction.ts";

const log = logger("cut");

type TrackItem = VideoClipTrackItem | AudioClipTrackItem;

export interface LiveItem {
  src: SourceItem;
  ref: TrackItem;
  clip: ClipProjectItem;
  name: string;
}

export interface CutRequest {
  remove?: Range[];
  splitAt?: bigint[];
  /** Override the enabled state per piece (Auto Director). null keeps the source state. */
  disable?: (p: Piece) => boolean | null;
  newName: string;
  /**
   * Edit the source sequence itself. A full copy is kept first, named newName
   * ("..._BACKUP_..."), so the original edit is always one click away.
   */
  inPlace?: boolean;
  onProgress?: (step: string, fraction: number) => void;
}

export interface CutReport {
  newSequenceName: string;
  /** In-place edits: the untouched copy of the sequence as it was before. */
  backupName?: string;
  plan: CutPlan;
  subclips: number;
  placed: number;
  verified: number;
  mismatches: string[];
  undoSteps: number;
}

export const SEGMENTS_BIN = "07 Cut segments";

async function sequenceTpf(seq: Sequence): Promise<{ tpf: bigint; fps: Rational }> {
  let tpf: bigint | null = null;
  try {
    const settings = await seq.getSettings();
    if (typeof settings.getVideoFrameRate === "function") tpf = BigInt(Math.round(settings.getVideoFrameRate().ticksPerFrame));
  } catch {
    /* fall back */
  }
  if (!tpf || tpf <= 0n) tpf = parseTicks(await seq.getTimebase());
  return { tpf, fps: frameRateFromTicksPerFrame(tpf) };
}

/** Every clip on every video and audio track, with what the planner needs. */
export async function readLiveItems(seq: Sequence): Promise<LiveItem[]> {
  const P = ppro();
  const CLIP = P.Constants.TrackItemType.CLIP;
  const out: LiveItem[] = [];
  const kinds: ["video" | "audio", number][] = [["video", await seq.getVideoTrackCount()], ["audio", await seq.getAudioTrackCount()]];
  for (const [kind, count] of kinds) {
    for (let t = 0; t < count; t++) {
      const track = kind === "video" ? await seq.getVideoTrack(t) : await seq.getAudioTrack(t);
      const items = track.getTrackItems(CLIP, false) as TrackItem[];
      for (let i = 0; i < items.length; i++) {
        const ref = items[i]!;
        const pi = await ref.getProjectItem();
        if (!pi) continue;
        const clip = P.ClipProjectItem.cast(pi);
        if (!clip || (await clip.isSequence())) continue; // nested sequences are not cut yet
        out.push({
          ref,
          clip,
          name: pi.name,
          src: {
            key: `${kind}${t}:${i}`,
            kind,
            track: t,
            start: parseTicks((await ref.getStartTime()).ticks),
            end: parseTicks((await ref.getEndTime()).ticks),
            inPoint: parseTicks((await ref.getInPoint()).ticks),
            speed: await ref.getSpeed(),
            disabled: await ref.isDisabled(),
            media: pi.getId(),
          },
        });
      }
    }
  }
  return out;
}

async function walkBins(folder: FolderItem, visit: (item: ProjectItem, parent: FolderItem) => void, depth = 0): Promise<void> {
  const P = ppro();
  for (const item of await folder.getItems()) {
    visit(item, folder);
    if (depth > 12) continue;
    try {
      const sub = P.FolderItem.cast(item);
      if (sub && item.name) await walkBins(sub, visit, depth + 1);
    } catch {
      /* not a bin */
    }
  }
}

async function ensureBin(project: Project, parent: FolderItem, name: string, undo: string): Promise<{ bin: FolderItem; created: boolean }> {
  const existing = await findChildBin(parent, name);
  if (existing) return { bin: existing, created: false };
  let committed = false;
  project.lockedAccess(() => {
    const action = parent.createBinAction(name, false);
    committed = project.executeTransaction((compound) => {
      compound.addAction(action);
    }, undo);
  });
  finishTransaction(committed, undo, 1);
  const bin = await findChildBin(parent, name);
  if (!bin) throw new Error(`Bin "${name}" was created but cannot be found.`);
  return { bin, created: true };
}

const shortId = () => Math.random().toString(36).slice(2, 7).toUpperCase();

export async function buildCutSequence(project: Project, source: Sequence, req: CutRequest): Promise<CutReport> {
  const P = ppro();
  const progress = req.onProgress ?? (() => undefined);
  const undo = `MAG: ${req.newName}`;
  let undoSteps = 0;

  // ---- 1-2. read and plan (no changes yet) ---------------------------------
  progress("read", 0.02);
  const { tpf, fps } = await sequenceTpf(source);
  ticksPerFrame(fps); // throws on exotic rates rather than mis-cutting
  const sequenceEnd = parseTicks((await source.getEndTime()).ticks);
  const live = await readLiveItems(source);
  if (live.length === 0) throw new Error("The sequence has no clips to cut.");
  if (req.inPlace && (await readAllItems(source)).length !== live.length) {
    throw new Error("This sequence contains nested sequences, which the cut engine does not rebuild. Use \"new sequence\" mode.");
  }
  const plan = planCuts(live.map((l) => l.src), { tpf, sequenceEnd, remove: req.remove, splitAt: req.splitAt });
  if (plan.skipped.length) {
    throw new Error(`Cannot cut ${plan.skipped.length} clip(s): ${plan.skipped[0]!.reason}. Remove speed changes first.`);
  }
  if (req.disable) {
    for (const p of plan.pieces) {
      const d = req.disable(p);
      if (d !== null) p.disabled = d;
    }
  }
  log.info(`Plan: ${plan.pieces.length} pieces, ${plan.removed.length} range(s) removed (${ticksToTimecode(plan.removedTicks, fps)})`);

  const clipByMedia = new Map<string, LiveItem>();
  for (const l of live) if (!clipByMedia.has(l.src.media)) clipByMedia.set(l.src.media, l);

  // ---- 3. bins + subclips ---------------------------------------------------
  progress("subclips", 0.1);
  await ensureProjectBins(project);
  const root = await project.getRootItem();
  const appBin = await findChildBin(root, ROOT_BIN);
  if (!appBin) throw new Error("Project bins are missing.");
  const segRoot = await ensureBin(project, appBin, SEGMENTS_BIN, undo);
  const segBin = await ensureBin(project, segRoot.bin, req.newName, undo);
  undoSteps += Number(segRoot.created) + Number(segBin.created);

  const run = shortId();
  const segments = uniqueSegments(plan.pieces);
  const nameOf = (i: number) => {
    const s = segments[i]!;
    const owner = clipByMedia.get(s.media)!;
    return `${owner.name} ${s.kind === "video" ? "V" : "A"} ${ticksToTimecode(s.srcIn, fps)} [${run}-${i}]`;
  };
  let committed = false;
  project.lockedAccess(() => {
    const actions = segments.map((s, i) => {
      const owner = clipByMedia.get(s.media)!;
      return owner.clip.createSubClipAction(
        nameOf(i),
        P.TickTime.createWithTicks(String(s.srcIn)),
        P.TickTime.createWithTicks(String(s.srcOut)),
        true,
        { takeVideo: s.kind === "video", takeAudio: s.kind === "audio" },
      );
    });
    committed = project.executeTransaction((compound) => {
      for (const a of actions) compound.addAction(a);
    }, undo);
  });
  finishTransaction(committed, undo, segments.length);
  undoSteps++;

  // Find the new subclips wherever Premiere put them, then file them.
  const tag = new RegExp(`\\[${run}-(\\d+)\\]$`);
  const found = new Map<number, { item: ProjectItem; parent: FolderItem }>();
  await walkBins(root, (item, parent) => {
    const m = tag.exec(item.name);
    if (m) found.set(Number(m[1]), { item, parent });
  });
  if (found.size !== segments.length) {
    throw new Error(`Premiere created ${found.size} of ${segments.length} subclips. Nothing else was changed; undo to remove them.`);
  }
  const toMove = [...found.values()].filter((f) => f.parent !== segBin.bin);
  if (toMove.length) {
    committed = false;
    project.lockedAccess(() => {
      const actions = toMove.map((f) => f.parent.createMoveItemAction(f.item, segBin.bin));
      committed = project.executeTransaction((compound) => {
        for (const a of actions) compound.addAction(a);
      }, undo);
    });
    finishTransaction(committed, undo, toMove.length);
    undoSteps++;
  }
  const subclipBySeg = new Map<string, ProjectItem>();
  segments.forEach((s, i) => subclipBySeg.set(s.id, found.get(i)!.item));

  // ---- 4. clone the source sequence and clear the clone ----------------------
  progress("clone", 0.35);
  const before = new Set((await project.getSequences()).map((s) => s.guid.toString()));
  committed = false;
  project.lockedAccess(() => {
    const action = source.createCloneAction();
    committed = project.executeTransaction((compound) => {
      compound.addAction(action);
    }, undo);
  });
  finishTransaction(committed, undo, 1);
  undoSteps++;
  const clone = (await project.getSequences()).find((s) => !before.has(s.guid.toString()));
  if (!clone) throw new Error("The sequence copy was not found after cloning.");
  // In place: the clone is the backup and the original is rebuilt. Otherwise the clone is the result.
  const target = req.inPlace ? source : clone;
  const sourceName = (await source.getProjectItem()).name;

  const editor = P.SequenceEditor.getEditor(target);
  const allTargetItems = await readAllItems(target);
  if (allTargetItems.length) {
    committed = false;
    project.lockedAccess(() => {
      P.TrackItemSelection.createEmptySelection((selection) => {
        for (const it of allTargetItems) selection.addItem(it, true);
        const action = editor.createRemoveItemsAction(selection, false, P.Constants.MediaType.ANY, false);
        committed = project.executeTransaction((compound) => {
          compound.addAction(action);
        }, undo);
      });
    });
    finishTransaction(committed, undo, allTargetItems.length);
    undoSteps++;
  }

  // ---- 5. place every piece --------------------------------------------------
  progress("place", 0.55);
  const BATCH = 400; // keeps each transaction responsive on long episodes
  for (let i = 0; i < plan.pieces.length; i += BATCH) {
    const batch = plan.pieces.slice(i, i + BATCH);
    committed = false;
    project.lockedAccess(() => {
      const actions = batch.map((p) =>
        editor.createOverwriteItemAction(
          subclipBySeg.get(segmentId(p))!,
          P.TickTime.createWithTicks(String(p.dest)),
          p.track,
          p.track,
        ));
      committed = project.executeTransaction((compound) => {
        for (const a of actions) compound.addAction(a);
      }, undo);
    });
    finishTransaction(committed, undo, batch.length);
    undoSteps++;
    progress("place", 0.55 + 0.3 * ((i + batch.length) / plan.pieces.length));
  }

  // ---- 6. disabled states, name, bin, verification ----------------------------
  progress("verify", 0.88);
  const placed = await readLiveItems(target);
  const at = (kind: string, track: number, start: bigint) => `${kind}|${track}|${start}`;
  const placedIndex = new Map(placed.map((l) => [at(l.src.kind, l.src.track, l.src.start), l]));

  const toDisable = plan.pieces
    .filter((p) => p.disabled)
    .map((p) => placedIndex.get(at(p.kind, p.track, p.dest)))
    .filter((l): l is LiveItem => !!l && !l.src.disabled);
  if (toDisable.length) {
    committed = false;
    project.lockedAccess(() => {
      const actions = toDisable.map((l) => l.ref.createSetDisabledAction(true));
      committed = project.executeTransaction((compound) => {
        for (const a of actions) compound.addAction(a);
      }, undo);
    });
    finishTransaction(committed, undo, toDisable.length);
    undoSteps++;
  }

  const seqItem = await clone.getProjectItem();
  const sequencesBin = await findChildBin(appBin, "03 Sequences");
  committed = false;
  project.lockedAccess(() => {
    const actions = [seqItem.createSetNameAction(req.newName)];
    if (sequencesBin) actions.push(seqItem.getParentBin().createMoveItemAction(seqItem, sequencesBin));
    committed = project.executeTransaction((compound) => {
      for (const a of actions) compound.addAction(a);
    }, undo);
  });
  finishTransaction(committed, undo, 1);
  undoSteps++;

  const mismatches: string[] = [];
  let verified = 0;
  for (const p of plan.pieces) {
    const got = placedIndex.get(at(p.kind, p.track, p.dest));
    const len = p.srcOut - p.srcIn;
    if (!got) {
      mismatches.push(`${p.kind === "video" ? "V" : "A"}${p.track + 1} ${ticksToTimecode(p.dest, fps)}: missing`);
    } else if (got.src.end - got.src.start !== len) {
      mismatches.push(`${p.kind === "video" ? "V" : "A"}${p.track + 1} ${ticksToTimecode(p.dest, fps)}: length ${
        ticksToTimecode(got.src.end - got.src.start, fps)} instead of ${ticksToTimecode(len, fps)}`);
    } else {
      verified++;
    }
  }
  const extra = placed.length - verified;
  if (extra > 0 && mismatches.length === 0) mismatches.push(`${extra} unexpected extra clip(s) on the new sequence`);

  try {
    await project.openSequence(target);
  } catch (e) {
    log.debug(`openSequence failed: ${errorMessage(e)}`);
  }
  progress("done", 1);
  const report: CutReport = {
    newSequenceName: req.inPlace ? sourceName : req.newName,
    backupName: req.inPlace ? req.newName : undefined,
    plan,
    subclips: segments.length,
    placed: placed.length,
    verified,
    mismatches,
    undoSteps,
  };
  if (mismatches.length) log.warn(`Verification: ${verified}/${plan.pieces.length} pieces exact; first issue: ${mismatches[0]}`);
  else log.info(`Verification: all ${verified} pieces exact`);
  return report;
}

/** All clip items (including nested sequences) for clearing a cloned sequence. */
async function readAllItems(seq: Sequence): Promise<TrackItem[]> {
  const P = ppro();
  const CLIP = P.Constants.TrackItemType.CLIP;
  const out: TrackItem[] = [];
  for (let t = 0; t < (await seq.getVideoTrackCount()); t++) {
    out.push(...((await seq.getVideoTrack(t)).getTrackItems(CLIP, false) as TrackItem[]));
  }
  for (let t = 0; t < (await seq.getAudioTrackCount()); t++) {
    out.push(...((await seq.getAudioTrack(t)).getTrackItems(CLIP, false) as TrackItem[]));
  }
  return out;
}

/** Sequence In/Out as a removal range, for the "remove In→Out" engine test. */
export async function sequenceInOut(seq: Sequence): Promise<Range | null> {
  const a = parseTicks((await seq.getInPoint()).ticks);
  const b = parseTicks((await seq.getOutPoint()).ticks);
  const end = parseTicks((await seq.getEndTime()).ticks);
  if (b <= a || (a === 0n && b >= end)) return null;
  return { start: a, end: b };
}

export type { Piece };
