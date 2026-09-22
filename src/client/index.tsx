/**
 * Browser half — the Cordis client entry.
 *
 * The interesting decision here is that registration is CONDITIONAL. A viewer
 * that claims `.docx` and then cannot render it is worse than no viewer at all:
 * it turns a working structured reading view into an error page. So `apply`
 * asks the host half what it can actually convert, and only claims the
 * extensions it can serve:
 *
 *   converter available  → this plugin's viewers win (priority 100) and render
 *                          the real layout as a PDF
 *   converter unavailable → nothing is registered, so the structured reading
 *                          views (priority 50) keep serving the file
 *
 * That is the whole fallback story, and it needs no coordination between
 * plugins: the registry simply picks whatever did register.
 */
import { createElement } from 'react'
import { OfficePdfViewer } from './OfficePdfViewer'
import { NS, dictionaries, interpolate, translatorFrom } from './locales'
import { clientContextOf, sidebarFileUrl } from './seams'
import css from './styles.css'
import type { HealthResponse, OfficeKind } from './types'
import type { T } from './locales'
import type { ClientContext, FileViewerDescriptorLike, SessionScopeLike } from './seams'

/** Route root; the host half mounts the same string. */
const BASE = '/office-render'

/** Provenance tag so a wrong-looking render is traceable to this plugin. */
const TAG = '[dsh-office-render]'

/** Above the structured reading views (50), below nothing. */
const PRIORITY = 100

/** Services that must be published before `apply` runs. */
export const inject = ['betterSidebar', 'locale'] as const

/** Id of the injected <style> tag, so a re-apply can detect its own work. */
const STYLE_ID = 'dsh-office-render-styles'

/** What one viewer needs beyond the shared plumbing. */
interface KindSpec {
  id: string
  titleKey: string
  exts: readonly string[]
}

/** The two viewers this plugin can register, keyed by what the host converts. */
const SPECS: Record<OfficeKind, KindSpec> = {
  docx: { id: 'dsh-office-render:docx', titleKey: 'viewer.docx', exts: ['docx', 'docm', 'dotx'] },
  pptx: { id: 'dsh-office-render:pptx', titleKey: 'viewer.pptx', exts: ['pptx', 'pptm', 'potx'] },
}

/** Append the stylesheet once; the disposer removes it. */
function injectStyles(): () => void {
  if (document.getElementById(STYLE_ID) !== null) return () => {}
  const tag = document.createElement('style')
  tag.id = STYLE_ID
  tag.textContent = css
  document.head.appendChild(tag)
  return () => tag.remove()
}

/** Bind a translator to our namespace, falling back to the built-in English. */
function translatorOf(ctx: ClientContext): T {
  const locale = ctx.locale
  if (locale === undefined) return translatorFrom(dictionaries.en)
  return (key, vars) => {
    try {
      const bound = locale.bind(NS)(key)
      return interpolate(bound === '' ? key : bound, vars)
    } catch {
      return interpolate(key, vars)
    }
  }
}

/** One probe per page load: the answer cannot change while the host runs. */
let healthTask: Promise<HealthResponse | undefined> | undefined

/** Ask the host half which kinds it can convert. Undefined means "assume none". */
function health(): Promise<HealthResponse | undefined> {
  if (healthTask === undefined) {
    healthTask = (async () => {
      try {
        const response = await fetch(`${BASE}/health`)
        if (!response.ok) {
          console.log(`${TAG} host routes answered HTTP ${response.status}; faithful rendering stays off.`)
          return undefined
        }
        return (await response.json()) as HealthResponse
      } catch (error) {
        console.log(`${TAG} host routes unreachable; faithful rendering stays off.`, error)
        return undefined
      }
    })()
  }
  return healthTask
}

/** The file-viewer descriptor for one convertible kind. */
function descriptor(
  kind: OfficeKind,
  spec: KindSpec,
  healthResponse: HealthResponse,
  t: T,
): FileViewerDescriptorLike {
  return {
    id: spec.id,
    title: () => t(spec.titleKey),
    exts: spec.exts,
    priority: PRIORITY,
    fetchStrategy: 'custom',
    load: async (path: string, scope: SessionScopeLike, signal?: AbortSignal) => {
      // The sidebar's own route authorizes the read, workspace fence included;
      // we then hand the bytes straight back to our host half for conversion.
      const response = await fetch(sidebarFileUrl(scope, path), { signal })
      if (!response.ok) throw new Error(`HTTP ${response.status} while reading ${path}`)
      return new Uint8Array(await response.arrayBuffer())
    },
    component: props =>
      createElement(OfficePdfViewer, {
        path: props.path,
        title: props.title,
        customData: props.customData,
        t,
        convertPath: healthResponse.convertPath ?? `${BASE}/convert`,
        kind,
        ...(healthResponse.engines[kind] !== undefined ? { engine: healthResponse.engines[kind] } : {}),
      }),
  }
}

/**
 * Browser-face apply.
 *
 * @param rawCtx - the client root context, narrowed structurally in `seams.ts`.
 */
export function apply(rawCtx: unknown): void {
  const ctx = clientContextOf(rawCtx)

  ctx.effect(injectStyles, `${TAG} stylesheet`)

  if (ctx.locale !== undefined) {
    for (const [tag, dict] of Object.entries(dictionaries)) {
      ctx.effect(() => ctx.locale!.register(NS, tag, dict), `${TAG} dictionary ${tag}`)
    }
  }

  const t = translatorOf(ctx)
  const bar = ctx.betterSidebar

  if (bar === undefined) {
    console.warn(`${TAG} ctx.betterSidebar 未发布：dsh-better-sidebar 未安装或已禁用，版式渲染保持惰性。`)
    return
  }

  ctx.effect(() => {
    let disposed = false
    const disposers: (() => void)[] = []

    void (async () => {
      const reported = await health()
      // The plugin may have been unloaded while the probe was in flight; a
      // registration that lands after disposal would never be revoked.
      if (disposed) return

      const kinds = reported?.kinds ?? []
      if (kinds.length === 0) {
        console.log(
          `${TAG} 本机没有可用的 Office 转换器（WPS / Microsoft Office），不注册预览器：.docx/.pptx 仍由结构化阅读视图接手。`,
        )
        return
      }

      for (const kind of kinds) {
        const spec = SPECS[kind]
        if (spec === undefined) continue
        disposers.push(bar.registerFileViewer(descriptor(kind, spec, reported as HealthResponse, t)))
        console.log(`${TAG} 已注册版式还原预览器 ${spec.id}（引擎 ${reported?.engines[kind] ?? '?'}）`)
      }
    })()

    return () => {
      disposed = true
      for (const dispose of disposers) dispose()
    }
  }, `${TAG} conditional viewer registration`)
}
