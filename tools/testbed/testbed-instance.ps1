# testbed-instance.ps1 —— the isolated instance end to end: the npm pack tarball (list and extract),
# the profile built from the web template, the plugin install with its on-disk readings, the detached
# start / readiness probe / verified stop, the stray-process and listener assertions, the HTTP calls on
# the instance's own /api surface, and the per-criterion reading assembly that draws on those runs.
#
# Loaded by tools/testbed/testbed-lib.ps1. Everything it creates lands under the caller's -Root; the
# main home is never touched.
# ---------------------------------------------------------------------------
# The npm pack tarball: list entries, extract a few members
# ---------------------------------------------------------------------------

# Windows ships two tars: the GNU tar bundled with Git (the MSYS2 one) and the system bsdtar. This
# layer smooths over both:
#   * every path handed to tar is converted to forward slashes. MSYS2 re-decodes backslash escapes
#     in arguments received from native processes, so a fragment like `logs\tarball` gets eaten into
#     a tab and the path stops matching.
#   * GNU tar reads the colon in `C:...` as a remote host; `--force-local` makes it read locally.
#     Implementations without that flag fall back to "cd into the archive's directory, hand over the leaf name only".
# Read-only: list entries and extract named members to a directory; never modifies the archive or anything else.
function Invoke-Tar {
  param(
    [Parameter(Mandatory=$true)][string]$Archive,
    [Parameter(Mandatory=$true)][AllowEmptyCollection()][string[]]$BeforeArchive,
    [AllowEmptyCollection()][string[]]$AfterArchive = @(),
    [string]$TarExe = 'tar'
  )
  $full = [System.IO.Path]::GetFullPath($Archive)
  if (-not (Test-Path -LiteralPath $full)) { throw "archive is missing: $full" }
  $fullArg = $full -replace '\\', '/'
  $afterArg = @($AfterArchive | ForEach-Object { ([string]$_) -replace '\\', '/' })
  # `--force-local` must precede `-xzf`/`-tzf`: the f in those short options eats the next word as the archive name.
  $out = @(& $TarExe '--force-local' @BeforeArchive $fullArg @afterArg 2>&1)
  if ($LASTEXITCODE -eq 0) { return @($out | ForEach-Object { [string]$_ }) }
  $firstTry = ($out -join ' ')
  $dir = Split-Path -Parent $full
  $leaf = Split-Path -Leaf $full
  Push-Location $dir
  try {
    $out = @(& $TarExe @BeforeArchive $leaf @afterArg 2>&1)
    if ($LASTEXITCODE -ne 0) {
      throw "tar failed for '$full' (--force-local: $firstTry | relative archive name: $($out -join ' '))"
    }
    return @($out | ForEach-Object { [string]$_ })
  } finally { Pop-Location }
}

function Invoke-TarList {
  param([Parameter(Mandatory=$true)][string]$Archive, [string]$TarExe = 'tar')
  return @(Invoke-Tar -Archive $Archive -BeforeArchive @('-tzf') -TarExe $TarExe)
}

function Expand-TarMember {
  param(
    [Parameter(Mandatory=$true)][string]$Archive,
    [Parameter(Mandatory=$true)][string]$Destination,
    [Parameter(Mandatory=$true)][AllowEmptyCollection()][string[]]$Members,
    [string]$TarExe = 'tar'
  )
  $dest = [System.IO.Path]::GetFullPath($Destination)
  if (-not (Test-Path -LiteralPath $dest)) { New-Item -ItemType Directory -Force -Path $dest | Out-Null }
  $null = Invoke-Tar -Archive $Archive -BeforeArchive @('-xzf') -AfterArchive (@('-C', $dest) + @($Members)) -TarExe $TarExe
}

# Drop a real record into a synthetic workspace: copy the pointed-to records directory as the
# workspace's `.superworker`. The panel reads exactly that hidden directory in the workspace; synthetic
# workspaces lack it by default, so the instance would only ever draw the "no records" screen.
# Acts only when the caller (the up action) asks for it; otherwise no workspace is touched.
function Add-TestbedRecords {
  param(
    [Parameter(Mandatory=$true)]$Manifest,
    [Parameter(Mandatory=$true)][string]$RecordsPath
  )
  $source = [System.IO.Path]::GetFullPath($RecordsPath).TrimEnd('\')
  if (-not (Test-Path -LiteralPath $source)) { throw "records directory is missing: $source" }
  if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "records path is not a directory: $source" }
  $readings = New-Object System.Collections.Generic.List[object]
  foreach ($ws in $Manifest.workspaces) {
    if ($ws.empty) { continue }
    $target = Join-Path ([string]$ws.path) '.superworker'
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
    $files = @(Get-ChildItem -LiteralPath $target -Recurse -File -Force)
    $readings.Add([ordered]@{
      workspaceId = [string]$ws.workspaceId
      workspacePath = [string]$ws.path
      recordsPath = $target
      fileCount = $files.Count
      totalBytes = [long](($files | Measure-Object -Property Length -Sum).Sum)
    })
  }
  return @($readings.ToArray())
}

# ---------------------------------------------------------------------------
# Profile and instance
# ---------------------------------------------------------------------------

# Build the isolated profile from the web template, pinning session compression to none (the
# profile's cordis.patch.yml). The profile is created with --dump-config: it writes the profile,
# prints the composed tree, and exits — it never starts a service.
function New-TestbedProfile {
  param([Parameter(Mandatory=$true)][string]$TestbedHome, [Parameter(Mandatory=$true)][string]$Profile, [string]$DshCmd = 'dsh')
  $profileDir = Join-Path $TestbedHome ('profiles\' + $Profile)
  $previous = $env:DSH_HOME
  try {
    $env:DSH_HOME = $TestbedHome
    $dump = & $DshCmd $Profile --from-default-profile web --dump-config 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "profile creation failed: $dump" }
    if (-not (Test-Path -LiteralPath $profileDir)) { throw "profile directory was not created: $profileDir" }
    # The user layer is an id-targeted patch: config is replaced wholesale rather than merged key by
    # key, so root must be written back along with it.
    $patch = @(
      '# superworker testbed profile layer.',
      '# Sessions in this home are stored as plaintext JSONL: the physical encoding is exclusive',
      '# across one session root, and this home is rebuilt from scratch on every provision.',
      '- id: session-persistence-jsonl',
      '  config:',
      "    root: !!js dshHomePath('sessions')",
      '    compression: none'
    ) -join "`n"
    Write-TextFile -Path (Join-Path $profileDir 'cordis.patch.yml') -Text ($patch + "`n")
    $after = & $DshCmd $Profile --dump-config 2>&1 | Out-String
    if ($after -notmatch 'compression: none') { throw 'profile patch did not compose compression: none' }
    if ($after -notmatch "root: !!js dshHomePath\('sessions'\)") { throw 'profile patch dropped the session root' }
    return $profileDir
  } finally { $env:DSH_HOME = $previous }
}

