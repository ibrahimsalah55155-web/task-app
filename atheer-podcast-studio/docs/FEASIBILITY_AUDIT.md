# ATHEER PODCAST STUDIO — Technical Feasibility Audit

Target: Adobe Premiere Pro 2026 (26.x), UXP plugin + local companion service.
Audit date: 2026-11-12.

**Sources.** Adobe's Premiere UXP reference and changelog, read from the
documentation source repository `AdobeDocs/uxp-premiere-pro` (commit `ffa53e0`,
2026-11-04), and the official samples `AdobeDocs/uxp-premiere-pro-samples`
(commit `e1c8b68`, 2026-11-11). Every API named below was checked there. The
"Since" values are Adobe's. The plugin is type-checked against Adobe's
`@adobe/premierepro@26.5.1` declarations and linted with
`@adobe/eslint-plugin-premierepro@26.5.0`.

**What has not been verified.** None of this has been run inside Premiere Pro
yet (the build machine has no Premiere). Section 4 lists what must be confirmed
in Premiere, in priority order.

---

## 0. Update 2026-11-12 (after the editor's requirements)

The editor works on **one Windows machine** with the **latest Premiere from Creative Cloud** and wants
**nothing to open beside Premiere**. Changes:

- **Engine inside the plugin.** Premiere 26.2+ supports UXP Hybrid plugins (native C++ addons). The plugin
  now ships a small addon (`native/engine_launcher`) that starts the engine from the plugin's own folder with
  `CREATE_NO_WINDOW`, inside a Windows job object with `KILL_ON_JOB_CLOSE` (it cannot outlive Premiere), and
  hands it a per-session token through its environment. No pairing, no console, no separate install.
  The engine runs on the official signed embeddable CPython (less antivirus trouble than a packed exe).
  Windows only, which is allowed for independent `.ccx` distribution.
- **Razor replacement ("cut engine").** Still no split API in 26.x/27.0. The cut engine plans every piece with
  exact tick math, creates one subclip per media range (`createSubClipAction`, 26.3), clones the sequence,
  clears the clone, overwrites each piece at its exact time on its original track, restores disabled states,
  then **reads the result back and verifies every piece**. The original sequence is never modified. This one
  mechanism serves Silence Cut (remove ranges) and Auto Director (split points + disable).
- **MOGRT text:** the user is on Premiere 27, so `MogrtText` (27.0) is usable for the Motion Library.

## 1. Verdict per feature

| # | Feature | Verdict | Main reason |
|---|---------|---------|-------------|
| 1 | Media inspection (timecode, fps, audio) | **Feasible, built** | Companion + FFprobe. Phase 1. |
| 1 | Audio/timecode sync with confidence + drift | **Feasible** | Pure companion DSP; no Premiere API needed. |
| 1 | Build synced multitrack sequence | **Feasible** | `createSequence*`, `SequenceEditor.createOverwriteItemAction`, track rename (26.3). |
| 1 | Premiere *multicam source sequence* | **Blocked** | No API. Not needed: cameras are stacked on V1–V3. |
| 2 | Silence detection | **Feasible** | Companion (VAD + energy + ASR timing). |
| 2 | Silence removal across all tracks | **Feasible with workaround** | **No razor/split API in 26.x.** Cuts are rebuilt from source ranges. |
| 2 | Click-free audio edges | **Feasible with workaround** | No audio transition API; Volume keyframes instead. To verify. |
| 3 | Speaker detection | **Feasible** | Isolated mics first; diarization fallback. |
| 3 | Non-destructive camera switching | **Feasible** | `VideoClipTrackItem.createSetDisabledAction` (25.6). Segments built as in #2. |
| 4 | Reel candidates with hooks + scores | **Feasible** | Companion ASR + ranking. Local LLM optional. |
| 4 | Reel sequences (9:16, 1:1, 4:5, 16:9) | **Feasible** | `createSequenceWithPresetPath` (26.3) / `SequenceSettings.setVideoFrameRect`. |
| 4 | Face-aware reframing | **Feasible** | Companion face tracking → Motion `ComponentParam` keyframes. |
| 4 | Batch export after approval | **Feasible** | `EncoderManager.exportSequence` (25.6), `startBatchEncode` (26.3). |
| 5 | Arabic transcription (dialects) | **Feasible, quality to measure** | faster-whisper large-v3 locally; Egyptian Arabic accuracy must be measured on real episodes. |
| 5 | Native editable caption track | **Uncertain** | No API creates caption items from text. Depends on importing an SRT and placing it (to test). Fallback: SRT import by hand. |
| 5 | Animated word captions | **Feasible as overlays** | Companion renders transparent video. Not native text, and labelled as such. |
| 6 | One-click MOGRT at playhead | **Feasible** | `SequenceEditor.insertMogrtFromPath` (25.6) + `getPlayerPosition`. |
| 6 | Set MOGRT text from the panel | **Blocked on 26.x** | `MogrtText` is 27.0. 26.x fallback: string keyframe on the text param (to test), Essential Graphics by hand, or rendered overlay. |
| 6 | Authoring the .mogrt files | **External tool** | .mogrt files are authored in After Effects or Premiere; the code cannot create them reliably. |
| 7 | Undo / safety | **Feasible** | `lockedAccess` + `executeTransaction` with undo labels; versioned sequences. |
| 7 | Respect locked tracks | **Partial** | No `isLocked` getter in 26.x (only a lock-changed event). Mitigation: write only into sequences the plugin created. |

