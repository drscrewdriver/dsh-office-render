/**
 * Structural mirrors of the client services this plugin consumes.
 *
 * Nothing here is imported from `dsh-better-sidebar`: we are a SOFT dependency
 * and the plugin must stay inert (and loadable) when the sidebar is absent. Only
 * the members we call are declared, so no cross-package value coupling and no
 * assumption that a peer resolves.
 */
import type { ReactNode } from 'react'

/** The session scope every sidebar request carries. */
export interface SessionScopeLike {
  readonly sessionId: string
  readonly cwd?: string
  readonly repoRoot?: string
}

/** Props a file viewer receives (the subset we use). */
export interface FileViewerPropsLike {
  scope: SessionScopeLike
  path: string
  title: string
  viewerId: string
  content?: string
  truncated?: boolean
  customData?: unknown
}

/** How the host loads a file's bytes for one viewer. */
export type FileFetchStrategy = 'none' | 'fsRead' | 'mediaUrl' | 'custom' | 'binary-download'

/** A file-previewer registration. */
export interface FileViewerDescriptorLike {
  id: string
  title?: string | (() => string)
  icon?: ReactNode | ((size: number) => ReactNode)
  exts: readonly string[]
  priority?: number
  fetchStrategy: FileFetchStrategy
  load?: (path: string, scope: SessionScopeLike, signal?: AbortSignal) => Promise<unknown>
  component: (props: FileViewerPropsLike) => ReactNode
}

/** The registry published as `ctx.betterSidebar`. */
export interface BetterSidebarLike {
  registerFileViewer(descriptor: FileViewerDescriptorLike): () => void
}

/** The locale service (shell-resident; declared service). */
export interface LocaleLike {
  register(ns: string, locale: string, dict: Record<string, string>): () => void
  bind(ns: string): (key: string) => string
}

/** The client root context, narrowed to what this plugin touches. */
export interface ClientContext {
  effect(factory: () => void | (() => void), label: string): void
  betterSidebar?: BetterSidebarLike
  locale?: LocaleLike
}

/** True when `value` looks like the sidebar registry. */
function isBetterSidebar(value: unknown): value is BetterSidebarLike {
  if (typeof value !== 'object' || value === null) return false
  return typeof (value as Partial<BetterSidebarLike>).registerFileViewer === 'function'
}

/** True when `value` looks like the locale service. */
function isLocale(value: unknown): value is LocaleLike {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<LocaleLike>
  return typeof candidate.register === 'function' && typeof candidate.bind === 'function'
}

/** Narrow an untyped cordis context into the shape we use. */
export function clientContextOf(raw: unknown): ClientContext {
  const ctx = (raw ?? {}) as ClientContext
  return {
    effect: typeof ctx.effect === 'function' ? ctx.effect.bind(raw) : () => {},
    ...(isBetterSidebar(ctx.betterSidebar) ? { betterSidebar: ctx.betterSidebar } : {}),
    ...(isLocale(ctx.locale) ? { locale: ctx.locale } : {}),
  }
}

/**
 * Absolute URL of better-sidebar's raw-bytes route for one path.
 *
 * A `.pptx` is binary and `fsRead` answers a binary file with a head-only
 * result, so the viewer declares `fetchStrategy: 'custom'` and pulls bytes from
 * here. Going through this route rather than reading the file ourselves is what
 * keeps the workspace-root path fence on the host side.
 *
 * (Pictures *embedded in* the deck are different: they live inside the zip, so
 * there is no host route to point at — the reader returns their bytes and the
 * view turns them into object URLs.)
 */
export function sidebarFileUrl(scope: SessionScopeLike, path: string): string {
  const params = new URLSearchParams({ sessionId: scope.sessionId, path })
  if (scope.cwd !== undefined && scope.cwd !== '') params.set('cwd', scope.cwd)
  return `/sidebar/file?${params.toString()}`
}
