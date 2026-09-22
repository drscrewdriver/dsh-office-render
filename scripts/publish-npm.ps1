<#
.SYNOPSIS
  Publish this plugin to npm against an explicit registry, with the gates a
  renamed package needs before its first public release.

.DESCRIPTION
  Every step is a hard gate: the script stops at the first failure and never
  "publishes anyway". Order:

    1. build + tests        npm run verify (bundle load gate + both test suites)
    2. identity gate        the name must be free, or already OURS
    3. tarball listing      npm pack --dry-run — see exactly what ships
    4. auth gate            refuse to publish without a session (a bare 401 is
                            a terrible way to find out)
    5. publish              npm publish against $Registry, access public
    6. lane tag             add the $LaneTag dist-tag (latest stays as set)
    7. optional             deprecate the OLD name, pointing at this one

  -DryRun runs 1–3 and prints 4–7 without touching the registry. It is the only
  mode safe to run repeatedly — run it first.

.PARAMETER Registry
  Registry to publish to. Defaults to the official one on purpose: an upload
  must go to the official channel, never to a mirror.

.PARAMETER LaneTag
  Extra dist-tag for the DSH version lane (this repo's convention: dsh-0.1.5).

.PARAMETER DeprecateOld
  An older package name to mark deprecated, e.g. after a rename. Skipped with a
  note when that name was never published (a git-only identity).

.EXAMPLE
  pwsh -File scripts/publish-npm.ps1 -DryRun

.EXAMPLE
  pwsh -File scripts/publish-npm.ps1 -DeprecateOld dsh-csv-sidebar
#>
[CmdletBinding()]
param(
  [string] $Registry = 'https://registry.npmjs.org',
  [string] $LaneTag = 'dsh-0.1.5',
  [string] $DeprecateOld = '',
  [string] $OldReplacement = '',
  [switch] $DryRun,
  [switch] $SkipTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# npm writes its own warnings to stderr, and under $ErrorActionPreference='Stop'
# a redirected native command turns those bytes into a terminating error. So:
# relax the preference for the call, merge the streams, and read $LASTEXITCODE
# explicitly. `--loglevel=error` also drops the noise (e.g. a stray `store-dir`
# in the user's npmrc) so the captured text is just the value we asked for.
function Invoke-Npm {
  param([string[]] $Arguments)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $text = (& npm '--loglevel=error' @Arguments 2>&1 | Out-String)
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  return [pscustomobject]@{ Text = $text; Code = $code }
}

$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  $pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
  $name = $pkg.name
  $version = $pkg.version
  Write-Host "publish-npm: $name@$version -> $Registry  (DryRun=$($DryRun.IsPresent))" -ForegroundColor Cyan

  # ── 1. build + tests ───────────────────────────────────────────────────────
  if ($SkipTests) {
    Write-Host '  [1/7] verify SKIPPED (-SkipTests)' -ForegroundColor Yellow
  } else {
    Write-Host '  [1/7] npm run verify' -ForegroundColor Cyan
    & npm run verify
    if ($LASTEXITCODE -ne 0) { throw "verify failed (exit $LASTEXITCODE) — refusing to publish" }
  }

  # ── 2. identity gate: free, or ours ────────────────────────────────────────
  Write-Host '  [2/7] identity gate' -ForegroundColor Cyan
  $probe = Invoke-Npm @('view', $name, 'version', '--registry', $Registry)
  $existing = $probe.Text.Trim()
  if ($probe.Code -eq 0 -and $existing -ne '') {
    $whoami = (Invoke-Npm @('whoami', '--registry', $Registry)).Text.Trim()
    $maintainers = (Invoke-Npm @('view', $name, 'maintainers', '--registry', $Registry, '--json')).Text
    if ($whoami -eq '' -or $maintainers -notmatch [regex]::Escape($whoami)) {
      throw "the name '$name' is taken on $Registry and is not maintained by '$whoami' — pick another name"
    }
    Write-Host "        ours ($whoami); currently published: $existing" -ForegroundColor DarkGray
  } else {
    Write-Host "        '$name' is free on $Registry" -ForegroundColor DarkGray
  }

  # ── 3. what actually ships ────────────────────────────────────────────────
  Write-Host '  [3/7] npm pack --dry-run (tarball contents)' -ForegroundColor Cyan
  & npm pack --dry-run --registry $Registry
  if ($LASTEXITCODE -ne 0) { throw "npm pack --dry-run failed (exit $LASTEXITCODE)" }

  if ($DryRun) {
    Write-Host ''
    Write-Host '  [4/7] would check: npm whoami' -ForegroundColor Yellow
    Write-Host '  [5/7] would run  : npm publish --access public' -ForegroundColor Yellow
    Write-Host "  [6/7] would run  : npm dist-tag add $name@$version $LaneTag" -ForegroundColor Yellow
    if ($DeprecateOld -ne '') {
      Write-Host "  [7/7] would run  : npm deprecate $DeprecateOld@* '<note>'" -ForegroundColor Yellow
    }
    Write-Host ''
    Write-Host 'DryRun: nothing was published.' -ForegroundColor Green
    exit 0
  }

  # ── 4. auth gate ──────────────────────────────────────────────────────────
  $who = (Invoke-Npm @('whoami', '--registry', $Registry)).Text.Trim()
  if ($who -eq '') { throw "not logged in to $Registry — run: npm login --registry $Registry" }
  Write-Host "  [4/7] authenticated as $who" -ForegroundColor Cyan

  # ── 5. publish ────────────────────────────────────────────────────────────
  Write-Host '  [5/7] npm publish' -ForegroundColor Cyan
  & npm publish --registry $Registry --access public
  if ($LASTEXITCODE -ne 0) { throw "npm publish failed (exit $LASTEXITCODE)" }

  # ── 6. lane tag ───────────────────────────────────────────────────────────
  Write-Host "  [6/7] dist-tag $LaneTag" -ForegroundColor Cyan
  & npm dist-tag add "$name@$version" $LaneTag --registry $Registry
  if ($LASTEXITCODE -ne 0) { throw "npm dist-tag add failed (exit $LASTEXITCODE)" }

  # ── 7. optional: point the old name at this one ───────────────────────────
  if ($DeprecateOld -ne '') {
    $note = if ($OldReplacement -ne '') { $OldReplacement } else { "renamed to $name" }
    $oldProbe = Invoke-Npm @('view', $DeprecateOld, 'version', '--registry', $Registry)
    $oldVersion = $oldProbe.Text.Trim()
    if ($oldProbe.Code -eq 0 -and $oldVersion -ne '') {
      Write-Host "  [7/7] deprecate $DeprecateOld (was $oldVersion)" -ForegroundColor Cyan
      & npm deprecate "$DeprecateOld@*" $note --registry $Registry
      if ($LASTEXITCODE -ne 0) { throw "npm deprecate failed (exit $LASTEXITCODE)" }
    } else {
      Write-Host "  [7/7] $DeprecateOld was never published — nothing to deprecate" -ForegroundColor DarkGray
    }
  }

  Write-Host ''
  Write-Host "published $name@$version (tags: latest, $LaneTag)" -ForegroundColor Green
  Write-Host "migrate a profile with:" -ForegroundColor Green
  Write-Host "  pwsh -File scripts/migrate-profile.ps1 -Profile web -NewSpec '$name@$version'" -ForegroundColor Green
}
finally {
  Pop-Location
}
