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
import type { FolderItem, Project, ProjectItem, Sequence } from "@adobe/premierepro";
import { logger } from "../core/log.ts";
import { ppro } from "./api.ts";
import { CHILD_BINS, ROOT_BIN, ensureProjectBins, findChildBin } from "./edits.ts";
import { secondsToTicks } from "./timeline.ts";
import { type Imported, importAndFind } from "./importing.ts";
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

type CamRole = "wide_cam" | "host_cam" | "guest_cam";
type NameKey = "wide" | "host" | "guest" | "guestMic" | "hostMic" | "extra" | "camAudio";
export interface TrackName { index: number; key: NameKey; n?: number; cam?: "wide" | "host" | "guest" }

const CAM_KEY: Record<CamRole, "wide" | "host" | "guest"> = { wide_cam: "wide", host_cam: "host", guest_cam: "guest" };

/**
 * Pure: track index for every item, with no empty tracks in between (a shoot without a
 * Wide Camera or without separate mics must not leave gaps: Premiere refuses an insert
 * on a track index that does not exist yet).
 *   video: Wide, Host, Guest (only those present)
 *   audio: Guest Mic, Host Mic, extras, then each camera's own audio (only those present)
 */
export function layout(items: BuildItem[]): { video: Map<BuildItem, number>; audio: Map<BuildItem, number>;
  camAudioTracks: number[]; extraTracks: number[]; vNames: TrackName[]; aNames: TrackName[] } {
  const present = (r: Role) => items.some((i) => i.role === r);
  const cams = (["wide_cam", "host_cam", "guest_cam"] as CamRole[]).filter(present);
  const extras = [...new Set(items.filter((i) => i.role === "extra").map((i) => i.path))];
  const vNames: TrackName[] = cams.map((r, k) => ({ index: k, key: CAM_KEY[r] }));
  const aNames: TrackName[] = [];
  if (present("guest_mic")) aNames.push({ index: aNames.length, key: "guestMic" });
  if (present("host_mic")) aNames.push({ index: aNames.length, key: "hostMic" });
  const extraTracks = extras.map((_, k) => {
    aNames.push({ index: aNames.length, key: "extra", n: k + 1 });
    return aNames.length - 1;
  });
  const camAudioTracks = cams.map((r, k) => {
    aNames.push({ index: aNames.length, key: "camAudio", n: k + 1, cam: CAM_KEY[r] });
    return aNames.length - 1;
  });
  const video = new Map<BuildItem, number>();
  const audio = new Map<BuildItem, number>();
  const guestMic = aNames.find((x) => x.key === "guestMic")?.index;
  const hostMic = aNames.find((x) => x.key === "hostMic")?.index;
  for (const it of items) {
    if (it.role.endsWith("_cam")) {
      const k = cams.indexOf(it.role as CamRole);
      video.set(it, k);
      audio.set(it, camAudioTracks[k]!);
    } else if (it.role === "guest_mic") audio.set(it, guestMic!);
    else if (it.role === "host_mic") audio.set(it, hostMic!);
    else audio.set(it, extraTracks[extras.indexOf(it.path)]!);
  }
  return { video, audio, camAudioTracks, extraTracks, vNames, aNames };
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


async function importInto(project: Project, bin: FolderItem, paths: string[]): Promise<Map<string, Imported>> {
  if (!paths.length) return new Map();
  return await importAndFind(project, paths, bin);
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
  const created = await project.createSequenceFromMedia(plan.name, [clipOf(first).clip], seqBin as unknown as ProjectItem);
  const seq = created ?? (await project.getSequences()).find((s) => !before.has(s.guid.toString()));
  if (!seq) throw new Error("The new sequence was not created.");
  await clearSequence(project, seq);

  const { video, audio, camAudioTracks, vNames, aNames } = layout(plan.items);
  const editor = P.SequenceEditor.getEditor(seq);
  const undo = `MAG: Build ${plan.name}`;
  // One insert per transaction: an insert that creates a track must see the tracks the
  // previous inserts created (Premiere validates the index when the action is made).
  for (const it of insertionOrder(plan.items)) {
    let committed = false;
    project.lockedAccess(() => {
      const action = editor.createInsertProjectItemAction(
        clipOf(it).item,
        P.TickTime.createWithTicks(String(secondsToTicks(Math.max(0, it.seqStart)))),
        video.get(it) ?? 0,
        audio.get(it) ?? 0,
        true,
      );
      committed = project.executeTransaction((compound) => {
        compound.addAction(action);
      }, undo);
    });
    finishTransaction(committed, undo, 1);
  }

  await nameTracks(project, seq, plan, vNames, aNames);
  // Camera audio is muted only when separate mics exist; otherwise it is the only sound.
  const hasMics = plan.items.some((i) => i.role === "guest_mic" || i.role === "host_mic" || i.role === "extra");
  for (const idx of hasMics ? camAudioTracks : []) {
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

async function nameTracks(project: Project, seq: Sequence, plan: BuildPlan, vNames: TrackName[], aNames: TrackName[]): Promise<void> {
  const n = plan.trackNames;
  const label = (t: TrackName) => (t.key === "extra" ? `${n.extra} ${t.n}`
    : t.key === "camAudio" ? `${n[t.cam!]} · ${n.camAudio}` : n[t.key]);
  const vList: [number, string][] = vNames.map((t) => [t.index, label(t)]);
  const aList: [number, string][] = aNames.map((t) => [t.index, label(t)]);
  const vCount = await seq.getVideoTrackCount();
  const aCount = await seq.getAudioTrackCount();
  const tracks: { track: { createSetNameAction?: (s: string) => unknown }; name: string }[] = [];
  for (const [i, name] of vList) if (i < vCount) tracks.push({ track: await seq.getVideoTrack(i), name });
  for (const [i, name] of aList) if (i < aCount) tracks.push({ track: await seq.getAudioTrack(i), name });
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
