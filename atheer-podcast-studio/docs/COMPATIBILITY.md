# Compatibility report

Status of every requested capability. Nothing moves to "Tested in Premiere"
until it passes its item in `QA_CHECKLIST.md` on a real Premiere Pro install.

Legend
- **Tested in Premiere**: passed its QA item in Premiere Pro.
- **Built, tested outside Premiere**: code exists and passes automated tests
  (engine against real media; panel against a fake `premierepro` module that
  enforces Adobe's lock rules; UI in Chromium; Windows pieces on a GitHub
  Windows runner). Not yet run in Premiere.
- **Planned / Blocked by Adobe API**: see the audit.

Target: **Windows x64, Premiere Pro 2026 (latest from Creative Cloud), single machine.**

## Release 0.2.0

| Capability | Status | Evidence |
|---|---|---|
| Plugin name: "مجموعة الملتيميديا والذكاء الاصطناعي" / "Multimedia & AI Group" | Built | manifest label (default + `ar`), panel header |
| Arabic / English switch, right-to-left layout | Built, tested outside Premiere | `test/i18n.test.ts`; screenshots. UXP has no CSS `direction`: rows are mirrored in CSS and Arabic text carries Unicode RTL embedding (to confirm in Premiere, QA P1-16) |
| Camera names: Guest / Host / Wide Camera (كاميرا الضيف / المذيع / الوايد) | Built | i18n strings, stage texts |
| **Engine inside the plugin** (no window, no pairing, stops with Premiere) | Built, tested outside Premiere | Addon compiled with MSVC on Windows CI; harness loads it, starts the engine, checks health, stops it, and checks the job object kills it when the host dies |
| Single `.ccx` with panel + engine + Python + FFmpeg | Built on CI | `installer/build-windows-package.ps1`, workflow artifact |
| **Cut engine** (replacement for the missing razor API) | Built, tested outside Premiere | `test/cutplan.test.ts`, `test/cutengine.test.ts`; in-panel test with self-verification |
| Media inspection (TC, fps, VFR, audio, missing drive) | Built, tested outside Premiere | engine pytest + panel integration test |
| Project reader, bins, marker (undoable) | Built, tested outside Premiere | `test/ppro.test.ts` |

## Production stages (0.3.0)

All stages are built and tested outside Premiere (engine on real audio/media; panel on the fake
Premiere that enforces Adobe's lock rules; end-to-end in the demo harness with the real engine).

| Stage | Status | How |
|---|---|---|
| 1 Sync & Build | Built, tested outside Premiere | Envelope + sample-accurate correlation, drift ppm, timecode cross-check; sequence from the first camera's settings, V1 Wide / V2 Host / V3 Guest, A1 Guest Mic / A2 Host Mic, camera audio kept but muted |
| 2 Smart Silence Cut | Built, tested outside Premiere | Silero VAD per mic, presets, padding, retained pause, laughter/breath protection, review list, markers, cut engine |
| 3 AI Auto Director | Built, tested outside Premiere | Per-mic activity with bleed handling, min shot, both→wide, hold on silence, cutaways; cut engine splits all cameras at the same frames and disables off-air pieces |
| 4 AI Reels | Built, tested outside Premiere | Verbatim hooks + context/relevance scores; reel sequences via the cut engine; 9:16/1:1/4:5 frame + Motion reframing on the face (**Motion coordinate system to verify, QA P5-02**) |
| 5 Captions | Built, tested outside Premiere; real Arabic ASR tested in CI | faster-whisper locally (model downloaded once), Arabic segmentation, editor, SRT, 4 styles as transparent stills placed at exact times |
| 6 Motion Library | Built, tested outside Premiere | 6 templates rendered by the engine (ProRes 4444) |
| 7 Export | Built, not run | EncoderManager queue/immediate with your .epr preset, only for selected sequences |
| Premiere multicam source sequence | Workaround (0.4.0) | Nested sequence + Multi-Camera enable (see below) |
| Native caption track from text | Workaround (0.4.0) | SRT → caption track (verified) or one drag from the bin |

## Finishing tools (0.4.0)

| Capability | Status | How / evidence |
|---|---|---|
| Voice clean-up (noise, hum, harsh S, level, loudness) | Built, tested outside Premiere (Linux + Windows CI) | RNNoise voice model + notch + de-esser + EQ + compressor + exact-gain loudness with look-ahead limiter. Output is checked to be sample-aligned with the original (GCC-PHAT, < 1 ms) before the panel swaps media (`changeMediaFilePath`); original files untouched; one-click back |
| Camera colour match | Built, tested outside Premiere | Lumetri on each camera's master clip, closed loop: Premiere renders test frames (`Exporter.exportSequenceFrame`), engine measures, panel corrects (secant solver, tested against simulated unknown slider scales). LUTs saved too. **Slider names are matched in English** (QA F-04) |
| Premiere Multi-Camera | Built (workaround), tested outside Premiere | No API creates a multicam source sequence; the panel nests the synced sequence, then one right-click enables Multi-Camera |
| Cut in the same sequence | Built, tested outside Premiere | Cut engine rebuilds the open sequence after keeping a full backup copy |
| Speaker separation from one mic | Built; real model test passes in CI | sherpa-onnx + pyannote segmentation-3.0 + 3D-Speaker embedding, bundled. CI: host/guest/host turns labelled correctly |
| Caption translation Arabic ↔ English | Built; real model test passes in CI (Linux + Windows) | OPUS-MT via CTranslate2 int8, bundled; sentence-level, caption times kept |
| Better Arabic/Egyptian recognition | Built | Glossary (Whisper prompt + hotwords) and persistent correction rules |
| Real Premiere caption track | Built with fallback; to verify (QA F-11) | SRT imported and inserted on a new track index; if Premiere does not make a caption track, the stray item is removed and the SRT stays in the bin for one drag |
| MOGRT templates with editable text | Built; to verify (QA F-12) | `insertMogrtFromPath` + string parameters (JSON `textEditValue` kept), read back after setting |
| macOS package | Not built | The editor works on one Windows machine; available on request |

## Premiere versions

| Premiere | Panel | Notes |
|---|---|---|
| 26.0 – 26.1 | Loads (dev build only) | Hybrid addon needs 26.2+ |
| 26.2 | Loads | Cut engine needs 26.3 (subclips) |
| 26.3 – 26.5 | Full | |
| **27.x (current)** | **Full, recommended** | + `MogrtText` for template text |

## Operating systems

| OS | Status |
|---|---|
| Windows 10/11 x64 | Target. Built and tested on GitHub's Windows runner (engine + addon outside Premiere) |
| macOS | Not packaged (not needed for this user). Dev build works with a hand-started engine |
