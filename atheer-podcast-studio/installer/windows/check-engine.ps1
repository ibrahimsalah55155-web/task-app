# Multimedia & AI Group: engine check. Finds the installed plugin, looks at the engine, tries to start it
# with errors visible, and writes everything to MAG-engine-check.txt on the Desktop (opens in Notepad).
param([switch]$Quiet, [string]$UxpRoot = "", [string]$Out = "")
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
if (-not $UxpRoot) { $UxpRoot = Join-Path $env:APPDATA "Adobe\UXP" }
if (-not $Out) { $Out = Join-Path ([Environment]::GetFolderPath("Desktop")) "MAG-engine-check.txt" }
$Id = "com.multimediaai.podcaststudio"
$Report = New-Object System.Collections.Generic.List[string]
function R($m) { $Report.Add([string]$m); Write-Host $m }

R "=== Multimedia & AI Group engine check  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="
R "Windows: $([Environment]::OSVersion.VersionString)  64-bit: $([Environment]::Is64BitOperatingSystem)"
R "PowerShell: $($PSVersionTable.PSVersion)"

# 1. installed copies
$roots = @((Join-Path $UxpRoot "Plugins\External"))
foreach ($b in @($env:CommonProgramFiles, ${env:CommonProgramFiles(x86)}) | Where-Object { $_ }) { $roots += (Join-Path $b "Adobe\UXP\Plugins\External") }
$dirs = @()
foreach ($r in $roots | Select-Object -Unique) {
  if (Test-Path $r) { $dirs += @(Get-ChildItem -Path $r -Directory -Filter "${Id}_*" -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }) }
}
R ""
R "--- installed plugin folders ---"
if (-not $dirs) { R "NONE FOUND under: $($roots -join '; ')" }
foreach ($d in $dirs) {
  $v = try { (Get-Content (Join-Path $d "manifest.json") -Raw | ConvertFrom-Json).version } catch { "?" }
  R "$d  (version $v)"
  foreach ($f in "engine\python\pythonw.exe", "engine\python\python.exe", "engine\python\python312.dll", "engine\start-engine.vbs",
                 "engine\ffmpeg\ffmpeg.exe", "win\x64\mag_engine.uxpaddon") {
    $p = Join-Path $d $f
    R ("   {0,-34} {1}" -f $f, $(if (Test-Path $p) { "ok" } else { "MISSING" }))
  }
  $site = Join-Path $d "engine\python\Lib\site-packages\atheer_companion"
  R ("   {0,-34} {1}" -f "engine code", $(if (Test-Path $site) { "ok" } else { "MISSING" }))
}
$info = Join-Path $UxpRoot "PluginsInfo\v1\PPRO.json"
R "registration file: $info  exists=$(Test-Path $info)"
$lnk = Join-Path ([Environment]::GetFolderPath("Startup")) "Multimedia AI Group Engine.lnk"
R "start with Windows shortcut: exists=$(Test-Path $lnk)"

# 2. processes and ports
function Show-Ports {
  R ""
  R "--- engine processes ---"
  $procs = Get-CimInstance Win32_Process -Filter "Name = 'pythonw.exe' OR Name = 'python.exe'" -ErrorAction SilentlyContinue
  $mine = @($procs | Where-Object { $_.ExecutablePath -like "*$Id*" })
  if (-not $mine) { R "none running" }
  foreach ($p in $mine) { R "pid $($p.ProcessId)  $($p.CommandLine)" }
  R ""
  R "--- ports 47820-47823 ---"
  foreach ($port in 47820..47823) {
    $owner = ""
    try {
      $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -First 1
      $pp = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
      $owner = " (listening: pid $($c.OwningProcess) $($pp.ProcessName))"
    } catch { $owner = " (nothing listening)" }
    try {
      $h = Invoke-RestMethod -TimeoutSec 3 -Uri "http://127.0.0.1:$port/api/v1/health"
      R "${port}: ANSWERS  $($h.service) $($h.version)$owner"
    } catch { R "${port}: no answer ($($_.Exception.Message))$owner" }
  }
}
Show-Ports

# 3. logs
$logDir = Join-Path $env:LOCALAPPDATA "MultimediaAIGroup\engine\logs"
foreach ($f in "crash.log", "companion.log") {
  $p = Join-Path $logDir $f
  R ""
  R "--- $p (last 40 lines) ---"
  if (Test-Path $p) { Get-Content $p -Tail 40 | ForEach-Object { R $_ } } else { R "(no file)" }
}

# 4. start it with errors visible
$dir = $dirs | Select-Object -First 1
if ($dir) {
  R ""
  R "--- starting the engine with output captured (30 s) ---"
  $py = Join-Path $dir "engine\python\python.exe"
  $ff = Join-Path $dir "engine\ffmpeg"
  $o = Join-Path $env:TEMP "mag_engine_out.txt"; $e = Join-Path $env:TEMP "mag_engine_err.txt"
  Remove-Item $o, $e -ErrorAction SilentlyContinue
  $env:PYTHONHOME = $null; $env:PYTHONPATH = $null
  try {
    $proc = Start-Process -FilePath $py -WorkingDirectory (Join-Path $dir "engine") -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $o -RedirectStandardError $e `
      -ArgumentList @("-m", "atheer_companion", "--port-range", "47820-47823", "--trust-local", "--verbose",
                      "--ffmpeg", "`"$ff\ffmpeg.exe`"", "--ffprobe", "`"$ff\ffprobe.exe`"")
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline -and -not $proc.HasExited) {
      Start-Sleep -Seconds 2
      $ok = $false
      foreach ($port in 47820..47823) { try { Invoke-RestMethod -TimeoutSec 2 -Uri "http://127.0.0.1:$port/api/v1/health" | Out-Null; $ok = $true; break } catch { } }
      if ($ok) { break }
    }
    R "process exited: $($proc.HasExited)$(if ($proc.HasExited) { "  exit code $($proc.ExitCode)" })"
    R "[stdout]"; if (Test-Path $o) { Get-Content $o -Tail 40 | ForEach-Object { R $_ } }
    R "[stderr]"; if (Test-Path $e) { Get-Content $e -Tail 60 | ForEach-Object { R $_ } }
  } catch { R "could not start: $($_.Exception.Message)" }
  Show-Ports
}

$Report | Set-Content -Path $Out -Encoding UTF8
R ""
R "Saved: $Out"
if (-not $Quiet) {
  Start-Process notepad.exe $Out
  Add-Type -AssemblyName System.Windows.Forms
  $opts = [System.Windows.Forms.MessageBoxOptions]::RtlReading -bor [System.Windows.Forms.MessageBoxOptions]::RightAlign
  [System.Windows.Forms.MessageBox]::Show("الفحص خلص. الملف MAG-engine-check.txt اتحفظ على سطح المكتب واتفتح في Notepad.`nابعته (أو انسخ اللي فيه) في الشات.",
    "Multimedia & AI Group", "OK", "Information", "Button1", $opts) | Out-Null
}
