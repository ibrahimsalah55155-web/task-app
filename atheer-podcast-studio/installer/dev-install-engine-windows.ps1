# DEVELOPMENT ONLY. Editors install the single .ccx instead (docs/INSTALL.md).
# Installs the engine into a private Python virtual environment and
# creates a "Start ATHEER Companion" shortcut on the Desktop. Windows 10/11.
#
#   Right-click > Run with PowerShell
#   or: powershell -ExecutionPolicy Bypass -File installer\install-companion-windows.ps1 [-WithAI]
#
# Nothing is downloaded except Python packages from PyPI. FFmpeg is not
# installed automatically; the script tells you how if it is missing.
param([switch]$WithAI)
$ErrorActionPreference = "Stop"

function Say($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$CompanionSrc = (Resolve-Path (Join-Path $Here "..\companion")).Path
$AppHome = if ($env:ATHEER_HOME) { $env:ATHEER_HOME } else { Join-Path $env:LOCALAPPDATA "AtheerPodcastStudio" }
$Venv = Join-Path $AppHome "venv"

Say "Checking Python (3.10 or newer)"
$Py = $null
foreach ($cand in @("py -3.13", "py -3.12", "py -3.11", "py -3.10", "python")) {
  $parts = $cand.Split(" ")
  try {
    & $parts[0] $parts[1..($parts.Length - 1)] -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" 2>$null
    if ($LASTEXITCODE -eq 0) { $Py = $parts; break }
  } catch { }
}
if (-not $Py) {
  Write-Host "Python 3.10+ not found. Install it from https://www.python.org/downloads/windows/ (tick 'Add python.exe to PATH') and run this again." -ForegroundColor Red
  exit 1
}
Write-Host "Using $($Py -join ' ')"

Say "Creating virtual environment in $Venv"
New-Item -ItemType Directory -Force -Path $AppHome | Out-Null
& $Py[0] $Py[1..($Py.Length - 1)] -m venv $Venv
$VPy = Join-Path $Venv "Scripts\python.exe"
& $VPy -m pip install --upgrade pip | Out-Null

Say "Installing the companion"
if ($WithAI) { & $VPy -m pip install "$CompanionSrc[ai]" } else { & $VPy -m pip install "$CompanionSrc" }
if ($LASTEXITCODE -ne 0) { Write-Host "pip install failed" -ForegroundColor Red; exit 1 }
& $VPy -m atheer_companion --version

Say "Checking FFmpeg"
if ((Get-Command ffprobe -ErrorAction SilentlyContinue) -and (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  (& ffprobe -hide_banner -version | Select-Object -First 1)
} else {
  Write-Host "FFmpeg is NOT installed. Install it, then restart the companion:" -ForegroundColor Yellow
  Write-Host "  winget install --id Gyan.FFmpeg -e"
  Write-Host "  or download a build and set ATHEER_FFMPEG / ATHEER_FFPROBE to ffmpeg.exe / ffprobe.exe."
}

$Starter = Join-Path $AppHome "Start ATHEER Companion.bat"
@"
@echo off
title ATHEER Companion - keep this window open while editing
"$VPy" -m atheer_companion %*
pause
"@ | Set-Content -Encoding ASCII $Starter

$Shell = New-Object -ComObject WScript.Shell
$Lnk = $Shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath("Desktop")) "Start ATHEER Companion.lnk"))
$Lnk.TargetPath = $Starter
$Lnk.WorkingDirectory = $AppHome
$Lnk.Save()

Say "Done"
Write-Host "Start the companion with the 'Start ATHEER Companion' shortcut on your Desktop,"
Write-Host "then enter the pairing code it shows in the Premiere panel."