---

## 2. Platform constraints (apply to everything)

1. **UXP is not Node.** No `child_process`. `shell.openPath/openExternal` open files or URLs with a
   consent dialog; they cannot start and manage a service.
   → Solved with a UXP Hybrid addon that launches the bundled engine hidden (section 0).
2. **Network permission.** Requests are allowed only to domains listed in
   `requiredPermissions.network.domains`. The manifest lists `http://127.0.0.1:47820`,
   `ws://127.0.0.1:47820` and the `localhost` equivalents. The port is therefore fixed.
3. **macOS and `http://`.** Adobe's network guide warns that macOS restricts `http://`.
   Loopback addresses are normally exempt from App Transport Security, but this
   **must be confirmed on a Mac** (QA P1-07). Fallback: serve TLS on loopback with a
   locally generated certificate.
4. **UXP WebSocket is client-only** and cannot set headers, so the companion takes the
   token as a query parameter on `/events`. Job progress also works by HTTP polling.
5. **CORS/Origin.** Adobe's troubleshooting table mentions CORS in UXP. The companion accepts
   requests with no Origin, `null` or a non-web scheme, and refuses `http(s)://` web origins,
   so a browser page cannot drive it. The panel's real Origin value is logged by the companion
   (Settings → Copy diagnostics shows it). If UXP sends a web-looking origin, start the companion with
   `--allow-origin <value>` (QA P1-06).
6. **CSS subset.** Only flexbox; no `grid`, no `gap`, no transitions/animations, no `position`.
   The panel UI is built within that list. No `<details>` element either.
7. **TextDecoder is missing** in UXP: secure-storage bytes are decoded by hand.
8. **Hybrid (C++) plugins** need Premiere 26.2+, the Hybrid SDK from the Adobe Developer Console,
   Release builds for Windows x64, macOS arm64 and x64, and Apple notarization. They are
   **optional**: nothing in the plan requires native code inside Premiere.
9. **Action rules (26.3+).** `create*Action` must run inside `project.lockedAccess()`; commit with
   `executeTransaction()`; no `await` inside either callback. Enforced by Adobe's ESLint
   rules (`npm run lint`, part of `npm run check`).
10. **Constants are runtime values.** `Constants.*` enums must be read from the module at runtime,
    never hard-coded.

---

## 3. Feature-by-feature audit

### 3.1 Phase 1 — Foundation (built)