# Whether the entries a config row points at exist on disk: resolve the package named by the row's
# `name:` from the profile's own resolution location (the package.json in the profile directory),
# plus the browser half's hand (`exports["./client"]`). Parsing only — no importing of plugin code,
# no service started; the resolved paths are then verified on disk once more (require.resolve walks
# real paths; symlinks are already resolved). The small generated .cjs is written into the testbed's
# own root, touching nothing else.
function Resolve-PluginEntryFiles {
  param(
    [Parameter(Mandatory=$true)][string]$Root,
    [Parameter(Mandatory=$true)][string]$ProfileDir,
    [Parameter(Mandatory=$true)][string]$PluginName,
    [string]$NodeExe = 'node'
  )
  $manifestPath = Join-Path $ProfileDir 'package.json'
  $script = @'
const { createRequire } = require('module')
const require_ = createRequire(process.argv[2])
for (const spec of process.argv.slice(3)) {
  try { process.stdout.write(JSON.stringify({ spec, path: require_.resolve(spec) }) + '\n') }
  catch (error) { process.stdout.write(JSON.stringify({ spec, path: null, error: String((error && error.code) || error) }) + '\n') }
}
'@
  $scriptPath = Join-Path $Root 'logs\resolve-plugin-entry.cjs'
  Write-TextFile -Path $scriptPath -Text ($script + "`n")
  $specs = @($PluginName, ($PluginName + '/client'))
  $out = @(& $NodeExe $scriptPath $manifestPath @specs 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "resolving the plugin entries failed (exit $LASTEXITCODE): $($out -join ' ')" }
  $rows = New-Object System.Collections.Generic.List[object]
  foreach ($line in $out) {
    $text = ([string]$line).Trim()
    if ($text.Length -eq 0 -or -not $text.StartsWith('{')) { continue }
    $parsed = $text | ConvertFrom-Json
    $resolved = [string]$parsed.path
    $exists = ($resolved.Length -gt 0) -and (Test-Path -LiteralPath $resolved)
    $bytes = 0
    if ($exists) { $bytes = (Get-Item -LiteralPath $resolved).Length }
    $rows.Add([ordered]@{
      spec = [string]$parsed.spec
      path = $resolved
      exists = $exists
      bytes = $bytes
      error = [string]$parsed.error
    })
  }
  return @($rows.ToArray())
}


# `exports[key]`, resolved to a path string: a string-valued export is its own default, an object
# takes `.default`, and an absent key is ''. Read through the manifest rather than re-written here.
function Get-ManifestExportPath {
  param([Parameter(Mandatory=$true)]$Manifest, [Parameter(Mandatory=$true)][string]$Key)
  if ($null -eq $Manifest.exports) { return '' }
  $node = $Manifest.exports.$Key
  if ($null -eq $node) { return '' }
  if ($node -is [string]) { return [string]$node }
  $value = $node.default
  if ($null -eq $value) { return '' }
  return [string]$value
}

# The two runtime entries a release artifact must carry, read off the package's own manifest: the host
# hand (`exports['.'].default`, falling back to `main`) and the browser hand
# (`exports['./client'].default`). Returned as slash-separated paths relative to the package root — the
# one form the archive listing and the on-disk check both use. An entry the manifest does not name is
# refused here, before anything is installed.
function Get-PluginEntryRels {
  param([Parameter(Mandatory=$true)]$Manifest, [Parameter(Mandatory=$true)][string]$ManifestPath)
  $hostEntry = Get-ManifestExportPath -Manifest $Manifest -Key '.'
  if ($hostEntry.Length -eq 0) { $hostEntry = [string]$Manifest.main }
  $clientEntry = Get-ManifestExportPath -Manifest $Manifest -Key './client'
  $named = @(
    @('exports["."].default (the host half)', $hostEntry),
    @('exports["./client"].default (the browser half)', $clientEntry)
  )
  $rels = New-Object System.Collections.Generic.List[string]
  foreach ($pair in $named) {
    $label = [string]$pair[0]
    $value = ([string]$pair[1]).Trim()
    if ($value.Length -eq 0) {
      throw "the package names no $label entry, so what was built cannot be checked: $ManifestPath"
    }
    $rel = ($value -replace '\\', '/')
    $rel = $rel -replace '^\./', ''
    $rels.Add($rel)
  }
  return @($rels.ToArray())
}

