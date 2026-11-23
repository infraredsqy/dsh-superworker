# dev-restart.ps1 - rebuild-cycle fixture: stop the local DSH web instance, reinstall this
# plugin from the newest packed tgz, relaunch, and verify the boot actually succeeded.
#
#   # from a LIVE SESSION, launch detached (WMI) - do NOT run this script directly in-session:
#   pwsh -NoProfile -Command "Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
#     -Arguments 'pwsh -NoProfile -File <repo>\tools\dev-restart.ps1 -GraceSeconds 20'"
#
# ============================================================================
# SAFETY - READ BEFORE TOUCHING THIS SCRIPT
# ============================================================================
# 1. Killing the listener on the web port KILLS the DSH instance that may be hosting an
#    active conversation (the harness itself runs inside that process). This script must
#    therefore only ever run DETACHED - via Win32_Process.Create (WMI) or a scheduled task -
#    so it survives the process tree it tears down. History: on 2026-11-22 16:03 an in-session
#    restart killed its own relauncher along with the tree; nothing came back up.
# 2. Never kill by image name. This script kills exactly one pid: the listener on $Port whose
#    command line matches 'dsh'. Anything else -> ABORT. (taskkill /IM node.exe would kill the
#    harness and every conversation on the machine.)
# 3. Install only while DSH is down: a running instance holds file locks in node_modules and
#    a mid-flight `plugin add` dies half-written.
# 4. Verify from the boot log, not from exit codes: real failures looked like
#    "1 entry did not activate" with a zero exit upstream.
# ============================================================================
param(
  [switch]$Dry,
  [string]$Profile = 'web',
  [int]$Port = 3080,
  [string]$Tgz = 'auto',          # tgz path, or 'auto' = newest .tmp\pack\*.tgz
  [string]$PluginName = 'dsh-superworker',
  [switch]$SkipReinstall,
  [switch]$SkipVerify,
  [int]$GraceSeconds = 20,        # let the dying session flush its final report
  [string]$RepoRoot = '',         # default: repo containing this script
  [string]$LauncherPath = '',     # default: %USERPROFILE%\.dsh\launch-web.cmd
  [string]$LogPath = ''           # default: <RepoRoot>\.tmp\dev-restart.log
)
$ErrorActionPreference = 'Continue'
if ($RepoRoot -eq '') { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
if ($LauncherPath -eq '') { $LauncherPath = Join-Path $env:USERPROFILE '.dsh\launch-web.cmd' }
if ($LogPath -eq '') { $LogPath = Join-Path $RepoRoot '.tmp\dev-restart.log' }
$WebLog = Join-Path $env:USERPROFILE '.dsh\web-run.log'

function Log($m) {
  try { Add-Content -LiteralPath $LogPath -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) } catch {}
}

Log ("dev-restart start pid=" + $PID + " dry=" + [bool]$Dry + " port=" + $Port + " grace=" + $GraceSeconds)
Write-Output ("dev-restart: log at " + $LogPath)

# 1. Grace period: the session that triggered us may still be writing its final report.
if ($GraceSeconds -gt 0) {
  Log ("grace sleep " + $GraceSeconds + "s begin")
  if (-not $Dry) { Start-Sleep -Seconds $GraceSeconds }
  Log 'grace sleep end'
}

# 2. Find the listener and verify its identity before any kill.
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
  $proc = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $conn.OwningProcess) -ErrorAction SilentlyContinue
  $cmd = [string]$proc.CommandLine
  Log ("listener pid " + $conn.OwningProcess + " cmdline: " + $cmd)
  if ($cmd -notmatch 'dsh') {
    Log 'ABORT: the port is held by a process whose command line does not mention dsh; refusing to kill.'
    Write-Output 'ABORT: port is held by a non-dsh process; nothing was killed.'
    exit 5
  }
  if ($Dry) {
    Log ("dry: would stop pid " + $conn.OwningProcess)
  } else {
    Log ("stopping dsh pid " + $conn.OwningProcess)
    Stop-Process -Id $conn.OwningProcess -Force
  }
} else {
  Log 'no listener on the port; skip stop'
}

# 3. Port drain loop: the socket can lag the process death by a breath; never launch a second
#    instance onto a port that is still closing.
if (-not $Dry -and $conn) {
  $drained = $false
  for ($k = 0; $k -lt 40; $k++) {
    if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { $drained = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $drained) {
    Log 'ABORT: port never drained after the kill; refusing to launch a second instance.'
    exit 6
  }
  Log 'port drained'
}

# 4. Reinstall the plugin from the tgz (only safe while DSH is down).
if (-not $SkipReinstall) {
  $tgzPath = $Tgz
  if ($tgzPath -eq 'auto') {
    $latest = Get-ChildItem -Path (Join-Path $RepoRoot '.tmp\pack') -Filter '*.tgz' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($null -eq $latest) {
      Log 'ABORT: -Tgz auto but no tgz found in .tmp\pack (run: npm pack --pack-destination .tmp\pack)'
      exit 7
    }
    $tgzPath = $latest.FullName
  }
  if (-not (Test-Path -LiteralPath $tgzPath)) {
    Log ("ABORT: tgz missing: " + $tgzPath)
    exit 7
  }
  if ($Dry) {
    Log ("dry: would plugin remove+add " + $tgzPath)
  } else {
    Log 'plugin remove begin'
    & dsh plugin --profile $Profile remove $PluginName 2>&1 | Add-Content -LiteralPath $LogPath
    Log 'plugin add begin'
    & dsh plugin --profile $Profile add $tgzPath 2>&1 | Add-Content -LiteralPath $LogPath
    Log ("plugin add exit=" + $LASTEXITCODE)
  }
} else {
  Log 'skip reinstall (-SkipReinstall)'
}

# 5. Offline verify: the profile config must still carry the plugin line.
if (-not $SkipVerify -and -not $Dry) {
  try {
    $dump = (& dsh --profile $Profile --dump-config 2>&1) | Out-String
    $dump | Add-Content -LiteralPath $LogPath
    if ($dump -match [regex]::Escape($PluginName)) { Log ("verify: " + $PluginName + " line present") }
    else { Log ("verify FAILED: " + $PluginName + " line MISSING from dump-config") }
  } catch { Log ("verify failed: " + $_.ToString()) }
} elseif (-not $Dry) {
  Log 'skip verify (-SkipVerify)'
}

# 6. Relaunch via the normal launcher, hidden.
if ($Dry) {
  Log ("dry: would launch " + $LauncherPath)
} else {
  Start-Process -FilePath $LauncherPath -WindowStyle Hidden
  Log 'launched dsh web'
}

# 7. Online verify: wait for the port to come back, then read the boot log for real failures.
if (-not $Dry) {
  $up = $false
  for ($k = 0; $k -lt 300; $k++) {
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { $up = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if ($up) { Log 'port is listening again' } else { Log 'FAILED: port never came back within 150s' }
  if ($up -and (Test-Path -LiteralPath $WebLog)) {
    $tail = Get-Content -LiteralPath $WebLog -Tail 40 -ErrorAction SilentlyContinue
    $tail | Add-Content -LiteralPath $LogPath
    $bad = $tail | Where-Object { $_ -match 'did not activate|Failed to activate|cannot get property' }
    if ($bad) { Log ("BOOT LOG SHOWS FAILURES: " + ($bad -join ' | ')); exit 8 }
    Log 'boot log tail clean'
  }
}
Log 'dev-restart end'
Write-Output 'dev-restart: done'
exit 0
