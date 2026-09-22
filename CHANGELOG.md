# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-23

First release. Faithful layout for `.docx` / `.pptx` by converting to PDF with an
Office-compatible suite installed on the host machine.

### Added

- Host routes `GET /office-render/health` and
  `POST /office-render/convert?ext=docx|pptx`, mounted on `ctx.webServer`.
- Converter driving WPS Office (`KWPS.Application` / `KWPP.Application`) and
  Microsoft Office (`Word.Application` / `PowerPoint.Application`), tried in that
  order per file kind, with the engine name reported back.
- `scripts/convert-office.ps1`: pure-ASCII converter that verifies its own output
  by magic number before claiming success. Paths arrive as argv because Windows
  PowerShell 5.1 decodes a BOM-less `.ps1` as ANSI.
- Content-hash PDF cache in the OS temp directory, swept by age (7 days) and
  count (200) on first use, with a configurable location. A sidecar file records
  the engine that produced each artifact, so a cache hit still names it — after
  the first view every view is a hit, and an unnamed hit would mean the label
  never showed at all.
- Serialized conversions: one COM suite at a time, with a 120 s timeout that
  kills the process tree.
- Conditional viewer registration: the client probes `/health` and only claims
  `.docx`/`.pptx` when the host can actually convert them, so the structured
  reading views keep serving machines with no converter.
- Same-origin guard on conversion (403 for cross-origin POSTs).
- `npm test` — 18 checks, including an end-to-end conversion of a real `.docx`
  through the real converter script.
- `npm run smoke` — mounts the built artifact on a real HTTP server, so the
  conversion path can be verified without restarting DSH.
- Environment overrides: `DSH_OFFICE_RENDER_POWERSHELL`,
  `DSH_OFFICE_RENDER_SCRIPT`, `DSH_OFFICE_RENDER_CACHE`.

### Known limitations

- Requires an Office-compatible suite; nothing degrades to a rendered layout
  without one (it degrades to the sibling reading views instead).
- The health probe binds the engine rather than performing a test conversion, so
  a half-broken install is reported at conversion time, not at probe time.
- PDF output is a snapshot: no animations, transitions or interactive objects.
