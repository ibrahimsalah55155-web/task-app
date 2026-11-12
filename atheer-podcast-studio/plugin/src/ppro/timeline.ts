/**
 * What the engine needs to analyse a sequence: for every track, which file
 * plays where (seconds), so audio can be rebuilt on the sequence time axis.
 */
import type { Sequence } from "@adobe/premierepro";
import { parseTicks, ticksToSeconds } from "../core/time.ts";
import { readLiveItems } from "./cutengine.ts";

export interface PieceSpec {
  path: string;
  srcIn: number;
  seqStart: number;
  dur: number;
}

export interface TrackSpec {
  kind: "video" | "audio";
  index: number;
  label: string;
  name: string;
  pieces: PieceSpec[];
}

export interface TimelineSpec {
  duration: number;
  video: TrackSpec[];
  audio: TrackSpec[];
}

export async function readTimeline(seq: Sequence): Promise<TimelineSpec> {
  const live = await readLiveItems(seq);
  const video: TrackSpec[] = [];
  const audio: TrackSpec[] = [];
  const vCount = await seq.getVideoTrackCount();
  const aCount = await seq.getAudioTrackCount();
  for (let i = 0; i < vCount; i++) video.push({ kind: "video", index: i, label: `V${i + 1}`, name: (await seq.getVideoTrack(i)).name, pieces: [] });
  for (let i = 0; i < aCount; i++) audio.push({ kind: "audio", index: i, label: `A${i + 1}`, name: (await seq.getAudioTrack(i)).name, pieces: [] });
  for (const l of live) {
    if (l.src.disabled) continue;
    const path = await l.clip.getMediaFilePath();
    if (!path) continue;
    const list = l.src.kind === "video" ? video : audio;
    list[l.src.track]?.pieces.push({
      path,
      srcIn: ticksToSeconds(l.src.inPoint),
      seqStart: ticksToSeconds(l.src.start),
      dur: ticksToSeconds(l.src.end - l.src.start),
    });
  }
  return { duration: ticksToSeconds(parseTicks((await seq.getEndTime()).ticks)), video, audio };
}

const has = (name: string, words: string[]) => words.some((w) => name.toLowerCase().includes(w));

/** Best guess of which track is which, from the names Sync & Build gives (any language). */
export function guessRoles(tl: TimelineSpec): {
  guestMic: number | null; hostMic: number | null; guestCam: number | null; hostCam: number | null; wideCam: number | null;
} {
  const find = (tracks: TrackSpec[], words: string[]) => {
    const t = tracks.find((x) => x.pieces.length && has(x.name, words));
    return t ? t.index : null;
  };
  const guestW = ["guest", "ضيف"];
  const hostW = ["host", "مذيع", "anchor", "presenter"];
  const wideW = ["wide", "وايد", "master"];
  const mics = tl.audio.filter((t) => t.pieces.length);
  return {
    guestMic: find(tl.audio, guestW) ?? mics[0]?.index ?? null,
    hostMic: find(tl.audio, hostW) ?? mics[1]?.index ?? null,
    guestCam: find(tl.video, guestW),
    hostCam: find(tl.video, hostW),
    wideCam: find(tl.video, wideW),
  };
}

export const secondsToTicks = (s: number) => BigInt(Math.round(s * 254016000000));
