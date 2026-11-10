# inject-probe.ps1 -- the real-instance readings for the instruction-context node
# (f7206ae1): judgement 3 (a session's context carries the instructions in force, a changed
# entry shows up on the next turn, and the panel's instruction column agrees), judgement 4
# (with the instruction plugin moved away the injection idles, DSH still boots, the panel still
# mounts), and judgement 5, the linked-worktree form (a session whose cwd is a git checkout of its
# main tree carries the main tree's listing -- the shape a node's fork-mode session has, and the
# reason the root resolution leads back to the main tree).
#
# One command, one run:  pwsh -File tools/testbed/inject-probe.ps1
#
# Everything it builds lives under -Root (default %LOCALAPPDATA%\dsh-superworker-inject-probe);
# it provisions a fresh isolated home + profile, stages a copy of this checkout's built package,
# installs that copy, and drives real sessions. The main home and the main profile are never
# touched. The instance it starts is stopped again in the finally block, by the PID it recorded
# (never by process name).
#
# The evidence: <Root>\logs\inject-probe-readings.json plus the raw API exchanges under
# <Root>\logs\raw\. Judgement 5 provisions the root again, and a provision deletes it wholesale
# (testbed-instance.ps1 Invoke-TestbedProvision), its session log -- held open by the running
# instance -- included. So every judgement's snapshot block, session log and raw exchanges are
# copied into "<Root>-evidence", a sibling directory no provision touches, before the next
# provision runs; -EvidenceDir (which must live outside -Root) hands that whole set over into a
# node's temp/ folder. A piece that could not be carried out is written into the readings as
# missing, never skipped in silence.
#
# How the session's context is read: a model step appends the runtime-context snapshot as a
# durable user message ("Current runtime context. This snapshot supersedes earlier runtime-context
# snapshots."). The isolated home carries no model credentials, so the model call itself fails
# after that append -- which is exactly the observation this probe needs: the step assembled, the
# snapshot landed, nothing was fetched. No fake model service is required.
#
#Parameters: -Workspace names the synthetic workspace, -Sentence is the instruction the record
# starts with, -ChangedSentence is the one it is changed to, -StepTimeoutSeconds bounds the wait
# for one snapshot to land, -EvidenceDir copies the readings and the preserved evidence out.

#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$Root = '',
  [string]$Profile = 'superworker-inject-probe',
  [string]$Workspace = 'workspace-inject',
  [string]$MainHome = '',
  [string]$DshCmd = 'dsh',
  [string]$NodeExe = 'node',
  [string]$Plugin = '',
  [int]$ReadyTimeoutSeconds = 30,
  [int]$StepTimeoutSeconds = 25,
  [string]$Sentence = 'write the report before the next turn',
  [string]$ChangedSentence = 'write the report only after the review',
  [string]$EvidenceDir = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'testbed-lib.ps1')

if ($Root.Length -eq 0) { $Root = Join-Path $env:LOCALAPPDATA 'dsh-superworker-inject-probe' }
if ($MainHome.Length -eq 0) { $MainHome = Join-Path $env:USERPROFILE '.dsh' }
if ($Plugin.Length -eq 0) { $Plugin = Join-Path $PSScriptRoot '..\..' }
$Plugin = [System.IO.Path]::GetFullPath($Plugin)
$DshCmd = Resolve-ApplicationExecutable -Name $DshCmd
$NodeExe = Resolve-ApplicationExecutable -Name $NodeExe

$SnapshotMarker = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'
$ListingHead = 'instruction(s) visible from this step:'

$readings = [ordered]@{
  startedAt = (Get-Date).ToString('o')
  root = $Root
  mainHome = $MainHome
  plugin = $Plugin
  sentence = $Sentence
  changedSentence = $ChangedSentence
  judgement3 = [ordered]@{ passed = $false; readings = @(); snapshots = [ordered]@{} }
  judgement4 = [ordered]@{ passed = $false; readings = @(); snapshots = [ordered]@{} }
  judgement5 = [ordered]@{ covered = $false; passed = $false; readings = @(); snapshots = [ordered]@{} }
  evidence = @()
}
$failures = New-Object System.Collections.Generic.List[string]

