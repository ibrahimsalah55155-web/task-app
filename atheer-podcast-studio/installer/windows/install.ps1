# Multimedia & AI Group: installs the panel into Premiere Pro without opening the Creative Cloud app.
#
# Double-click Install.cmd (next to the .ccx). Two methods, tried in this order:
#   1. "official": Adobe's own plugin installer (UnifiedPluginInstallerAgent.exe). It is installed with
#      Premiere/Creative Cloud components even if you never open the Creative Cloud app.
#   2. "direct":   copies the plugin into  %APPDATA%\Adobe\UXP\Plugins\External\<id>_<version>  and registers
#      it in  %APPDATA%\Adobe\UXP\PluginsInfo\v1\PPRO.json  (a backup of that file is kept). This is how
#      UXP side-loading works for other Adobe apps; Adobe does not document it for Premiere, so it is the
#      fallback, used only after you agree.
#
#   install.ps1 [-Mode auto|official|direct] [-Uninstall] [-Yes] [-Quiet] [-UxpRoot <folder>] [-Ccx <file>]
param(
  [ValidateSet("auto", "official", "direct")] [string]$Mode = "auto",
  [switch]$Uninstall,
  [switch]$Yes,      # do not ask (CI / advanced)
  [switch]$Quiet,    # no message boxes (CI)
  [string]$UxpRoot = "",
  [string]$Ccx = "",
  [switch]$NoAutostart  # do not add the Windows log-on entry (CI)
)
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $UxpRoot) { $UxpRoot = Join-Path $env:APPDATA "Adobe\UXP" }

function Say($m, $c = "Cyan") { Write-Host $m -ForegroundColor $c }

function Box($text, $title = "Multimedia & AI Group", [string]$kind = "info", [switch]$Ask) {
  if ($Quiet) { Say $text; return $true }
  Add-Type -AssemblyName System.Windows.Forms
  $buttons = if ($Ask) { [System.Windows.Forms.MessageBoxButtons]::YesNo } else { [System.Windows.Forms.MessageBoxButtons]::OK }
  $icon = switch ($kind) { "error" { "Error" } "warn" { "Warning" } "ask" { "Question" } default { "Information" } }
  $opts = [System.Windows.Forms.MessageBoxOptions]::RtlReading -bor [System.Windows.Forms.MessageBoxOptions]::RightAlign
  $r = [System.Windows.Forms.MessageBox]::Show($text, $title, $buttons, [System.Windows.Forms.MessageBoxIcon]::$icon,
    [System.Windows.Forms.MessageBoxDefaultButton]::Button1, $opts)
  return ($r -eq [System.Windows.Forms.DialogResult]::Yes -or $r -eq [System.Windows.Forms.DialogResult]::OK)
}

# ---- the package ---------------------------------------------------------------------------
if (-not $Ccx) {
  $found = Get-ChildItem -Path $Here -Filter "MultimediaAIGroup-*.ccx" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $found) {
    Box "مش لاقي ملف MultimediaAIGroup-....ccx جنب ملف التسطيب.`nفك الضغط عن الملف اللي نزّلته كله في فولدر واحد، وبعدين افتح Install.cmd من جوه الفولدر." "Multimedia & AI Group" "error" | Out-Null
    exit 2
  }
  $Ccx = $found.FullName
}
# Files downloaded from the internet carry a "blocked" mark; remove it so Windows lets the engine run.
Unblock-File -Path $Ccx -ErrorAction SilentlyContinue