# Install the pointed-to plugin into the isolated profile, turning "installed" into reproducible
# readings on the spot.
#
# Both delivery forms are accepted:
#   * a package directory (`-Plugin <this repo>`, the developer's own form) — pnpm records it as `link:`;
#   * an npm pack tarball (`-Plugin <…>.tgz`, the form handed to strangers) — pnpm unpacks the
#     package into the profile and the user side runs no build scripts. Both legs go through DSH's
#     own entry `dsh plugin --profile <name> add <target>`.
#
# Neither the package name nor the row id is hardcoded; both are read from the pointed-to package
# itself: the name from its `package.json` `name` (the same word is the dependency key pnpm records,
# the bundle list's entry, and the boot manifest handed to the browser); the row id from the first
# top-level row under the package's own section (`# == <package name>`) in the composed config tree.
# After installing, verify for real: the profile manifest records the package name, the bundle list
# selects it, and the row exists in the config tree and is not disabled — all read, or it is not installed.
function Install-TestbedPlugin {
  param(
    [Parameter(Mandatory=$true)][string]$Root,
    [Parameter(Mandatory=$true)][string]$TestbedHome,
    [Parameter(Mandatory=$true)][string]$Profile,
    [Parameter(Mandatory=$true)][string]$PluginPath,
    [string]$DshCmd = 'dsh'
  )
  $profileDir = Join-Path $TestbedHome ('profiles\' + $Profile)
  if (-not (Test-Path -LiteralPath $profileDir)) { throw "profile directory is missing: $profileDir" }
  $PluginPath = [System.IO.Path]::GetFullPath($PluginPath)
  if (-not (Test-Path -LiteralPath $PluginPath)) { throw "plugin source is missing: $PluginPath" }

  # What is installed is the **build output**: both runtime entries the package declares must be
  # present, otherwise what gets installed is a line that cannot start. Which two those are is read
  # off the package's own manifest — `exports['.'].default` (falling back to `main`) for the host
  # half, `exports['./client'].default` for the browser half — and never written out a second time
  # here. Directory form: read the manifest, then check those two on disk. Tarball form: list the
  # archive, pull `package.json` out, and then require the two entries it names to be members.
  #
  # The two forms get their own sentence on purpose: only a checkout has build scripts. Telling
  # someone who installed a `.tgz` to "run npm run bundle" points at a command the release has never
  # carried.
  $packageForm = 'directory'
  $tarballSha256 = ''
  $artifactBase = $PluginPath
  if ([System.IO.Path]::GetExtension($PluginPath).ToLowerInvariant() -eq '.tgz') {
    $packageForm = 'tarball'
    $tarballSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $PluginPath).Hash.ToLowerInvariant()
    $entries = @(Invoke-TarList -Archive $PluginPath)
    if (-not ($entries -contains 'package/package.json')) {
      throw "not a plugin package (no package.json in the archive): $PluginPath (entries: $($entries.Count))"
    }
    $stage = Join-Path $Root 'logs\tarball'
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    Expand-TarMember -Archive $PluginPath -Destination $stage -Members @('package/package.json')
    $package = Get-Content -LiteralPath (Join-Path $stage 'package\package.json') -Raw | ConvertFrom-Json
    $artifactRels = @(Get-PluginEntryRels -Manifest $package -ManifestPath $PluginPath)
    $members = New-Object System.Collections.Generic.List[string]
    $members.Add('package/package.json')
    foreach ($rel in $artifactRels) {
      $member = 'package/' + $rel
      if (-not ($entries -contains $member)) {
        throw "the tarball is missing '$member', which its own package.json names as a runtime entry — this release was packed without its build output; re-pack a built checkout ('npm pack' runs prepack, which builds it)"
      }
      $members.Add($member)
    }
    Expand-TarMember -Archive $PluginPath -Destination $stage -Members @($members.ToArray())
    $artifactBase = Join-Path $stage 'package'
  } else {
    $manifestPath = Join-Path $PluginPath 'package.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) { throw "not a plugin package (no package.json): $manifestPath" }
    $package = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $artifactRels = @(Get-PluginEntryRels -Manifest $package -ManifestPath $manifestPath)
    foreach ($rel in $artifactRels) {
      $full = Join-Path $PluginPath $rel
      if (-not (Test-Path -LiteralPath $full)) {
        throw "plugin build output is missing: $full — build this checkout first ('npm run build:products' in $PluginPath)"
      }
    }
  }
  $PluginName = [string]$package.name
  if ($PluginName.Length -eq 0) { throw "the plugin package does not declare a name: $(Join-Path $artifactBase 'package.json')" }
  $PluginId = ''

  $previous = $env:DSH_HOME
  $started = Get-Date
  try {
    $env:DSH_HOME = $TestbedHome
    $install = & $DshCmd plugin --profile $Profile add $PluginPath 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "plugin install failed (exit $LASTEXITCODE): $install" }

    $manifest = Get-Content -LiteralPath (Join-Path $profileDir 'package.json') -Raw | ConvertFrom-Json
    $recorded = [string]$manifest.dependencies.$PluginName
    if ($recorded.Length -eq 0) { throw "profile manifest does not record $PluginName after the install: $install" }
    $bundles = @($manifest.dsh.profile.bundles)
    if (-not ($bundles -contains $PluginName)) {
      throw "profile bundle list does not select $PluginName after the install (bundles: $($bundles -join ', ')): $install"
    }

    # The composed config tree: the first top-level row under this package's own section
    # (`# == <package name>`) is its row. Both id and name are read from the dump; no hardcoded
    # names are matched. `--dump-config` only prints; it never starts a service.
    $composed = & $DshCmd $Profile --dump-config 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "dump-config failed after the install (exit $LASTEXITCODE): $composed" }
    $composedLines = $composed -split "`r?`n"
    $sectionHeader = '# == ' + $PluginName
    $rowIndex = -1
    for ($i = 0; $i -lt $composedLines.Length; $i++) {
      if ($composedLines[$i].Trim() -ne $sectionHeader) { continue }
      for ($j = $i + 1; $j -lt $composedLines.Length; $j++) {
        if ($composedLines[$j] -match '^\s*#') { break }
        $idMatch = [regex]::Match($composedLines[$j], '^-\s+id:\s+(\S+)\s*$')
        if ($idMatch.Success) { $PluginId = $idMatch.Groups[1].Value; $rowIndex = $j; break }
      }
      break
    }
    if ($PluginId.Length -eq 0) {
      throw "the composed config tree has no row under the '$PluginName' bundle layer after the install: $composed"
    }
    $rows = New-Object System.Collections.Generic.List[string]
    for ($j = $rowIndex; $j -lt $composedLines.Length; $j++) {
      if ($j -gt $rowIndex) {
        if ($composedLines[$j].Trim().Length -eq 0) { break }
        if ($composedLines[$j] -match '^\s*-') { break }
        if ($composedLines[$j] -match '^\s*#') { break }
      }
      $rows.Add($composedLines[$j].TrimEnd())
    }
    $rowText = ($rows -join ' | ').Trim()
    if ($rowText -match 'disabled:') { throw "the composed row for '$PluginId' is disabled: $rowText" }
    # Every entry the row points at must be on disk: the host hand (`.`) and the browser hand (`./client`).
    $entries = @(Resolve-PluginEntryFiles -Root $Root -ProfileDir $profileDir -PluginName $PluginName -NodeExe $NodeExe)
    foreach ($entry in $entries) {
      if (-not $entry.exists) {
        throw "the config row names '$PluginName' but its entry '$($entry.spec)' does not resolve to a file on disk (path='$($entry.path)' error='$($entry.error)')"
      }
    }
  } finally { $env:DSH_HOME = $previous }
  $elapsed = [math]::Round(((Get-Date) - $started).TotalSeconds, 2)

  $reading = [ordered]@{
    plugin = $PluginName
    pluginId = $PluginId
    packageForm = $packageForm
    pluginSource = $PluginPath
    tarballSha256 = $tarballSha256
    recordedSpec = $recorded
    profileBundles = $bundles
    composedRow = $rowText
    entries = @($entries)
    artifacts = @($artifactRels | ForEach-Object { [ordered]@{
      relative = $_
      bytes = (Get-Item -LiteralPath (Join-Path $artifactBase $_)).Length
    } })
    elapsedSeconds = $elapsed
  }
  Write-TextFile -Path (Join-Path $Root 'logs\plugin-install.json') -Text (($reading | ConvertTo-Json -Depth 8) + "`n")
  return $reading
}