function Note3 {
  param([string]$Text)
  $readings.judgement3.readings += $Text
  Write-Host ("  " + $Text)
}

function Note4 {
  param([string]$Text)
  $readings.judgement4.readings += $Text
  Write-Host ("  " + $Text)
}

function Note5 {
  param([string]$Text)
  $readings.judgement5.readings += $Text
  Write-Host ("  " + $Text)
}

# ---------------------------------------------------------------------------
# Evidence that outlives a provision
# ---------------------------------------------------------------------------

# Copy one piece of evidence into the stage directory: a file, or a directory merged file by file
# (judgement 5's exchanges join the judgement 3/4 ones under one raw/). -Replace clears the
# destination directory first, for the hand-over into -EvidenceDir. Every call records its outcome
# in $readings.evidence -- a source that is not there is a reading, never a silent skip.
function Save-Evidence {
  param([Parameter(Mandatory = $true)][string]$Source, [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$Label, [switch]$Replace)
  $entry = [ordered]@{ label = $Label; source = $Source; destination = $Destination; copied = $false; missing = $false }
  if (-not (Test-Path -LiteralPath $Source)) {
    $entry.missing = $true
    $readings.evidence += $entry
    Write-Host ("  evidence MISSING: " + $Label + " -- " + $Source)
    return
  }
  if (Test-Path -LiteralPath $Source -PathType Container) {
    if ($Replace -and (Test-Path -LiteralPath $Destination)) { Remove-Item -LiteralPath $Destination -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    foreach ($item in @(Get-ChildItem -LiteralPath $Source)) {
      Copy-Item -LiteralPath $item.FullName -Destination $Destination -Recurse -Force
    }
  } else {
    $parent = Split-Path -Parent $Destination
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
  }
  $entry.copied = $true
  $readings.evidence += $entry
  Write-Host ("  evidence saved: " + $Label)
}

# One snapshot block exactly as it stood in the log at read time, with a header line so the file
# says what it is without the readings beside it.
function Write-SnapshotFile {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Note, [string]$Text)
  Write-TextFile -Path $Path -Text ("# " + $Note + "`n`n" + $Text)
}

# ---------------------------------------------------------------------------
# The synthetic record: one live global entry, written the way the plugin writes it
# ---------------------------------------------------------------------------
function Write-InstructionRecord {
  param([Parameter(Mandatory = $true)][string]$WorkspacePath, [Parameter(Mandatory = $true)][string]$Text)
  $dir = Join-Path $WorkspacePath '.superworker'
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $record = [ordered]@{
    instructions = @([ordered]@{
      id = 'i-0001'
      text = $Text
      scope = 'global'
      target = 'stage'
      state = 'live'
      cycle = $null
      node = $null
      said_by = 'user'
      at = '2026-11-10T00:00:00Z'
      resolved_at = $null
      note = $null
    })
  }
  Write-TextFile -Path (Join-Path $dir 'instructions.json') -Text (($record | ConvertTo-Json -Depth 10) + "`n")
}

# The plugin package as it is installed, staged into the disposable root: the copy is what gets
# installed, so judgement 4 can move the instruction plugin away without touching this checkout.
function New-StagedPlugin {
  param([Parameter(Mandatory = $true)][string]$Source, [Parameter(Mandatory = $true)][string]$Destination)
  if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  foreach ($name in @('package.json', 'cordis.patch.yml')) {
    Copy-Item -LiteralPath (Join-Path $Source $name) -Destination $Destination -Force
  }
  foreach ($name in @('lib', 'locale')) {
    Copy-Item -LiteralPath (Join-Path $Source $name) -Destination $Destination -Recurse -Force
  }
  $engine = Join-Path $Destination 'packages\superworker-core'
  New-Item -ItemType Directory -Force -Path $engine | Out-Null
  Copy-Item -LiteralPath (Join-Path $Source 'packages\superworker-core\dist') -Destination $engine -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $Source 'packages\superworker-core\plugins') -Destination $engine -Recurse -Force
  return $Destination
}

