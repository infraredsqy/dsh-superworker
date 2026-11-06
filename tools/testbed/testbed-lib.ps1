# testbed-lib.ps1 —— the testbed's shared base, and the only file a caller dot-sources: path and on-disk
# format conversions, the file and JSON writers every part lands its readings with, the guard on -Root,
# and then the three parts themselves, each split by its own subject:
#
#   testbed-mainhome.ps1   main-home fingerprints, the S1/S2 ownership terms, the four-bucket verdict
#   testbed-fixture.ps1    the synthetic workspaces and sessions, and the fixture's own header check
#   testbed-instance.ps1   the tarball, the profile, the plugin install, start/stop, the HTTP calls
#
# Called only by tools/testbed/testbed.ps1. Everything it creates (isolated home / profile / synthetic
# workspaces / synthetic sessions) lands under the caller's -Root; this file assumes no concrete paths.
#
# Design notes: measured against a live DSH instance, not copied from elsewhere. What they describe
# is undocumented on-disk format, so a DSH upgrade can move it under the testbed -- re-measure
# before trusting a note.
#   * Session root layout: session logs land at <home>\sessions\<projectKey(cwd)>\<encodeSegment(id)>\session.v4.jsonl.
#     When reading logs the instance cross-checks "the path recomputed from the header's id + cwd" against the on-disk
#     path; a wrongly computed path gets the session dropped.
#   * A session's physical encoding is exclusive across the whole root: mixing another suffix into the same root makes
#     the entire session list throw. The testbed home is rebuilt each time and its profile pins compression to none,
#     so the whole root is plaintext .jsonl.
#   * An invalid session header field name/type raises no error; that session silently vanishes from the list.
#     Hence validate the header first, then look at the list.
#   * The workspace registry (<home>\storages\workspace.json) is read once at instance start; it must be written while the instance is stopped.
#   * The main home is shared: while the testbed runs, other projects' live sessions may be appending to it. Criterion 4 demands
#     **positive ownership evidence for every difference**, unioning two kinds:
#     S1 structural (project key differs from every key this fixture derives + the encoding suffix is one this profile cannot write) and
#     S2 witnessed (paths really touched in a "no instance running" observation window). Deletions, paths carrying a
#     testbed-made name, and any change in the two quiet areas fail outright.
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# ---------------------------------------------------------------------------
# Path and on-disk format conversions
# ---------------------------------------------------------------------------

# Convert a cwd into the "project directory" level under the session root (same algorithm as the
# product side: separators fold to '-', other unsafe chars become ~XXXX).
function Get-ProjectKey {
  param([Parameter(Mandatory=$true)][string]$Cwd)
  if ($Cwd.Length -eq 0) { throw 'project key: cwd must not be empty' }
  $readable = ''
  $separatorRun = $false
  foreach ($ch in $Cwd.ToCharArray()) {
    if ($ch -eq '\' -or $ch -eq '/' -or $ch -eq ':') {
      if (-not $separatorRun) { $readable += '-' }
      $separatorRun = $true
    } elseif ($ch -ne '~' -and $ch -match '^[A-Za-z0-9._-]$') {
      $readable += $ch
      $separatorRun = $false
    } else {
      $readable += '~' + ([int]$ch).ToString('X4')
      $separatorRun = $false
    }
  }
  $slug = $readable -replace '^-+', ''
  if ($slug.Length -eq 0) { $slug = 'root' }
  if ($slug.Length -gt 251) { $slug = $slug.Substring(0, 251) }
  return '--' + $slug + '--'
}

# Turn a session id into a single safe path segment.
function Get-EncodedSegment {
  param([Parameter(Mandatory=$true)][string]$Raw)
  if ($Raw.Length -eq 0) { throw 'encoded segment: value must not be empty' }
  if ($Raw -eq '.') { return '~002E' }
  if ($Raw -eq '..') { return '~002E~002E' }
  $out = ''
  foreach ($ch in $Raw.ToCharArray()) {
    if ($ch -ne '~' -and $ch -match '^[A-Za-z0-9._-]$') { $out += $ch }
    else { $out += '~' + ([int]$ch).ToString('X4') }
  }
  return $out
}

# Canonical path via Node's fs.realpathSync: the product side judges workspace-path uniqueness by this same canon.
function Get-CanonicalPath {
  param([Parameter(Mandatory=$true)][string]$Path, [string]$NodeExe = 'node')
  $out = & $NodeExe -e "process.stdout.write(require('fs').realpathSync(process.argv[1]))" $Path
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrEmpty($out)) { throw "realpath failed for '$Path'" }
  return [string]$out
}

# Resolve a directly-CreateProcess-able executable: want the .cmd/.bat/.exe one, not the extensionless POSIX shim in the npm directory.
function Resolve-ApplicationExecutable {
  param([Parameter(Mandatory=$true)][string]$Name)
  $candidates = @(Get-Command -Name $Name -All -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandType -eq 'Application' -and $_.Name -match '\.(cmd|bat|exe)$' })
  if ($candidates.Count -gt 0) { return $candidates[0].Source }
  foreach ($dir in ($env:PATH -split ';')) {
    foreach ($extension in @('.cmd', '.bat', '.exe')) {
      $candidate = Join-Path $dir ($Name + $extension)
      if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
  }
  throw "cannot resolve an executable launcher named '$Name'"
}

# Write text: no BOM by default (JSON / JSONL parsers treat a BOM as corrupt data); line endings exactly as the caller's text.
function Write-TextFile {
  param([Parameter(Mandatory=$true)][string]$Path, [Parameter(Mandatory=$true)][string]$Text)
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Text, $script:Utf8NoBom)
}

# JSON string literal (escaping left to ConvertTo-Json, which gets Windows backslashes right).
function ConvertTo-JsonString {
  param([Parameter(Mandatory=$true)][string]$Value)
  return (ConvertTo-Json -InputObject $Value -Compress)
}

# ---------------------------------------------------------------------------
# The root guard
# ---------------------------------------------------------------------------

# Refuse a -Root that would delete or overlap something that is not this fixture's: a drive root, a
# shallow path, a path inside the project tree, or a path overlapping the main home. Every action runs
# this before it touches disk.
function Assert-SafeRoot {
  param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][string]$MainHome)
  $full = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
  $driveRoot = [System.IO.Path]::GetPathRoot($full).TrimEnd('\')
  if ($full.Length -eq 0 -or $full -eq $driveRoot) { throw "refusing a drive root as the testbed root: '$full'" }
  if (($full.Split('\')).Count -lt 3) { throw "refusing a shallow testbed root: '$full'" }
  $projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
  if ($full -eq $projectRoot -or $full.StartsWith($projectRoot + '\')) {
    throw "refusing a testbed root inside the project tree: '$full'"
  }
  $main = [System.IO.Path]::GetFullPath($MainHome).TrimEnd('\')
  if ($full -eq $main -or $full.StartsWith($main + '\') -or $main.StartsWith($full + '\')) {
    throw "refusing a testbed root that overlaps the main home: '$full'"
  }
  return $full
}

# ---------------------------------------------------------------------------
# The parts
# ---------------------------------------------------------------------------

. (Join-Path $PSScriptRoot 'testbed-mainhome.ps1')
. (Join-Path $PSScriptRoot 'testbed-fixture.ps1')
. (Join-Path $PSScriptRoot 'testbed-instance.ps1')