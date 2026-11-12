/**
 * The eight workflow stages. Stages that are not built yet say so plainly and
 * carry no action buttons: nothing in the panel pretends to work.
 */

export interface StageDef {
  id: string;
  step: number;
  title: string;
  short: string;
  phase: number;
  goal: string;
  approach: string[];
  limits: string[];
  companionNeeds: string[];
}

export const STAGES: StageDef[] = [
  {
    id: "sync",
    step: 1,
    title: "Sync & Build",
    short: "Sync",
    phase: 2,
    goal: "Inspect every camera and recorder file, sync them on one timebase and build an editable multicam sequence (V1 Wide, V2 Host, V3 Guest; A1 Guest mic, A2 Host mic).",
    approach: [
      "Companion reads timecode, frame rate and audio with FFprobe (working now: Dashboard > Inspect sequence media).",
      "Sync by embedded timecode when it agrees with audio; otherwise coarse-to-fine audio cross-correlation with drift estimation and a confidence score.",
      "Sequence built with SequenceEditor overwrite actions at exact tick offsets, tracks renamed (26.3+), all in undoable transactions.",
    ],
    limits: [
      "There is no API to create a Premiere multicam source sequence; cameras are stacked on separate tracks instead (which is what Auto Director needs).",
      "Track lock state cannot be read in 26.x, so the plugin only writes into sequences it creates.",
    ],
    companionNeeds: ["ffprobe", "ffmpeg", "numpy"],
  },
  {
    id: "silence",
    step: 2,
    title: "Smart Silence Cut",
    short: "Silence",
    phase: 3,
    goal: "Find real pauses across all microphones, let the editor review them, then remove the same interval from every camera and audio track in a new PODCAST_01_SILENCE_CUT sequence.",
    approach: [
      "Silero VAD + per-mic energy + transcript word timing, with protected padding around speech onsets.",
      "One edit decision list drives every track, frame-aligned with exact tick math.",
    ],
    limits: [
      "Premiere 26.x has no razor/split API. Cuts are rebuilt from source ranges (overwrite + trim actions); this path must pass the Test 2 checklist in Premiere before release.",
      "Audio crossfades: no audio transition API; short fades will use Volume keyframes (to be verified).",
    ],
    companionNeeds: ["ffmpeg", "numpy", "silero_vad"],
  },
  {
    id: "director",
    step: 3,
    title: "AI Auto Director",
    short: "Director",
    phase: 4,
    goal: "Pick the camera of whoever is speaking, with minimum shot length and hysteresis, by cutting all three camera tracks at the same boundaries and disabling the clips that are not on air.",
    approach: [
      "Speaker activity from the isolated mics first; diarization only when mics bleed or are missing.",
      "VideoClipTrackItem.createSetDisabledAction (25.6) toggles each segment, so every camera stays on the timeline.",
    ],
    limits: ["Same razor limitation as Silence Cut: segments are rebuilt, not split in place."],
    companionNeeds: ["ffmpeg", "numpy", "silero_vad"],
  },
  {
    id: "reels",
    step: 4,
    title: "AI Viral Clip Finder",
    short: "Reels",
    phase: 5,
    goal: "Read the approved cut's transcript, propose reel candidates with authentic hooks and context scores, and build REEL_xx_EDIT sequences (9:16, 1:1, 4:5, 16:9).",
    approach: [
      "Transcript from local Whisper; ranking by heuristics plus an optional local LLM (no cloud key).",
      "New sequences via createSequenceWithPresetPath (26.3) + frame size settings; reframing with Motion keyframes.",
    ],
    limits: ["Scores are editorial heuristics, not predictions of views."],
    companionNeeds: ["ffmpeg", "faster_whisper", "cv2"],
  },
  {
    id: "captions",
    step: 5,
    title: "Smart Captions",
    short: "Captions",
    phase: 6,
    goal: "Arabic-first captions (Egyptian and other dialects) with word timing, editable in the panel, delivered as SRT and as styled overlays.",
    approach: [
      "faster-whisper large-v3 locally; low-confidence words highlighted for review.",
      "SRT import into the project, tested in Premiere; animated styles rendered by the companion as transparent overlays whose text stays editable in the panel.",
    ],
    limits: [
      "No 26.x API creates caption track items from text. Native captions depend on the SRT import path passing tests; otherwise SRT is imported manually.",
      "Rendered overlays are graphics, not native text layers, and the panel will say so.",
    ],
    companionNeeds: ["ffmpeg", "faster_whisper"],
  },
  {
    id: "motion",
    step: 6,
    title: "ATHEER Motion Library",
    short: "Motion",
    phase: 7,
    goal: "One-click lower thirds, image inserts, split screens and titles at the playhead, on a free track, without overwriting anything.",
    approach: [
      "SequenceEditor.insertMogrtFromPath (25.6) with collision-aware track choice.",
      "Animation specs come from the reference videos you send: timing, easing, typography, layout.",
    ],
    limits: [
      "MogrtText (programmatic text editing) arrives in Premiere 27.0. On 26.x the text is edited in Essential Graphics or the template is rendered by the companion.",
    ],
    companionNeeds: ["ffmpeg"],
  },
  {
    id: "export",
    step: 7,
    title: "Review & Export",
    short: "Export",
    phase: 8,
    goal: "Review approved outputs and queue them to Media Encoder with your presets. Nothing is exported or published without approval.",
    approach: ["EncoderManager.exportSequence (25.6); launchEncoder / startBatchEncode (26.3)."],
    limits: [],
    companionNeeds: [],
  },
];
