# testbed-mainhome.ps1 —— the main home as counter-evidence for completion criterion 4, and nothing
# else: the per-area fingerprint, the lightweight metadata scan that opens an observation window, the
# S1 structural / S2 witnessed ownership terms, and the four-bucket verdict over one area's changes
# (exempt / deletion / testbed-made name / unattributed, mutually exclusive, plus the partition
# self-check and the reading assembly for criterion 4's report lines).
#
# Loaded by tools/testbed/testbed-lib.ps1; it writes nothing into the main home — every function here
# only reads. The design notes that produced these terms live in that file's header.
# ---------------------------------------------------------------------------
# Main home fingerprints (the counter-evidence readings for completion criterion 4)
# ---------------------------------------------------------------------------

# Fingerprint one path. kind tree recurses; kind file is a single file.
#   contentDigest —— composed only of "relative path + byte count + content SHA256": the literal "counts and hashes" reading;
#   entryDigest   —— the above plus mtime, used outside the criteria to show exactly which files moved;
#   entries       —— relative path -> "length|mtime|content hash", for per-path comparison.
function Get-AreaFingerprint {
  param([Parameter(Mandatory=$true)][string]$Path)
  # Even an empty set must have a definite digest: when a directory holds no file (or the area is
  # absent entirely) the fixed empty-string sha256 is taken, so both sides have something to compare
  # and the caller never trips over a "parameter is null" binding error.
  $emptyDigest = Get-TextDigest -Lines @()
  $result = [ordered]@{
    path = $Path; exists = $false; kind = 'missing'
    fileCount = 0; totalBytes = 0; contentDigest = $emptyDigest; entryDigest = $emptyDigest; entries = @{}
  }
  if (-not (Test-Path -LiteralPath $Path)) { return $result }
  $item = Get-Item -LiteralPath $Path -Force
  $result.exists = $true
  if ($item.PSIsContainer) {
    $result.kind = 'tree'
    $base = $item.FullName.TrimEnd('\')
    $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force)
  } else {
    $result.kind = 'file'
    $base = (Split-Path -Parent $item.FullName)
    $files = @($item)
  }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $contentLines = New-Object System.Collections.Generic.List[string]
  $entryLines = New-Object System.Collections.Generic.List[string]
  try {
    foreach ($f in $files) {
      $rel = $f.FullName.Substring($base.Length).TrimStart('\')
      $stream = [System.IO.File]::OpenRead($f.FullName)
      try {
        $hash = [System.BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
      } finally { $stream.Dispose() }
      $content = "$($f.Length)|$hash"
      $entry = "$content|$($f.LastWriteTimeUtc.Ticks)"
      $result.entries[$rel] = $entry
      $contentLines.Add("$rel`t$content")
      $entryLines.Add("$rel`t$entry")
      $result.fileCount = $result.fileCount + 1
      $result.totalBytes = $result.totalBytes + $f.Length
    }
  } finally { $sha.Dispose() }
  $result.contentDigest = Get-TextDigest -Lines @((@($contentLines.ToArray()) | Sort-Object))
  $result.entryDigest = Get-TextDigest -Lines @((@($entryLines.ToArray()) | Sort-Object))
  return $result
}

# Text digest of one path's entries. Empty sets (a file-less area, an empty subset) are accepted; the digest is the fixed empty-string sha256.
function Get-TextDigest {
  param([AllowEmptyCollection()][AllowNull()][string[]]$Lines = @())
  if ($null -eq $Lines) { $Lines = @() }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($Lines -join "`n"))
    return [System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
  } finally { $sha.Dispose() }
}

# Per-path comparison of two fingerprints, returning the change set (a difference in mtime, length, or content hash counts as changed).
function Compare-AreaFingerprint {
  param([Parameter(Mandatory=$true)]$Before, [Parameter(Mandatory=$true)]$After)
  $changed = New-Object System.Collections.Generic.List[string]
  foreach ($rel in $After.entries.Keys) {
    if (-not $Before.entries.ContainsKey($rel)) { $changed.Add("+$rel") ; continue }
    if ($Before.entries[$rel] -ne $After.entries[$rel]) { $changed.Add("~$rel") }
  }
  foreach ($rel in $Before.entries.Keys) {
    if (-not $After.entries.ContainsKey($rel)) { $changed.Add("-$rel") }
  }
  return @($changed | Sort-Object)
}

# Strip the change-set prefix, leaving the plain relative path. Returns an empty array when nothing changed (callers need not distinguish $null).
function Get-ChangedPaths {
  param([AllowEmptyCollection()][string[]]$Changed = @())
  if ($null -eq $Changed) { return @() }
  return @($Changed | ForEach-Object { $_.Substring(1) })
}

# Lightweight scan: only "relative path -> length|mtime tick", never reads file content (the main
# home's session store is large; reading content is reserved for the two full fingerprints the
# criteria actually compare). For "did it move" this is enough.
function Get-AreaMetaScan {
  param([Parameter(Mandatory=$true)][string]$Path)
  $result = [ordered]@{ path = $Path; exists = $false; kind = 'missing'; fileCount = 0; entries = @{} }
  if (-not (Test-Path -LiteralPath $Path)) { return $result }
  $item = Get-Item -LiteralPath $Path -Force
  $result.exists = $true
  if ($item.PSIsContainer) {
    $result.kind = 'tree'
    $base = $item.FullName.TrimEnd('\')
    $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force)
  } else {
    $result.kind = 'file'
    $base = (Split-Path -Parent $item.FullName)
    $files = @($item)
  }
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($base.Length).TrimStart('\')
    $result.entries[$rel] = "$($f.Length)|$($f.LastWriteTimeUtc.Ticks)"
    $result.fileCount = $result.fileCount + 1
  }
  return $result
}

# Relative paths touched between two observations (added / rewritten / vanished all count).
# Before is a lightweight scan (length|mtime), After a full fingerprint (length|content hash|mtime); only length and mtime are compared.
function Get-TouchedPaths {
  param([Parameter(Mandatory=$true)]$MetaBefore, [Parameter(Mandatory=$true)]$FingerprintAfter)
  $touched = New-Object System.Collections.Generic.List[string]
  foreach ($rel in $FingerprintAfter.entries.Keys) {
    $parts = ([string]$FingerprintAfter.entries[$rel]) -split '\|'
    $afterMeta = "$($parts[0])|$($parts[2])"
    if (-not $MetaBefore.entries.ContainsKey($rel)) { $touched.Add([string]$rel) ; continue }
    if ([string]$MetaBefore.entries[$rel] -ne $afterMeta) { $touched.Add([string]$rel) }
  }
  foreach ($rel in $MetaBefore.entries.Keys) {
    if (-not $FingerprintAfter.entries.ContainsKey($rel)) { $touched.Add([string]$rel) }
  }
  return @($touched | Sort-Object -Unique)
}

# File count and content digest of one fingerprint "excluding certain relative paths".
# Purpose: the foreign write paths picked out by the witness set are carved off first, and the
# criteria's counts and hashes are taken over the remainder, which is what makes the equality
# meaningful (and which paths were carved off is printed line by line in the readings).
function Get-FingerprintSubset {
  param(
    [Parameter(Mandatory=$true)]$Fingerprint,
    [AllowEmptyCollection()][string[]]$Exclude = @()
  )
  $skip = New-Object System.Collections.Generic.HashSet[string]
  foreach ($rel in @($Exclude)) { if ($null -ne $rel) { $null = $skip.Add([string]$rel) } }
  $lines = New-Object System.Collections.Generic.List[string]
  $count = 0
  $bytes = 0
  foreach ($rel in $Fingerprint.entries.Keys) {
    if ($skip.Contains([string]$rel)) { continue }
    $entry = [string]$Fingerprint.entries[$rel]
    $length = [long](($entry -split '\|')[0])
    $lines.Add("$rel`t$entry")
    $count = $count + 1
    $bytes = $bytes + $length
  }
  return [ordered]@{
    fileCount = $count
    totalBytes = $bytes
    digest = Get-TextDigest -Lines @((@($lines.ToArray()) | Sort-Object))
    excluded = $skip.Count
  }
}

# S1 (structural exemption): a path proves "this fixture cannot have written it" by where it sits
# (which project key) plus its physical encoding suffix. Both must hold: (1) the project key differs
# from every key this fixture derives; (2) the encoding suffix is one this profile cannot write
# (this profile pins compression to none, so the whole root can only be plaintext .jsonl). Missing
# either means no exemption — this exists precisely to close the "unknown name, let it pass" escape
# hatch: a plaintext .jsonl under some other project key still fails.
function Test-StructuralExemption {
  param(
    [Parameter(Mandatory=$true)][string]$RelativePath,
    [AllowEmptyCollection()][string[]]$FixtureProjectKeys = @(),
    [AllowEmptyCollection()][string[]]$FixtureEncodings = @('.jsonl')
  )
  $segments = @($RelativePath -split '\\')
  if ($segments.Count -lt 2) {
    return [ordered]@{
      exempt = $false; projectKey = ''; leaf = [string]$RelativePath
      reason = 'S1 structural not met: the path sits directly in the area root, so it carries no project key to read'
    }
  }
  $key = [string]$segments[0]
  $leaf = [string]$segments[$segments.Count - 1]
  $keyIsForeign = $true
  foreach ($candidate in @($FixtureProjectKeys)) {
    if ([string]::IsNullOrEmpty([string]$candidate)) { continue }
    if ($key -eq [string]$candidate) { $keyIsForeign = $false; break }
  }
  $encodingIsForeign = $true
  foreach ($candidate in @($FixtureEncodings)) {
    if ([string]::IsNullOrEmpty([string]$candidate)) { continue }
    if ($leaf.ToLowerInvariant().EndsWith(([string]$candidate).ToLowerInvariant())) { $encodingIsForeign = $false; break }
  }
  $exempt = $keyIsForeign -and $encodingIsForeign
  $reason = ''
  if (-not $keyIsForeign) {
    $reason = "S1 structural not met: project key '$key' is one this fixture derives"
  } elseif (-not $encodingIsForeign) {
    $reason = "S1 structural not met: '$leaf' carries an encoding this profile writes ($(@($FixtureEncodings) -join ', '))"
  } else {
    $reason = "S1 structural: project key '$key' is not one this fixture derives, and '$leaf' is not the plaintext encoding this profile writes ($(@($FixtureEncodings) -join ', '))"
  }
  return [ordered]@{ exempt = $exempt; projectKey = $key; leaf = $leaf; reason = $reason }
}

# Criterion 4's leak-signature set: names this testbed itself makes. The verdict matches them
# against relative paths with `-like "*signature*"` (see Get-MainHomeAreaVerdict), and relative
# paths are assembled segment by segment — a single Windows directory segment contains neither ':'
# nor '\', so a whole absolute path (like
# %LOCALAPPDATA%\dsh-superworker-testbed\workspaces\workspace-alpha) is never contiguous
# inside a relative path, and such entries would never be recognized. Signatures are therefore
# always fragments that can appear contiguously inside a relative path:
#   * the synthetic session ids (each is itself a single path segment);
#   * the synthetic workspaces' directory names (sessions are grouped by cwd, so the name is folded
#     into the project-key segment by Get-ProjectKey);
#   * the testbed root's leaf name (every key this fixture derives contains it; this is the safety net).
function Get-TestbedLeakSignatures {
  param(
    [Parameter(Mandatory=$true)][string]$Root,
    [AllowEmptyCollection()]$Sessions = @(),
    [AllowEmptyCollection()]$Workspaces = @()
  )
  $signatures = New-Object System.Collections.Generic.List[string]
  foreach ($session in @($Sessions)) {
    if ($null -eq $session) { continue }
    $id = [string]$session.sessionId
    if ($id.Length -gt 0 -and -not $signatures.Contains($id)) { $signatures.Add($id) }
  }
  foreach ($ws in @($Workspaces)) {
    if ($null -eq $ws) { continue }
    $name = Split-Path -Leaf ([string]$ws.path)
    if ($name.Length -gt 0 -and -not $signatures.Contains($name)) { $signatures.Add($name) }
  }
  $rootLeaf = Split-Path -Leaf ([System.IO.Path]::GetFullPath($Root).TrimEnd('\'))
  if ($rootLeaf.Length -gt 0 -and -not $signatures.Contains($rootLeaf)) { $signatures.Add($rootLeaf) }
  return @($signatures.ToArray())
}

# The verdict for one main-home area: split the "before baseline vs after" change set by ownership
# and decide whether this area passes. Criterion 4's terms: **every difference must carry positive
# evidence it was not written by this fixture**, unioning two kinds:
#   * S1 structural: the project key differs from every key this fixture derives, and the encoding
#     suffix is one this profile cannot write (both required);
#   * S2 witnessed: the path really moved during a "no testbed instance running" observation window;
#   a change satisfying neither fails. Prefixes kept: + new / ~ rewritten / - deleted.
# Hard-failure faces join no exemption: paths carrying a testbed-made name (leak signatures), any
# change in the two quiet areas, and **any deletion** (- prefix).
# The four buckets (exempt / deletions / leaks / unattributed) are **mutually exclusive**: each
# change lands in exactly one, and the four buckets together cover every change — no more, no less.
# partitionConsistent records whether this self-check held (the entry point prints it as an
# assertion; the criteria still read only the three counts).
# passed is decided by the three counts alone (deletions / unattributed / leaks all 0); exempt* /
# exemptReasons / subset* / partitionConsistent are printed readings, of which subset* is a support
# reading: it is implied by those three counts and is no independent evidence.
function Get-MainHomeAreaVerdict {
  param(
    [Parameter(Mandatory=$true)][string]$Name,
    [Parameter(Mandatory=$true)]$Before,
    [Parameter(Mandatory=$true)]$After,
    [Parameter(Mandatory=$true)][bool]$QuietArea,
    [AllowEmptyCollection()][string[]]$LiveWitness = @(),
    [AllowEmptyCollection()][string[]]$LeakSignatures = @(),
    [AllowEmptyCollection()][string[]]$FixtureProjectKeys = @(),
    [AllowEmptyCollection()][string[]]$FixtureEncodings = @('.jsonl')
  )
  $witnessKeys = New-Object System.Collections.Generic.HashSet[string]
  foreach ($key in @($LiveWitness)) { if ($null -ne $key) { $null = $witnessKeys.Add([string]$key) } }
  $changed = @(Compare-AreaFingerprint -Before $Before -After $After)
  $exempt = New-Object System.Collections.Generic.List[string]
  $exemptStructural = New-Object System.Collections.Generic.List[string]
  $exemptWitnessed = New-Object System.Collections.Generic.List[string]
  $exemptReasons = [ordered]@{}
  $deletions = New-Object System.Collections.Generic.List[string]
  $leaks = New-Object System.Collections.Generic.List[string]
  $unattributed = New-Object System.Collections.Generic.List[string]
  foreach ($change in $changed) {
    $rel = $change.Substring(1)
    $named = $false
    foreach ($signature in @($LeakSignatures)) {
      if ([string]::IsNullOrEmpty([string]$signature)) { continue }
      if ($rel -like "*$signature*") { $named = $true; break }
    }
    # The four buckets are **mutually exclusive**: each change lands in exactly one and then
    # continues (so each change prints one detail line, and the four counts in the readings must sum
    # to the number of changes — the same invariant computed in this lib serves as the assertion).
    # Order: deletion -> testbed-made name -> quiet area -> exempt/unattributed.
    #   Deletions come first: a deleted path carrying a testbed-made name is still recorded once, as
    #   a deletion, and never also into the named bucket — otherwise the readings would say "0
    #   deletions" while listing a real deletion, or the reverse with "0 testbed-made names" beside
    #   an obviously named path. Both buckets are hard failures; the verdict is unaffected by this filing.
    if ($change.StartsWith('-')) { $deletions.Add($change); continue }
    if ($named) { $leaks.Add($change); continue }
    if ($QuietArea) { $unattributed.Add($change); continue }
    # Union the two positive kinds of evidence: structural first, then the witness set.
    $structural = Test-StructuralExemption -RelativePath $rel -FixtureProjectKeys $FixtureProjectKeys -FixtureEncodings $FixtureEncodings
    $witnessed = $witnessKeys.Contains("$Name/$rel")
    if ($structural.exempt) {
      $exempt.Add($change)
      $exemptStructural.Add($change)
      $reason = $structural.reason
      if ($witnessed) { $reason = $reason + ' (this path is also in the live-write witness set)' }
      $exemptReasons[$change] = $reason
      continue
    }
    if ($witnessed) {
      $exempt.Add($change)
      $exemptWitnessed.Add($change)
      $exemptReasons[$change] = 'S2 witness: this path changed during an observation window opened while no testbed instance was running; ' + $structural.reason
      continue
    }
    $unattributed.Add($change)
  }
  $exemptPaths = @($exempt | ForEach-Object { $_.Substring(1) })
  # Subset comparison after carving off the exempt paths: it removes the exempt entries from both
  # sides, so as long as deletions / unattributed / leaks are all 0 (i.e. every change was exempted)
  # the two subsets are necessarily identical entry by entry — it restates those three counts and
  # gives no independent evidence, hence it does **not enter $passed**: the verdict rests on those
  # three counts alone. It is still computed, printed as a support reading.
  $subsetBefore = Get-FingerprintSubset -Fingerprint $Before -Exclude $exemptPaths
  $subsetAfter = Get-FingerprintSubset -Fingerprint $After -Exclude $exemptPaths
  $subsetIdentical = ($subsetBefore.fileCount -eq $subsetAfter.fileCount) -and ($subsetBefore.digest -eq $subsetAfter.digest)
  $passed = ($deletions.Count -eq 0) -and ($unattributed.Count -eq 0) -and ($leaks.Count -eq 0)
  # Four-bucket exclusivity self-check: pool the four buckets' entries; the pool's count must equal
  # the change count (nothing missing) and its deduplicated count must equal it too (nothing
  # doubled). The entry point prints this as an assertion: a mismatch between readings and detail
  # lines shows up right here.
  $filed = New-Object System.Collections.Generic.List[string]
  foreach ($entry in @($exempt)) { $filed.Add([string]$entry) }
  foreach ($entry in @($deletions)) { $filed.Add([string]$entry) }
  foreach ($entry in @($leaks)) { $filed.Add([string]$entry) }
  foreach ($entry in @($unattributed)) { $filed.Add([string]$entry) }
  $filedDistinct = @($filed | Sort-Object -Unique)
  $partitionConsistent = ($filed.Count -eq $changed.Count) -and ($filedDistinct.Count -eq $changed.Count)
  return [ordered]@{
    name = $Name
    quietArea = $QuietArea
    changed = $changed
    exempt = @($exempt.ToArray())
    exemptStructural = @($exemptStructural.ToArray())
    exemptWitnessed = @($exemptWitnessed.ToArray())
    exemptReasons = $exemptReasons
    exemptPaths = @($exemptPaths)
    deletions = @($deletions.ToArray())
    leaks = @($leaks.ToArray())
    unattributed = @($unattributed.ToArray())
    subsetBefore = $subsetBefore
    subsetAfter = $subsetAfter
    subsetIdentical = $subsetIdentical
    filedCount = $filed.Count
    filedDistinctCount = $filedDistinct.Count
    partitionConsistent = $partitionConsistent
    passed = $passed
  }
}


# ---------------------------------------------------------------------------
# The fingerprint and its summaries
# ---------------------------------------------------------------------------

# Keep only summaries in the readings file: per-file lists are too long; raw readings live in check-report.txt and logs\raw.
function Get-FingerprintSummary {
  param([Parameter(Mandatory = $true)]$Fingerprint)
  return [ordered]@{
    path = $Fingerprint.path
    exists = $Fingerprint.exists
    kind = $Fingerprint.kind
    fileCount = $Fingerprint.fileCount
    totalBytes = $Fingerprint.totalBytes
    contentDigest = $Fingerprint.contentDigest
    entryDigest = $Fingerprint.entryDigest
  }
}

# The three counter-evidence areas for completion criterion 4: the main home's session store, workspace records, credentials.
function Get-MainHomeAreas {
  param([Parameter(Mandatory = $true)][string]$MainHome)
  return @(
    [ordered]@{ name = 'sessions'; path = (Join-Path $MainHome 'sessions') },
    [ordered]@{ name = 'workspace-records'; path = (Join-Path $MainHome 'storages\workspace.json') },
    [ordered]@{ name = 'credentials'; path = (Join-Path $MainHome '.credentials.yaml') }
  )
}

function Get-MainHomeFingerprint {
  param([Parameter(Mandatory = $true)][string]$MainHome)
  $areas = [ordered]@{}
  foreach ($area in (Get-MainHomeAreas -MainHome $MainHome)) {
    $areas[$area.name] = Get-AreaFingerprint -Path $area.path
  }
  return $areas
}

# Lightweight scan for the witness set: takes only "relative path -> length|mtime", never reads
# content (same shape as the full fingerprint's readings; the criteria read the full one).
function Get-MainHomeMetaScan {
  param([Parameter(Mandatory = $true)][string]$MainHome)
  $areas = [ordered]@{}
  foreach ($area in (Get-MainHomeAreas -MainHome $MainHome)) {
    $areas[$area.name] = Get-AreaMetaScan -Path $area.path
  }
  return $areas
}

# Completion criterion 4's reading assembly: ask the verdict for each of the three areas, print every
# ground it read (the four mutually exclusive buckets and the partition self-check), and add the two
# assertions that make "no foreign change" hold — no listener and no process of this fixture's own
# identity left behind. The caller supplies the two fingerprints and both witness windows; nothing
# here touches disk.
#
# The four buckets are exclusive by construction: each changed path lands in exactly one of exempt /
# deletion / testbed-made name / unattributed, and `partitionConsistent` reconciles the counts against
# the detail lines. Only with an empty exempt set does the whole-area comparison equal the spec's
# literal wording; a non-empty exempt set demotes it to a support reading, which is printed as such.
function Get-MainHomeCriterion {
  param(
    [Parameter(Mandatory=$true)][AllowEmptyString()][string]$Root,
    [Parameter(Mandatory=$true)][AllowEmptyString()][string]$Profile,
    [Parameter(Mandatory=$true)]$Manifest,
    [Parameter(Mandatory=$true)]$Before,
    [Parameter(Mandatory=$true)]$After,
    [Parameter(Mandatory=$true)][AllowEmptyCollection()]$LiveWitness,
    [Parameter(Mandatory=$true)]$WindowBeforeRun,
    [Parameter(Mandatory=$true)]$WindowAfterRun,
    [AllowEmptyCollection()][int[]]$InstancePids = @(),
    [Parameter(Mandatory=$true)]$Run
  )
  # Leak signatures: names this testbed itself makes. Signatures are always fragments that can
  # appear contiguously inside a relative path — the verdict matches against relative paths, where
  # a whole absolute path (e.g. the workspace path) is never contiguous and such entries would not
  # be recognized; Get-TestbedLeakSignatures therefore computes them uniformly.
  $leakSignatures = @(Get-TestbedLeakSignatures -Root $Root -Sessions @($Manifest.sessions) -Workspaces @($Manifest.workspaces))
  # S1's baseline: the project keys this fixture itself derives (computed from the synthetic
  # workspace paths) + the encodings this profile can write. A plaintext .jsonl appearing under some
  # other project key still fails S1 — this closes the "unknown name, let it pass" escape hatch.
  $fixtureProjectKeys = New-Object System.Collections.Generic.List[string]
  foreach ($ws in $Manifest.workspaces) {
    $key = Get-ProjectKey -Cwd ([string]$ws.path)
    if (-not $fixtureProjectKeys.Contains($key)) { $fixtureProjectKeys.Add($key) }
  }
  $fixtureEncodings = @('.jsonl')
  $lines = New-Object System.Collections.Generic.List[string]
  $passed = $true
  $lines.Add("hard-fail signature set — these names are what this testbed makes (a changed path carrying one of them is never exempt; $($leakSignatures.Count) entries): $($leakSignatures -join ' | ')")
  $lines.Add("S1 baseline — project keys this fixture derives: $($fixtureProjectKeys -join ', ')")
  $lines.Add("S1 baseline — encodings this profile writes: $($fixtureEncodings -join ', ') (the profile pins compression: none, so this home only ever writes plaintext)")

  foreach ($name in $Before.Keys) {
    $areaBefore = $Before[$name]
    $areaAfter = $After[$name]
    # The session store already has other live harness sessions appending to it (the witness-set
    # paths); the workspace records and credentials areas have no other writer, so any touch there
    # is a hard failure; in the session store, each changed path is judged by who owns it.
    $quietArea = ($name -ne 'sessions')
    $verdict = Get-MainHomeAreaVerdict -Name $name -Before $areaBefore -After $areaAfter -QuietArea $quietArea `
      -LiveWitness @($LiveWitness) -LeakSignatures $leakSignatures `
      -FixtureProjectKeys @($fixtureProjectKeys.ToArray()) -FixtureEncodings $fixtureEncodings
    $countIdentical = ($areaBefore.fileCount -eq $areaAfter.fileCount)
    $wholeIdentical = $countIdentical -and ($areaBefore.contentDigest -eq $areaAfter.contentDigest)
    $lines.Add("$name : before files=$($areaBefore.fileCount) bytes=$($areaBefore.totalBytes) sha256=$($areaBefore.contentDigest.Substring(0,16))... | after files=$($areaAfter.fileCount) bytes=$($areaAfter.totalBytes) sha256=$($areaAfter.contentDigest.Substring(0,16))...")
    $lines.Add("$name : path=$($areaBefore.path) kind=$($areaBefore.kind)")
    $areaNote = $(if ($quietArea) { 'quiet area: no other writer here, so any change fails' } else { 'shared area: every changed path needs its own positive ownership evidence' })
    $lines.Add("$name : raw whole-area reading (context only; $areaNote): fileCount identical=$countIdentical wholeAreaCountAndHashIdentical=$wholeIdentical")
    $lines.Add("$name : changed paths=$($verdict.changed.Count), prefixes kept (+ new / ~ rewritten / - deleted)")
    $lines.Add("$name : four buckets, mutually exclusive — every changed path is filed in exactly one, in this order: deletion -> a testbed-made name -> a quiet area -> exempt or unattributed | exempt=$($verdict.exempt.Count) (S1 structural=$($verdict.exemptStructural.Count), S2 witnessed live write=$($verdict.exemptWitnessed.Count)) | deletions (hard fail, never exempt)=$($verdict.deletions.Count) | carrying a testbed-made name (hard fail, never exempt)=$($verdict.leaks.Count) | unattributed (no positive evidence)=$($verdict.unattributed.Count)")
    $lines.Add("$name : bucket self-check: changed=$($verdict.changed.Count) filed=$($verdict.filedCount) distinct=$($verdict.filedDistinctCount) partitionConsistent=$($verdict.partitionConsistent) (each changed path shows up in exactly one detail line below)")
    if (-not $verdict.partitionConsistent) { $passed = $false }
    # Every detail line is printed: the counts cover the full set, so the details print the full set
    # too (small scale this round); every basis for PASS/FAIL stays visible.
    foreach ($item in $verdict.exempt) { $lines.Add("$name : exempt -> $item") }
    foreach ($item in $verdict.exempt) { $lines.Add("$name :    why: $($verdict.exemptReasons[$item])") }
    foreach ($item in $verdict.deletions) { $lines.Add("$name : DELETION, hard fail (never exempt) -> $item") }
    foreach ($item in $verdict.unattributed) { $lines.Add("$name : UNATTRIBUTED change, no positive evidence -> $item") }
    foreach ($item in $verdict.leaks) { $lines.Add("$name : LEAK SIGNATURE, hard fail (never exempt) -> $item") }
    # The subset comparison is a support reading: it carves the exempt paths out of both sides, and
    # holds trivially when the three counts are 0, so it is no independent evidence (the verdict
    # rests on the four counts above plus the partitionConsistent self-check — a mismatch between
    # reading and detail lines turns red right here).
    if ($areaBefore.fileCount -eq 0) { $lines.Add("$name : this area holds no files (empty set: before=$($areaBefore.fileCount) after=$($areaAfter.fileCount)); its digest is the fixed empty-set sha256, so there is nothing to compare here") }
    elseif ($verdict.exempt.Count -eq 0) { $lines.Add("$name : nothing was exempted here, so the whole-area reading above is the spec's literal one (no subset was carved out of it)") }
    elseif ($verdict.subsetBefore.fileCount -eq 0) { $lines.Add("$name : support reading only, and it has nothing to compare: excluding exactly the $($verdict.exempt.Count) exempt path(s) leaves no file in the remainder (empty subset), so no equality is claimed") }
    else { $lines.Add("$name : support reading only (implied by the counts above, so it is no independent evidence): excluding exactly the $($verdict.exempt.Count) exempt path(s) leaves files=$($verdict.subsetBefore.fileCount) sha256=$($verdict.subsetBefore.digest.Substring(0,16))... countAndHashIdentical=$($verdict.subsetIdentical)") }
    if (-not $verdict.passed) { $passed = $false }
  }
  $lines.Add("live-write witness (paths that changed during an observation window opened while no testbed instance was running): $(@($LiveWitness).Count)")
  $lines.Add("  window 1 before the run (lightweight scan -> full fingerprint): $(@($WindowBeforeRun.Values | ForEach-Object { $_.Count } | Measure-Object -Sum).Sum) path(s)")
  $lines.Add("  window 2 after the run (lightweight scan -> full fingerprint, instance already stopped): $(@($WindowAfterRun.Values | ForEach-Object { $_.Count } | Measure-Object -Sum).Sum) path(s)")
  foreach ($item in (@($LiveWitness) | Sort-Object)) { $lines.Add("live witness -> $item") }
  # After the final stop there must be no listener or process of this testbed left: this check is
  # what makes the "foreign changes" claim above hold.
  # Stray processes are collected by **identity**: this fixture's own launcher path, or descendants
  # of the instance pids recorded this run; the caller itself and its ancestor chain are excluded
  # (the shell and host running check are fine even if their command lines mention the run root).
  $strayProcesses = Get-StrayTestbedProcess -Root $Root -Profile $Profile -InstancePids @($InstancePids)
  $listenerAlive = Test-TcpListener -Port $Run.port
  $lines.Add("stray listener on the last instance port after the final stop: $listenerAlive")
  $lines.Add("stray scan identity: this testbed's own launcher path '$(Join-Path $Root ('logs\start-' + $Profile + '.cmd'))' and the instance pid tree @($InstancePids); the caller's own process (pid=$PID) and its ancestors are excluded from the scan")
  $lines.Add("stray node/cmd process carrying that identity: $($strayProcesses.Count)")
  foreach ($item in $strayProcesses) { $lines.Add("stray process -> $item") }
  if ($listenerAlive) { $passed = $false }
  if ($strayProcesses.Count -gt 0) { $passed = $false }
  return [ordered]@{ Passed = $passed; Lines = @($lines.ToArray()) }
}
