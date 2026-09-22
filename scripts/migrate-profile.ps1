<#
.SYNOPSIS
  Move one DSH profile from an old plugin identity to a new one — delete the
  old, install the new, and prove both happened.

.DESCRIPTION
  Renaming a plugin changes four things at once, and missing any one of them
  fails SILENTLY:

    1. the dependency spec in the profile's package.json
    2. the name in dsh.profile.bundles — maintained by the CLI's reconcile
       pass, never by hand
    3. the row id in the profile's cordis.patch.yml (a patch targeting an id
       that does not exist is a no-op, not an error)
    4. the directory under profile node_modules

  Order is deliberate: **install the new identity first, remove the old one
  second.** A failure in between leaves a working plugin in place instead of an
  empty profile. Both pnpm calls are retried once — while the host is running,
  node_modules is locked and the first attempt can fail with
  ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR.

  -DryRun prints the plan and runs only the read-only verification.

.PARAMETER NewSpec
  What to install: a registry spec (`dsh-pptx-sidebar@0.1.0`), a git spec
  (`github:owner/repo#<sha>`), or a local path.

.PARAMETER OldName
  Optional package name to remove from the profile. **This plugin is not a
  rename**, so the usual call omits it and the script is install-only; pass it
  when replacing some other identity with this one.

.PARAMETER RepoPath
  Optional path to the plugin checkout; when given, the installed
  lib/client.js is hashed against it.

.EXAMPLE
  pwsh -File scripts/migrate-profile.ps1 -Profile web -NewSpec 'dsh-pptx-sidebar@0.1.0' -DryRun

