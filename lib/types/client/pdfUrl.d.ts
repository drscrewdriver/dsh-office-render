/**
 * How the converted PDF is handed to the browser's viewer.
 *
 * A PDF page has a fixed geometry — it comes from the document's own
 * `w:pgSz` / `p:sldSz`, and the converter reproduces it exactly. It therefore
 * cannot reflow to a narrow sidebar the way the reading views do; all the width
 * adaptation available to it is ZOOM.
 *
 * `#view=FitH` is that zoom: the viewer scales the page so its width fills the
 * frame. Without it, Chromium shows the page at 100% and a sidebar narrower than
 * the page (A4 at 100% is ~794 CSS px) just gets a horizontal scrollbar — which
 * is what "the PDF does not adapt" actually looks like.
 *
 * Pure and small on purpose: this is a decision worth one tested place rather
 * than a string built inline in a component.
 */
/** Chromium's PDF viewer reads the page view mode from the URL fragment. */
export declare const FIT_WIDTH = "#view=FitH";
/**
 * The URL to point a viewer (iframe or new tab) at, given a blob URL or any
 * other PDF location.
 *
 * An existing fragment is replaced rather than appended to: `#a#b` would leave
 * whatever the first fragment set in force and silently drop our view mode.
 */
export declare function pdfViewerSrc(pdfUrl: string): string;