# ---------------------------------------------------------------------------
# One instance cycle: start, wait, connect
# ---------------------------------------------------------------------------
function Start-Cycle {
  param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][string]$TestbedHome,
    [Parameter(Mandatory = $true)][string]$Profile, [Parameter(Mandatory = $true)][string]$DshCmd,
    [Parameter(Mandatory = $true)][string]$NodeExe, [Parameter(Mandatory = $true)][int]$TimeoutSeconds)
  $instancePid = Start-TestbedInstance -Root $Root -TestbedHome $TestbedHome -Profile $Profile -DshCmd $DshCmd -NodeExe $NodeExe
  $ready = Wait-TestbedReady -Root $Root -ProcessId $instancePid -TimeoutSeconds $TimeoutSeconds
  $browser = Connect-TestbedBrowser -Url $ready.url
  return [ordered]@{ processId = $instancePid; ready = $ready; browser = $browser }
}

function Send-Prompt {
  param([Parameter(Mandatory = $true)]$Cycle, [Parameter(Mandatory = $true)][string]$SessionId,
    [Parameter(Mandatory = $true)][string]$Text, [Parameter(Mandatory = $true)][string]$EvidencePath)
  $request = [ordered]@{
    requestId = [guid]::NewGuid().ToString('n')
    sessionId = $SessionId
    mode = 'queue'
    content = @(@{ type = 'text'; text = $Text })
  }
  return Invoke-TestbedApi -Port $Cycle.ready.port -WebSession $Cycle.browser -Endpoint 'session/prompt' `
    -Arguments ([ordered]@{ request = $request }) -EvidencePath $EvidencePath
}

# The session log is held open by the instance: read it through a share that permits the writer
# to keep appending while it is being read.
function Read-Shared {
  param([Parameter(Mandatory = $true)][string]$Path)
  $stream = $null
  $reader = $null
  try {
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    $reader = New-Object System.IO.StreamReader($stream)
    return $reader.ReadToEnd()
  } finally {
    if ($reader -ne $null) { $reader.Dispose() }
    if ($stream -ne $null) { $stream.Dispose() }
  }
}

# Wait until the session log carries one more snapshot than it did, then count the markers.
#
# This is a bounded read poll on purpose: the log is a durable file another process appends to,
# and that append raises no event this process can subscribe to (no handle, no signal). The poll
# is capped by -StepTimeoutSeconds and returns as soon as the count is reached, so it costs one
# wait, not a fixed sleep.
function Wait-Snapshots {
  param([Parameter(Mandatory = $true)][string]$LogPath, [Parameter(Mandatory = $true)][int]$AtLeast,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  for (;;) {
    $text = ''
    if (Test-Path -LiteralPath $LogPath) { $text = Read-Shared -Path $LogPath }
    $count = ([regex]::Matches($text, [regex]::Escape($SnapshotMarker))).Count
    if ($count -ge $AtLeast) { return @{ text = $text; count = $count } }
    if ((Get-Date) -ge $deadline) { return @{ text = $text; count = $count } }
    Start-Sleep -Milliseconds 200
  }
}

# The last snapshot in the log, as the message the model saw: the text of the last `runtime-context`
# user message record that carries the marker. Everything else around it in the log (request
# headers, skill catalogues, the failed model attempt) stays out of it -- the session log is kept
# whole as evidence beside it, so nothing is lost, but the snapshot file reads as the context block.
function Last-Snapshot {
  param([Parameter(Mandatory = $true)][string]$LogText)
  $found = ''
  foreach ($line in ($LogText -split "`n")) {
    $trimmed = $line.Trim()
    if ($trimmed.Length -eq 0) { continue }
    try { $record = $trimmed | ConvertFrom-Json } catch { continue }
    if ([string]$record.type -ne 'user/message') { continue }
    if ($record.data -eq $null -or $record.data.source -eq $null) { continue }
    if ([string]$record.data.source.kind -ne 'runtime-context') { continue }
    $content = @($record.data.content)
    if ($content.Count -eq 0 -or $content[0].text -eq $null) { continue }
    $text = [string]$content[0].text
    if ($text.Contains($SnapshotMarker)) { $found = $text }
  }
  return $found
}

