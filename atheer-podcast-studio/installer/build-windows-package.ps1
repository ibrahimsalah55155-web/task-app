# Builds the single Windows installer: MultimediaAIGroup-<version>.ccx
#
# The .ccx contains everything; the editor installs it once by double-clicking:
#   manifest.json, index.html, index.js ...   the panel
#   win\x64\mag_engine.uxpaddon               native launcher (UXP Hybrid addon, MSVC Release, static CRT)
#   engine\python\                            official signed CPython (embeddable) + engine code + deps
#   engine\ffmpeg\ffmpeg.exe, ffprobe.exe     FFmpeg (LGPL build)
#   engine\models\                            speaker separation + translation models (installer/fetch_models.py)
#
# Requirements on the build machine: Windows x64, Visual Studio 2022 (C++ workload),
# Node.js 20+, Python 3.12, git, internet. Used as-is by .github/workflows/mag-windows-package.yml.
#
#   pwsh installer/build-windows-package.ps1 [-OutDir build-win] [-SdkDir <UXP Hybrid SDK src folder>]
param(
  [string]$OutDir = "build-win",
  [string]$SdkDir = "",
  [string]$PythonVersion = "3.12.10",
  [string]$ModelsDir = "",
  [switch]$SkipTests
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Say($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Must($what) { if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" } }

$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Out = Join-Path $Repo $OutDir
$Pkg = Join-Path $Out "plugin"
$Work = Join-Path $Out "work"
Remove-Item -Recurse -Force $Out -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Pkg, $Work | Out-Null
$Version = (Get-Content (Join-Path $Repo "plugin\package.json") | ConvertFrom-Json).version

# ---- 1. panel ------------------------------------------------------------------
Say "Building the panel (hybrid manifest)"
Push-Location (Join-Path $Repo "plugin")
npm ci; Must "npm ci"
node build.mjs --hybrid; Must "panel build"
Pop-Location
Copy-Item -Recurse (Join-Path $Repo "plugin\dist\*") $Pkg
Remove-Item (Join-Path $Pkg "index.js.map") -ErrorAction SilentlyContinue

# ---- 2. native addon -------------------------------------------------------------
if (-not $SdkDir) {
  # Adobe's UXP Hybrid SDK headers. Official source: Adobe Developer Console (pass -SdkDir).
  # CI fallback: the same headers as redistributed in hyperbrew/bolt-uxp, pinned to a commit.
  Say "Fetching UXP Hybrid SDK headers (pinned)"
  $BoltCommit = "bcc092f"
  git clone --quiet https://github.com/hyperbrew/bolt-uxp.git (Join-Path $Work "bolt-uxp"); Must "git clone"
  git -C (Join-Path $Work "bolt-uxp") checkout --quiet $BoltCommit; Must "git checkout"
  $SdkDir = Join-Path $Work "bolt-uxp\src\hybrid\src"
}
$Api = Join-Path $SdkDir "api"; $Util = Join-Path $SdkDir "utilities"
if (-not (Test-Path (Join-Path $Api "UxpAddonShared.h"))) { throw "UxpAddonShared.h not found under $SdkDir\api" }

Say "Compiling mag_engine.uxpaddon with MSVC (Release, /MT)"
$VsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$Vs = & $VsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $Vs) { throw "Visual Studio with C++ tools not found" }
$Vcvars = Join-Path $Vs "VC\Auxiliary\Build\vcvars64.bat"
$Native = Join-Path $Repo "native\engine_launcher"
$AddonDir = Join-Path $Pkg "win\x64"
New-Item -ItemType Directory -Force -Path $AddonDir | Out-Null
$cl = "cl /nologo /O2 /MT /EHsc /std:c++17 /W3 /DUNICODE /D_UNICODE /I`"$Api`" /I`"$Util`""
cmd /c "`"$Vcvars`" >nul && cd /d `"$Work`" && $cl /LD `"$Native\module.cpp`" `"$Util\UxpAddon.cpp`" /Fe:mag_engine.dll /link /DLL"; Must "addon compile"
Copy-Item (Join-Path $Work "mag_engine.dll") (Join-Path $AddonDir "mag_engine.uxpaddon")
cmd /c "`"$Vcvars`" >nul && cd /d `"$Work`" && $cl `"$Native\test_harness.cpp`" /Fe:test_harness.exe"; Must "harness compile"

# ---- 3. embedded Python + engine -----------------------------------------------------
Say "Embedding CPython $PythonVersion"
$Py = Join-Path $Pkg "engine\python"
$Zip = Join-Path $Work "python-embed.zip"
Invoke-WebRequest "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip" -OutFile $Zip
Write-Host "python embed sha256: $((Get-FileHash $Zip -Algorithm SHA256).Hash)"
Expand-Archive $Zip -DestinationPath $Py
$Pth = Get-ChildItem $Py -Filter "python*._pth" | Select-Object -First 1
$Zipname = (Get-ChildItem $Py -Filter "python3*.zip" | Select-Object -First 1).Name
Set-Content -Encoding ASCII $Pth.FullName "$Zipname`r`n.`r`nLib\site-packages`r`nimport site`r`n"
$MajMin = ($PythonVersion.Split(".")[0..1] -join "")

Say "Installing the engine into the embedded Python"
python -m pip wheel --no-deps -w (Join-Path $Work "wheels") (Join-Path $Repo "companion"); Must "engine wheel"
$Wheel = (Get-ChildItem (Join-Path $Work "wheels") -Filter "*.whl" | Select-Object -First 1).FullName
python -m pip install --no-compile --target (Join-Path $Py "Lib\site-packages") --platform win_amd64 `
  --python-version $MajMin --implementation cp --only-binary=:all: $Wheel; Must "engine install"

# ---- 4. FFmpeg -----------------------------------------------------------------------
Say "Adding FFmpeg (LGPL build from BtbN/FFmpeg-Builds)"
$Headers = @{ "User-Agent" = "mag-build" }
if ($env:GITHUB_TOKEN) { $Headers["Authorization"] = "Bearer $env:GITHUB_TOKEN" }
$Rel = Invoke-RestMethod -Headers $Headers "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest"
$Asset = $Rel.assets | Where-Object { $_.name -match '^ffmpeg-n(\d+)\.(\d+)-latest-win64-lgpl-\d+\.\d+\.zip$' } |
  Sort-Object { [version]("{0}.{1}" -f ($_.name -replace '^ffmpeg-n(\d+)\.(\d+).*$', '$1'), ($_.name -replace '^ffmpeg-n(\d+)\.(\d+).*$', '$2')) } -Descending |
  Select-Object -First 1
if (-not $Asset) { throw "No win64 LGPL FFmpeg build found in the latest BtbN release" }
$FfZip = Join-Path $Work $Asset.name
Invoke-WebRequest -Headers $Headers $Asset.browser_download_url -OutFile $FfZip
$SumsFile = Join-Path $Work "checksums.sha256"
Invoke-WebRequest -Headers $Headers ($Rel.assets | Where-Object name -eq "checksums.sha256").browser_download_url -OutFile $SumsFile
$Line = Get-Content $SumsFile | Where-Object { $_ -match [regex]::Escape($Asset.name) } | Select-Object -First 1
if (-not $Line) { throw "No checksum listed for $($Asset.name)" }
$Expected = ($Line -split "\s+")[0].ToLower()
$Actual = (Get-FileHash $FfZip -Algorithm SHA256).Hash.ToLower()
if ($Expected -ne $Actual) { throw "FFmpeg checksum mismatch ($Actual vs $Expected)" }
Write-Host "FFmpeg $($Asset.name) sha256 OK"
Expand-Archive $FfZip -DestinationPath (Join-Path $Work "ffmpeg")
$FfDir = Join-Path $Pkg "engine\ffmpeg"
New-Item -ItemType Directory -Force -Path $FfDir | Out-Null
$Bin = Get-ChildItem -Recurse (Join-Path $Work "ffmpeg") -Filter "ffprobe.exe" | Select-Object -First 1
Copy-Item (Join-Path $Bin.DirectoryName "ffmpeg.exe"), (Join-Path $Bin.DirectoryName "ffprobe.exe") $FfDir
Get-ChildItem -Recurse (Join-Path $Work "ffmpeg") -Filter "LICENSE*" | Select-Object -First 1 | Copy-Item -Destination (Join-Path $FfDir "LICENSE.txt")

# ---- 4a. engine start script (used when Premiere does not run the native launcher) ---------
Copy-Item (Join-Path $PSScriptRoot "engine\start-engine.vbs") (Join-Path $Pkg "engine\start-engine.vbs")

# ---- 4b. offline models -------------------------------------------------------------------
if ($ModelsDir) {
  $Src = if ([System.IO.Path]::IsPathRooted($ModelsDir)) { $ModelsDir } else { Join-Path $Repo $ModelsDir }
  if (-not (Test-Path (Join-Path $Src "diarization\embedding.onnx"))) { throw "Models folder $Src is incomplete" }
  Say "Adding offline models from $Src"
  New-Item -ItemType Directory -Force -Path (Join-Path $Pkg "engine\models") | Out-Null
  Copy-Item -Recurse (Join-Path $Src "*") (Join-Path $Pkg "engine\models")
} else {
  Write-Warning "No -ModelsDir: speaker separation and translation will be unavailable in this package."
}

# ---- 5. tests on this Windows machine ------------------------------------------------
if (-not $SkipTests) {
  Say "Testing the packaged engine"
  & (Join-Path $Py "python.exe") -m atheer_companion --version; Must "engine --version"
  & (Join-Path $FfDir "ffprobe.exe") -hide_banner -version | Select-Object -First 1

  Say "Testing the graphics renderer (Arabic shaping + ProRes 4444) with the packaged Python and FFmpeg"
  $RenderTest = @"
from pathlib import Path
from atheer_companion.graphics.render import render_video
r = render_video(r'$FfDir\ffmpeg.exe', 'lower_third', {'name': 'د. اختبار'}, 1080, 1920, 25, 2.0, Path(r'$Work\gfx'))
print('rendered', r['frames'], 'frames ->', r['path'])
"@
  & (Join-Path $Py "python.exe") -c $RenderTest; Must "graphics render test"

  Say "Testing audio sync (scipy + numpy + FFmpeg) and voice detection (onnxruntime + Silero) on Windows"
  & $FfDir\ffmpeg.exe -hide_banner -loglevel error -y -f lavfi -i "anoisesrc=d=40:c=pink:r=48000:a=0.4,volume='if(lt(mod(t,1.3),0.5),1,0.05)':eval=frame" (Join-Path $Work "ref.wav")
  & $FfDir\ffmpeg.exe -hide_banner -loglevel error -y -ss 2.5 -i (Join-Path $Work "ref.wav") -ar 44100 (Join-Path $Work "cam.wav")
  $SyncTest = @"
from pathlib import Path
from atheer_companion.analysis.audio import AudioCache
from atheer_companion.analysis.sync import SyncFile, sync_files
from atheer_companion.analysis.vad import silero_available
c = AudioCache(r'$FfDir\ffmpeg.exe', Path(r'$Work\ac'))
r = sync_files([SyncFile(r'$Work\ref.wav', 'guest_mic'), SyncFile(r'$Work\cam.wav', 'wide_cam')], c)
off = [x for x in r['results'] if x['role'] == 'wide_cam'][0]['offset']
print('offset', off, 'silero', silero_available())
assert abs(off - 2.5) < 0.01 and silero_available()
"@
  & (Join-Path $Py "python.exe") -c $SyncTest; Must "sync test"

  Say "Testing voice clean-up (RNNoise + loudness) keeps sample-exact timing on Windows"
  & $FfDir\ffmpeg.exe -hide_banner -loglevel error -y -f lavfi -i "sine=f=180:d=6:r=48000" -f lavfi -i "anoisesrc=d=6:c=pink:r=48000:a=0.05" -filter_complex "[0][1]amix=inputs=2:normalize=0" (Join-Path $Work "mic.wav")
  $CleanTest = @"
from atheer_companion.analysis import cleanup
r = cleanup.clean_file(r'$FfDir\ffmpeg.exe', r'$FfDir\ffprobe.exe', r'$Work\mic.wav', r'$Work\clean\mic_clean.wav', cleanup.settings('standard'))
print('lufs', r['lufsBefore'], '->', r['lufsAfter'], 'lag ms', r['lagMs'])
assert abs(r['lagMs']) < 1 and abs(r['lufsAfter'] + 16) < 1
"@
  & (Join-Path $Py "python.exe") -c $CleanTest; Must "clean-up test"

  if ($ModelsDir) {
    Say "Testing translation (CTranslate2 + SentencePiece) and speaker models (sherpa-onnx) with the packaged Python"
    $ModelTest = @"
import numpy as np
from atheer_companion.analysis import translate, diarize
print(translate.available_pairs())
out = translate.OpusMT('ar', 'en')(['شكراً جزيلاً على وجودك معنا اليوم.'])
print(out)
assert 'thank' in out[0].lower()
assert diarize.available()
segs = diarize.diarize_audio(np.zeros(16000 * 3, np.float32), 2)
print('diarization ok', segs)
"@
    & (Join-Path $Py "python.exe") -c $ModelTest; Must "model test"
  }

  Say "Testing the addon: start, health, stop"
  & (Join-Path $Work "test_harness.exe") (Join-Path $AddonDir "mag_engine.uxpaddon") 47830 stop; Must "addon stop test"

  Say "Testing the addon: engine dies with its host process"
  # (PowerShell variable names are case-insensitive: do not call this $out, it would replace $Out.)
  $HarnessLines = & (Join-Path $Work "test_harness.exe") (Join-Path $AddonDir "mag_engine.uxpaddon") 47831 abandon
  $HarnessLines | Write-Host
  Must "addon abandon test"
  $EnginePid = [int](($HarnessLines | Where-Object { $_ -like "PID *" }) -replace "PID ", "")
  Start-Sleep -Seconds 3
  if (Get-Process -Id $EnginePid -ErrorAction SilentlyContinue) { throw "Engine $EnginePid survived its host process" }
  Write-Host "OK: engine $EnginePid was killed with its host"
}

# ---- 6. package ------------------------------------------------------------------------
Say "Packaging"
Get-ChildItem -Recurse -Directory $Pkg -Filter "__pycache__" | Remove-Item -Recurse -Force
$Ccx = Join-Path $Out "MultimediaAIGroup-$Version.ccx"
Compress-Archive -Path (Join-Path $Pkg "*") -DestinationPath ($Ccx -replace '\.ccx$', '.zip')
Move-Item ($Ccx -replace '\.ccx$', '.zip') $Ccx
$SizeMb = [math]::Round((Get-Item $Ccx).Length / 1MB, 1)
Write-Host "Built $Ccx ($SizeMb MB)"

# ---- 7. download folder: .ccx + installer that needs no Creative Cloud app --------------------
Say "Preparing the download folder (installer without Creative Cloud)"
$Dl = Join-Path $Out "MultimediaAIGroup-$Version"
New-Item -ItemType Directory -Force -Path $Dl | Out-Null
Move-Item $Ccx $Dl
Copy-Item (Join-Path $PSScriptRoot "windows\*") $Dl -Exclude ".gitattributes"
$Ccx = Join-Path $Dl "MultimediaAIGroup-$Version.ccx"

if (-not $SkipTests) {
  Say "Testing the installer (direct method) in a scratch UXP folder"
  $Uxp = Join-Path $Work "uxp-test"
  $Info = Join-Path $Uxp "PluginsInfo\v1\PPRO.json"
  New-Item -ItemType Directory -Force -Path (Split-Path $Info) | Out-Null
  # another plugin already registered: it must survive install, upgrade and uninstall
  '{"plugins":[{"hostMinVersion":"25.6.0","name":"Other","path":"$localPlugins\\External\\other_1.0.0","pluginId":"other.plugin","status":"enabled","type":"uxp","versionString":"1.0.0"}]}' |
    Set-Content -Path $Info -Encoding UTF8
  foreach ($round in 1, 2) {
    $InstallLines = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Dl "install.ps1") -Mode direct -Yes -Quiet -NoAutostart -UxpRoot $Uxp
    $InstallLines | Write-Host
    Must "installer round $round"
    # The installer starts the engine through Windows (start-engine.vbs) and checks it answers with its token.
    if (-not ($InstallLines -match "Engine: running:478")) { throw "engine did not start through Windows in round $round" }
  }
  $tokFile = Join-Path $Uxp ("Plugins\External\com.multimediaai.podcaststudio_$Version\engine\autostart.token")
  $tok = (Get-Content $tokFile -Raw).Trim()
  $caps = Invoke-RestMethod -Uri "http://127.0.0.1:47820/api/v1/capabilities" -Headers @{ Authorization = "Bearer $tok" }
  Write-Host "engine started by Windows answers: $($caps.service) $($caps.version)"
  $j = Get-Content $Info -Raw | ConvertFrom-Json
  $ids = @($j.plugins | ForEach-Object { $_.pluginId })
  Write-Host "registered: $($ids -join ', ')"
  if ($ids.Count -ne 2 -or -not ($ids -contains "other.plugin") -or -not ($ids -contains "com.multimediaai.podcaststudio")) { throw "PPRO.json not as expected" }
  $mine = $j.plugins | Where-Object { $_.pluginId -eq "com.multimediaai.podcaststudio" }
  $dir = Join-Path $Uxp ("Plugins\External\com.multimediaai.podcaststudio_$Version")
  foreach ($f in "manifest.json", "index.js", "win\x64\mag_engine.uxpaddon", "engine\python\pythonw.exe", "engine\ffmpeg\ffmpeg.exe") {
    if (-not (Test-Path (Join-Path $dir $f))) { throw "missing after install: $f" }
  }
  if ($mine.path -ne "`$localPlugins\External\com.multimediaai.podcaststudio_$Version") { throw "bad path entry: $($mine.path)" }
  if (@(Get-ChildItem (Split-Path $Info) -Filter "PPRO.json.bak-*").Count -lt 1) { throw "no backup of PPRO.json" }
  Write-Host "OK: installed, upgraded in place, other plugin kept, backup made"

  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Dl "install.ps1") -Uninstall -Mode direct -Quiet -UxpRoot $Uxp
  Must "uninstall"
  $j = Get-Content $Info -Raw | ConvertFrom-Json
  if (@($j.plugins).Count -ne 1 -or $j.plugins[0].pluginId -ne "other.plugin" -or (Test-Path $dir)) { throw "uninstall did not clean up" }
  $left = Get-CimInstance Win32_Process -Filter "Name = 'pythonw.exe'" | Where-Object { $_.ExecutablePath -like "*com.multimediaai.podcaststudio*" }
  if ($left) { throw "engine still running after uninstall" }
  Write-Host "OK: uninstall removed only this plugin"

  Say "Testing the installer with no PPRO.json at all (fresh machine)"
  $Uxp2 = Join-Path $Work "uxp-fresh"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Dl "install.ps1") -Yes -Quiet -NoAutostart -UxpRoot $Uxp2
  Must "fresh install (auto mode)"
  $j = Get-Content (Join-Path $Uxp2 "PluginsInfo\v1\PPRO.json") -Raw | ConvertFrom-Json
  if (@($j.plugins).Count -ne 1) { throw "fresh PPRO.json wrong" }
  Get-Content (Join-Path $Uxp2 "PluginsInfo\v1\PPRO.json") | Write-Host
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Dl "install.ps1") -Uninstall -Mode direct -Quiet -UxpRoot $Uxp2
}
Get-ChildItem $Dl | ForEach-Object { Write-Host ("  " + $_.Name) }
