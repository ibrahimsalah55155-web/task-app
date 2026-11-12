# Builds the single Windows installer: MultimediaAIGroup-<version>.ccx
#
# The .ccx contains everything; the editor installs it once by double-clicking:
#   manifest.json, index.html, index.js ...   the panel
#   win\x64\mag_engine.uxpaddon               native launcher (UXP Hybrid addon, MSVC Release, static CRT)
#   engine\python\                            official signed CPython (embeddable) + engine code + deps
#   engine\ffmpeg\ffmpeg.exe, ffprobe.exe     FFmpeg (LGPL build)
#
# Requirements on the build machine: Windows x64, Visual Studio 2022 (C++ workload),
# Node.js 20+, Python 3.12, git, internet. Used as-is by .github/workflows/mag-windows-package.yml.
#
#   pwsh installer/build-windows-package.ps1 [-OutDir build-win] [-SdkDir <UXP Hybrid SDK src folder>]
param(
  [string]$OutDir = "build-win",
  [string]$SdkDir = "",
  [string]$PythonVersion = "3.12.10",
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

# ---- 5. tests on this Windows machine ------------------------------------------------
if (-not $SkipTests) {
  Say "Testing the packaged engine"
  & (Join-Path $Py "python.exe") -m atheer_companion --version; Must "engine --version"
  & (Join-Path $FfDir "ffprobe.exe") -hide_banner -version | Select-Object -First 1

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