function Get-PanelInstructionRows {
  param([Parameter(Mandatory = $true)]$Cycle, [Parameter(Mandatory = $true)][string]$SessionId,
    [Parameter(Mandatory = $true)][string]$EvidencePath)
  $reading = Invoke-TestbedApi -Port $Cycle.ready.port -WebSession $Cycle.browser -Endpoint 'superworker/read' `
    -Arguments ([ordered]@{ sessionId = $SessionId; workspaceRoot = '' }) `
    -EvidencePath $EvidencePath
  return @($reading.instructions)
}

# ---------------------------------------------------------------------------
# The run
# ---------------------------------------------------------------------------
$safeRoot = Assert-SafeRoot -Root $Root -MainHome $MainHome
$null = Stop-TestbedInstance -Root $safeRoot -Profile $Profile
$rawDir = Join-Path $safeRoot 'logs\raw'
if (-not (Test-Path -LiteralPath $rawDir)) { New-Item -ItemType Directory -Force -Path $rawDir | Out-Null }

# The stage directory: the evidence home that survives a provision. It is a sibling of -Root by
# construction (same parent, one extra suffix), so Invoke-TestbedProvision's "delete -Root" never
# reaches it. Cleared here, at the start of a run, so what it holds afterwards is only this run's.
$stageDir = $safeRoot + '-evidence'
if (Test-Path -LiteralPath $stageDir) { Remove-Item -LiteralPath $stageDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
$readings.evidenceStage = $stageDir

# An evidence directory inside -Root would be deleted by the judgement-5 provision: fall back to
# the stage directory instead of promising a hand-over that cannot happen.
if ($EvidenceDir.Length -gt 0) {
  $evidenceFull = [System.IO.Path]::GetFullPath($EvidenceDir).TrimEnd('\')
  if ($evidenceFull -eq $safeRoot -or $evidenceFull.StartsWith($safeRoot + '\')) {
    $readings.evidenceDirIgnored = $evidenceFull
    Write-Host "evidence dir inside -Root ignored (a provision deletes -Root): $evidenceFull"
    $EvidenceDir = ''
  }
}

Write-Host "inject probe  : $safeRoot"
Write-Host "plugin        : $Plugin"
Write-Host ''

$exitCode = 1
try {
  $manifest = Invoke-TestbedProvision -Root $safeRoot -Profile $Profile -Workspace $Workspace `
    -SessionCount 1 -DshCmd $DshCmd -NodeExe $NodeExe
  $testbedHome = [string]$manifest.home
  $session = @($manifest.sessions)[0]
  $wsFixture = @($manifest.workspaces)[0]
  $sessionId = [string]$session.sessionId
  $logPath = [string]$session.logPath
  $readings.sessionId = $sessionId
  $readings.workspacePath = [string]$wsFixture.path
  $readings.sessionLog = $logPath

  $staged = New-StagedPlugin -Source $Plugin -Destination (Join-Path $safeRoot 'plugin-staged')
  $install = Install-TestbedPlugin -Root $safeRoot -TestbedHome $testbedHome -Profile $Profile `
    -PluginPath $staged -DshCmd $DshCmd
  $readings.pluginInstall = [ordered]@{ plugin = $install.plugin; recordedSpec = $install.recordedSpec; composedRow = $install.composedRow }

  Write-InstructionRecord -WorkspacePath ([string]$wsFixture.path) -Text $Sentence

  # ---- Judgement 3: the session's own context carries the instructions, a change lands on the
  # next turn, and the panel's instruction column agrees ----
  $cycle = Start-Cycle -Root $safeRoot -TestbedHome $testbedHome -Profile $Profile -DshCmd $DshCmd `
    -NodeExe $NodeExe -TimeoutSeconds $ReadyTimeoutSeconds
  $readings.judgement3.readings += "instance up: pid=$($cycle.processId) url=http://127.0.0.1:$($cycle.ready.port)/"

  $mount = Get-TestbedPanelMount -Port $cycle.ready.port -Url $cycle.ready.url -PluginName $install.plugin `
    -PluginId $install.pluginId -EvidenceDir $rawDir
  Note3 "panel mounts: settings namespace '$($mount.namespace)', boot page lists $($mount.clientBundleRef) ($($mount.pageBytes) chars)"

  $prompt1 = $null
  try {
    $prompt1 = Send-Prompt -Cycle $cycle -SessionId $sessionId -Text 'say one word' -EvidencePath (Join-Path $rawDir 'prompt-1')
    Note3 "prompt 1 accepted: accepted=$($prompt1.accepted)"
  } catch {
    Note3 "prompt 1 refused: $($_.Exception.Message)"
  }
  $pass1 = Wait-Snapshots -LogPath $logPath -AtLeast 1 -TimeoutSeconds $StepTimeoutSeconds
  $snap1 = Last-Snapshot -LogText $pass1.text
  $readings.judgement3.snapshots.afterPrompt1 = $snap1
  Note3 "snapshots after prompt 1: $($pass1.count); listing present=$($snap1.Contains($ListingHead)); the sentence present=$($snap1.Contains($Sentence))"

  $rows1 = @()
  try {
    $rows1 = Get-PanelInstructionRows -Cycle $cycle -SessionId $sessionId -EvidencePath (Join-Path $rawDir 'panel-read-1')
    Note3 "panel instruction rows: $(@($rows1).Count) -> $(@($rows1 | ForEach-Object { $_.text }) -join ' | ')"
  } catch {
    Note3 "panel read failed: $($_.Exception.Message)"
  }

  # The change: the same entry, a new sentence. Written straight into the record the way the
  # account holds it (one live entry, same id).
  Write-InstructionRecord -WorkspacePath ([string]$wsFixture.path) -Text $ChangedSentence
  $prompt2 = $null
  try {
    $prompt2 = Send-Prompt -Cycle $cycle -SessionId $sessionId -Text 'say one more word' -EvidencePath (Join-Path $rawDir 'prompt-2')
    Note3 "prompt 2 accepted: accepted=$($prompt2.accepted)"
  } catch {
    Note3 "prompt 2 refused: $($_.Exception.Message)"
  }
  $pass2 = Wait-Snapshots -LogPath $logPath -AtLeast 2 -TimeoutSeconds $StepTimeoutSeconds
  $snap2 = Last-Snapshot -LogText $pass2.text
  $readings.judgement3.snapshots.afterPrompt2 = $snap2
  Note3 "snapshots after prompt 2: $($pass2.count); the changed sentence present=$($snap2.Contains($ChangedSentence)); the old sentence gone=$(-not $snap2.Contains($Sentence))"

  $rows2 = @()
  try {
    $rows2 = Get-PanelInstructionRows -Cycle $cycle -SessionId $sessionId -EvidencePath (Join-Path $rawDir 'panel-read-2')
    Note3 "panel instruction rows after the change: $(@($rows2).Count) -> $(@($rows2 | ForEach-Object { $_.text }) -join ' | ')"
  } catch {
    Note3 "panel read after the change failed: $($_.Exception.Message)"
  }

  $panelAgrees = ($snap2.Contains($ChangedSentence) -and (@($rows2 | Where-Object { [string]$_.text -eq $ChangedSentence }).Count -ge 1))
  $judgement3 = (
    ($pass1.count -ge 1) -and $snap1.Contains($ListingHead) -and $snap1.Contains($Sentence) -and
    ($pass2.count -ge 2) -and $snap2.Contains($ChangedSentence) -and (-not $snap2.Contains($Sentence)) -and
    $panelAgrees
  )
  $readings.judgement3.passed = [bool]$judgement3
  Note3 "judgement 3: $(if ($judgement3) { 'PASS' } else { 'FAIL' })"
  if (-not $judgement3) { $failures.Add('judgement-3') }

  $null = Stop-TestbedInstance -Root $safeRoot -Profile $Profile

  # ---- Judgement 4: with the instruction plugin moved away, the injection idles (not one byte
  # of the listing), DSH still boots, and the panel still mounts ----
  $pluginRoot = Join-Path $testbedHome ('profiles\' + $Profile + '\node_modules\' + $install.plugin + '\packages\superworker-core\plugins')
  $instructionAt = Join-Path $pluginRoot 'instruction'
  if (-not (Test-Path -LiteralPath $instructionAt)) {
    # A profile that linked the package: follow the link to the staged copy the install pointed at.
    $instructionAt = Join-Path $staged 'packages\superworker-core\plugins\instruction'
  }
  $moved = $instructionAt + '.away'
  if (Test-Path -LiteralPath $moved) { Remove-Item -LiteralPath $moved -Recurse -Force }
  Rename-Item -LiteralPath $instructionAt -NewName 'instruction.away'
  Note4 "instruction plugin moved away: $instructionAt -> $moved"

  try {
    $cycle2 = Start-Cycle -Root $safeRoot -TestbedHome $testbedHome -Profile $Profile -DshCmd $DshCmd `
      -NodeExe $NodeExe -TimeoutSeconds $ReadyTimeoutSeconds
    Note4 "instance up with no instruction plugin: pid=$($cycle2.processId) url=http://127.0.0.1:$($cycle2.ready.port)/"

    $mount2 = Get-TestbedPanelMount -Port $cycle2.ready.port -Url $cycle2.ready.url -PluginName $install.plugin `
      -PluginId $install.pluginId -EvidenceDir $rawDir
    Note4 "panel still mounts: settings namespace '$($mount2.namespace)', boot page lists $($mount2.clientBundleRef)"

    $prompt3 = $null
    try {
      $prompt3 = Send-Prompt -Cycle $cycle2 -SessionId $sessionId -Text 'say a third word' -EvidencePath (Join-Path $rawDir 'prompt-3')
      Note4 "prompt 3 accepted: accepted=$($prompt3.accepted)"
    } catch {
      Note4 "prompt 3 refused: $($_.Exception.Message)"
    }
    $pass3 = Wait-Snapshots -LogPath $logPath -AtLeast 3 -TimeoutSeconds $StepTimeoutSeconds
    $snap3 = Last-Snapshot -LogText $pass3.text
    $readings.judgement4.snapshots.afterPrompt3 = $snap3
    $idle = (-not $snap3.Contains($ListingHead)) -and (-not $snap3.Contains($ChangedSentence))
    Note4 "snapshots after prompt 3: $($pass3.count); listing present=$($snap3.Contains($ListingHead)); the recording sentence present=$($snap3.Contains($ChangedSentence)) -> idle=$idle"

    $judgement4 = ($idle -and $pass3.count -ge 3 -and $mount2.namespacePresent)
    $readings.judgement4.passed = [bool]$judgement4
    Note4 "judgement 4: $(if ($judgement4) { 'PASS' } else { 'FAIL' })"
    if (-not $judgement4) { $failures.Add('judgement-4') }
  } finally {
    $null = Stop-TestbedInstance -Root $safeRoot -Profile $Profile
    if (Test-Path -LiteralPath $moved) { Rename-Item -LiteralPath $moved -NewName 'instruction' }
  }

  # Judgement 3/4's evidence, out of the disposable root before judgement 5 replaces it: the
  # snapshots as they stood at read time, the session log all three came out of, and the raw
  # exchanges of every step so far.
  Write-SnapshotFile -Path (Join-Path $stageDir 'snapshot-1.txt') -Text $snap1 `
    -Note 'snapshot 1 (judgement 3): the runtime-context user message the isolated instance appended after prompt 1 -- listing present, the original sentence. Verbatim, from the session log at read time.'
  Write-SnapshotFile -Path (Join-Path $stageDir 'snapshot-2.txt') -Text $snap2 `
    -Note 'snapshot 2 (judgement 3): the same after the record sentence was changed -- a second snapshot appended, the new sentence in, the old one gone. Verbatim, from the session log at read time.'
  Write-SnapshotFile -Path (Join-Path $stageDir 'snapshot-3.txt') -Text $snap3 `
    -Note 'snapshot 3 (judgement 4): the same after the instruction plugin was moved away -- a third snapshot, no listing: the injection idled, the working-directory context still there. Verbatim, from the session log at read time.'
  Save-Evidence -Source $logPath -Destination (Join-Path $stageDir 'session-log.jsonl') `
    -Label 'session-log.jsonl (judgement 3/4: the log all three snapshots came from)'
  Save-Evidence -Source $rawDir -Destination (Join-Path $stageDir 'raw') `
    -Label 'raw (judgement 3/4: prompt, panel-read, settings-describe and boot-page exchanges)'

  # ---- Judgement 5: the linked-worktree form. A node's fork-mode session works in a checkout of its
  # own, and that checkout carries no record of its own: the assembly has to lead back to the main
  # tree's listing. One more instance cycle, on a fixture whose session cwd is a real git worktree. ----
  if ($null -eq (Get-Command git -ErrorAction SilentlyContinue)) {
    $readings.judgement5.skipped = 'git is not on PATH: a linked worktree cannot be made'
    Note5 'skipped: git is not on PATH, so no linked worktree can be made here'
  } else {
    $manifest5 = Invoke-TestbedProvision -Root $safeRoot -Profile $Profile -Workspace 'workspace-linked' `
      -SessionCount 1 -DshCmd $DshCmd -NodeExe $NodeExe -LinkedWorktree
    $testbedHome = [string]$manifest5.home
    $session5 = @($manifest5.sessions)[0]
    $ws5 = @($manifest5.workspaces)[0]
    $sessionId5 = [string]$session5.sessionId
    $logPath5 = [string]$session5.logPath
    $worktreePath = [string]$ws5.path
    $mainPath5 = [string]$ws5.mainPath
    $readings.judgement5.worktreePath = $worktreePath
    $readings.judgement5.mainPath = $mainPath5
    $readings.judgement5.sessionId = $sessionId5
    $readings.judgement5.sessionLog = $logPath5
    if (-not (Test-Path -LiteralPath $rawDir)) { New-Item -ItemType Directory -Force -Path $rawDir | Out-Null }

    $staged5 = New-StagedPlugin -Source $Plugin -Destination (Join-Path $safeRoot 'plugin-staged')
    $null = Install-TestbedPlugin -Root $safeRoot -TestbedHome $testbedHome -Profile $Profile `
      -PluginPath $staged5 -DshCmd $DshCmd
    Write-InstructionRecord -WorkspacePath $mainPath5 -Text $Sentence
    $worktreeRecord = Test-Path -LiteralPath (Join-Path $worktreePath '.superworker')
    $dotGitIsContainer = (Get-Item -LiteralPath (Join-Path $worktreePath '.git') -Force).PSIsContainer
    Note5 "fixture: the main tree '$mainPath5' holds the record; the session's cwd is the checkout '$worktreePath'"
    Note5 "the checkout holds a record directory? $worktreeRecord; its .git is a file (a real linked worktree)? $(-not $dotGitIsContainer)"

    $cycle5 = Start-Cycle -Root $safeRoot -TestbedHome $testbedHome -Profile $Profile -DshCmd $DshCmd `
      -NodeExe $NodeExe -TimeoutSeconds $ReadyTimeoutSeconds
    Note5 "instance up: pid=$($cycle5.processId) url=http://127.0.0.1:$($cycle5.ready.port)/"
    try {
      $prompt5 = $null
      try {
        $prompt5 = Send-Prompt -Cycle $cycle5 -SessionId $sessionId5 -Text 'say one word' `
          -EvidencePath (Join-Path $rawDir 'prompt-linked-1')
        Note5 "prompt accepted at the worktree cwd: accepted=$($prompt5.accepted)"
      } catch {
        Note5 "prompt refused at the worktree cwd: $($_.Exception.Message)"
      }
      $pass5 = Wait-Snapshots -LogPath $logPath5 -AtLeast 1 -TimeoutSeconds $StepTimeoutSeconds
      $snap5 = Last-Snapshot -LogText $pass5.text
      $readings.judgement5.snapshots.afterPromptAtWorktree = $snap5
      Note5 "snapshots: $($pass5.count); listing present=$($snap5.Contains($ListingHead)); the main tree's sentence present=$($snap5.Contains($Sentence))"

      $judgement5 = (
        ($pass5.count -ge 1) -and $snap5.Contains($ListingHead) -and $snap5.Contains($Sentence) -and
        (-not $worktreeRecord) -and (-not $dotGitIsContainer)
      )
      $readings.judgement5.covered = [bool]($judgement5 -or ($pass5.count -ge 1))
      $readings.judgement5.passed = [bool]$judgement5
      Note5 "judgement 5: $(if ($judgement5) { 'PASS' } else { 'FAIL' })"
      if (-not $judgement5) { $failures.Add('judgement-5') }
    } finally {
      $null = Stop-TestbedInstance -Root $safeRoot -Profile $Profile
    }

    # Judgement 5's own evidence, out of its root: the instance is stopped, so its log is copied as
    # it stands (not appended to any more). The raw exchange joins the judgement 3/4 ones under raw/.
    Write-SnapshotFile -Path (Join-Path $stageDir 'snapshot-linked-1.txt') -Text $snap5 `
      -Note "snapshot 1 (judgement 5): the runtime-context user message in the session whose cwd is the linked-worktree checkout '$worktreePath' -- the listing is the main tree '$mainPath5' one. Verbatim, from that session's log at read time."
    Save-Evidence -Source $logPath5 -Destination (Join-Path $stageDir 'session-log-linked.jsonl') `
      -Label 'session-log-linked.jsonl (judgement 5: the linked-worktree session log)'
    Save-Evidence -Source $rawDir -Destination (Join-Path $stageDir 'raw') `
      -Label 'raw (judgement 5: the worktree-cwd prompt exchange)'
  }

  $exitCode = $(if ($failures.Count -eq 0) { 0 } else { 1 })
} catch {
  Write-Host ("probe aborted: " + $_.Exception.Message)
  $readings.aborted = $_.Exception.Message
  $readings.abortedAt = $_.ScriptStackTrace
  $exitCode = 1
} finally {
  $null = Stop-TestbedInstance -Root $safeRoot -Profile $Profile
  # Hand the preserved set over to -EvidenceDir, first, then write the readings: so the readings
  # file itself says what happened to every piece, a missing one included. A piece that is missing
  # is a reading ("missing"), not a silent skip.
  if ($EvidenceDir.Length -gt 0) {
    if (-not (Test-Path -LiteralPath $EvidenceDir)) { New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null }
    $readings.evidenceHandedTo = [System.IO.Path]::GetFullPath($EvidenceDir)
    foreach ($item in @(
      @{ label = 'session-log.jsonl'; source = (Join-Path $stageDir 'session-log.jsonl') },
      @{ label = 'session-log-linked.jsonl'; source = (Join-Path $stageDir 'session-log-linked.jsonl') },
      @{ label = 'snapshot-1.txt'; source = (Join-Path $stageDir 'snapshot-1.txt') },
      @{ label = 'snapshot-2.txt'; source = (Join-Path $stageDir 'snapshot-2.txt') },
      @{ label = 'snapshot-3.txt'; source = (Join-Path $stageDir 'snapshot-3.txt') },
      @{ label = 'snapshot-linked-1.txt'; source = (Join-Path $stageDir 'snapshot-linked-1.txt') },
      @{ label = 'raw'; source = (Join-Path $stageDir 'raw') }
    )) {
      Save-Evidence -Source $item.source -Destination (Join-Path $EvidenceDir $item.label) -Label $item.label -Replace
    }
  }
  $readings.finishedAt = (Get-Date).ToString('o')
  $readings.failed = @($failures.ToArray())
  $jsonPath = Join-Path $safeRoot 'logs\inject-probe-readings.json'
  Write-TextFile -Path $jsonPath -Text (($readings | ConvertTo-Json -Depth 12) + "`n")
  if ($EvidenceDir.Length -gt 0) {
    Copy-Item -LiteralPath $jsonPath -Destination (Join-Path $EvidenceDir 'inject-probe-readings.json') -Force
  }
  Write-Host ''
  Write-Host "readings: $jsonPath"
  Write-Host "evidence: $stageDir"
  if ($EvidenceDir.Length -gt 0) { Write-Host "handed  : $($readings.evidenceHandedTo)" }
  Write-Host "failed  : $(if ($failures.Count -eq 0) { 'none' } else { ($failures -join ', ') })"
}
exit $exitCode