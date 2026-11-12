# Compatibility report

Status of every requested capability. Updated each phase. Nothing moves to
"Tested in Premiere" until it passes its QA checklist item on a real
Premiere Pro 2026 install.

Legend
- **Tested in Premiere**: passed its QA item in Premiere Pro.
- **Built, tested outside Premiere**: code exists and passes automated tests
  (companion against real media; panel against a fake `premierepro` module
  that enforces Adobe's lock rules; UI in Chromium). Not yet run in Premiere.
- **Planned**: designed in the audit, not built.
- **Blocked by Adobe API**: no supported 26.x API; fallback described.
- **Needs companion / native**: work that UXP cannot do itself.

## Phase 1 — Foundation (this release, 0.1.0)

| Capability | Status | Evidence |
|---|---|---|
| Dockable UXP panel (manifest v5, `premierepro` ≥ 26.0) | Built, tested outside Premiere | Bundle builds; UI driven in Chromium with a fake host |
| Premiere version + API availability table | Built, tested outside Premiere | `test/ppro.test.ts` |
| Read active project, sequences, tracks (real API indices), frame rate, playhead, media paths | Built, tested outside Premiere | `test/ppro.test.ts` |
| Create ATHEER bin structure (idempotent, undoable) | Built, tested outside Premiere | `test/ppro.test.ts` |
| Add marker at playhead (undoable, proves timeline writes) | Built, tested outside Premiere | `test/ppro.test.ts` |
| Companion service: health, pairing, tokens, jobs, cancel, WebSocket events, logs | Built, tested outside Premiere | 25 pytest tests + live process |
| Media inspection with FFprobe (TC, fps rational, VFR, audio, missing drive, unreadable file, duplicate names, mixed rates) | Built, tested outside Premiere | `companion/tests/test_api.py`; panel→companion integration test |
| Analysis cache (path + size + mtime + version) | Built, tested outside Premiere | `test_cache_invalidated_when_file_changes` |
| Exact frame/tick math incl. drop-frame | Built, tested outside Premiere | `test/time.test.ts` |
| Installer (macOS/Linux) | Built, tested on Linux | Installed into a clean venv, tests re-run there |
| Installer (Windows) | Built, **not run** | Needs a Windows machine |

## Later phases

| Capability | Status | Notes |
|---|---|---|
| Waveform/timecode sync, drift, confidence | Planned (Phase 2) | Needs companion (numpy) |
| Synced multitrack sequence build | Planned (Phase 2) | APIs exist (25.6 / 26.3) |
| Premiere multicam source sequence | Blocked by Adobe API | Stacked tracks instead |
| Silence detection | Planned (Phase 3) | Needs companion (Silero VAD) |
| Silence removal across tracks | Planned (Phase 3) | **No razor API**: segments rebuilt with overwrite + trim actions |
| Audio fades at cuts | Planned (Phase 3) | No audio transitions API; Volume keyframes to verify |
| Speaker detection / diarization | Planned (Phase 4) | Needs companion |
| Enable/disable camera segments | Planned (Phase 4) | `createSetDisabledAction` (25.6) |
| Reel finding and scoring | Planned (Phase 5) | Needs companion (faster-whisper; optional local LLM) |
| Reel sequences + reframing | Planned (Phase 5) | 26.3 preset sequences; Motion keyframes |
| Arabic ASR + SRT | Planned (Phase 6) | Needs companion |
| Native caption track from text | Blocked by Adobe API | SRT import path to test; manual import fallback |
| Animated captions | Planned (Phase 6) | Rendered overlays (needs companion) |
| One-click MOGRT insert at playhead | Planned (Phase 7) | `insertMogrtFromPath` (25.6) |
| Edit MOGRT text from the panel | Blocked on 26.x | `MogrtText` is 27.0; string keyframe to test |
| Batch export via AME | Planned (Phase 8) | 25.6 / 26.3 |
| Native C++ addon | Not needed so far | Hybrid plugins 26.2+, optional |

## Premiere versions

| Premiere | Panel loads | Notes |
|---|---|---|
| < 26.0 | No (manifest minVersion) | |
| 26.0 – 26.1 | Yes | Frame rate read via `getTimebase`; several later modules unavailable |
| 26.2 | Yes | Hybrid addons, `getVideoFrameRate` |
| **26.3 – 26.5** | **Yes (recommended)** | Track rename, preset sequences, subclips, AME batch |
| 27.x | Expected | `MogrtText` becomes available; `Application` class removed (not used) |

## Operating systems

| OS | Panel | Companion | Notes |
|---|---|---|---|
| Windows 10/11 x64 | Expected | Expected (installer not yet run) | CUDA GPU optional for Whisper |
| macOS arm64 / x64 | Expected | Expected | Verify loopback `http://` (QA P1-07); Whisper runs on CPU |