$ProgressPreference = "SilentlyContinue"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Tmp = Join-Path $env:TEMP ("mag_install_" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
# Read the manifest straight from the package (fast); the full unpack happens only when needed.
$zipRead = [System.IO.Compression.ZipFile]::OpenRead($Ccx)
try {
  $entry = $zipRead.Entries | Where-Object { $_.FullName -eq "manifest.json" } | Select-Object -First 1
  if (-not $entry) { throw "manifest.json not found in $Ccx" }
  $sr = New-Object System.IO.StreamReader($entry.Open(), [System.Text.Encoding]::UTF8)
  $Manifest = $sr.ReadToEnd() | ConvertFrom-Json
  $sr.Close()
} finally { $zipRead.Dispose() }
$Id = $Manifest.id
$Version = $Manifest.version
$Name = $Manifest.name
$HostMin = $Manifest.host.minVersion
$Folder = "${Id}_$Version"
Say "Package: $Name $Version ($Id)"

# ---- method 1: Adobe's installer ------------------------------------------------------------
function Find-Upia {
  $bases = @($env:CommonProgramFiles, ${env:CommonProgramFiles(x86)}, "C:\Program Files\Common Files") | Where-Object { $_ } | Select-Object -Unique
  foreach ($b in $bases) {
    $p = Join-Path $b "Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
    if (Test-Path $p) { return $p }
  }
  foreach ($b in $bases) {
    $root = Join-Path $b "Adobe"
    if (Test-Path $root) {
      $hit = Get-ChildItem -Path $root -Recurse -Filter "UnifiedPluginInstallerAgent.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($hit) { return $hit.FullName }
    }
  }
  return $null
}

function Official-Install($upia) {
  Say "Using Adobe's installer: $upia"
  $out = & $upia --install $Ccx 2>&1 | Out-String
  Write-Host $out
  $ok = ($LASTEXITCODE -eq 0) -and ($out -notmatch "(?i)fail|error")
  if ($ok) {
    $list = & $upia --list all 2>&1 | Out-String
    if ($list -match [regex]::Escape($Name) -or $list -match [regex]::Escape($Id)) { return $true }
    Say "Installer said OK but the plugin is not in its list:" "Yellow"; Write-Host $list
  }
  return $false
}

function Official-Remove($upia) {
  $out = & $upia --remove $Name 2>&1 | Out-String
  Write-Host $out
  return ($LASTEXITCODE -eq 0)
}

# ---- method 2: direct ------------------------------------------------------------------------
$PluginsDir = Join-Path $UxpRoot "Plugins\External"
$InfoFile = Join-Path $UxpRoot "PluginsInfo\v1\PPRO.json"

function Read-Info {
  if (-not (Test-Path $InfoFile)) { return [pscustomobject]@{ plugins = @() } }
  $raw = Get-Content $InfoFile -Raw -Encoding UTF8
  if (-not $raw.Trim()) { return [pscustomobject]@{ plugins = @() } }
  $j = $raw | ConvertFrom-Json
  if ($null -eq $j.plugins) { throw "PPRO.json has an unexpected format; not changing it." }
  return $j
}

function Write-Info($j) {
  New-Item -ItemType Directory -Force -Path (Split-Path $InfoFile) | Out-Null
  if (Test-Path $InfoFile) { Copy-Item $InfoFile ("$InfoFile.bak-" + (Get-Date -Format "yyyyMMdd-HHmmss")) }
  $text = $j | ConvertTo-Json -Depth 10
  [System.IO.File]::WriteAllText($InfoFile, $text, (New-Object System.Text.UTF8Encoding($false)))
}

function Direct-Install {
  # remove older versions of this plugin (also an earlier copy of this version)
  if (Test-Path $PluginsDir) {
    Get-ChildItem -Path $PluginsDir -Directory -Filter "${Id}_*" | ForEach-Object { Remove-Item -Recurse -Force $_.FullName }
  }
  $dest = Join-Path $PluginsDir $Folder
  New-Item -ItemType Directory -Force -Path $PluginsDir | Out-Null
  [System.IO.Compression.ZipFile]::ExtractToDirectory($Ccx, $dest)
  Get-ChildItem -Path $dest -Recurse -File | Unblock-File -ErrorAction SilentlyContinue
  $j = Read-Info
  $others = @($j.plugins | Where-Object { $_.pluginId -ne $Id })
  $entry = [pscustomobject][ordered]@{
    hostMinVersion = $HostMin
    name           = $Name
    path           = "`$localPlugins\External\$Folder"
    pluginId       = $Id
    status         = "enabled"
    type           = "uxp"
    versionString  = $Version
  }
  $j.plugins = @($others) + @($entry)
  Write-Info $j
  # verify
  $check = Read-Info
  $mine = @($check.plugins | Where-Object { $_.pluginId -eq $Id })
  if ($mine.Count -ne 1 -or -not (Test-Path (Join-Path $dest "manifest.json"))) { throw "Verification failed after copying." }
  Say "Installed to $dest" "Green"
  Say "Registered in $InfoFile" "Green"
  return $true
}

function Direct-Remove {
  $removed = $false
  if (Test-Path $PluginsDir) {
    Get-ChildItem -Path $PluginsDir -Directory -Filter "${Id}_*" | ForEach-Object { Remove-Item -Recurse -Force $_.FullName; $removed = $true }
  }
  if (Test-Path $InfoFile) {
    $j = Read-Info
    $before = @($j.plugins).Count
    $j.plugins = @($j.plugins | Where-Object { $_.pluginId -ne $Id })
    if (@($j.plugins).Count -ne $before) { Write-Info $j; $removed = $true }
  }
  return $removed
}

# ---- engine started by Windows ---------------------------------------------------------------
# Premiere normally starts the engine through the plugin's native launcher. When it does not (for
# example a plugin installed without Creative Cloud), the engine runs from engine\start-engine.vbs:
# at Windows log-on (shortcut below), right after installing, and on request from the panel.
$StartupLnk = Join-Path ([Environment]::GetFolderPath("Startup")) "Multimedia AI Group Engine.lnk"

function Plugin-Dirs {
  $roots = @((Join-Path $UxpRoot "Plugins\External"))
  foreach ($b in @($env:CommonProgramFiles, ${env:CommonProgramFiles(x86)}) | Where-Object { $_ }) {
    $roots += (Join-Path $b "Adobe\UXP\Plugins\External")
  }
  $out = @()
  foreach ($r in $roots | Select-Object -Unique) {
    if (Test-Path $r) { $out += @(Get-ChildItem -Path $r -Directory -Filter "${Id}_*" -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }) }
  }
  return $out
}