# Start a detached instance: returns immediately, PID recorded in <Root>\logs\instance.pid.
function Start-TestbedInstance {
  param(
    [Parameter(Mandatory=$true)][string]$Root,
    [Parameter(Mandatory=$true)][string]$TestbedHome,
    [Parameter(Mandatory=$true)][string]$Profile,
    [string]$DshCmd = 'dsh',
    [string]$NodeExe = 'node'
  )
  $out = Join-Path $Root 'logs\instance.out.log'
  $err = Join-Path $Root 'logs\instance.err.log'
  foreach ($f in @($out, $err)) { if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force } }
  $dshArgs = @($Profile)
  if (-not (Test-Path -LiteralPath (Join-Path $TestbedHome ('profiles\' + $Profile)))) {
    $dshArgs += @('--from-default-profile', 'web')
  }
  $dshArgs += @('--port', '0', '--no-open')

  # The launcher is a .cmd on disk: it sets DSH_HOME itself and points all three streams at
  # files/NUL. That way the long-lived cmd.exe / node never inherits the caller's (harness's) pipe
  # handles, which is what lets the caller return immediately.
  $nodeApplication = Resolve-ApplicationExecutable -Name $NodeExe
  $entry = Join-Path (Split-Path -Parent $DshCmd) 'node_modules\@deepseek-ai\dsh\lib\bin.js'
  if (Test-Path -LiteralPath $entry) {
    $command = '"' + $nodeApplication + '" "' + $entry + '" ' + ($dshArgs -join ' ')
  } else {
    $command = '"' + $DshCmd + '" ' + ($dshArgs -join ' ')
  }
  $launcherPath = Join-Path $Root ('logs\start-' + $Profile + '.cmd')
  $launcher = @(
    'rem Launcher written by the testbed provisioner.',
    'rem It pins the isolated home and gives all three streams a file or NUL, so a long-lived',
    'rem instance never holds a handle that belongs to whoever started it.',
    '@echo off',
    ('set "DSH_HOME=' + $TestbedHome + '"'),
    ($command + ' > "' + $out + '" 2> "' + $err + '" < NUL')
  ) -join "`n"
  Write-TextFile -Path $launcherPath -Text ($launcher + "`n")

  $proc = Start-Process -FilePath $launcherPath -WindowStyle Hidden -PassThru
  Write-TextFile -Path (Join-Path $Root 'logs\instance.pid') -Text ($proc.Id.ToString() + "`n")
  Write-TextFile -Path (Join-Path $Root 'logs\instance-launch.txt') -Text (
    "startedAt=$([DateTime]::UtcNow.ToString('o'))`nlauncherPid=$($proc.Id)`nlauncher=$launcherPath`nDSH_HOME=$TestbedHome`ncommand=$command`n")
  return $proc.Id
}

# Readiness probe: read the URL line from the instance's own output (with backoff and a cap); an
# early process exit errors out immediately.
function Wait-TestbedReady {
  param([Parameter(Mandatory=$true)][string]$Root, [Parameter(Mandatory=$true)][int]$ProcessId, [int]$TimeoutSeconds = 30)
  $log = Join-Path $Root 'logs\instance.out.log'
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $backoffMs = 50
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $log) {
      $text = Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue
      if ($text -match 'dsh web:\s*(http://\S+)') {
        $url = $Matches[1]
        $portMatch = [regex]::Match($url, ':(\d+)/')
        $tokenMatch = [regex]::Match($url, 'token=([^&\s]+)')
        if (-not $portMatch.Success) { throw "cannot read the port out of '$url'" }
        return [ordered]@{
          url = $url
          port = [int]$portMatch.Groups[1].Value
          token = $(if ($tokenMatch.Success) { $tokenMatch.Groups[1].Value } else { '' })
        }
      }
    }
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
      $errText = ''
      $errPath = Join-Path $Root 'logs\instance.err.log'
      if (Test-Path -LiteralPath $errPath) { $errText = (Get-Content -LiteralPath $errPath -Raw) }
      throw "instance $ProcessId exited before printing its URL. stderr: $errText"
    }
    # A child started by Start-Process offers only a log file, nothing to hang an event on; poll that
    # file with backoff, capped at TimeoutSeconds.
    Start-Sleep -Milliseconds $backoffMs
    if ($backoffMs -lt 500) { $backoffMs = $backoffMs * 2 }
  }
  throw "instance $ProcessId printed no URL within $TimeoutSeconds s"
}

# One testbed instance's processes: the launcher .cmd path is written by this cell alone, so its
# presence in a command line is enough to confirm identity.
function Get-TestbedInstanceProcesses {
  param([Parameter(Mandatory=$true)][string]$Root, [Parameter(Mandatory=$true)][string]$Profile)
  $launcher = Join-Path $Root ('logs\start-' + $Profile + '.cmd')
  $found = New-Object System.Collections.Generic.List[object]
  foreach ($proc in (Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" -ErrorAction SilentlyContinue)) {
    $cmdline = [string]$proc.CommandLine
    if ($cmdline.Length -gt 0 -and $cmdline -like "*$launcher*") { $found.Add($proc) }
  }
  return @($found.ToArray())
}

# Stop only the PID we recorded: verify the command line really is this profile first, then kill it
# together with its children. When the pid file is missing (or the process is gone), fall back to
# "command line carries this fixture's launcher path", verified the same way before killing.
function Stop-TestbedInstance {
  param([Parameter(Mandatory=$true)][string]$Root, [Parameter(Mandatory=$true)][string]$Profile)
  $pidFile = Join-Path $Root 'logs\instance.pid'
  $targets = New-Object System.Collections.Generic.List[object]
  if (Test-Path -LiteralPath $pidFile) {
    $text = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    $instancePid = 0
    if (-not [int]::TryParse($text, [ref]$instancePid)) { throw "pid file does not hold a number: $text" }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $instancePid" -ErrorAction SilentlyContinue
    if ($null -ne $proc) {
      $cmdline = [string]$proc.CommandLine
      if (($cmdline -notlike "*$Profile*") -or ($cmdline -notlike '*dsh*')) {
        throw "refusing to kill pid $instancePid : command line is not this testbed instance ('$cmdline')"
      }
      $targets.Add($proc)
    }
  }
  if ($targets.Count -eq 0) {
    foreach ($proc in (Get-TestbedInstanceProcesses -Root $Root -Profile $Profile)) {
      if ($proc.Name -eq 'cmd.exe') { $targets.Add($proc) }
    }
  }
  if ($targets.Count -eq 0) {
    if (Test-Path -LiteralPath $pidFile) { Remove-Item -LiteralPath $pidFile -Force }
    return $false
  }
  foreach ($proc in $targets) {
    & taskkill.exe /PID $proc.ProcessId /T /F 2>&1 | Out-Null
    # Waiting for exit uses Wait-Process (the process-exit event), not polling.
    Wait-Process -Id $proc.ProcessId -Timeout 15 -ErrorAction SilentlyContinue
    if ($null -ne (Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue)) {
      throw "instance $($proc.ProcessId) is still alive after taskkill"
    }
  }
  if (Test-Path -LiteralPath $pidFile) { Remove-Item -LiteralPath $pidFile -Force }
  return $true
}

# Is anyone still listening on the port (proof the teardown was clean; one connection attempt, no polling).
function Test-TcpListener {
  param([Parameter(Mandatory=$true)][int]$Port, [int]$TimeoutMs = 1500)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync('127.0.0.1', $Port)
    if (-not $task.Wait($TimeoutMs)) { return $false }
    return $client.Connected
  } catch { return $false } finally { $client.Close() }
}

