# testbed-fixture.ps1 —— the synthetic records the testbed authors: one workspace (optionally a second
# session-less one), one plaintext session log per session, the workspace registry, and the fixture's
# own self-check of those session headers before an instance is ever started (an invalid header makes
# a session vanish from the list silently, so the check comes first).
#
# Loaded by tools/testbed/testbed-lib.ps1. Everything it writes lands under the caller's -Root.
# ---------------------------------------------------------------------------
# Synthetic record fixtures
# ---------------------------------------------------------------------------

# Create a synthetic workspace directory (with a small countable record) and its session logs, and
# write the manifest to <Root>\logs\fixture.json.
# Parameters: -WorkspaceName / -SessionCount add a second workspace and session; -EmptyWorkspaceName adds a session-less workspace.
function New-TestbedFixture {
  param(
    [Parameter(Mandatory=$true)][string]$Root,
    [Parameter(Mandatory=$true)][string]$Profile,
    [string]$WorkspaceName = 'workspace-alpha',
    [int]$SessionCount = 1,
    [string]$EmptyWorkspaceName = '',
    [string]$NodeExe = 'node'
  )
  $testbedHome = Join-Path $Root 'home'
  $logs = Join-Path $Root 'logs'
  $storages = Join-Path $testbedHome 'storages'
  $sessions = Join-Path $testbedHome 'sessions'
  foreach ($d in @($testbedHome, $logs, $storages, $sessions)) {
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
  }

  $now = [DateTime]::UtcNow
  $iso = $now.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  $epochMs = [long]([DateTimeOffset]$now).ToUnixTimeMilliseconds()

  # Main workspace: a real directory + a small countable record.
  $wsDir = Join-Path $Root ('workspaces\' + $WorkspaceName)
  if (-not (Test-Path -LiteralPath $wsDir)) { New-Item -ItemType Directory -Force -Path $wsDir | Out-Null }
  $wsPath = Get-CanonicalPath -Path $wsDir -NodeExe $NodeExe

  $records = [ordered]@{
    kind = 'panel-records'
    note = 'hand-authored sample for the isolated testbed; counts are the point, not the volume'
    nodes = @(
      [ordered]@{ id = 'node-1'; title = 'collect panel readings'; state = 'done' },
      [ordered]@{ id = 'node-2'; title = 'render the ledger column'; state = 'active' },
      [ordered]@{ id = 'node-3'; title = 'verify grouping'; state = 'pending' }
    )
    dependencyEdges = @(
      [ordered]@{ from = 'node-1'; to = 'node-2' },
      [ordered]@{ from = 'node-2'; to = 'node-3' }
    )
    issues = @(
      [ordered]@{ id = 'issue-1'; title = 'column widths drift on a narrow window'; status = 'open' },
      [ordered]@{ id = 'issue-2'; title = 'empty workspace has no placeholder row'; status = 'open' }
    )
  }
  Write-TextFile -Path (Join-Path $wsDir 'panel-records.json') -Text (($records | ConvertTo-Json -Depth 10) + "`n")

  $workspaces = New-Object System.Collections.Generic.List[object]
  $sessionRows = New-Object System.Collections.Generic.List[object]

  $wsId = [guid]::NewGuid().ToString()
  $wsSessionIds = New-Object System.Collections.Generic.List[string]

  for ($i = 1; $i -le $SessionCount; $i++) {
    $sid = [guid]::NewGuid().ToString()
    $projectKey = Get-ProjectKey -Cwd $wsPath
    $sessionDir = Join-Path (Join-Path $sessions $projectKey) (Get-EncodedSegment -Raw $sid)
    $logPath = Join-Path $sessionDir 'session.v4.jsonl'
    $createdMs = $epochMs + $i

    # The first line is the session header: field names and types must fall in the set the product
    # side allows; one extra key and the whole session is dropped.
    $header = '{"type":"session","version":4,"id":' + (ConvertTo-JsonString $sid) +
      ',"createdAt":' + $createdMs +
      ',"cwd":' + (ConvertTo-JsonString $wsPath) +
      ',"isSeeded":false,"delegationDepth":0}'
    # Session body: one minimal pair of turn/start + turn/end. seq must match line order (from 0, no gaps).
    $event0 = '{"type":"turn/start","seq":0,"time":' + ($createdMs + 1) + ',"data":{"turn":1}}'
    $event1 = '{"type":"turn/end","seq":1,"time":' + ($createdMs + 2) + ',"data":{"turn":1}}'
    Write-TextFile -Path $logPath -Text ($header + "`n" + $event0 + "`n" + $event1 + "`n")

    $wsSessionIds.Add($sid)
    $sessionRows.Add([ordered]@{
      sessionId = $sid
      workspaceId = $wsId
      workspacePath = $wsPath
      logPath = $logPath
      projectDir = $projectKey
      eventCount = 2
    })
  }

  $workspaces.Add([ordered]@{
    workspaceId = $wsId
    name = $WorkspaceName
    path = $wsPath
    title = 'Synthetic Workspace Alpha'
    sessionIds = @($wsSessionIds.ToArray())
    empty = $false
    recordsPath = (Join-Path $wsDir 'panel-records.json')
  })

  if ($EmptyWorkspaceName.Length -gt 0) {
    $emptyDir = Join-Path $Root ('workspaces\' + $EmptyWorkspaceName)
    if (-not (Test-Path -LiteralPath $emptyDir)) { New-Item -ItemType Directory -Force -Path $emptyDir | Out-Null }
    $emptyPath = Get-CanonicalPath -Path $emptyDir -NodeExe $NodeExe
    $workspaces.Add([ordered]@{
      workspaceId = [guid]::NewGuid().ToString()
      name = $EmptyWorkspaceName
      path = $emptyPath
      title = 'Synthetic Workspace Empty'
      sessionIds = @()
      empty = $true
      recordsPath = ''
    })
  }

  # Workspace registry: read once, no watcher, so it is written wholesale while the instance is stopped.
  $ids = @($workspaces | ForEach-Object { $_.workspaceId })
  $table = [ordered]@{}
  $order = [ordered]@{
    initialized = $true
    workspaceIds = $ids
    archivedSessionIds = @()
    pinnedSessionIds = @()
  }
  foreach ($w in $workspaces) {
    $table[$w.workspaceId] = [ordered]@{
      path = $w.path
      title = $w.title
      sessionIds = @($w.sessionIds)
      createdAt = $iso
      updatedAt = $iso
    }
  }
  $document = [ordered]@{
    unit = [ordered]@{ name = 'workspace'; version = 2 }
    global = $order
    tables = [ordered]@{ workspaces = $table }
  }
  Write-TextFile -Path (Join-Path $storages 'workspace.json') -Text (($document | ConvertTo-Json -Depth 12) + "`n")

  $manifest = [ordered]@{
    kind = 'dsh-pathfinder-testbed-fixture'
    createdAt = $iso
    root = $Root
    home = $testbedHome
    profile = $Profile
    workspaces = @($workspaces.ToArray())
    sessions = @($sessionRows.ToArray())
  }
  Write-TextFile -Path (Join-Path $logs 'fixture.json') -Text (($manifest | ConvertTo-Json -Depth 12) + "`n")
  return $manifest
}

# The header's count-typed fields (version / createdAt / delegationDepth) must be numbers:
# the product layer (dsh-session-format's header validation) demands non-negative integers, and a
# string-typed value raises no error — that session simply vanishes from the list. Caught by type here.
function Test-HeaderInteger {
  param($Value)
  if ($Value -is [bool]) { return $false }
  if ($Value -is [int] -or $Value -is [long] -or $Value -is [short] -or $Value -is [byte]) { return ([double]$Value -ge 0) }
  if ($Value -is [double] -or $Value -is [decimal] -or $Value -is [single]) {
    return (([double]$Value -ge 0) -and ([double]$Value -eq [math]::Floor([double]$Value)))
  }
  return $false
}

# Validate a synthetic session's header and on-disk location: header first, then the list (an
# invalid header silently drops one entry from the list). Field set, field types (string / number /
# boolean), id-vs-disk-location cross-check, and event seq density — all four are validated.
function Test-TestbedSessionFixture {
  param([Parameter(Mandatory=$true)]$Session)
  $problems = New-Object System.Collections.Generic.List[string]
  $logPath = [string]$Session.logPath
  if (-not (Test-Path -LiteralPath $logPath)) {
    $problems.Add("session log missing: $logPath")
    return @($problems)
  }
  $lines = [System.IO.File]::ReadAllLines($logPath)
  if ($lines.Length -lt 1) { $problems.Add('session log is empty'); return @($problems) }
  $header = $null
  try { $header = $lines[0] | ConvertFrom-Json } catch { $problems.Add("header is not JSON: $($lines[0])") ; return @($problems) }
  $required = @('type', 'version', 'id', 'createdAt', 'isSeeded', 'delegationDepth')
  $optional = @('cwd', 'parentSession', 'origin', 'agentPreset')
  foreach ($key in $required) {
    if (-not ($header.PSObject.Properties.Name -contains $key)) { $problems.Add("header lacks required field '$key'") }
  }
  foreach ($key in $header.PSObject.Properties.Name) {
    if (-not ($required -contains $key) -and -not ($optional -contains $key)) { $problems.Add("header has field outside the allowed set: '$key'") }
  }
  if ($header.type -isnot [string]) { $problems.Add("header type is not a string: '$($header.type)'") }
  elseif ($header.type -ne 'session') { $problems.Add("header type is '$($header.type)'") }
  if (-not (Test-HeaderInteger -Value $header.version)) { $problems.Add("header version is not a non-negative integer: '$($header.version)'") }
  elseif ($header.version -ne 4) { $problems.Add("header version is '$($header.version)'; this fixture writes v4") }
  if ($header.id -isnot [string]) { $problems.Add("header id is not a string: '$($header.id)'") }
  elseif ([string]$header.id -ne [string]$Session.sessionId) { $problems.Add('header id does not match the requested session id') }
  if (-not (Test-HeaderInteger -Value $header.createdAt)) { $problems.Add("header createdAt is not a non-negative integer: '$($header.createdAt)'") }
  if ($header.cwd -isnot [string] -or [string]::IsNullOrEmpty([string]$header.cwd)) {
    # Without a usable cwd the on-disk location cannot be computed, and the last two checks
    # (location cross-check, event seq) could not run either: report this one and stop.
    $problems.Add("header cwd is not a usable string: '$($header.cwd)'")
    return @($problems)
  }
  if ($header.cwd -ne [string]$Session.workspacePath) { $problems.Add('header cwd does not match the workspace path') }
  if ($header.isSeeded -isnot [bool]) { $problems.Add("header isSeeded is not a boolean: '$($header.isSeeded)'") }
  elseif ($header.isSeeded -ne $false) { $problems.Add('header isSeeded is not false') }
  if (-not (Test-HeaderInteger -Value $header.delegationDepth)) { $problems.Add("header delegationDepth is not a non-negative integer: '$($header.delegationDepth)'") }
  $expectedPath = Join-Path (Join-Path (Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $logPath))) (Get-ProjectKey -Cwd ([string]$header.cwd))) (Get-EncodedSegment -Raw ([string]$header.id))) 'session.v4.jsonl'
  if ($expectedPath -ne $logPath) { $problems.Add("header id + cwd identify '$expectedPath' but the log sits at '$logPath'") }
  for ($i = 1; $i -lt $lines.Length; $i++) {
    if ($lines[$i].Trim().Length -eq 0) { continue }
    $event = $null
    try { $event = $lines[$i] | ConvertFrom-Json } catch { $problems.Add("event line $i is not JSON") ; continue }
    if ($event.seq -ne ($i - 1)) { $problems.Add("event line $i carries seq $($event.seq), expected $($i - 1)") }
  }
  return @($problems)
}

