/**
 * Version-aware feature detection.
 *
 * Minimum versions are taken from Adobe's Premiere UXP reference (the
 * "Since" field of each API) and changelog. Where the API can be checked at
 * runtime without side effects we also check it, because a documented API
 * that is missing at runtime must not be silently assumed.
 */
import { atLeast } from "../core/version.ts";
import { ppro } from "./api.ts";

export type CapabilityStatus = "available" | "missing_at_runtime" | "requires_newer_premiere";

export interface CapabilityDef {
  id: string;
  label: string;
  minVersion: string;
  usedBy: string;
  /** Optional side-effect-free runtime check. */
  runtime?: () => boolean;
}

export interface CapabilityResult extends CapabilityDef {
  status: CapabilityStatus;
}

const fn = (obj: unknown, name: string): boolean =>
  obj != null && typeof (obj as Record<string, unknown>)[name] === "function";

const p = () => ppro() as unknown as Record<string, unknown>;

export const CAPABILITIES: CapabilityDef[] = [
  {
    id: "transactions",
    label: "Undoable transactions (lockedAccess + executeTransaction)",
    minVersion: "25.6",
    usedBy: "All timeline edits",
    runtime: () => fn(p()["Project"], "getActiveProject"),
  },
  {
    id: "sequenceEditor",
    label: "SequenceEditor insert / overwrite / clone / remove",
    minVersion: "25.6",
    usedBy: "Sync & Build, Silence Cut, Auto Director, Reels",
    runtime: () => fn(p()["SequenceEditor"], "getEditor"),
  },
  {
    id: "trackItemDisable",
    label: "Enable / disable clip (createSetDisabledAction)",
    minVersion: "25.6",
    usedBy: "Auto Director (non-destructive switching)",
  },
  {
    id: "sequenceFrameRate",
    label: "SequenceSettings get/setVideoFrameRate",
    minVersion: "26.2",
    usedBy: "Sync & Build, Reels (vertical sequences)",
  },
  {
    id: "hybridAddons",
    label: "UXP Hybrid C++ addons",
    minVersion: "26.2",
    usedBy: "Optional native acceleration",
  },
  {
    id: "renameTracks",
    label: "Rename tracks (createSetNameAction on tracks)",
    minVersion: "26.3",
    usedBy: "Sync & Build (V1 WIDE / V2 HOST / V3 GUEST labels)",
  },
  {
    id: "sequenceWithPreset",
    label: "Project.createSequenceWithPresetPath",
    minVersion: "26.3",
    usedBy: "Sync & Build, Reels",
  },
  {
    id: "subclips",
    label: "ClipProjectItem.createSubClipAction",
    minVersion: "26.3",
    usedBy: "Silence Cut / Reels fallback cutting strategy",
  },
  {
    id: "transcriptQuery",
    label: "Transcript.hasTranscript / querySupportedLanguages",
    minVersion: "26.3",
    usedBy: "Captions (optional Premiere speech-to-text path)",
    runtime: () => fn(p()["Transcript"], "hasTranscript"),
  },
  {
    id: "ameBatch",
    label: "EncoderManager.launchEncoder / startBatchEncode",
    minVersion: "26.3",
    usedBy: "Export (batch reels)",
  },
  {
    id: "transcribe",
    label: "Transcript.transcribeClipProjectItem",
    minVersion: "26.5",
    usedBy: "Captions (optional Premiere speech-to-text path)",
    runtime: () => fn(p()["Transcript"], "transcribeClipProjectItem"),
  },
  {
    id: "mediaDuration",
    label: "Media.getDuration / getStart (sync)",
    minVersion: "26.5",
    usedBy: "Sync & Build",
  },
  {
    id: "mogrtText",
    label: "MogrtText: edit MOGRT text from code",
    minVersion: "27.0",
    usedBy: "Motion Library (direct text editing; 26.x uses a fallback)",
    runtime: () => p()["MogrtText"] != null,
  },
  {
    id: "timecodeConvert",
    label: "TickTime.timeToTimecode / timecodeToTime",
    minVersion: "27.0",
    usedBy: "Display only (the panel has its own exact converter)",
    runtime: () => fn(p()["TickTime"], "timeToTimecode"),
  },
];

export function detectCapabilities(hostVersion: string): CapabilityResult[] {
  return CAPABILITIES.map((def) => {
    if (!atLeast(hostVersion, def.minVersion)) return { ...def, status: "requires_newer_premiere" };
    if (def.runtime) {
      let ok = false;
      try {
        ok = def.runtime();
      } catch {
        ok = false;
      }
      if (!ok) return { ...def, status: "missing_at_runtime" };
    }
    return { ...def, status: "available" };
  });
}

export function capability(results: CapabilityResult[], id: string): boolean {
  return results.find((r) => r.id === id)?.status === "available";
}