function Stop-Engine {
  # Any engine running from an installed copy of this plugin (files must not be in use while replacing them).
  $dirs = @(Plugin-Dirs)
  $procs = Get-CimInstance Win32_Process -Filter "Name = 'pythonw.exe' OR Name = 'python.exe'" -ErrorAction SilentlyContinue
  foreach ($p in $procs) {
    foreach ($d in $dirs) {
      if ($p.ExecutablePath -and $p.ExecutablePath.StartsWith($d, [StringComparison]::OrdinalIgnoreCase)) {
        Say "Stopping engine (pid $($p.ProcessId))"
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
      }
    }
  }
  Start-Sleep -Milliseconds 500
}

function Engine-Answers($tokenFile) {
  if (-not (Test-Path $tokenFile)) { return 0 }
  $tok = (Get-Content $tokenFile -Raw).Trim()
  foreach ($port in 47820..47823) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://127.0.0.1:$port/api/v1/capabilities" -Headers @{ Authorization = "Bearer $tok" }
      if ($r.StatusCode -eq 200) { return $port }
    } catch { }
  }
  return 0
}

function Setup-Autostart($pluginDir) {
  $vbs = Join-Path $pluginDir "engine\start-engine.vbs"
  if (-not (Test-Path $vbs)) { return "no-script" }
  $probe = Join-Path $pluginDir "engine\.write-test"
  try { Set-Content -Path $probe -Value "x" -ErrorAction Stop; Remove-Item $probe -Force } catch { return "read-only" }
  if (-not $NoAutostart) {
    $ws = New-Object -ComObject WScript.Shell
    $lnk = $ws.CreateShortcut($StartupLnk)
    $lnk.TargetPath = Join-Path $env:WINDIR "System32\wscript.exe"
    $lnk.Arguments = '"' + $vbs + '"'
    $lnk.WorkingDirectory = Split-Path $vbs
    $lnk.WindowStyle = 7
    $lnk.Description = "Multimedia & AI Group engine for Premiere Pro"
    $lnk.Save()
  }
  Start-Process -FilePath (Join-Path $env:WINDIR "System32\wscript.exe") -ArgumentList ('"' + $vbs + '"') -WindowStyle Hidden
  $tokenFile = Join-Path $pluginDir "engine\autostart.token"
  $deadline = (Get-Date).AddSeconds(90)  # first start: Windows Defender scans the new files
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $port = Engine-Answers $tokenFile
    if ($port) { Say "Engine running on port $port" "Green"; return "running:$port" }
  }
  return "no-answer"
}