.EXAMPLE
  pwsh -File scripts/migrate-profile.ps1 -Profile web -NewSpec 'github:drscrewdriver/dsh-pptx-sidebar#<sha>'
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $Profile,
  [Parameter(Mandatory = $true)][string] $NewSpec,
  [string] $OldName = '',
  [string] $NewName = '',
  [string] $Registry = 'https://registry.npmjs.org',
  # NOTE: $PSScriptRoot is not populated while a param block's default is being
  # evaluated, so the checkout path is resolved in the body instead.
  [string] $RepoPath = '',
  [string] $DshCmd = '',
  [string] $DshHome = '',
  [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── helpers ──────────────────────────────────────────────────────────────────

function Resolve-Dsh {
  param([string] $Explicit)
  if ($Explicit -ne '') { return $Explicit }
  $cmd = Get-Command dsh -ErrorAction SilentlyContinue
  if ($null -ne $cmd) { return $cmd.Source }
  foreach ($candidate in @('C:\nodejs\dsh.cmd', (Join-Path $env:APPDATA 'npm\dsh.cmd'))) {
    if (Test-Path $candidate) { return $candidate }
  }
  throw 'dsh CLI not found — pass -DshCmd <path>'
}

function Resolve-DshHome {
  param([string] $Explicit)
  if ($Explicit -ne '') { return $Explicit }
  if ($env:DSH_HOME) { return $env:DSH_HOME }
  return (Join-Path $env:USERPROFILE '.dsh')
}

# The package name behind a spec: github:owner/repo#sha -> repo, name@1.0.0 -> name.
function Get-SpecName {
  param([string] $Spec)
  if ($Spec -like 'github:*') {
    $body = $Spec.Substring(7)
    $body = ($body -split '#')[0]
    return ($body -split '/')[-1]
  }
  if ($Spec.StartsWith('file:') -or $Spec.StartsWith('link:') -or $Spec.StartsWith('.') -or $Spec.StartsWith('/')) {
    $pkgJson = Join-Path ($Spec -replace '^(file:|link:)', '') 'package.json'
    if (Test-Path $pkgJson) { return (Get-Content $pkgJson -Raw | ConvertFrom-Json).name }
    throw "cannot infer a package name from '$Spec' — pass -NewName"
  }
  if ($Spec.Contains('@')) { return ($Spec -split '@')[0] }
  return $Spec
}

# The running host holds node_modules open, so a first attempt may fail.
function Invoke-DshPlugin {
  param([string] $Dsh, [string[]] $Arguments, [string] $Label)
  & $Dsh @Arguments
  if ($LASTEXITCODE -eq 0) { return }
  $first = $LASTEXITCODE
  Write-Host "        $Label failed (exit $first) — retrying once (node_modules locked by the running host)" -ForegroundColor Yellow
  Start-Sleep -Seconds 3
  & $Dsh @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Label failed twice (exit $LASTEXITCODE)" }
}

# Resolve the target spec BEFORE touching anything. A spec that does not exist
# today — an npm version that was never published, an unreachable repo — must
# fail here, not halfway through a migration. (Learned the hard way: a README
# example of the form `name@1.0.0` reads as "runnable now" even when nothing
# was published under that name yet.)
function Assert-SpecResolves {
  param([string] $Spec, [string] $Registry)

  # github:owner/repo[#ref]
  if ($Spec -like 'github:*') {
    $body = $Spec.Substring(7)
    $ref = ''
    if ($body.Contains('#')) {
      $ref = ($body -split '#')[1]
      $body = ($body -split '#')[0]
    }
    $url = $body
    if ($url -notmatch '^[a-z]+://' -and $url -notmatch '^git@') { $url = "https://github.com/$body.git" }
    # A 40-hex ref cannot be queried by name; prove reachability instead and let
    # pnpm verify the SHA during install.
    $refArg = if ($ref -ne '' -and $ref -notmatch '^[0-9a-f]{7,40}$') { $ref } else { 'HEAD' }

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $code = 1
    try {
      $probe = (& git ls-remote --exit-code $url $refArg 2>&1 | Out-String)
      $code = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previous
    }
    if ($code -ne 0 -or $probe.Trim() -eq '') {
      throw "git spec does not resolve: '$Spec' (git ls-remote $url $refArg found nothing)"
    }
    Write-Host "        git spec resolves ($url @ $refArg)" -ForegroundColor DarkGray
    if ($ref -match '^[0-9a-f]{7,40}$') {
      Write-Host '        ref is a commit SHA — reachability proven here, the SHA itself is verified by the install' -ForegroundColor DarkGray
    }
    return
  }

  # local path / file: / link:
  if ($Spec -like 'file:*' -or $Spec -like 'link:*' -or $Spec.StartsWith('.') -or $Spec.StartsWith('/') -or $Spec -match '^[A-Za-z]:') {
    $path = $Spec -replace '^(file:|link:)', ''
    if (-not (Test-Path (Join-Path $path 'package.json'))) { throw "local spec has no package.json: $path" }
    Write-Host '        local spec has a package.json' -ForegroundColor DarkGray
    return
  }

  # registry spec: name or name@range
  $name = $Spec
  $range = ''
  if ($Spec.Contains('@')) {
    $name = ($Spec -split '@')[0]
    $range = ($Spec -split '@', 2)[1]
  }
  $target = if ($range -ne '') { "$name@$range" } else { $name }

  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $code = 1
  $probe = ''
  try {
    $probe = (& npm --loglevel=error view $target version --registry $Registry 2>&1 | Out-String)
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($code -ne 0 -or $probe.Trim() -eq '') {
    throw "'$target' does not resolve on $Registry — publish it first (scripts/publish-npm.ps1), or install a github: spec instead"
  }
  Write-Host "        registry spec resolves: $target -> $($probe.Trim())" -ForegroundColor DarkGray
}

# ── setup ────────────────────────────────────────────────────────────────────

# Default the checkout path to this script's repository root.
if ($RepoPath -eq '') {
  if ($PSScriptRoot) { $RepoPath = Split-Path -Parent $PSScriptRoot } else { $RepoPath = (Get-Location).Path }
}

$dsh = Resolve-Dsh $DshCmd
$dshHome = Resolve-DshHome $DshHome
$profileDir = Join-Path (Join-Path $dshHome 'profiles') $Profile
if (-not (Test-Path (Join-Path $profileDir 'package.json'))) {
  throw "no such profile: $profileDir"
}
$newName = if ($NewName -ne '') { $NewName } else { Get-SpecName $NewSpec }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$manifestPath = Join-Path $profileDir 'package.json'
$patchPath = Join-Path $profileDir 'cordis.patch.yml'

# A migration may legitimately be re-run (e.g. after a version bump), and the
# old identity is often already gone. Removing a package that is not a
# dependency is an ERROR in pnpm, so probe first instead of failing halfway
# through — this step is idempotent on purpose.
$manifestBefore = Get-Content $manifestPath -Raw | ConvertFrom-Json
# Install-only by default ($OldName = ''): this plugin was never a rename, so
# there is no old identity to remove. Every removal check below follows suit.
$haveOld = $OldName -ne ''
$oldInstalled = $haveOld -and (@($manifestBefore.dependencies.PSObject.Properties.Name) -contains $OldName)
$patchHasOldRow = $haveOld -and [System.IO.File]::ReadAllText($patchPath).Contains("- id: $OldName")

Write-Host "migrate-profile: -> $newName$(if ($haveOld) { " (replacing $OldName)" })" -ForegroundColor Cyan
Write-Host "  profile : $profileDir" -ForegroundColor DarkGray
Write-Host "  spec    : $NewSpec" -ForegroundColor DarkGray
Write-Host "  dsh     : $dsh" -ForegroundColor DarkGray
Write-Host "  DryRun  : $($DryRun.IsPresent)" -ForegroundColor DarkGray

Write-Host ''
Write-Host 'preflight: does the target spec exist?' -ForegroundColor Cyan
Assert-SpecResolves -Spec $NewSpec -Registry $Registry

Write-Host ''
Write-Host 'plan:' -ForegroundColor Cyan
Write-Host "  1. back up package.json + cordis.patch.yml  (.bak-$stamp)"
Write-Host "  2. dsh plugin --profile $Profile add $NewSpec        <- new identity FIRST"
if ($oldInstalled) {
  Write-Host "  3. dsh plugin --profile $Profile remove $OldName     <- old identity SECOND (reconcile drops it from bundles)"
} else {
  Write-Host "  3. skip remove $OldName — not a dependency of this profile (already migrated)"
}
if ($patchHasOldRow) {
  Write-Host "  4. swap '- id: $OldName' -> '- id: $newName' in cordis.patch.yml"
} else {
  Write-Host "  4. skip the patch row swap — no '- id: $OldName' present"
}
Write-Host '  5. verify deps / bundles / node_modules / composed row'

# ── 1. backups ───────────────────────────────────────────────────────────────

if (-not $DryRun) {
  Copy-Item $manifestPath "$manifestPath.bak-$stamp" -Force
  Copy-Item $patchPath "$patchPath.bak-$stamp" -Force
  Write-Host ''
  Write-Host "backed up: package.json.bak-$stamp, cordis.patch.yml.bak-$stamp" -ForegroundColor DarkGray
}

# ── 2–3. install new, then remove old ────────────────────────────────────────

if (-not $DryRun) {
  Write-Host ''
  Write-Host "[2/5] add $NewSpec" -ForegroundColor Cyan
  Invoke-DshPlugin -Dsh $dsh -Label "add $NewSpec" -Arguments @('plugin', '--profile', $Profile, 'add', $NewSpec)

  Write-Host "[3/5] remove $OldName" -ForegroundColor Cyan
  if ($oldInstalled) {
    Invoke-DshPlugin -Dsh $dsh -Label "remove $OldName" -Arguments @('plugin', '--profile', $Profile, 'remove', $OldName)
  } else {
    Write-Host "        skipped — $(if ($haveOld) { "$OldName is not a dependency of this profile" } else { 'this plugin is not a rename' })" -ForegroundColor DarkGray
  }

  # ── 4. the profile patch row id ────────────────────────────────────────────
  Write-Host "[4/5] swap the patch row id in cordis.patch.yml" -ForegroundColor Cyan
  if ($patchHasOldRow) {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $patchText = [System.IO.File]::ReadAllText($patchPath)
    [System.IO.File]::WriteAllText($patchPath, $patchText.Replace("- id: $OldName", "- id: $newName"), $utf8)
    Write-Host "        '$OldName' -> '$newName'" -ForegroundColor DarkGray
  } else {
    Write-Host "        skipped — no '- id: $OldName' row to swap" -ForegroundColor DarkGray
  }
}

# ── 5. verification (also the whole of a DryRun) ─────────────────────────────

Write-Host ''
Write-Host '[5/5] verification' -ForegroundColor Cyan
$failures = New-Object System.Collections.Generic.List[string]

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$deps = @($manifest.dependencies.PSObject.Properties.Name)
$bundles = @($manifest.dsh.profile.bundles)

$depsHasOld = $deps -contains $OldName
$depsHasNew = $deps -contains $newName
$bundlesHasOld = $bundles -contains $OldName
$bundlesHasNew = $bundles -contains $newName
$oldDir = $haveOld -and (Test-Path (Join-Path (Join-Path $profileDir 'node_modules') $OldName))
$newDir = Test-Path (Join-Path (Join-Path $profileDir 'node_modules') $newName)

Write-Host ("  dependencies : old={0} new={1}" -f $(if ($haveOld) { $depsHasOld } else { 'n/a' }), $depsHasNew)
Write-Host ("  bundles      : old={0} new={1} (count {2})" -f $(if ($haveOld) { $bundlesHasOld } else { 'n/a' }), $bundlesHasNew, $bundles.Count)
Write-Host ("  node_modules : old={0} new={1}" -f $(if ($haveOld) { $oldDir } else { 'n/a' }), $newDir)

if ($oldInstalled) { $failures.Add("dependencies still lists $OldName") }
if ($bundlesHasOld) { $failures.Add("dsh.profile.bundles still lists $OldName") }
if ($oldDir) { $failures.Add("node_modules/$OldName still exists") }
if (-not $depsHasNew) { $failures.Add("dependencies does not list $newName") }
if (-not $bundlesHasNew) { $failures.Add("dsh.profile.bundles does not list $newName") }
if (-not $newDir) { $failures.Add("node_modules/$newName is missing") }

# the composed tree is the only proof that the row really exists.
# Same native-stderr caveat as elsewhere: relax the preference around the call,
# or a stray warning on stderr terminates the script under 'Stop'.
$previousEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  $dump = (& $dsh --profile $Profile --dump-config 2>&1 | Out-String)
} finally {
  $ErrorActionPreference = $previousEap
}
# @() matters: a single match is a string (no .Count) and zero matches is $null,
# and Set-StrictMode turns that into a hard error.
$rowNew = @(($dump -split "`r?`n") | Where-Object { $_.Trim() -eq "- id: $newName" }).Count
$rowOld = @(($dump -split "`r?`n") | Where-Object { $_.Trim() -eq "- id: $OldName" }).Count
Write-Host ("  composed row : new={0} old={1}" -f $rowNew, $rowOld)
if ($rowNew -lt 1) { $failures.Add("--dump-config shows no row for $newName") }
if ($rowOld -gt 0) { $failures.Add("--dump-config still shows a row for $OldName") }

# the installed artifact must be the one we built
if ($RepoPath -ne '' -and (Test-Path (Join-Path $RepoPath 'lib/client.js'))) {
  $localHash = (Get-FileHash (Join-Path $RepoPath 'lib/client.js')).Hash
  $installedFile = Join-Path (Join-Path (Join-Path $profileDir 'node_modules') $newName) 'lib/client.js'
  if (Test-Path $installedFile) {
    $installedHash = (Get-FileHash $installedFile).Hash
    $same = $localHash -eq $installedHash
    Write-Host ("  client.js    : {0} ({1})" -f $(if ($same) { 'MATCH' } else { 'DIFF' }), $localHash.Substring(0, 12))
    if (-not $same) { $failures.Add('installed lib/client.js differs from the checkout') }
  }
}

Write-Host ''
if ($failures.Count -gt 0) {
  Write-Host 'FAILED:' -ForegroundColor Red
  foreach ($failure in $failures) { Write-Host "  - $failure" -ForegroundColor Red }
  if (-not $DryRun) {
    Write-Host ''
    Write-Host "roll back with: Copy-Item '$manifestPath.bak-$stamp' '$manifestPath' -Force" -ForegroundColor Yellow
    Write-Host "                Copy-Item '$patchPath.bak-$stamp' '$patchPath' -Force" -ForegroundColor Yellow
  }
  exit 1
}

Write-Host 'all checks passed.' -ForegroundColor Green
if ($DryRun) {
  Write-Host 'DryRun: nothing was changed. Re-run without -DryRun to apply.' -ForegroundColor Yellow
} else {
  Write-Host 'RESTART the DSH host for the new row to take effect (a browser refresh is not enough).' -ForegroundColor Green
}
exit 0
