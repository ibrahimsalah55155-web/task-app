/**
 * Sync & Build: import the files and lay them out on a new sequence at the
 * offsets found by the engine.
 *
 *   V1 Wide Camera   V2 Host Camera   V3 Guest Camera
 *   A1 Guest Mic     A2 Host Mic      A3+ extra mics, then camera audio (muted)
 *
 * The sequence takes its settings from the first camera clip
 * (createSequenceFromMedia), is cleared, then every file is inserted on its
 * track at its exact start. Camera audio stays available but muted, so there
 * is no double audio.
 */
import type { ClipProjectItem, FolderItem, Project, ProjectItem, Sequence } from "@adobe/premierepro";
import { logger } from "../core/log.ts";
import { ppro } from "./api.ts";
import { CHILD_BINS, ROOT_BIN, ensureProjectBins, findChildBin } from "./edits.ts";
import { secondsToTicks } from "./timeline.ts";
import { finishTransaction } from "./transaction.ts";

const log = logger("build");

export type Role = "guest_cam" | "host_cam" | "wide_cam" | "guest_mic" | "host_mic" | "extra";

export interface BuildItem {
  path: string;
  role: Role;
  seqStart: number; // seconds
}

export interface BuildPlan {
  name: string;
  items: BuildItem[];
  trackNames: { wide: string; host: string; guest: string; guestMic: string; hostMic: string; extra: string; camAudio: string };
}

/** Pure: track index for every item. */
export function layout(items: BuildItem[]): { video: Map<BuildItem, number>; audio: Map<BuildItem, number>;
  camAudioTracks: number[]; extraTracks: number[]; } {
  const vIdx: Record<string, number> = { wide_cam: 0, host_cam: 1, guest_cam: 2 };
  const video = new Map<BuildItem, number>();
  const audio = new Map<BuildItem, number>();
  const extras = [...new Set(items.filter((i) => i.role === "extra").map((i) => i.path))];
  const cams = ["wide_cam", "host_cam", "guest_cam"].filter((r) => items.some((i) => i.role === r));
  const extraTracks = extras.map((_, k) => 2 + k);
  const camAudioBase = 2 + extras.length;
  const camAudioTracks = cams.map((_, k) => camAudioBase + k);
  for (const it of items) {
    if (it.role in vIdx) {
      video.set(it, vIdx[it.role]!);
      audio.set(it, camAudioBase + cams.indexOf(it.role));
    } else if (it.role === "guest_mic") audio.set(it, 0);
    else if (it.role === "host_mic") audio.set(it, 1);
    else audio.set(it, 2 + extras.indexOf(it.path));
  }
  return { video, audio, camAudioTracks, extraTracks };
}

/**
 * Premiere creates ONE new track when an insert names an index past the last
 * track, so every insert must name an existing index or exactly the next one.
 * Mics first (A1, A2, extras), then cameras bottom-up (V1 wide, V2 host, V3 guest),
 * each bringing the next camera-audio track.
 */
export function insertionOrder(items: BuildItem[]): BuildItem[] {
  const rank: Record<Role, number> = { guest_mic: 0, host_mic: 1, extra: 2, wide_cam: 3, host_cam: 4, guest_cam: 5 };
  const extras = [...new Set(items.filter((i) => i.role === "extra").map((i) => i.path))];
  return [...items].sort((a, b) => rank[a.role] - rank[b.role]
    || (a.role === "extra" ? extras.indexOf(a.path) - extras.indexOf(b.path) : 0)
    || a.seqStart - b.seqStart);
}

const samePath = (a: string, b: string) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();

async function importInto(project: Project, bin: FolderItem, paths: string[]): Promise<Map<string, ClipProjectItem>> {
  const P = ppro();
  const found = new Map<string, ClipProjectItem>();
  const scan = async () => {
    for (const item of await bin.getItems()) {
      try {
        const c = P.ClipProjectItem.cast(item);
        const p = c ? await c.getMediaFilePath() : "";
        const want = paths.find((x) => samePath(x, p));
        if (c && want) found.set(want, c);
      } catch {
        /* not a clip */
      }
    }
  };
  await scan();
  const missing = paths.filter((p) => !found.has(p));
  if (missing.length) {
    const ok = await project.importFiles(missing, true, bin as unknown as ProjectItem, false);
    if (!ok) throw new Error("Premiere could not import the files.");
    await scan();
  }
  const still = paths.filter((p) => !found.has(p));
  if (still.length) throw new Error(`Not found after import: ${still.join(", ")}`);
  return found;
}

