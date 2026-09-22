# Convert one Office document to PDF using a locally installed, COM-capable
# Office-compatible suite.
#
# IMPORTANT - this file must stay pure ASCII.
# Windows PowerShell 5.1 decodes a BOM-less .ps1 with the ANSI code page, so any
# non-ASCII literal written here arrives mangled. The first version of this
# script embedded a Chinese sample path and reported "file not found" for a file
# that existed. Paths arrive as arguments instead: the OS passes argv as UTF-16,
# so Chinese file names survive.
#
# Contract with the caller (the plugin's Node half):
#   - exactly one JSON object is printed on the last stdout line
#   - convert: exit 0 => { ok: true, engine: <progid>, bytes: <n> }
#              exit 1 => { ok: false, error: <text> }
#   - probe:   exit 0 => { ok: true, engines: { "docx": <progid>, "pptx": <progid> } }
# The caller enforces the wall-clock timeout by killing this process tree, so
# this script deliberately has no timeout of its own: a hung COM call cannot be
# interrupted from inside PowerShell anyway.
#
# -Probe binds each engine and reads a property off it, which is what separates
# "the ProgID is registered" from "the COM server actually answers". It does NOT
# convert anything: proving a real conversion needs a real document, and the
# rare suite that binds, answers, and still fails to convert is reported by the
# conversion path instead (with the engine's own error text).
[CmdletBinding()]
param(
  [string] $Source = '',
  [string] $Dest = '',
  [ValidateSet('pptx', 'docx', '')][string] $Kind = '',
  [switch] $Probe
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Result($Object) {
  $Object | ConvertTo-Json -Compress -Depth 4 | Write-Output
}

function Stop-WithError([string] $Message) {
  Write-Result @{ ok = $false; error = $Message }
  exit 1
}

function Release-Com($Object) {
  if ($null -eq $Object) { return }
  try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($Object) } catch { }
}

# -- probe mode: report which engines are alive on this machine --------------
if ($Probe) {
  $engines = @{}
  foreach ($pair in @(
      @('pptx', 'KWPP.Application'),
      @('pptx', 'PowerPoint.Application'),
      @('docx', 'KWPS.Application'),
      @('docx', 'Word.Application'))) {
    $engineKind = $pair[0]
    $progId = $pair[1]
    if ($engines.ContainsKey($engineKind)) { continue }
    $app = $null
    try {
      $app = New-Object -ComObject $progId
      # Binding alone proves only that the ProgID is registered; reading a
      # property proves the server answers.
      $null = $app.Name
      $engines[$engineKind] = $progId
    } catch {
      # Not available on this machine; the next candidate gets its turn.
    } finally {
      if ($null -ne $app) { try { $app.Quit() } catch { } }
      Release-Com $app
    }
  }
  Write-Result @{ ok = $true; engines = $engines }
  exit 0
}

if ($Source -eq '') { Stop-WithError '-Source is required unless -Probe is used' }
if ($Dest -eq '') { Stop-WithError '-Dest is required unless -Probe is used' }
if ($Kind -eq '') { Stop-WithError '-Kind is required unless -Probe is used' }

if (-not (Test-Path -LiteralPath $Source)) {
  Stop-WithError "source not found: $Source"
}

$parent = Split-Path -Parent $Dest
if ($parent -and -not (Test-Path -LiteralPath $parent)) {
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
}
if (Test-Path -LiteralPath $Dest) {
  Remove-Item -LiteralPath $Dest -Force
}

$engine = ''
$failures = New-Object System.Collections.Generic.List[string]

if ($Kind -eq 'pptx') {
  # ppSaveAsPDF = 32 in the PowerPoint object model.
  foreach ($progId in @('KWPP.Application', 'PowerPoint.Application')) {
    if (Test-Path -LiteralPath $Dest) { break }
    $app = $null; $deck = $null
    try {
      $app = New-Object -ComObject $progId
      try { $app.DisplayAlerts = 0 } catch { }
      try { $app.Visible = $false } catch { }
      # Open(FileName, ReadOnly, Untitled, WithWindow) - WithWindow false keeps
      # this headless; some suites refuse Visible=false but honour this.
      $deck = $app.Presentations.Open($Source, $true, $false, $false)
      $deck.SaveAs($Dest, 32)
      $engine = $progId
    } catch {
      $failures.Add("${progId}: $($_.Exception.Message)")
    } finally {
      if ($null -ne $deck) { try { $deck.Close() } catch { } }
      Release-Com $deck
      if ($null -ne $app) { try { $app.Quit() } catch { } }
      Release-Com $app
    }
  }
} else {
  # wdExportFormatPDF = 17 in the Word object model.
  foreach ($progId in @('KWPS.Application', 'Word.Application')) {
    if (Test-Path -LiteralPath $Dest) { break }
    $app = $null; $doc = $null
    try {
      $app = New-Object -ComObject $progId
      try { $app.DisplayAlerts = 0 } catch { }
      try { $app.Visible = $false } catch { }
      # Open(FileName, ConfirmConversions, ReadOnly)
      $doc = $app.Documents.Open($Source, $false, $true)
      try {
        $doc.ExportAsFixedFormat($Dest, 17)
      } catch {
        # Older builds expose the format enum through SaveAs only.
        $doc.SaveAs($Dest, 17)
      }
      $engine = $progId
    } catch {
      $failures.Add("${progId}: $($_.Exception.Message)")
    } finally {
      if ($null -ne $doc) { try { $doc.Close(0) } catch { } }
      Release-Com $doc
      if ($null -ne $app) { try { $app.Quit() } catch { } }
      Release-Com $app
    }
  }
}

if (-not (Test-Path -LiteralPath $Dest)) {
  $detail = if ($failures.Count -gt 0) { $failures -join ' | ' } else { 'no COM engine accepted the file' }
  Stop-WithError $detail
}

$file = Get-Item -LiteralPath $Dest
if ($file.Length -le 1000) {
  Remove-Item -LiteralPath $Dest -Force
  Stop-WithError "converter produced only $($file.Length) bytes - refusing to serve it"
}

# A converter that "succeeds" but writes something else (an error page, an empty
# container) would poison the cache, so the magic number is checked here rather
# than trusted downstream.
$stream = [IO.File]::OpenRead($Dest)
try {
  $head = New-Object byte[] 5
  $read = $stream.Read($head, 0, 5)
} finally {
  $stream.Dispose()
}
if ($read -lt 5 -or [Text.Encoding]::ASCII.GetString($head, 0, 5) -ne '%PDF-') {
  Remove-Item -LiteralPath $Dest -Force
  Stop-WithError 'converter output is not a PDF'
}

Write-Result @{ ok = $true; engine = $engine; bytes = $file.Length }
exit 0
