# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-09-23

### Fixed

- **The PDF now fits the pane.** The viewer frame points at
  `<pdf-url>#view=FitH`, so the browser's PDF renderer scales the page to the
  frame width. Previously it rendered at 100%, which meant an A4 page (≈794 CSS
  px) overflowed any sidebar narrower than that and produced a horizontal
  scrollbar — the "the PDF does not adapt" symptom.
- An existing URL fragment is replaced rather than appended to, so
  `#page=3`-style fragments cannot silently suppress the view mode.

### Documented (measured, not assumed)

- The converted page geometry is the document's own, 1:1: `w:pgSz` 11906×16838
  twips → `[0 0 595.3 841.9]`, `p:sldSz` 12192000×6858000 EMU → `[0 0 960 540]`.
- The suite imposes no page-width limit of its own: 45 pt through 3000 pt
  (41.7 in) all round-tripped at exactly the requested size.
- Widening/narrowing the page during conversion is therefore possible but is
  **not** done: measured on a 2-page deck, removing the margins preserves both
  the text column and the page count, while any narrower page reflows it
  (2 → 3 pages). A PDF can be zoomed; it cannot reflow.

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