# A process's ancestor chain (up from the parent, at most 64 levels): used to exclude the caller itself from the teardown assertion.
function Get-ProcessAncestorIds {
  param([Parameter(Mandatory=$true)][int]$ProcessId, [AllowEmptyCollection()]$ProcessTable = $null)
  $table = $(if ($null -ne $ProcessTable) { @($ProcessTable) } else { @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) })
  $parentOf = @{}
  foreach ($proc in $table) { $parentOf[[int]$proc.ProcessId] = [int]$proc.ParentProcessId }
  $chain = New-Object System.Collections.Generic.List[int]
  $current = $ProcessId
  for ($step = 0; $step -lt 64; $step++) {
    if (-not $parentOf.ContainsKey($current)) { break }
    $parent = [int]$parentOf[$current]
    if ($parent -le 0 -or $chain.Contains($parent)) { break }
    $chain.Add($parent)
    $current = $parent
  }
  return @($chain.ToArray())
}

# Teardown assertion: any node/cmd process still running that **belongs to this testbed**. Identity
# is what this fixture itself has written down:
#   (1) the command line carries the launcher path this fixture wrote (<Root>\logs\start-<profile>.cmd);
#   (2) the process is a descendant of "instance pids this fixture wrote down" — the pid in the pid
#       file plus the ones the caller passed in for this run. The instance's own node command line
#       does not carry the launcher path, so only the pid tree identifies it; orphans whose father
#       already died count too, recovered via their own remembered ParentProcessId from the identity pids.
# The caller itself and its ancestor chain are explicitly excluded: if the caller mentions the run
# root in its command line (passing -Root explicitly is the most direct example), the old substring
# check would read the caller itself as "testbed leftover" — same deliverable, same on-disk state,
# a different invocation style would flip the exit code. A real leftover process can never be the
# caller's ancestor, so excluding it does not weaken this check.
function Get-StrayTestbedProcess {
  param(
    [Parameter(Mandatory=$true)][string]$Root,
    # The default is the profile name this entry point uses: the shipped entry always passes
    # -Profile explicitly; this default is for callers elsewhere that pass only -Root, so that
    # changing the criteria here does not break their invocation style.
    [string]$Profile = 'superworker-testbed',
    [AllowEmptyCollection()][int[]]$InstancePids = @()
  )
  $launcher = Join-Path $Root ('logs\start-' + $Profile + '.cmd')
  $table = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  # Exclusion set = the caller itself (the pwsh running this cell) + its ancestor chain (its host processes).
  $excluded = New-Object System.Collections.Generic.HashSet[int]
  $null = $excluded.Add([int]$PID)
  foreach ($ancestor in (Get-ProcessAncestorIds -ProcessId $PID -ProcessTable $table)) { $null = $excluded.Add([int]$ancestor) }
  # Identity core: the instance pids this fixture wrote down.
  $identityPids = New-Object System.Collections.Generic.HashSet[int]
  $pidFile = Join-Path $Root 'logs\instance.pid'
  if (Test-Path -LiteralPath $pidFile) {
    $instancePid = 0
    if ([int]::TryParse(((Get-Content -LiteralPath $pidFile -Raw).Trim()), [ref]$instancePid)) { $null = $identityPids.Add($instancePid) }
  }
  foreach ($id in @($InstancePids)) { $null = $identityPids.Add([int]$id) }
  # Collect descendants level by level from the identity pids (orphans whose parent edge is broken are found too).
  $descendants = New-Object System.Collections.Generic.HashSet[int]
  foreach ($id in $identityPids) { $null = $descendants.Add([int]$id) }
  $grew = $true
  while ($grew) {
    $grew = $false
    foreach ($proc in $table) {
      $procId = [int]$proc.ProcessId
      if ($descendants.Contains($procId)) { continue }
      if ($descendants.Contains([int]$proc.ParentProcessId)) { $null = $descendants.Add($procId); $grew = $true }
    }
  }
  $found = New-Object System.Collections.Generic.List[string]
  foreach ($proc in $table) {
    if ($proc.Name -ne 'node.exe' -and $proc.Name -ne 'cmd.exe') { continue }
    $procId = [int]$proc.ProcessId
    if ($excluded.Contains($procId)) { continue }
    $cmdline = [string]$proc.CommandLine
    $byLauncher = ($cmdline.Length -gt 0 -and $cmdline -like "*$launcher*")
    $byTree = $descendants.Contains($procId)
    if (-not ($byLauncher -or $byTree)) { continue }
    $how = $(if ($byLauncher -and $byTree) { 'launcher path + instance pid tree' } elseif ($byLauncher) { 'launcher path' } else { 'instance pid tree' })
    $found.Add("$procId $($proc.Name) [$how]: $cmdline")
  }
  return @($found.ToArray())
}

# ---------------------------------------------------------------------------
# HTTP calls (the instance's own /api surface)
# ---------------------------------------------------------------------------

# Trade the instance's boot token for a browser cookie: a GET on the URL 303s to ./ and plants the cookie in the session.
function Connect-TestbedBrowser {
  param([Parameter(Mandatory=$true)][string]$Url)
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $null = Invoke-WebRequest -Uri $Url -WebSession $session -MaximumRedirection 5 -TimeoutSec 20 -UseBasicParsing
  return $session
}