export async function buildSyncedSequence(project: Project, plan: BuildPlan): Promise<Sequence> {
  const P = ppro();
  if (!plan.items.length) throw new Error("Nothing to build.");
  await ensureProjectBins(project);
  const root = await project.getRootItem();
  const app = await findChildBin(root, ROOT_BIN);
  const footage = app ? await findChildBin(app, CHILD_BINS[0]) : null;
  const audioBin = app ? await findChildBin(app, CHILD_BINS[1]) : null;
  const seqBin = app ? await findChildBin(app, CHILD_BINS[2]) : null;
  if (!footage || !audioBin || !seqBin) throw new Error("Project bins are missing.");

  const cams = plan.items.filter((i) => i.role.endsWith("_cam"));
  const sounds = plan.items.filter((i) => !i.role.endsWith("_cam"));
  const camItems = await importInto(project, footage, [...new Set(cams.map((i) => i.path))]);
  const sndItems = await importInto(project, audioBin, [...new Set(sounds.map((i) => i.path))]);
  const clipOf = (it: BuildItem) => (it.role.endsWith("_cam") ? camItems : sndItems).get(it.path)!;

  // New sequence with the first camera's settings, then emptied.
  const first = cams[0] ?? sounds[0]!;
  const before = new Set((await project.getSequences()).map((s) => s.guid.toString()));
  const created = await project.createSequenceFromMedia(plan.name, [clipOf(first)], seqBin as unknown as ProjectItem);
  const seq = created ?? (await project.getSequences()).find((s) => !before.has(s.guid.toString()));
  if (!seq) throw new Error("The new sequence was not created.");
  await clearSequence(project, seq);

  const { video, audio, camAudioTracks, extraTracks } = layout(plan.items);
  const editor = P.SequenceEditor.getEditor(seq);
  const undo = `MAG: Build ${plan.name}`;
  const ordered = insertionOrder(plan.items);
  let committed = false;
  project.lockedAccess(() => {
    const actions = ordered.map((it) => editor.createInsertProjectItemAction(
      clipOf(it) as unknown as ProjectItem,
      P.TickTime.createWithTicks(String(secondsToTicks(it.seqStart))),
      video.get(it) ?? 0,
      audio.get(it) ?? 0,
      true,
    ));
    committed = project.executeTransaction((compound) => {
      for (const a of actions) compound.addAction(a);
    }, undo);
  });
  finishTransaction(committed, undo, ordered.length);

  await nameTracks(project, seq, plan, camAudioTracks, extraTracks);
  for (const idx of camAudioTracks) {
    try {
      await (await seq.getAudioTrack(idx)).setMute(true);
    } catch (e) {
      log.warn(`Could not mute camera audio track A${idx + 1}`, e);
    }
  }
  await project.openSequence(seq);
  log.info(`Built ${plan.name}: ${plan.items.length} file(s)`);
  return seq;
}

async function clearSequence(project: Project, seq: Sequence): Promise<void> {
  const P = ppro();
  const CLIP = P.Constants.TrackItemType.CLIP;
  const items: unknown[] = [];
  for (let t = 0; t < (await seq.getVideoTrackCount()); t++) items.push(...(await seq.getVideoTrack(t)).getTrackItems(CLIP, false));
  for (let t = 0; t < (await seq.getAudioTrackCount()); t++) items.push(...(await seq.getAudioTrack(t)).getTrackItems(CLIP, false));
  if (!items.length) return;
  const editor = P.SequenceEditor.getEditor(seq);
  const undo = "MAG: Prepare sequence";
  let committed = false;
  project.lockedAccess(() => {
    P.TrackItemSelection.createEmptySelection((selection) => {
      for (const it of items) selection.addItem(it as never, true);
      const action = editor.createRemoveItemsAction(selection, false, P.Constants.MediaType.ANY, false);
      committed = project.executeTransaction((compound) => {
        compound.addAction(action);
      }, undo);
    });
  });
  finishTransaction(committed, undo, items.length);
}

async function nameTracks(project: Project, seq: Sequence, plan: BuildPlan, camAudio: number[], extra: number[]): Promise<void> {
  const n = plan.trackNames;
  const vNames: [number, string][] = [[0, n.wide], [1, n.host], [2, n.guest]];
  const aNames: [number, string][] = [[0, n.guestMic], [1, n.hostMic], ...extra.map((i, k) => [i, `${n.extra} ${k + 1}`] as [number, string]),
    ...camAudio.map((i, k) => [i, `${n.camAudio} ${k + 1}`] as [number, string])];
  const vCount = await seq.getVideoTrackCount();
  const aCount = await seq.getAudioTrackCount();
  const tracks: { track: { createSetNameAction?: (s: string) => unknown }; name: string }[] = [];
  for (const [i, name] of vNames) if (i < vCount) tracks.push({ track: await seq.getVideoTrack(i), name });
  for (const [i, name] of aNames) if (i < aCount) tracks.push({ track: await seq.getAudioTrack(i), name });
  if (!tracks.every((t) => typeof t.track.createSetNameAction === "function")) {
    log.warn("Track renaming needs Premiere 26.3+; tracks keep default names");
    return;
  }
  const undo = "MAG: Name tracks";
  let committed = false;
  project.lockedAccess(() => {
    const actions = tracks.map((t) => (t.track as { createSetNameAction(s: string): import("@adobe/premierepro").Action }).createSetNameAction(t.name));
    committed = project.executeTransaction((compound) => {
      for (const a of actions) compound.addAction(a);
    }, undo);
  });
  finishTransaction(committed, undo, tracks.length);
}
