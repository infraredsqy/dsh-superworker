# testbed.ps1 —— testbed entry: one command, three actions.
#
#   pwsh -File tools/testbed/testbed.ps1 -Action up      start the testbed instance (isolated home + its own profile + synthetic
#                                                        workspaces + this repo's panel installed into that profile), left running to inspect
#   pwsh -File tools/testbed/testbed.ps1 -Action check   run all five spec completion criteria 1-5, printing each reading; non-zero exit on failure
#   pwsh -File tools/testbed/testbed.ps1 -Action down    stop only the PID this script recorded (verify the command line first, never kill by process name)
#
# Everything it creates lives under -Root (default %LOCALAPPDATA%\dsh-pathfinder-testbed): not in the repo, never touches the main home.
#
# This file is the dispatch and the report, nothing else: which action runs, the reading assembly per criterion
# (Add-Report / Add-Criterion) and the two files a check leaves behind. Everything an action calls lives in the
# three parts the base loads — testbed-mainhome.ps1 (criterion 4's counter-evidence), testbed-fixture.ps1 (the
# synthetic records), testbed-instance.ps1 (tarball, profile, install, start/stop, HTTP) — over
# testbed-lib.ps1, which holds the path and file helpers those parts share.
#
# Parameters: -Workspace renames the workspace, -SessionCount adds a second session, -EmptyWorkspace adds a session-less workspace,
# -Plugin swaps the plugin installed into the profile (default is this repo; relative paths are resolved against the caller's current
# directory; a `.tgz` from npm pack installs in package form), -SeedRecords drops a real record into a synthetic workspace (copied as `.pf`,
# effective on the up action only; without it the workspace is untouched — the default run creates one workspace and one session.

#Requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('up', 'check', 'down')][string]$Action,
  [string]$Root = '',
  [string]$Profile = 'pf-testbed',
  [string]$Workspace = 'workspace-alpha',
  [int]$SessionCount = 1,
  [string]$EmptyWorkspace = '',
  [string]$MainHome = '',
  [int]$ReadyTimeoutSeconds = 30,
  [string]$DshCmd = 'dsh',
  [string]$NodeExe = 'node',
  [string]$Plugin = '',
  [string]$SeedRecords = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'testbed-lib.ps1')

if ($Root.Length -eq 0) { $Root = Join-Path $env:LOCALAPPDATA 'dsh-pathfinder-testbed' }
if ($MainHome.Length -eq 0) { $MainHome = Join-Path $env:USERPROFILE '.dsh' }
# The default plugin is this repo: two levels up from `tools\testbed\` is the project root.
if ($Plugin.Length -eq 0) { $Plugin = Join-Path $PSScriptRoot '..\..' }
# Normalize to an absolute path at the entry: the artifact pre-check and what goes to
# `dsh plugin --profile … add` must be the same value. Otherwise each resolves the relative path
# against its own base — the pre-check against the caller's current directory (so it passes), dsh
# against the profile directory (so it installs a nonexistent directory), and the error then points
# at the profile directory.
$Plugin = [System.IO.Path]::GetFullPath($Plugin)

# Spawn in Application form: Start-Process does not guess extensions and never touches the extensionless POSIX shim in the npm directory.
$DshCmd = Resolve-ApplicationExecutable -Name $DshCmd
$NodeExe = Resolve-ApplicationExecutable -Name $NodeExe


# ---------------------------------------------------------------------------
# Action: down
# ---------------------------------------------------------------------------
if ($Action -eq 'down') {
  $safeRoot = Assert-SafeRoot -Root $Root -MainHome $MainHome
  $stopped = Stop-TestbedInstance -Root $safeRoot -Profile $Profile
  Write-Host "testbed root : $safeRoot"
  Write-Host "stopped      : $stopped"
  exit 0
}