# Two positive readings, on the running instance itself, that "the panel is really installed"
# (neither reads the config tree off disk):
#   * settings namespace: the line's id shows up in the `settings/describe` roster (a plugin line's
#     id is the name of its settings namespace, and the `Config` the host half exposes hangs under it);
#   * browser half: the boot manifest the instance hands the browser lists `<package name>/client.js` —
#     the bundle the shell is to fetch.
# Both must read back; missing either throws: installed but not serving is as broken as not installed.
function Get-TestbedPanelMount {
  param(
    [Parameter(Mandatory=$true)][int]$Port,
    [Parameter(Mandatory=$true)][string]$Url,
    [Parameter(Mandatory=$true)][string]$PluginName,
    [Parameter(Mandatory=$true)][string]$PluginId,
    [Parameter(Mandatory=$true)][string]$EvidenceDir
  )
  $browser = Connect-TestbedBrowser -Url $Url
  $describe = Invoke-TestbedApi -Port $Port -WebSession $browser -Endpoint 'settings/describe' `
    -Arguments ([ordered]@{}) -EvidencePath (Join-Path $EvidenceDir 'settings-describe')
  $namespaces = @($describe.namespaces | ForEach-Object { [string]$_.ns })
  if (-not ($namespaces -contains $PluginId)) {
    throw "the live instance does not expose the '$PluginId' settings namespace (namespaces: $($namespaces -join ', '))"
  }

  $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -WebSession $browser -TimeoutSec 20 -UseBasicParsing
  $page = $response.Content
  if ($page -isnot [string]) { $page = [System.Text.Encoding]::UTF8.GetString($page) }
  Write-TextFile -Path (Join-Path $EvidenceDir 'boot-page.html') -Text ($page + "`n")
  $bundleRef = "$PluginName/client.js"
  if (-not $page.Contains($bundleRef)) {
    throw "the live instance's boot manifest does not list '$bundleRef' (page $($page.Length) chars)"
  }
  return [ordered]@{
    namespace = $PluginId
    namespacePresent = $true
    namespaceCount = $namespaces.Count
    namespaces = $namespaces
    clientBundleRef = $bundleRef
    clientBundleListed = $true
    pageBytes = $page.Length
  }
}

# One /api/<namespace>/<method> call: the request envelope is exactly { type, rpcId, method, payload:{ args } },
# the response is { result:{ ok, value } }. The endpoint spelling is <namespace>/<method> (the
# instance only accepts two-segment paths) and the envelope's method matches it verbatim; args key
# names follow the method signature: session/list takes _request; session/page, session/projections
# and workspace/create take request.
function Invoke-TestbedApi {
  param(
    [Parameter(Mandatory=$true)][int]$Port,
    [Parameter(Mandatory=$true)]$WebSession,
    [Parameter(Mandatory=$true)][string]$Endpoint,
    $Arguments = @{},
    [string]$EvidencePath = ''
  )
  $envelope = [ordered]@{
    type = 'client-request'
    rpcId = [guid]::NewGuid().ToString('n')
    method = $Endpoint
    payload = [ordered]@{ args = $Arguments }
  }
  $body = $envelope | ConvertTo-Json -Depth 20 -Compress
  $base = "http://127.0.0.1:$Port"
  $response = Invoke-WebRequest -Uri "$base/api/$Endpoint" -Method Post -WebSession $WebSession `
    -ContentType 'application/json' -Body $body -TimeoutSec 30 -UseBasicParsing
  $text = [string]$response.Content
  if ($EvidencePath.Length -gt 0) {
    Write-TextFile -Path ($EvidencePath + '.request.json') -Text $body
    Write-TextFile -Path ($EvidencePath + '.response.json') -Text $text
  }
  $parsed = $text | ConvertFrom-Json
  if ($parsed.result.ok -ne $true) {
    $code = $parsed.result.error.code
    $message = $parsed.result.error.message
    throw "endpoint $Endpoint returned an error result: ${code}: $message"
  }
  return $parsed.result.value
}

# Completion criterion 1's "one command that prints the session list".
#   * Only one shell is printed: the shell the entry point itself runs under (pwsh). The two shells
#     quote differently (in cmd, single quotes are plain characters and %TEMP% expands; in pwsh the
#     JSON inside single quotes goes out verbatim and $env:TEMP expands) — printing both side by
#     side only invites pasting the wrong line.
#   * What is printed is one line: paste it into pwsh as-is and hit enter, and the list prints
#     (first segment takes the cookie, second prints the list).
#   * curl carries -f: a non-zero exit code on HTTP 4xx/5xx, so "it was rejected but curl exited 0"
#     cannot read as success.
function Format-TestbedListCommand {
  param([Parameter(Mandatory=$true)][int]$Port, [Parameter(Mandatory=$true)][string]$Token)
  $body = '{"type":"client-request","rpcId":"list-1","method":"session/list","payload":{"args":{"_request":{}}}}'
  $cookieJar = '"$env:TEMP\superworker-testbed-cookies.txt"'
  $line1 = 'curl.exe -s -f -c ' + $cookieJar + ' "http://127.0.0.1:' + $Port + '/?token=' + $Token + '" -o NUL'
  $line2 = 'curl.exe -s -f -b ' + $cookieJar + ' -H "content-type: application/json" -d ''' + $body + ''' http://127.0.0.1:' + $Port + '/api/session/list'
  # One line; do not join array elements with + (comma and + precedence glues the segments wrong).
  return ($line1 + '; ' + $line2)
}

# ---------------------------------------------------------------------------
# Provisioning, one instance cycle's readings, and the criterion lines drawn from them (1, 2, 3, 5)
# ---------------------------------------------------------------------------
# Print "one command that prints the session list". Only the pwsh form is printed, labeled as such;
# the command is immediately followed by "what counts as passing".
function Get-TestbedListCommandLines {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$Token,
    [AllowEmptyCollection()][string[]]$SessionIds = @()
  )
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add('one command that prints the session list — pwsh only, this entry runs under pwsh; paste this single line as-is:')
  $lines.Add((Format-TestbedListCommand -Port $Port -Token $Token))
  $lines.Add('it passed when the reply has "ok":true and its items contain: ' + (@($SessionIds) -join ', ') + ' — read that reply, and leave the shell exit code out of it: -f makes curl itself exit 22 on a 4xx/5xx, while the shell that runs this one line still exits 0')
  return @($lines.ToArray())
}

# Delete wholesale and rebuild: idempotent in place; a home left over from the previous round is not treated as clean.
function Invoke-TestbedProvision {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Profile,
    [Parameter(Mandatory = $true)][string]$Workspace,
    [Parameter(Mandatory = $true)][int]$SessionCount,
    [string]$EmptyWorkspace = '',
    [switch]$LinkedWorktree,
    [Parameter(Mandatory = $true)][string]$DshCmd,
    [Parameter(Mandatory = $true)][string]$NodeExe
  )
  # Stop the still-running instance before rebuilding: it holds its own stdout/stderr files open, and they cannot be deleted otherwise.
  $null = Stop-TestbedInstance -Root $Root -Profile $Profile
  if (Test-Path -LiteralPath $Root) { Remove-Item -LiteralPath $Root -Recurse -Force }
  New-Item -ItemType Directory -Force -Path (Join-Path $Root 'logs') | Out-Null
  $testbedHome = Join-Path $Root 'home'
  New-Item -ItemType Directory -Force -Path $testbedHome | Out-Null

  $profileDir = New-TestbedProfile -TestbedHome $testbedHome -Profile $Profile -DshCmd $DshCmd
  $manifest = New-TestbedFixture -Root $Root -Profile $Profile -WorkspaceName $Workspace `
    -SessionCount $SessionCount -EmptyWorkspaceName $EmptyWorkspace -LinkedWorktree:$LinkedWorktree -NodeExe $NodeExe

  # Validate the header first, then the manifest: an invalid header makes that session vanish silently, so it must be caught here.
  foreach ($session in $manifest.sessions) {
    $problems = Test-TestbedSessionFixture -Session $session
    if ($problems.Count -gt 0) { throw ("synthetic session header check failed: " + ($problems -join '; ')) }
  }

  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("root=$Root")
  $lines.Add("home=$testbedHome")
  $lines.Add("profileDir=$profileDir")
  foreach ($ws in $manifest.workspaces) {
    $lines.Add("workspace=$($ws.workspaceId) name=$($ws.name) sessions=$(@($ws.sessionIds).Count) path=$($ws.path)")
  }
  foreach ($session in $manifest.sessions) {
    $lines.Add("session=$($session.sessionId) log=$($session.logPath)")
  }
  Write-TextFile -Path (Join-Path $Root 'logs\provision-summary.txt') -Text (($lines -join "`n") + "`n")
  return $manifest
}