| Item | Detail |
|---|---|
| APIs | `Project.getActiveProject`, `getActiveSequence`, `getSequences`, `Sequence.getSettings().getVideoFrameRate` (26.2) / `getTimebase` (25.6), `getFrameSize`, `getEndTime`, `getPlayerPosition`, `getVideo/AudioTrack(Count)`, `VideoTrack.getTrackItems(Constants.TrackItemType.CLIP, false)`, `ClipProjectItem.cast/getMediaFilePath/isOffline/isSequence`, `FolderItem.createBinAction`, `Markers.getMarkers/createAddMarkerAction`, `EventManager.addGlobalEventListener`, `uxp.host.version`, `uxp.storage.secureStorage` |
| Minimum | 25.6 for reads; 26.2 for exact sequence frame rate (falls back to `getTimebase`). Manifest `minVersion` 26.0.0; 26.3+ recommended. |
| External | Companion: Python 3.10+, FastAPI/uvicorn, FFprobe |
| Blockers | None known. `Application.version` is removed in 27.0, so version comes from `uxp.host.version`. |
| Tests | Unit tests with a fake `premierepro` that enforces the lock rules; real panel-client ↔ real companion integration test; UI flow driven in Chromium against the real companion; QA checklist P1 in Premiere. |

### 3.2 Module 1 — Sync & Build

| Item | Detail |
|---|---|
| APIs | `Project.importFiles(paths, suppressUI, targetBin)`, `createSequence` / `createSequenceWithPresetPath` (26.3) / `createSequenceFromMedia`, `SequenceEditor.createOverwriteItemAction(projectItem, time, vIdx, aIdx)` (track index ≥ count creates a track), `VideoTrack/AudioTrack.createSetNameAction` (26.3), `SequenceSettings.setVideoFrameRect/setVideoFrameRate` (26.2), `ClipProjectItem.createSetInOutPointsAction` |
| Method | Companion: FFprobe metadata → timecode candidate offsets → audio decode to 16 kHz mono by FFmpeg → coarse cross-correlation on envelopes (whole file, low rate) → fine correlation in windows around the coarse lag → **drift**: lag measured in several windows along the file, linear fit gives ppm drift; confidence from correlation peak ratio. Different sample rates are resampled by FFmpeg. Timecode is used when it agrees with audio within one frame; disagreement is reported, not hidden. |
| Premiere side | New sequence, cameras overwritten at exact tick offsets onto V1 Wide / V2 Host / V3 Guest, external mics on A1/A2, camera audio placed on extra tracks and muted, not deleted. All in one undoable transaction, then tracks renamed (26.3). |
| Blockers | No multicam-source-sequence API (not needed). Track lock state cannot be read. Unknown: whether `createOverwriteItemAction` places a clip's linked audio on the requested audio track exactly as the UI does (QA P2-03). |
| Fallback | If placement of linked A/V is unreliable: insert video-only and audio-only subclips (`createSubClipAction` with `takeVideo/takeAudio`, 26.3). If drift exceeds 1 frame over the recording, Premiere has no clip-level time-stretch API that is safe here; the plugin reports it and recommends conforming the audio in the companion (FFmpeg `atempo`/resample) to a new file, which is then used non-destructively. |
| Tests | Test 1 in the brief, plus mixed frame rates, 44.1/48 kHz, missing audio, duplicate file names (detected in Phase 1 already). |

### 3.3 Module 2 — Smart Silence Cut

| Item | Detail |
|---|---|
| APIs | `Sequence.createCloneAction` (versioning), `SequenceEditor.createOverwriteItemAction` / `createCloneTrackItemAction`, `VideoClipTrackItem/AudioClipTrackItem.createSetInPointAction / createSetOutPointAction / createSetStartAction / createSetEndAction`, `SequenceEditor.createRemoveItemsAction(selection, ripple, mediaType, shiftOverlapping)` |
| Critical finding | **There is no razor / split / "add edit" action in the 26.x API** (searched the full reference; the only "razor" mention is a snap event). |
| Method | Build `PODCAST_01_SILENCE_CUT` as a new sequence from one edit decision list (EDL): for every kept range and every source track, place the source clip and trim it with set-in/out/start/end actions, frame-aligned with the panel's exact tick math (`src/core/time.ts`). The original synced sequence is never edited. |
| Detection | Silero VAD per mic + RMS energy + Whisper word timings. Defaults: protect 120 ms before speech onset and 180 ms after offset; keep a minimum pause; keep laughter/breaths optionally (energy + VAD disagreement → "non-speech sound", not silence). |
| Fades | No audio transition factory (only `TransitionFactory.createVideoTransition`). Use 2–4 frame Volume keyframes via `AudioClipTrackItem.getComponentChain()` → `ComponentParam.createAddKeyframeAction` (to test, QA P3-02). |
| Fallback | If per-clip trimming proves unreliable at scale: (a) subclips per kept range (26.3) inserted in order; (b) FCP7 XML generated by the companion and imported (`importFiles` on an .xml) — **untested in UXP**. |
| Tests | Test 2 + a 2-hour recording (performance of thousands of actions in one transaction must be measured; batch per 200 actions if needed). |

