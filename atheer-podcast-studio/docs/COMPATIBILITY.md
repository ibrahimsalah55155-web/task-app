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

## Later phases

| Capability | Status | Notes |
|---|---|---|
| Waveform/timecode sync, drift, confidence | Planned (Phase 2) | |
| Synced multitrack sequence build | Planned (Phase 2) | APIs exist |
| Premiere multicam source sequence | Blocked by Adobe API | Stacked tracks instead |
| Silence removal across tracks | Planned (Phase 3) | Uses the cut engine |
| Auto Director | Planned (Phase 4) | Cut engine `splitAt` + `createSetDisabledAction` |
| Reels | Planned (Phase 5) | |
| Arabic captions | Planned (Phase 6) | Local Whisper; SRT path to test |
| MOGRT insert at playhead + text editing | Planned (Phase 7) | `MogrtText` available on Premiere 27 (user has latest) |
| Batch export via AME | Planned (Phase 8) | |

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