# Readings from one instance cycle: completion criteria 1, 2 and 5 all draw from here.
function Invoke-TestbedRun {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)]$Manifest,
    [Parameter(Mandatory = $true)]$Ready
  )
  $rawDir = Join-Path $Root 'logs\raw'
  if (-not (Test-Path -LiteralPath $rawDir)) { New-Item -ItemType Directory -Force -Path $rawDir | Out-Null }
  $browser = Connect-TestbedBrowser -Url $Ready.url
  $list = Invoke-TestbedApi -Port $Ready.port -WebSession $browser -Endpoint 'session/list' `
    -Arguments ([ordered]@{ _request = [ordered]@{} }) `
    -EvidencePath (Join-Path $rawDir 'session-list')

  $rows = New-Object System.Collections.Generic.List[object]
  foreach ($session in $Manifest.sessions) {
    $row = @($list.items | Where-Object { [string]$_.sessionId -eq [string]$session.sessionId })
    $page = Invoke-TestbedApi -Port $Ready.port -WebSession $browser -Endpoint 'session/page' -Arguments ([ordered]@{
        request = [ordered]@{
          address = [ordered]@{ kind = 'session'; sessionId = [string]$session.sessionId }
          throughSeq = -1
        }
      }) -EvidencePath (Join-Path $rawDir ('session-page-' + $session.sessionId))
    $projections = Invoke-TestbedApi -Port $Ready.port -WebSession $browser -Endpoint 'session/projections' `
      -Arguments ([ordered]@{ request = [ordered]@{ sessionId = [string]$session.sessionId } }) `
      -EvidencePath (Join-Path $rawDir ('session-projections-' + $session.sessionId))
    $workspace = Invoke-TestbedApi -Port $Ready.port -WebSession $browser -Endpoint 'workspace/create' `
      -Arguments ([ordered]@{ request = [ordered]@{ path = [string]$session.workspacePath } }) `
      -EvidencePath (Join-Path $rawDir ('workspace-create-' + $session.sessionId))

    $listed = $row.Count -gt 0
    $accounted = @($workspace.workspace.sessionIds) -contains [string]$session.sessionId
    $cwdMatches = ($listed -and ([string]$row[0].cwd -eq [string]$session.workspacePath))
    $rows.Add([ordered]@{
      sessionId = $session.sessionId
      listed = $listed
      listRow = $(if ($listed) { $row[0] } else { $null })
      listItemCount = @($list.items).Count
      listAllIds = @($list.items | ForEach-Object { [string]$_.sessionId })
      pageRecordCount = @($page.records).Count
      pageHasMore = $page.hasMore
      pageOpened = ($null -ne $page)
      projectionsAsOfSeq = $projections.asOfSeq
      projectionsOpened = ($null -ne $projections)
      workspaceCreatedByThisCall = [bool]$workspace.created
      workspaceId = [string]$workspace.workspace.workspaceId
      workspacePath = [string]$workspace.workspace.path
      workspaceSessionIds = @($workspace.workspace.sessionIds)
      accounted = $accounted
      cwdMatches = $cwdMatches
    })
  }

  # The optional empty workspace is read too: it should resolve, with an empty member list.
  $emptyReadings = New-Object System.Collections.Generic.List[object]
  foreach ($ws in $Manifest.workspaces) {
    if (-not $ws.empty) { continue }
    $resolved = Invoke-TestbedApi -Port $Ready.port -WebSession $browser -Endpoint 'workspace/create' `
      -Arguments ([ordered]@{ request = [ordered]@{ path = [string]$ws.path } }) `
      -EvidencePath (Join-Path $rawDir ('workspace-create-' + $ws.workspaceId))
    $emptyReadings.Add([ordered]@{
      name = $ws.name
      workspaceId = [string]$resolved.workspace.workspaceId
      createdByThisCall = [bool]$resolved.created
      sessionIds = @($resolved.workspace.sessionIds)
    })
  }

  return [ordered]@{
    url = $Ready.url
    port = $Ready.port
    token = $Ready.token
    itemCount = @($list.items).Count
    sessions = @($rows.ToArray())
    emptyWorkspaces = @($emptyReadings.ToArray())
  }
}