### 3.4 Module 3 — AI Auto Director

| Item | Detail |
|---|---|
| APIs | Same segment building as Module 2, plus `VideoClipTrackItem.createSetDisabledAction(true/false)` (25.6) |
| Method | Per-mic VAD + energy ratio → speaker activity; diarization only when mic bleed is high or there is one mic. Decision: hysteresis, minimum shot length, cut points snapped to word gaps from the transcript, "both speaking" → configurable (default Wide), silence → hold. Output: shot list. Premiere: every camera track is segmented at the same boundaries; in each interval exactly one video segment is enabled. Audio is never disabled. |
| Compositing | With V3 Guest above V2 Host above V1 Wide, disabling the clips that are off air leaves exactly one visible. Verified by exporting frames with `Exporter.exportSequenceFrame` at shot midpoints (automated check, QA P4-02). |
| Diarization licence note | pyannote models require a Hugging Face account token to download, which conflicts with "no key". Prefer isolated mics; evaluate a key-free embedding model (e.g. SpeechBrain ECAPA, Apache-2.0) only if needed. |
| Tests | Test 3 + manual override + "re-analyse selected range" keeps locked choices. |

### 3.5 Module 4 — AI Viral Clip Finder

| Item | Detail |
|---|---|
| APIs | Read the approved sequence's track items (same as Phase 1 reader) to map sequence time → source time; `createSequenceWithPresetPath` (26.3) or `createSequence` + `createSetSettingsAction` with `setVideoFrameRect` for 1080×1920 / 1080×1080 / 1080×1350; segment placement as in Module 2; `getComponentChain()` → Motion `Position/Scale` keyframes (`ComponentParam.createKeyframe`, `PointF`); `EncoderManager.exportSequence` |
| Method | Transcript of the *cut* (source ranges re-used from the cache, so no re-transcription), sentence segmentation, candidate windows matching the duration range, scoring (hook strength, self-containedness, context integrity) by heuristics and, optionally, a local LLM through an OpenAI-compatible local server (Ollama / llama.cpp; Qwen-family models handle Arabic). Hooks are always verbatim spans of the transcript. |
| Reframing | OpenCV YuNet face detector (MIT/Apache) at 2–5 fps, active speaker from Module 3, smoothed path, applied as few keyframes as possible; split-screen layouts by placing two camera tracks with Crop + Motion. |
| Blockers | Crop effect match name must be discovered at runtime via `VideoFilterFactory.getMatchNames()`; never hard-code. |
| Tests | Test 4. |

### 3.6 Module 5 — Smart Captions

| Item | Detail |
|---|---|
| APIs | `Project.importFiles` (.srt), `SequenceEditor.createInsertProjectItemAction` (to place the caption item), `Sequence.getCaptionTrack(Count)`; optional Premiere path: `Transcript.transcribeClipProjectItem` (26.5), `querySupportedLanguages` (26.3), `createImportTextSegmentsAction` |
| Method | faster-whisper (MIT) large-v3 with word timestamps, CPU int8 fallback; Arabic punctuation and RTL handled in the panel and the SRT writer (RLM marks where needed); line length limits per style; low-confidence words flagged. |
| Blockers | The API cannot create caption track items from text. Importing a transcript (`createImportTextSegmentsAction`) attaches it to a clip, which is not the same as captions on the timeline. |
| Fallback | (1) SRT import + insert (to test, QA P6-01); (2) if that fails, the panel writes the SRT and the editor imports it once with *File › Import*; (3) animated styles are rendered by the companion as ProRes 4444 / QuickTime Animation with alpha, imported into the Captions bin and placed on a free track. The panel keeps the source text and timing and can re-render. Rendered captions are described as graphics. |
| Tests | Test 5 with real Egyptian Arabic, measuring word error rate on a hand-corrected 10-minute sample. |

