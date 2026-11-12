# Multimedia & AI Group — Podcast Studio
# مجموعة الملتيميديا والذكاء الاصطناعي

Podcast post-production for Adobe Premiere Pro 2026 on Windows: sync, silence cut,
auto camera switching, reels, Arabic captions and motion templates. One `.ccx`
installs the panel together with its processing engine; the engine starts hidden
when the panel opens and stops with Premiere. Arabic / English interface.

**Status: 0.3.0. All stages are built: Sync & Build, Silence Cut, Auto Director, Reels, Captions, Motion Library, Export.** See `docs/COMPATIBILITY.md` for exactly
what works, what is tested where, and what is blocked by Premiere's API.

```
atheer-podcast-studio/
├── plugin/        UXP panel (TypeScript, esbuild). Loads in Premiere 26.0+.
│   ├── static/    manifest.json, index.html, styles.css, icons
│   ├── src/core   exact tick/frame/timecode math, versions, logging, prefs
│   ├── src/ppro   Premiere access: capabilities, project reader, undoable edits
│   ├── src/companion  HTTP client + pairing token storage
│   ├── src/ui     panel views
│   └── test/      unit tests (fake premierepro) + real companion integration test
├── native/        engine launcher (UXP Hybrid C++ addon, Windows) + its Windows test harness
├── companion/     the processing engine (Python, FastAPI) on 127.0.0.1:47820-47823
│   ├── atheer_companion/  API, pairing auth, jobs, FFprobe inspection, SQLite cache
│   └── tests/     pytest against real generated media
├── installer/     build-windows-package.ps1 (makes the .ccx) + dev-only engine installers
└── docs/          feasibility audit, compatibility report, install guide, QA checklist
```

## How the engine lives inside the plugin

Premiere's UXP JavaScript cannot launch processes, decode audio or run ML models.
A small native addon (UXP Hybrid, Premiere 26.2+) starts the bundled engine from the
plugin folder with no window, inside a Windows job object so it can never outlive
Premiere, and gives it a per-session token. The panel does every Premiere change itself,
through undoable transactions.

## Quick start

Editors: download the `.ccx` from the latest GitHub Actions run and double-click it
(`docs/INSTALL.md`). Developers: `pwsh installer/build-windows-package.ps1` builds the same file.

## Development checks

```bash
cd plugin && npm run check        # tsc (src + tests), Adobe ESLint rules, tests, build
cd companion && python -m pytest  # needs ffmpeg on PATH
```

The plugin is type-checked against Adobe's `@adobe/premierepro@26.5.1`
declarations. `@adobe/eslint-plugin-premierepro` enforces the 26.3 rules:
actions are created inside `lockedAccess`, committed with
`executeTransaction`, and nothing asynchronous runs inside them.

## Documents

- `docs/FEASIBILITY_AUDIT.md`: every feature against the real 26.x API, with blockers and fallbacks
- `docs/COMPATIBILITY.md`: implemented / tested / blocked matrix
- `docs/INSTALL.md`: installation and troubleshooting
- `docs/QA_CHECKLIST.md`: what to verify in Premiere
