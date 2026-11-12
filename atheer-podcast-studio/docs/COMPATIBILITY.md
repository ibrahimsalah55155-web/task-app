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
| Premiere multicam source sequence | Blocked by Adobe API | Stacked tracks instead |
| Native caption track from text | Blocked by Adobe API | SRT export + styled stills on a video track |

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
