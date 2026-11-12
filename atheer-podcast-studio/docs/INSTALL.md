# Installing ATHEER Podcast Studio (Premiere Pro 2026)

Two parts are installed:

1. **The panel**: a UXP plugin inside Premiere.
2. **The companion**: a small local program that does the media and AI work.
   It runs only on your machine (address `127.0.0.1:47820`) and never needs an API key.

## Requirements

- Adobe Premiere Pro 2026, version **26.3 or newer** recommended (26.0+ loads).
- Python **3.10+** (Windows: python.org installer with "Add python.exe to PATH").
- FFmpeg (includes FFprobe).
  - Windows: `winget install --id Gyan.FFmpeg -e`
  - macOS: `brew install ffmpeg`
- For development only: Node.js 20+ and the **UXP Developer Tool** (UDT) 2.2+ from Creative Cloud.

## 1. Install the companion

Windows (PowerShell):

```powershell
powershell -ExecutionPolicy Bypass -File installer\install-companion-windows.ps1
```

macOS (Terminal):

```bash
bash installer/install-companion-macos.sh
```

Add `-WithAI` (Windows) or `--with-ai` (macOS) to also install the speech/VAD
packages used from Phase 2. They are large; Phase 1 does not need them.

The installer creates **Start ATHEER Companion** (a Desktop shortcut on Windows;
a `.command` file in `~/Library/Application Support/AtheerPodcastStudio` on macOS).

## 2. Build and load the panel (development build)

```bash
cd plugin
npm ci
npm run check      # typecheck + Adobe lint rules + tests + build
```

Then in the UXP Developer Tool:

1. Start Premiere Pro.
2. UDT → **Add Plugin** → choose `plugin/dist/manifest.json`.
3. Click **Load**. In Premiere open **Window › UXP Plugins › ATHEER Podcast Studio**
   (if it does not appear, untick and re-tick it in that menu).
4. Dock the panel wherever you like.

To make an installable package: UDT → **Package** → produces a `.ccx` file.
Double-click the `.ccx` on the editing machine to install it through Creative Cloud.

## 3. First run

1. Double-click **Start ATHEER Companion**. A window shows a 6-character pairing code.
   Keep this window open while you edit.
2. In the panel's **Dashboard › Companion** card, type the code and press **Pair**.
   This is needed once; the panel remembers it.
3. Open a sequence and press **Inspect sequence media**.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Companion card says "offline" | Start the companion; check nothing else uses port 47820. |
| "Port 47820 is already in use" | A companion is already running, or another app uses the port. The port is fixed by the plugin manifest. |
| "origin_rejected" | Restart the companion with the `--allow-origin` value the panel shows, then send us that value (QA P1-06). |
| Pairing says "Too many wrong codes" | Wait 60 s; a new code is shown in the companion window. |
| "Not paired" after reinstalling Premiere | Pair again (secure storage was cleared). |
| FFprobe "NOT FOUND" | Install FFmpeg, or start the companion with `--ffprobe <path> --ffmpeg <path>`. |
| Forget all paired panels | `Start ATHEER Companion --revoke-all` |

Logs: the companion writes `companion.log` under its data folder
(`%LOCALAPPDATA%\AtheerPodcastStudio\companion\logs` on Windows,
`~/Library/Application Support/AtheerPodcastStudio/companion/logs` on macOS).
The panel's **Settings › Copy diagnostics** copies versions, API availability and recent log lines.