function Format-RunReadings {
  param([Parameter(Mandatory = $true)]$Run)
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("url=http://127.0.0.1:$($Run.port)/?token=<redacted>")
  $lines.Add("session.list items=$($Run.itemCount) ids=$((@($Run.sessions | ForEach-Object { $_.listAllIds }) | Select-Object -First 1) -join ',')")
  foreach ($row in $Run.sessions) {
    $lines.Add("  session $($row.sessionId): listed=$($row.listed) cwdMatches=$($row.cwdMatches) blank=$($row.listRow.blank) running=$($row.listRow.running) agentAvailable=$($row.listRow.agentAvailable)")
    $lines.Add("  session.page records=$($row.pageRecordCount) hasMore=$($row.pageHasMore) (ok result, no error)")
    $lines.Add("  session.projections opened=$($row.projectionsOpened) asOfSeq=$($row.projectionsAsOfSeq) (ok result, no error)")
    $lines.Add("  workspace $($row.workspaceId) path=$($row.workspacePath) createdByThisCall=$($row.workspaceCreatedByThisCall) sessionIds=$($row.workspaceSessionIds -join ',') accounted=$($row.accounted)")
  }
  foreach ($empty in $Run.emptyWorkspaces) {
    $lines.Add("  empty workspace $($empty.workspaceId) createdByThisCall=$($empty.createdByThisCall) sessionIds=$(@($empty.sessionIds).Count)")
  }
  return @($lines.ToArray())
}

function Test-RunCriteria {
  param([Parameter(Mandatory = $true)]$Run)
  $ok = $true
  foreach ($row in $Run.sessions) {
    # Listed, grouped under the workspace (both readings of membership require it), and both open
    # steps returned ok results. Zero records in the page is normal: the synthetic session is built
    # to be listable and openable only — its body carries no message events.
    if (-not $row.listed) { $ok = $false }
    if (-not $row.cwdMatches) { $ok = $false }
    if (-not $row.accounted) { $ok = $false }
    if ($row.workspaceCreatedByThisCall) { $ok = $false }
    if (-not $row.pageOpened) { $ok = $false }
    if (-not $row.projectionsOpened) { $ok = $false }
  }
  return $ok
}

# Criterion 2's own verdict: the session is grouped under the workspace, not ungrouped. It reads
# only its own two terms — the session accounted in workspace.sessionIds, and the session.list
# row's cwd equal to the workspace path — so it can turn red on its own while criterion 1 stays
# green; it is not a share of criterion 1's full predicate.
function Test-GroupingCriteria {
  param([Parameter(Mandatory = $true)]$Run)
  $ok = $true
  foreach ($row in $Run.sessions) {
    if (-not $row.accounted) { $ok = $false }
    if (-not $row.cwdMatches) { $ok = $false }
  }
  return $ok
}

# Completion criterion 1's readings: the run's own summary lines, then the one command that prints
# the session list (with what counts as passing, read from the same run). Verdict: Test-RunCriteria.
function Get-SessionListCriterion {
  param([Parameter(Mandatory=$true)]$Run)
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($line in (Format-RunReadings -Run $Run)) { $lines.Add($line) }
  $lines.Add('command used (one command, prints the session list):')
  foreach ($line in (Get-TestbedListCommandLines -Port $Run.port -Token $Run.token -SessionIds @($Run.sessions | ForEach-Object { [string]$_.sessionId }))) { $lines.Add($line) }
  return [ordered]@{ Passed = (Test-RunCriteria -Run $Run); Lines = @($lines.ToArray()) }
}

# Completion criterion 2's readings: the two terms that make a session grouped rather than ungrouped,
# printed one line each. Its own verdict (Test-GroupingCriteria) can turn red on its own while
# criterion 1 stays green — it is not a share of criterion 1's full predicate.
function Get-GroupingCriterion {
  param([Parameter(Mandatory=$true)]$Run)
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($row in $Run.sessions) {
    $lines.Add("session $($row.sessionId) accounted by workspace.sessionIds: $($row.accounted)")
    $lines.Add("session.list row cwd == workspace path: $($row.cwdMatches) ($($row.listRow.cwd))")
    $lines.Add("workspace.create resolved an existing registration: createdByThisCall=$($row.workspaceCreatedByThisCall) workspaceId=$($row.workspaceId)")
    $lines.Add('grouping input is workspace.sessionIds; this session is in it, so it is grouped, not ungrouped')
  }
  return [ordered]@{ Passed = (Test-GroupingCriteria -Run $Run); Lines = @($lines.ToArray()) }
}

# Completion criterion 3's readings: the restarted instance's own run, printed the same way as
# criterion 1's, with the pid it was started as. Verdict: the same Test-RunCriteria asked of that run
# (it covers criteria 1 and 2 together).
function Get-RestartCriterion {
  param([Parameter(Mandatory=$true)]$Run, [Parameter(Mandatory=$true)][int]$ProcessId)
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("restarted instance: port=$($Run.port) pid=$ProcessId")
  foreach ($line in (Format-RunReadings -Run $Run)) { $lines.Add($line) }
  return [ordered]@{ Passed = (Test-RunCriteria -Run $Run); Lines = @($lines.ToArray()) }
}

# Completion criterion 5's readings: the isolated home held no credentials before the first start, the
# first start really printed its URL, and after it started only the browser-session record the web app
# issues itself appeared. No model credentials are supplied by the provisioner, so none may show up.
function Get-CredentialsCriterion {
  param(
    [Parameter(Mandatory=$true)][bool]$PresentBeforeStart,
    [Parameter(Mandatory=$true)][AllowEmptyString()][string]$CredentialsAfterStart,
    [Parameter(Mandatory=$true)][AllowEmptyString()][string]$TestbedHome,
    [Parameter(Mandatory=$true)][AllowEmptyString()][string]$UrlLine
  )
  $recordKeys = New-Object System.Collections.Generic.List[string]
  $inRecords = $false
  foreach ($line in ($CredentialsAfterStart -split "`n")) {
    if ($line -match '^records:\s*$') { $inRecords = $true; continue }
    if (-not $inRecords) { continue }
    if ($line -match '^  ([^\s:]+):\s*$') { $recordKeys.Add($Matches[1]); continue }
    if ($line -match '^\S') { $inRecords = $false }
  }
  $unexpectedKeys = @($recordKeys | Where-Object { $_ -ne 'client-connection/browser-session' })
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("credentials file present before the first start: $PresentBeforeStart")
  $lines.Add("isolated home: $TestbedHome")
  $lines.Add("first start printed: $UrlLine")
  $lines.Add("credential record keys after the first start: $($recordKeys -join ', ') (expected: the web app's own client-connection/browser-session grant only)")
  $lines.Add("unexpected credential keys: $($unexpectedKeys.Count)")
  $lines.Add('model credentials supplied by the provisioner: none; no fake model service was mounted')
  $passed = ((-not $PresentBeforeStart) -and ($UrlLine -match 'dsh web:') -and ($unexpectedKeys.Count -eq 0))
  return [ordered]@{ Passed = $passed; Lines = @($lines.ToArray()) }
}
