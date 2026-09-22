# dsh-office-render

**Faithful layout** for `.docx` and `.pptx` in the DSH sidebar.

It converts the document to PDF using an Office-compatible suite installed on
the host machine — WPS Office or Microsoft Office — and shows that PDF. The
layout you see is the one the suite produces, not our approximation of it.

This exists because a structured reading view is honest but not what everyone
wants: a slide deck read as an outline is not a slide deck. So this plugin is the
opposite trade — the real renderer does the work, and we accept a dependency on
it being installed.

---

## How it works

```
click a .docx / .pptx in the sidebar
  → the sidebar's own /sidebar/file route authorizes the read (workspace fence stays there)
  → the bytes are POSTed to /office-render/convert on the host half
      → temp file → WPS/Office COM → PDF → cached by content hash
  → the PDF comes back and renders in an <iframe> (the browser's own PDF viewer)
```

Three things worth knowing about that path:

- **Bytes, not a path.** The client already holds the bytes the sidebar
  authorized. Accepting a path here would mean writing a *second* implementation
  of the workspace fence, and a subtly different second implementation of a
  security check is worse than none. Content also gives the cache its key.
- **An iframe, not the sidebar's PDF viewer.** Handing the PDF to the existing
  viewer would replace the user's current tab. An iframe keeps the document where
  it was clicked, and reuses the browser's PDF engine — text selection, zoom,
  search, print — for free.
- **One conversion at a time.** Each run starts a fresh COM suite instance; two
  at once would be two suites fighting over the same dialog owner.

## The fallback story

Registration is **conditional**, and this is the important design decision:

| What the host reports | What happens |
|---|---|
| A converter is available | This plugin claims `.docx`/`.pptx` (priority 100) and renders the real layout |
| No converter at all | It registers **nothing**, and the structured reading views (`dsh-docx-sidebar`, `dsh-pptx-sidebar`) keep serving those files |

A viewer that claims an extension and then cannot render it is worse than no
viewer: it would turn a working reading view into an error page. So the plugin
asks `/office-render/health` first and only claims what it can actually deliver.

That also means the three plugins compose with no coordination between them —
the sidebar registry simply picks whatever registered.

## Requirements

- **Dsh** `>=0.1.5-rc.1 <0.2.0-0`, with `dsh-better-sidebar` (soft dependency).
- **A converter.** Any of:
  - WPS Office — `KWPS.Application` (Writer), `KWPP.Application` (Presentation)
  - Microsoft Office — `Word.Application`, `PowerPoint.Application`

  The probe tries them in that order per file kind. WPS also registers the
  Microsoft ProgIDs, so a WPS-only machine is fully covered.

No converter? Install one, or just do not enable this plugin — the reading views
still work.

## Verify it without restarting DSH

```bash
npm run build
npm run smoke                                   # generated .docx fixture
npm run smoke -- "C:\path\to\deck.pptx"         # your own file
npm run smoke -- "C:\path\to\report.docx"
```

The smoke run mounts the built `lib/index.mjs` on a real `node:http` server and
drives the real routes, so it answers "does conversion work on this machine?"
independently of the DSH process. It prints the engine it used and the PDF size.

`npm test` is the other half: 18 checks over the core decisions (result parsing,
queue serialization, eviction policy, the origin guard) plus an end-to-end
conversion of a real `.docx` through the real shipped converter script.

## Routes

| Route | Purpose |
|---|---|
| `GET /office-render/health` | Which kinds this machine can convert, and with which engine. `?refresh=1` re-probes. |
| `POST /office-render/convert?ext=docx\|pptx` | Document bytes in, `application/pdf` out. |

Response headers on a successful conversion: `X-Office-Render-Engine`,
`X-Office-Render-Kind`, `X-Office-Render-Cache` (`hit`/`miss`).

## Width: what the PDF viewer actually does (all measured)

A PDF page has a fixed geometry, and **the converter does not invent it** — the
page size comes from the document itself, reproduced 1:1:

| Source declares | Converted PDF |
|---|---|
| `w:pgSz w=11906 h=16838` (A4) | `/MediaBox [0 0 595.3 841.9]` |
| `p:sldSz cx=12192000 cy=6858000` (16:9) | `/MediaBox [0 0 960 540]` |

The suite also imposes no limit of its own: measurably, page widths from 45 pt
(15.9 mm) up to 3000 pt (41.7 in) all came back at exactly the requested size,
with 0.0 pt deviation — well past the 22 in ceiling Word's own UI enforces.

Because the page is fixed, all the width adaptation available to it is **zoom**.
What the embedded viewer does with that zoom, measured in Chrome by rendering
the same document into frames of known width and measuring the rendered paper:

| Case | Frame inner width | Rendered page | Page / frame |
|---|---|---|---|
| 320 px frame, plain URL, on load | 316 px | 301 px | **95.2%** — fits |
| 640 px frame, plain URL, on load | 636 px | 619 px | **97.1%** — fits |
| 320 px frame, URL + `#view=FitH` | 316 px | 301 px | 95.2% — *identical* |
| 640 px frame, URL + `#view=FitH` | 636 px | 619 px | 97.1% — *identical* |
| frame widened 320 → 640 **after** load | 636 px | 301 px | **47.3%** — does not re-fit |

Three things follow, and the first two are the opposite of what this project
originally assumed:

1. **It already fits the pane width when it loads.** No fragment is needed, and
   the `#view=FitH` fragment that briefly shipped here was measured to change
   nothing at all (0 px difference) — it has been removed rather than left in
   place looking like the reason.
2. **A later resize is the real gap.** The viewer keeps the zoom it loaded with,
   so widening the pane leaves the page small. Its own toolbar offers zoom and
   fit controls, so this is recoverable by hand. Making it automatic would mean
   remounting the frame on a settled resize, which resets the reader to page 1 —
   a trade-off we chose not to make silently.
3. **Narrowing the page during conversion is possible but reflows.** Measured on
   a real 2-page `.docx`:

   | Strategy | Page width | Page count | Verdict |
   |---|---|---|---|
   | as-is | 595.3 pt | 2 | reference |
   | trim margins to the text column | 487.3 pt | **2** | layout preserved (−18% paper, +22% apparent text at the same pane) |
   | narrow the paper, keep margins | 487.3 pt | **3** | reflowed |
   | force 300 pt | 300.0 pt | **3** | reflowed |

   The honest limit: a page can only be narrowed down to its own text column
   before the line breaks change. Below that it is a re-typeset document, not a
   faithful render — which is what the structured reading views
   (`dsh-docx-sidebar` / `dsh-pptx-sidebar`) are for, since those reflow on
   purpose and scale their type with the pane.

## Limits, and what they cost

| Setting | Default | Why |
|---|---|---|
| Upload ceiling | 64 MB | Refused past this rather than buffered |
| Conversion timeout | 120 s | The process tree is killed; a COM call waiting on a dialog cannot be interrupted from inside PowerShell |
| Cache age / count | 7 days / 200 files | Swept on first use; entries are keyed by content hash |

Environment overrides, for tests and unusual layouts:
`DSH_OFFICE_RENDER_POWERSHELL`, `DSH_OFFICE_RENDER_SCRIPT`,
`DSH_OFFICE_RENDER_CACHE`.

## Security

- The route accepts **bytes**, never a filesystem path, so there is no path to
  escape and no fence to re-implement.
- A **cross-origin POST is refused** (403). Without that check, a page on any
  origin could make this machine launch Office processes — a denial-of-service
  lever, and one header comparison to close. A request with no `Origin` (curl,
  the smoke script) is allowed, since it already needs local port access.
- No shell interpolation anywhere: the converter is a script file invoked with
  `-File` plus discrete argv entries, never a command string.

## Honest caveats

- **A converter must be installed.** This plugin's whole value depends on that,
  and it is why the fallback above is not optional.
- **The probe binds, it does not convert.** A suite that registers its ProgID and
  answers a property read, yet still fails to convert, is reported at conversion
  time with the engine's own error text. That is a rare state (a half-broken
  install) and it surfaces as a clear message rather than a silent blank.
- **PDF is a snapshot.** Animations, transitions, embedded video and interactive
  objects are gone; that is inherent to the format, not a bug in the pipeline.
- **Fonts come from the host.** A deck using fonts this machine lacks will
  substitute them — faithfully to *this* machine, not to the author's.
- First look at a file costs a second or two; the content-hash cache makes every
  later look instant.

## Layout

| File | Role |
|---|---|
| `src/host/render-core.ts` | Every decision worth testing: result parsing, queue, eviction, probe parsing. No Cordis, no child_process. |
| `src/index.ts` | The host half: routes, cache, timeout, process-tree kill, origin guard |
| `scripts/convert-office.ps1` | The converter. **Pure ASCII on purpose** — Windows PowerShell 5.1 decodes a BOM-less `.ps1` as ANSI, so paths arrive as argv instead of literals |
| `src/client/index.tsx` | The conditional registration described above |
| `src/client/OfficePdfViewer.tsx` | POST, blob URL, iframe, revoke |

## License

MIT
