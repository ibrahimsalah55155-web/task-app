# ATHEER PODCAST STUDIO

Podcast post-production for Adobe Premiere Pro 2026: sync, silence cut, auto
camera switching, reels, Arabic captions and motion templates, as a dockable
UXP panel backed by a local processing service.

**Status: Phase 1 (foundation) built.** See `docs/COMPATIBILITY.md` for exactly
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
├── companion/     local service (Python, FastAPI) on 127.0.0.1:47820
│   ├── atheer_companion/  API, pairing auth, jobs, FFprobe inspection, SQLite cache
│   └── tests/     pytest against real generated media
├── installer/     Windows / macOS companion installers
└── docs/          feasibility audit, compatibility report, install guide, QA checklist
```

## Why two programs

Premiere's UXP runtime cannot launch processes, decode audio or run ML models.
The companion does that work locally and talks only to `127.0.0.1`. The
panel does every Premiere change itself, through undoable transactions.

## Quick start

See `docs/INSTALL.md`. In short:

```bash
bash installer/install-companion-macos.sh        # or the .ps1 on Windows
cd plugin && npm ci && npm run check             # builds plugin/dist
# UXP Developer Tool → Add Plugin → plugin/dist/manifest.json → Load
```

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