# ---------------------------------------------------------------------------
# Action: up
# ---------------------------------------------------------------------------
if ($Action -eq 'up') {
  $safeRoot = Assert-SafeRoot -Root $Root -MainHome $MainHome
  $manifest = Invoke-TestbedProvision -Root $safeRoot -Profile $Profile -Workspace $Workspace `
    -SessionCount $SessionCount -EmptyWorkspace $EmptyWorkspace -DshCmd $DshCmd -NodeExe $NodeExe
  $testbedHome = [string]$manifest.home
  # Optional: drop a real record into a synthetic workspace (the panel reads the workspace-level
  # `.pf`). Without it the workspace is untouched — the default run and check's five criteria never
  # pass through here.
  $recordsReading = @()
  if ($SeedRecords.Length -gt 0) {
    $recordsReading = @(Add-TestbedRecords -Manifest $manifest -RecordsPath $SeedRecords)
  }
  # Install the panel into the isolated profile: of the "one command" this cell must hand over, the
  # "panel installed and pointing at the synthetic workspace" half lands on this step. A failed
  # install stops right here — never start an instance without the panel.
  $pluginReading = Install-TestbedPlugin -Root $safeRoot -TestbedHome $testbedHome -Profile $Profile `
    -PluginPath $Plugin -DshCmd $DshCmd
  $instancePid = Start-TestbedInstance -Root $safeRoot -TestbedHome $testbedHome -Profile $Profile -DshCmd $DshCmd -NodeExe $NodeExe
  $ready = Wait-TestbedReady -Root $safeRoot -ProcessId $instancePid -TimeoutSeconds $ReadyTimeoutSeconds
  # The install must be visible: ask the running instance for two readings (the settings namespace
  # roster + the boot manifest handed to the browser).
  $rawDir = Join-Path $safeRoot 'logs\raw'
  if (-not (Test-Path -LiteralPath $rawDir)) { New-Item -ItemType Directory -Force -Path $rawDir | Out-Null }
  $mountReading = Get-TestbedPanelMount -Port $ready.port -Url $ready.url -PluginName $pluginReading.plugin `
    -PluginId $pluginReading.pluginId -EvidenceDir $rawDir

  Write-Host "testbed root : $safeRoot"
  Write-Host "isolated home: $testbedHome"
  foreach ($ws in $manifest.workspaces) {
    Write-Host "workspace    : $($ws.workspaceId) '$($ws.name)' sessions=$(@($ws.sessionIds).Count) path=$($ws.path)"
  }
  foreach ($session in $manifest.sessions) {
    Write-Host "session      : $($session.sessionId) -> $($session.logPath)"
  }
  Write-Host "pid          : $instancePid"
  Write-Host "url          : $($ready.url)"
  Write-Host ''
  Write-Host "panel        : $($pluginReading.plugin) <- $($pluginReading.recordedSpec)"
  Write-Host "panel row    : $($pluginReading.composedRow)"
  Write-Host "panel source : form=$($pluginReading.packageForm) path=$($pluginReading.pluginSource)$(if ($pluginReading.tarballSha256.Length -gt 0) { " sha256=$($pluginReading.tarballSha256)" } else { '' })"
  Write-Host "panel entries: $(@($pluginReading.entries | ForEach-Object { "$($_.spec) -> $($_.path) (exists=$($_.exists) $($_.bytes)B)" }) -join ' ｜ ')"
  Write-Host "panel mount  : settings namespace '$($mountReading.namespace)' is served by the live instance (namespaces=$($mountReading.namespaceCount)) ｜ boot manifest lists $($mountReading.clientBundleRef) (page $($mountReading.pageBytes) chars)"
  Write-Host "panel builds : $(@($pluginReading.artifacts | ForEach-Object { "$($_.relative) $($_.bytes)B" }) -join ', ')"
  foreach ($reading in $recordsReading) {
    Write-Host "records      : .pf seeded into $($reading.workspacePath) (files=$($reading.fileCount) bytes=$($reading.totalBytes))"
  }
  Write-Host ''
  foreach ($line in (Get-TestbedListCommandLines -Port $ready.port -Token $ready.token -SessionIds @($manifest.sessions | ForEach-Object { [string]$_.sessionId }))) {
    Write-Host $line
  }
  exit 0
}

# ---------------------------------------------------------------------------
# Action: check —— run completion criteria 1-5 one by one
# ---------------------------------------------------------------------------
$safeRoot = Assert-SafeRoot -Root $Root -MainHome $MainHome
$startedAt = Get-Date
$report = New-Object System.Collections.Generic.List[string]
$readings = [ordered]@{ startedAt = $startedAt.ToString('o'); root = $safeRoot; mainHome = $MainHome; criteria = @() }
$failures = New-Object System.Collections.Generic.List[string]

function Add-Report {
  param([string]$Text)
  $report.Add($Text)
  Write-Host $Text
}

function Add-Criterion {
  param([string]$Id, [string]$Title, [bool]$Passed, [AllowEmptyCollection()][string[]]$Lines)
  $readings.criteria += [ordered]@{ id = $Id; title = $Title; passed = $Passed; readings = @($Lines) }
  Add-Report ("[{0}] {1} : {2}" -f $(if ($Passed) { 'PASS' } else { 'FAIL' }), $Id, $Title)
  foreach ($line in $Lines) { Add-Report ("      " + $line) }
  if (-not $Passed) { $failures.Add($Id) }
}

Add-Report "testbed root : $safeRoot"
Add-Report "isolated home: $(Join-Path $safeRoot 'home')"
Add-Report "main home    : $MainHome"
Add-Report ''

# Counter-evidence readings for the main home (criterion 4's terms):
#   * The witness set is taken only in observation windows when no testbed instance is running:
#     stop our own instance first, take a lightweight scan (length and mtime only), then a full
#     fingerprint; paths touched between the two are the witness set. After the run (including the
#     restart pass), with the instance fully stopped, take another lightweight scan and another full
#     fingerprint for a second window. This is positive evidence that other live sessions really do
#     write during the window — the testbed has no process running during either one.
#   * The post-run full fingerprint is compared with the pre-run one: every change needs positive
#     ownership evidence to be exempted, and the two kinds of evidence are unioned —
#     S1 structural (project key differs from every key this fixture derives + the encoding suffix
#     is one this profile cannot write; both must hold) and
#     S2 witnessed (paths really touched in a "no instance running" window). Changes with neither
#     kind fail outright; deletions, paths carrying a testbed-made name, and any change in the two
#     quiet areas are hard failures and never exempt. How many were exempted and on what grounds is
#     printed line by line in the readings.
$null = Stop-TestbedInstance -Root $safeRoot -Profile $Profile
$metaBeforeRun = Get-MainHomeMetaScan -MainHome $MainHome
$fingerprintStart = Get-Date
$pass2 = Get-MainHomeFingerprint -MainHome $MainHome
$fingerprintPassSeconds = [math]::Round(((Get-Date) - $fingerprintStart).TotalSeconds, 2)

$witnessBeforeRun = [ordered]@{}
$liveWitness = New-Object System.Collections.Generic.HashSet[string]
foreach ($name in $pass2.Keys) {
  $areaWitness = New-Object System.Collections.Generic.List[string]
  foreach ($rel in (Get-TouchedPaths -MetaBefore $metaBeforeRun[$name] -FingerprintAfter $pass2[$name])) {
    $areaWitness.Add($rel)
    $null = $liveWitness.Add("$name/$rel")
  }
  $witnessBeforeRun[$name] = @($areaWitness.ToArray())
}

try {
  $manifest = Invoke-TestbedProvision -Root $safeRoot -Profile $Profile -Workspace $Workspace `
    -SessionCount $SessionCount -EmptyWorkspace $EmptyWorkspace -DshCmd $DshCmd -NodeExe $NodeExe
  $testbedHome = [string]$manifest.home

  # Completion criterion 5, reading one: before the instance starts, the isolated home holds no credentials.
  $credentialsBeforeStart = Test-Path -LiteralPath (Join-Path $testbedHome '.credentials.yaml')

  $instancePid = Start-TestbedInstance -Root $safeRoot -TestbedHome $testbedHome -Profile $Profile -DshCmd $DshCmd -NodeExe $NodeExe
  $ready1 = Wait-TestbedReady -Root $safeRoot -ProcessId $instancePid -TimeoutSeconds $ReadyTimeoutSeconds
  $urlLine1 = (Select-String -LiteralPath (Join-Path $safeRoot 'logs\instance.out.log') -Pattern 'dsh web:' | Select-Object -First 1).Line
  $run1 = Invoke-TestbedRun -Root $safeRoot -Manifest $manifest -Ready $ready1
  $credentialsAfterStart = ''
  $credentialsPath = Join-Path $testbedHome '.credentials.yaml'
  if (Test-Path -LiteralPath $credentialsPath) { $credentialsAfterStart = (Get-Content -LiteralPath $credentialsPath -Raw) }
  Write-TextFile -Path (Join-Path $safeRoot 'logs\raw\credentials-after-first-start.txt') -Text $credentialsAfterStart
  $null = Stop-TestbedInstance -Root $safeRoot -Profile $Profile

  # Completion criterion 3: restart a second instance; the first two criteria still hold.
  $instancePid2 = Start-TestbedInstance -Root $safeRoot -TestbedHome $testbedHome -Profile $Profile -DshCmd $DshCmd -NodeExe $NodeExe
  $ready2 = Wait-TestbedReady -Root $safeRoot -ProcessId $instancePid2 -TimeoutSeconds $ReadyTimeoutSeconds
  $run2 = Invoke-TestbedRun -Root $safeRoot -Manifest $manifest -Ready $ready2
  $null = Stop-TestbedInstance -Root $safeRoot -Profile $Profile

  # Open the second observation window only after the instance is fully stopped (again "no testbed
  # instance running"); the witness set is the union of both windows.
  $metaAfterRun = Get-MainHomeMetaScan -MainHome $MainHome
  $fingerprintEnd = Get-MainHomeFingerprint -MainHome $MainHome
  $witnessAfterRun = [ordered]@{}
  foreach ($name in $fingerprintEnd.Keys) {
    $areaWitness = New-Object System.Collections.Generic.List[string]
    foreach ($rel in (Get-TouchedPaths -MetaBefore $metaAfterRun[$name] -FingerprintAfter $fingerprintEnd[$name])) {
      $areaWitness.Add($rel)
      $null = $liveWitness.Add("$name/$rel")
    }
    $witnessAfterRun[$name] = @($areaWitness.ToArray())
  }

  # ---- Criterion 1: one command prints the session list; the synthetic session is in it; opening it raises no error ----
  $criterion1 = Get-SessionListCriterion -Run $run1
  Add-Criterion -Id '1' -Title 'session list contains the synthetic session and opening it returns a page' `
    -Passed $criterion1.Passed -Lines @($criterion1.Lines)

  # ---- Criterion 2: the session is grouped under the synthetic workspace, not ungrouped ----
  $criterion2 = Get-GroupingCriterion -Run $run1
  Add-Criterion -Id '2' -Title 'the session is grouped under the synthetic workspace, not ungrouped' `
    -Passed $criterion2.Passed -Lines @($criterion2.Lines)

  # ---- Criterion 3: after restarting a second instance, the two criteria above still hold ----
  $criterion3 = Get-RestartCriterion -Run $run2 -ProcessId $instancePid2
  Add-Criterion -Id '3' -Title 'after restarting the instance, criteria 1 and 2 still hold' `
    -Passed $criterion3.Passed -Lines @($criterion3.Lines)

  # ---- Criterion 4: the main home's three areas, every change attributed ----
  # The reading assembly — the four mutually exclusive buckets, the S1 structural / S2 witnessed
  # ownership terms, the partition self-check, and the no-listener / no-stray-process assertions —
  # lives with the fingerprints it reads, in testbed-mainhome.ps1. This entry hands over both
  # observation windows and prints what comes back.
  $criterion4 = Get-MainHomeCriterion -Root $safeRoot -Profile $Profile -Manifest $manifest `
    -Before $pass2 -After $fingerprintEnd -LiveWitness @($liveWitness) `
    -WindowBeforeRun $witnessBeforeRun -WindowAfterRun $witnessAfterRun `
    -InstancePids @($instancePid, $instancePid2) -Run $run2
  Add-Criterion -Id '4' -Title 'main home: every changed path carries its own positive ownership evidence (S1 structural or S2 witness; deletions, testbed-made names and quiet-area changes never exempt), and this testbed left no listener and no process of its own identity behind' `
    -Passed $criterion4.Passed -Lines @($criterion4.Lines)

  # ---- Criterion 5: the isolated environment starts without credentials ----
  # Before the instance starts, the isolated home holds no credentials; after it starts, only the
  # browser-session record the web app issues itself may appear.
  $criterion5 = Get-CredentialsCriterion -PresentBeforeStart $credentialsBeforeStart `
    -CredentialsAfterStart $credentialsAfterStart -TestbedHome $testbedHome -UrlLine $urlLine1
  Add-Criterion -Id '5' -Title 'the isolated instance starts with no credentials supplied (no fake model service needed)' `
    -Passed $criterion5.Passed -Lines @($criterion5.Lines)

  $readings['firstRun'] = $run1
  $readings['secondRun'] = $run2
  $readings['credentialsPresentBeforeFirstStart'] = $credentialsBeforeStart
  $readings['credentialsAfterFirstStart'] = $credentialsAfterStart
  $readings['mainHomeBefore'] = [ordered]@{}
  $readings['mainHomeAfter'] = [ordered]@{}
  foreach ($name in $pass2.Keys) {
    $readings['mainHomeBefore'][$name] = Get-FingerprintSummary -Fingerprint $pass2[$name]
    $readings['mainHomeAfter'][$name] = Get-FingerprintSummary -Fingerprint $fingerprintEnd[$name]
  }
  $readings['liveWriteWitness'] = @($liveWitness)
  $readings['witnessWindow1BeforeRun'] = $witnessBeforeRun
  $readings['witnessWindow2AfterRun'] = $witnessAfterRun
}
catch {
  Add-Report ("[FAIL] check aborted: " + $_.Exception.Message)
  Add-Report ($_.ScriptStackTrace)
  $failures.Add('aborted')
}
finally {
  $null = Stop-TestbedInstance -Root $safeRoot -Profile $Profile
}

$elapsed = [math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1)
$readings['elapsedSeconds'] = $elapsed
$readings['fingerprintPassSeconds'] = $fingerprintPassSeconds
Add-Report ''
Add-Report "elapsed: $elapsed s (two full main-home fingerprints at ~$fingerprintPassSeconds s each, plus two lightweight metadata scans)"
Add-Report "failed criteria: $(if ($failures.Count -eq 0) { 'none' } else { ($failures -join ', ') })"

Write-TextFile -Path (Join-Path $safeRoot 'logs\check-report.txt') -Text (($report -join "`n") + "`n")
Write-TextFile -Path (Join-Path $safeRoot 'logs\readings.json') -Text (($readings | ConvertTo-Json -Depth 20) + "`n")

if ($failures.Count -gt 0) { exit 1 }
exit 0
