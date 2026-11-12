/**
 * Read-only snapshot of the active project and sequence.
 *
 * Track labels are derived from real zero-based API indices ("V1" = video
 * index 0), never assumed from names, because users rename tracks freely.
 */
import type { AudioClipTrackItem, Project, Sequence, VideoClipTrackItem } from "@adobe/premierepro";
import { errorMessage, logger } from "../core/log.ts";
import { type Rational, frameRateFromTicksPerFrame, parseTicks, ticksToSeconds, ticksToTimecode } from "../core/time.ts";
import { ppro } from "./api.ts";

const log = logger("project");

export interface TrackInfo {
  kind: "video" | "audio";
  index: number; // zero-based API index
  label: string; // V1 / A1 as shown in Premiere's track header
  name: string;
  clipCount: number;
  muted: boolean | null;
}

export interface MediaRef {
  path: string;
  name: string;
  tracks: string[]; // labels of tracks where the media is used
  clipCount: number;
  offline: boolean;
}

export interface SequenceSnapshot {
  name: string;
  guid: string;
  width: number | null;
  height: number | null;
  fps: Rational | null;
  durationSeconds: number | null;
  playheadTimecode: string | null;
  playheadSeconds: number | null;
  videoTracks: TrackInfo[];
  audioTracks: TrackInfo[];
  captionTrackCount: number;
  media: MediaRef[];
  skippedItems: number; // track items with no file (graphics, nested sequences, ...)
}

export interface ProjectSnapshot {
  name: string;
  path: string;
  sequenceCount: number;
  activeSequence: SequenceSnapshot | null;
  readAt: number;
}

export async function getActiveProject(): Promise<Project | null> {
  try {
    return (await ppro().Project.getActiveProject()) ?? null;
  } catch (e) {
    log.warn("Could not read the active project", e);
    return null;
  }
}

async function sequenceFrameRate(seq: Sequence): Promise<Rational | null> {
  // getVideoFrameRate exists from 26.2; getTimebase (ticks per frame) from 25.6.
  try {
    const settings = await seq.getSettings();
    if (typeof settings.getVideoFrameRate === "function") {
      const fr = settings.getVideoFrameRate();
      if (fr && fr.ticksPerFrame > 0) return frameRateFromTicksPerFrame(String(Math.round(fr.ticksPerFrame)));
    }
  } catch (e) {
    log.debug(`getVideoFrameRate failed: ${errorMessage(e)}`);
  }
  try {
    const tb = await seq.getTimebase();
    return frameRateFromTicksPerFrame(tb);
  } catch (e) {
    log.warn("Could not read the sequence frame rate", e);
    return null;
  }
}

type AnyTrackItem = VideoClipTrackItem | AudioClipTrackItem;

async function collectMedia(
  items: AnyTrackItem[],
  label: string,
  byPath: Map<string, MediaRef>,
): Promise<number> {
  const P = ppro();
  let skipped = 0;
  for (const item of items) {
    try {
      const projectItem = await item.getProjectItem();
      const clip = projectItem ? P.ClipProjectItem.cast(projectItem) : null;
      if (!clip) {
        skipped++;
        continue;
      }
      if (await clip.isSequence()) {
        skipped++;
        continue;
      }
      const path = await clip.getMediaFilePath();
      if (!path) {
        skipped++;
        continue;
      }
      let ref = byPath.get(path);
      if (!ref) {
        const name = path.split(/[\\/]/).pop() ?? path;
        ref = { path, name, tracks: [], clipCount: 0, offline: await clip.isOffline() };
        byPath.set(path, ref);
      }
      ref.clipCount++;
      if (!ref.tracks.includes(label)) ref.tracks.push(label);
    } catch (e) {
      skipped++;
      log.debug(`Skipped a track item on ${label}: ${errorMessage(e)}`);
    }
  }
  return skipped;
}

export async function readSequence(seq: Sequence): Promise<SequenceSnapshot> {
  const P = ppro();
  const CLIP = P.Constants.TrackItemType.CLIP;
  const fps = await sequenceFrameRate(seq);

  let width: number | null = null;
  let height: number | null = null;
  try {
    const rect = await seq.getFrameSize();
    width = Math.round(rect.width);
    height = Math.round(rect.height);
  } catch (e) {
    log.debug(`getFrameSize failed: ${errorMessage(e)}`);
  }

  let durationSeconds: number | null = null;
  try {
    const end = await seq.getEndTime();
    durationSeconds = ticksToSeconds(parseTicks(end.ticks));
  } catch (e) {
    log.debug(`getEndTime failed: ${errorMessage(e)}`);
  }

  let playheadTimecode: string | null = null;
  let playheadSeconds: number | null = null;
  try {
    const pos = await seq.getPlayerPosition();
    const ticks = parseTicks(pos.ticks);
    playheadSeconds = ticksToSeconds(ticks);
    if (fps) playheadTimecode = ticksToTimecode(ticks, fps);
  } catch (e) {
    log.debug(`getPlayerPosition failed: ${errorMessage(e)}`);
  }

  const byPath = new Map<string, MediaRef>();
  let skippedItems = 0;
  const videoTracks: TrackInfo[] = [];
  const audioTracks: TrackInfo[] = [];

  const vCount = await seq.getVideoTrackCount();
  for (let i = 0; i < vCount; i++) {
    const track = await seq.getVideoTrack(i);
    const label = `V${i + 1}`;
    const items = track.getTrackItems(CLIP, false) as VideoClipTrackItem[];
    skippedItems += await collectMedia(items, label, byPath);
    let muted: boolean | null = null;
    try {
      muted = await track.isMuted();
    } catch {
      /* optional */
    }
    videoTracks.push({ kind: "video", index: i, label, name: track.name, clipCount: items.length, muted });
  }

  const aCount = await seq.getAudioTrackCount();
  for (let i = 0; i < aCount; i++) {
    const track = await seq.getAudioTrack(i);
    const label = `A${i + 1}`;
    const items = track.getTrackItems(CLIP, false) as AudioClipTrackItem[];
    skippedItems += await collectMedia(items, label, byPath);
    let muted: boolean | null = null;
    try {
      muted = await track.isMuted();
    } catch {
      /* optional */
    }
    audioTracks.push({ kind: "audio", index: i, label, name: track.name, clipCount: items.length, muted });
  }

  let captionTrackCount = 0;
  try {
    captionTrackCount = await seq.getCaptionTrackCount();
  } catch {
    /* optional */
  }

  return {
    name: seq.name,
    guid: seq.guid.toString(),
    width,
    height,
    fps,
    durationSeconds,
    playheadTimecode,
    playheadSeconds,
    videoTracks,
    audioTracks,
    captionTrackCount,
    media: [...byPath.values()],
    skippedItems,
  };
}

export async function readProjectSnapshot(): Promise<ProjectSnapshot | null> {
  const project = await getActiveProject();
  if (!project) return null;
  let sequenceCount = 0;
  try {
    sequenceCount = (await project.getSequences()).length;
  } catch (e) {
    log.debug(`getSequences failed: ${errorMessage(e)}`);
  }
  let activeSequence: SequenceSnapshot | null = null;
  const seq = await project.getActiveSequence();
  if (seq) activeSequence = await readSequence(seq);
  return { name: project.name, path: project.path, sequenceCount, activeSequence, readAt: Date.now() };
}