### 3.7 Module 6 — ATHEER Motion Library

| Item | Detail |
|---|---|
| APIs | `SequenceEditor.insertMogrtFromPath(path, time, vIdx, aIdx)` (25.6), `getInstalledMogrtPath`, `Sequence.getPlayerPosition`, track items' start/end for collision checks, `ComponentParam` on the inserted item |
| Collision rule | Choose the lowest video track above the camera tracks whose items do not overlap [playhead, playhead + duration]; if none, insert at `videoTrackCount` (creates a new track). Never overwrite. |
| Text on 26.x | `MogrtText` is **27.0**. On 26.x the text parameter might accept a string keyframe through `ComponentParam.createKeyframe(string)` (the reference lists string as a valid type); this is the first thing to test (QA P7-02). If it fails: the editor types the text in Essential Graphics, or the template is rendered by the companion. The panel will state which fields are editable where. |
| Authoring | .mogrt files need After Effects (or Premiere's Essential Graphics) to author. Plan: build the templates from the reference specs in After Effects. An AE ExtendScript can build the comps and call `CompItem.exportAsMotionGraphicsTemplate` to make it repeatable. Animation details come from the reference videos you send. |
| Brand | No Atheer logos or assets unless you provide them with permission. |
| Tests | Test 6 + insertion when the playhead sits over existing graphics. |

### 3.8 Module 7 — Export

`EncoderManager.exportSequence(sequence, ExportType.QUEUE_TO_AME, output, preset)`; `launchEncoder` / `startBatchEncode` (26.3); render events for progress. Nothing is queued without an explicit approval click.

### 3.9 Safety, undo and recovery

- Every edit is one named Undo step. The plugin never edits a sequence it did not create, except to add markers or graphics where the user asks.
- Versioned sequences: `createCloneAction` before regenerating; old versions kept in `03 Sequences`.
- Edit maps (source ↔ sequence time) and analysis are stored by the companion (SQLite keyed by path + size + mtime + analyser version), so a restart or a changed file never reuses stale data.
- Long jobs are cancellable. A companion restart loses in-memory job state; cached partial results remain and the panel reports "Unknown job (companion restarted?)".

---

## 4. Must be verified inside Premiere (priority order)

| ID | Question | Blocks |
|----|----------|--------|
| P1-06 | Which `Origin` does the UXP panel send to localhost? (Companion logs it.) | Everything |
| P1-07 | Does `http://127.0.0.1` work from UXP on macOS without TLS? | Everything on Mac |
| P2-03 | Does `createOverwriteItemAction` put linked audio on the requested audio track? | Sync & Build |
| P3-01 | Trim actions on a placed clip produce exact frame-aligned segments; cost of 1,000+ actions in one transaction | Silence, Director, Reels |
| P3-02 | Volume keyframes via `ComponentParam` on audio clips | Click-free cuts |
| P4-02 | Disabled clips on upper tracks reveal the enabled clip below in playback and export | Auto Director |
| P6-01 | Imported .srt can be placed on a sequence by API and becomes a caption track | Native captions |
| P7-02 | `ComponentParam.createKeyframe(string)` changes MOGRT text on 26.x | Motion Library text |

## 5. Third-party components (to be confirmed before each phase)

| Component | Licence | Offline | GPU | Notes |
|---|---|---|---|---|
| FFmpeg / FFprobe | LGPL/GPL (build-dependent) | yes | optional | Not bundled; user installs (winget/Homebrew). |
| FastAPI, uvicorn, websockets | MIT/BSD | yes | – | Phase 1. |
| faster-whisper (CTranslate2) | MIT | yes after model download | CUDA on Windows; CPU int8 on Mac | Model weights (Whisper, MIT) ~3 GB for large-v3. |
| Silero VAD | MIT | yes | no | |
| OpenCV (YuNet) | Apache-2.0 | yes | no | |
| pyannote | MIT code, gated models | needs HF token | yes | Avoid unless needed. |
| Local LLM (Ollama/llama.cpp) | varies by model | yes | recommended | Optional for reel ranking. |
