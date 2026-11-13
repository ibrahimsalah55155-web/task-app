# Installing — Multimedia & AI Group (Premiere Pro, Windows)

One file, installed once. Nothing to open next to Premiere afterwards.

## What you install

`MultimediaAIGroup-<version>.ccx` contains:

- the panel;
- the processing engine (official signed Python + the engine code);
- FFmpeg / FFprobe;
- offline models for speaker separation and Arabic ↔ English translation;
- a small native launcher (UXP Hybrid addon) that starts the engine **hidden**
  when the panel opens and stops it when Premiere closes.

No pairing code, no console window. Everything runs on this computer. The file is about 490 MB.
Internet is needed only once, the first time you use Captions/Reels, to download the speech model
(large-v3-turbo ≈ 1.6 GB) into `%LOCALAPPDATA%\MultimediaAIGroup\engine\models`. Translation,
speaker separation and voice clean-up need no download.

## Install

1. Download: GitHub → **Actions** → *Multimedia & AI Group plugin (Windows .ccx)* → latest green run →
   **Artifacts** → `MultimediaAIGroup-windows-ccx`. Unzip it into one folder. It contains
   `Install.cmd`, `Uninstall.cmd`, `install.ps1`, `اقرأني.txt` and `MultimediaAIGroup-<version>.ccx`.
2. Close Premiere Pro.
3. Double-click **`Install.cmd`** (if Windows says "protected your PC": *More info → Run anyway*).
   - It first uses Adobe's own plugin installer (`UnifiedPluginInstallerAgent.exe`), which is on the
     machine with Premiere's Creative Cloud components even if the Creative Cloud app is never opened.
   - If that is not on the machine, it asks, then installs directly into
     `%APPDATA%\Adobe\UXP\Plugins\External` and registers the plugin in
     `%APPDATA%\Adobe\UXP\PluginsInfo\v1\PPRO.json` (backup kept). Adobe documents this side-load
     route for other apps but not for Premiere; if the panel does not appear, enable
     *Settings › Plugins › Enable developer mode* and restart Premiere.
   - With the Creative Cloud app installed, double-clicking the `.ccx` itself also works.
4. Open Premiere Pro → **Window › UXP Plugins › Multimedia & AI Group**. Dock the panel.

Remove it with `Uninstall.cmd`.

## Use the language button

The **عربي / English** button at the top switches the whole panel. The choice is remembered.

## First checks (please send the result)

1. Dashboard → **Engine** shows *running / شغال*.
2. Open a sequence → **Inspect sequence media / فحص ملفات السيكوانس**.
3. **Cut engine test / اختبار محرك التقطيع**: mark In and Out on the timeline (I / O keys), press
   the button. A new sequence `<name>_CUT_TEST_<time>` opens with that range removed from all
   tracks. The panel says whether every piece was verified frame-exact.
4. Settings → **Copy diagnostics / نسخ بيانات التشخيص**, and paste it to us.

## Uninstall

Creative Cloud → **Stock & Marketplace › Plugins › Manage plugins** → remove *Multimedia & AI Group*.
The engine's cache lives in `%LOCALAPPDATA%\MultimediaAIGroup` and can be deleted.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Engine shows *error* with "Engine not found" | The package is incomplete. Reinstall the `.ccx`. |
| Engine shows *error* "did not answer within 45 s" | Antivirus is still scanning or blocking `engine\python\pythonw.exe` in the plugin folder. Allow it, then press **Restart engine**. |
| "No free port" | Another program uses ports 47820–47823. Close it and press **Restart engine**. |
| Cut test: "Needs Premiere 26.3" | Update Premiere from Creative Cloud. |
| Cut test reports pieces that differ | Copy diagnostics and send them: this is exactly what the test is for. |

## For developers

- Build the `.ccx` on Windows: `pwsh installer/build-windows-package.ps1` (needs Visual Studio 2022 C++,
  Node 20+, Python 3.12). CI runs the same script on every push.
- Develop without the addon: `cd plugin && npm ci && npm run build`, load `plugin/dist/manifest.json`
  in the UXP Developer Tool, and run the engine by hand (`installer/dev-install-engine-*.*`);
  the panel then asks for the pairing code the engine prints.
