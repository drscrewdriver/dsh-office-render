/**
 * The faithful viewer: send the bytes to our own host route, get a PDF, show it.
 *
 * Why an iframe over a blob URL rather than a PDF library: the browser already
 * ships a PDF renderer, and it is better than anything we would bundle —
 * text selection, zoom, search, print, accessibility. A blob URL keeps the PDF
 * out of the workspace and out of the network cache, and revoking it on unmount
 * is what stops a browsing session from pinning every deck it ever opened.
 *
 * The object URL is created from the RESPONSE, not from a path, because there is
 * no path: the PDF exists only in the host's temp cache and in this blob.
 */
import { useCallback, useEffect, useState } from 'react'
import { pdfViewerSrc } from './pdfUrl'
import { formatBytes } from './utils'
import { basename } from './utils'
import type { OfficeKind } from './types'
import type { T } from './locales'

interface OfficePdfViewerProps {
  path: string
  title?: string
  /** The original document's bytes, from the registered `custom` loader. */
  customData?: unknown
  t: T
  /** Where the host accepts a conversion POST (from `/health`). */
  convertPath: string
  kind: OfficeKind
  /** The engine the host reported, shown so a wrong-looking render is traceable. */
  engine?: string
}

/** True when the loader handed us something we can send. */
function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array
}

/** The extension we tell the host about, so it picks the right converter. */
function extensionOf(path: string): string {
  const name = basename(path)
  const at = name.lastIndexOf('.')
  return at < 0 ? '' : name.slice(at + 1).toLowerCase()
}

/** Pull `{ ok: false, error }` out of a failed response, or fall back to the status. */
async function failureOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string' && body.error !== '') return body.error
  } catch {
    // Not JSON; the status line is all we have.
  }
  return `HTTP ${response.status}`
}

export function OfficePdfViewer({ path, title, customData, t, convertPath, kind, engine }: OfficePdfViewerProps) {
  const fileName = title !== undefined && title !== '' ? title : basename(path)
  const [url, setUrl] = useState<string | null>(null)
  const [size, setSize] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  const retry = useCallback(() => {
    setError(null)
    setUrl(null)
    setAttempt(value => value + 1)
  }, [])

  useEffect(() => {
    if (!isBytes(customData)) return
    const controller = new AbortController()
    let objectUrl: string | null = null
    let cancelled = false

    void (async () => {
      try {
        const query = new URLSearchParams({ ext: extensionOf(path) })
        const response = await fetch(`${convertPath}?${query.toString()}`, {
          method: 'POST',
          // The bytes are the body: the host never re-derives a path from us, so
          // the workspace fence stays exactly where the sidebar put it.
          body: customData as unknown as BodyInit,
          headers: { 'Content-Type': 'application/octet-stream' },
          signal: controller.signal,
        })
        if (!response.ok) {
          const message = await failureOf(response)
          if (!cancelled) setError(message)
          return
        }
        const blob = await response.blob()
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setSize(blob.size)
        setUrl(objectUrl)
      } catch (cause) {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()

    return () => {
      cancelled = true
      controller.abort()
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }, [customData, path, convertPath, attempt])

  if (!isBytes(customData)) {
    return (
      <div className="off-root">
        <div className="off-loading">
          <div className="off-spinner" />
          <div>{t('state.converting')}</div>
        </div>
      </div>
    )
  }

  if (error !== null) {
    return (
      <div className="off-root">
        <div className="off-error">
          <div className="off-error__title">❌ {t('state.error')}</div>
          <div className="off-error__message">{error}</div>
          <button type="button" className="off-retry" onClick={retry}>
            {t('state.retry')}
          </button>
          <div className="off-error__hint">{t('hint.why')}</div>
          <div className="off-error__hint">{t('hint.fallback')}</div>
        </div>
      </div>
    )
  }

  if (url === null) {
    return (
      <div className="off-root">
        <div className="off-loading">
          <div className="off-spinner" />
          <div>{t('state.converting')}</div>
          <div className="off-loading__hint">{t('state.convertingHint')}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="off-root">
      <div className="off-head">
        <span className="off-head__name" title={fileName}>
          📄 {fileName}
        </span>
        <span className="off-head__tag">{t('meta.units', { size: formatBytes(size) })}</span>
        {engine !== undefined && <span className="off-head__tag">{t('meta.engine', { engine })}</span>}
        {/* The one thing a reader must not have to guess: this is a PDF, not the
            original file being rendered by its own editor. */}
        <span className="off-head__badge">{t('badge')}</span>
        <a className="off-head__link" href={pdfViewerSrc(url)} target="_blank" rel="noreferrer">
          {t('state.openPdf')}
        </a>
      </div>
      {/* FitH: the page is scaled to the pane width. A PDF cannot reflow, so
          zoom is the only width adaptation it has — see `pdfUrl.ts`. */}
      <iframe className="off-frame" src={pdfViewerSrc(url)} title={fileName} />
    </div>
  )
}