# ---- run ---------------------------------------------------------------------------------------
try {
  if (Get-Process -Name "Adobe Premiere Pro" -ErrorAction SilentlyContinue) {
    Box "اقفل البريمير الأول، وبعدين دوس OK." "Multimedia & AI Group" "warn" | Out-Null
  }
  $upia = if ($Mode -ne "direct") { Find-Upia } else { $null }

  if ($Uninstall) {
    Stop-Engine
    if (Test-Path $StartupLnk) { Remove-Item $StartupLnk -Force }
    $a = if ($upia) { Official-Remove $upia } else { $false }
    $b = Direct-Remove
    Box ($(if ($a -or $b) { "البلجن اتشال من البريمير." } else { "البلجن مش متسطب أصلاً." })) | Out-Null
    exit 0
  }

  Stop-Engine
  $done = $false
  $how = ""
  if ($upia -and $Mode -ne "direct") {
    $done = Official-Install $upia
    if ($done) { $how = "official" }
  } elseif ($Mode -eq "official") {
    Box "مش لاقي برنامج التسطيب بتاع أدوبي على الجهاز ده." "Multimedia & AI Group" "error" | Out-Null
    exit 3
  }

  if (-not $done) {
    $why = if ($upia) { "برنامج التسطيب بتاع أدوبي مقدرش يسطب البلجن." } else { "برنامج التسطيب بتاع أدوبي مش موجود على الجهاز (بييجي مع Creative Cloud)." }
    $ask = "$why`n`nأسطب البلجن مباشرةً في فولدر بلجنات البريمير؟`n(بتتعمل نسخة احتياطية من ملف تسجيل البلجنات، وتقدر تشيله بـ Uninstall.cmd)"
    if ($Yes -or (Box $ask "Multimedia & AI Group" "ask" -Ask)) {
      $done = Direct-Install
      $how = "direct"
    } else {
      exit 4
    }
  }

  if ($done) {
    $engineState = "no-plugin-dir"
    $dir = @(Plugin-Dirs) | Select-Object -First 1
    if ($dir) { $engineState = Setup-Autostart $dir }
    Say "Engine: $engineState"
    $msg = "البلجن اتسطب ✔`n`nافتح البريمير ← Window ← UXP Plugins ← Multimedia & AI Group."
    if ($engineState -like "running:*") {
      $msg += "`n`nالمحرك شغّال في الخلفية (من غير شباك) وهيشتغل لوحده كل ما تفتح الجهاز."
    } elseif ($engineState -eq "no-answer") {
      $msg += "`n`nالمحرك لسه مردّش (ممكن الأنتي فايرس بيفحص الملفات). لو البانل قال إن المحرك مش شغال، اعمل Restart للجهاز."
    }
    if ($how -eq "direct") {
      $msg += "`n`nلو مظهرش في القايمة: البريمير ← Edit ← Preferences (أو Settings) ← Plugins ← فعّل Enable developer mode، واقفل البريمير وافتحه تاني."
    }
    Box $msg | Out-Null
    Say "OK ($how)" "Green"
    exit 0
  }
} catch {
  Box ("حصلت مشكلة في التسطيب:`n" + $_.Exception.Message) "Multimedia & AI Group" "error" | Out-Null
  Write-Host $_.ScriptStackTrace
  exit 1
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
