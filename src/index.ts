/**
 * Node half of `dsh-office-render`.
 *
 * It owns one capability the browser cannot have: turning a `.docx` / `.pptx`
 * into a PDF with an Office-compatible suite installed on THIS machine. It
 * serves that over two routes so the browser half stays a viewer:
 *
 *   GET  /office-render/health    → which kinds this machine can convert
 *   POST /office-render/convert   → raw bytes in, `application/pdf` out
 *
 * Three deliberate choices, each of which a reader will otherwise wonder about:
 *
 * 1. **Bytes, not a path.** The client already holds the file's bytes (the
 *    sidebar's own `/sidebar/file` route authorized them, workspace fence
 *    included). Accepting a path here would mean re-implementing that fence, and
 *    a second, subtly different implementation of a security check is worse than
 *    none. Content also gives us a natural cache key.
 *
 * 2. **One conversion at a time.** Each run starts a fresh COM suite instance.
 *    Two at once means two suites competing for the same document state and
 *    dialog owner, so jobs are serialized rather than raced.
 *
 * 3. **A hard timeout that kills the process tree.** A COM call waiting on a
 *    dialog cannot be interrupted from inside PowerShell, so the only reliable
 *    stop is killing the tree from out here.
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  cacheKey,
  convert,
  createQueue,
  filesToEvict,
  formatBytes,
  isConvertible,
  kindOfExtension,
  parseProbeOutput,
  probeArgs,
  resolvePowerShell,
  type ConvertRequest,
  type OfficeKind,
  type ProbeResult,
  type SpawnResult,
} from './host/render-core.js'
import type { OfficeRenderContext, WebRequest, WebResponse } from './host/dsh-seams.js'

/** Stable Cordis plugin name; must match `cordis.patch.yml` and `package.json#name`. */
export const name = 'dsh-office-render'

/** The only service required: the route registrar. */
export const inject = ['webServer'] as const

/** Route root; the client half inlines the same string. */
const BASE = '/office-render'

/** Ceiling for one uploaded document. Beyond this the request is refused. */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

/** How long one conversion may take before its process tree is killed. */
const CONVERT_TIMEOUT_MS = 120_000

/** How long a probe may take. Binding four COM servers is quick, but not free. */
const PROBE_TIMEOUT_MS = 60_000

/** Cache policy: entries older than this go, and never keep more than N. */
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const CACHE_MAX_COUNT = 200

/** The one-job-at-a-time gate around COM. */
const queue = createQueue()

/** Serialize `spawn` into the `SpawnFn` seam, with a tree-killing timeout. */
function spawnWithTimeout(file: string, args: string[], options: { timeoutMs: number }): Promise<SpawnResult> {
  return new Promise(resolve => {
    // `windowsHide` matters: without it a console window flashes on every
    // preview, which looks exactly like a bug.
    const child = spawn(file, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const killTree = (): void => {
      if (child.pid === undefined) return
      try {
        // COM servers are children of the interpreter, so the whole tree has to
        // go or the suite keeps running with an unsaved document open.
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          // Nothing left to kill.
        }
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, options.timeoutMs)

    const finish = (code: number | null, extra = ''): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr: `${stderr}${extra}`, timedOut })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error: Error) => finish(null, `\n${error.message}`))
    child.on('close', (code: number | null) => finish(code))
  })
}

/** The plugin's own directory, for locating the shipped converter script. */
function pluginRoot(): string {
  return dirname(fileURLToPath(import.meta.url))
}

/** Where converted PDFs and their inputs live. */
function cacheDir(): string {
  // Overridable so tests (and anyone with a temp dir they would rather not fill)
  // can point it somewhere else without touching the installed package.
  return process.env.DSH_OFFICE_RENDER_CACHE ?? join(tmpdir(), 'dsh-office-render')
}

/** Interpreter preference: the managed `pwsh` first, then Windows PowerShell. */
function powershellPath(): string | undefined {
  const systemPowerShell = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  return resolvePowerShell(
    [
      { path: 'pwsh', exists: false },
      { path: systemPowerShell, exists: existsSync(systemPowerShell) },
      { path: 'powershell', exists: true },
    ],
    process.env.DSH_OFFICE_RENDER_POWERSHELL,
  )
}

/** The shipped converter script, or undefined when the package is incomplete. */
function converterScript(): string | undefined {
  // Resolved relative to the bundle (`lib/index.mjs` → `../scripts/...`), with an
  // override for layouts where that is not where the package put it.
  const override = process.env.DSH_OFFICE_RENDER_SCRIPT
  const script = override !== undefined && override !== '' ? override : join(pluginRoot(), '..', 'scripts', 'convert-office.ps1')
  return existsSync(script) ? script : undefined
}

/** A JSON response. */
function writeJson(response: WebResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Content-Length', String(payload.byteLength))
  response.setHeader('Cache-Control', 'no-store')
  response.end(payload)
}

/** Read the whole request body, refusing to buffer past `limit`. */
async function readBody(request: WebRequest, limit: number): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  let total = 0
  await new Promise<void>((resolve, reject) => {
    request.on('data', (chunk: Uint8Array) => {
      total += chunk.byteLength
      if (total > limit) {
        reject(new Error(`request body exceeds ${formatBytes(limit)}`))
        return
      }
      chunks.push(Buffer.from(chunk))
    })
    request.on('end', resolve)
    request.on('error', reject)
  })
  return new Uint8Array(Buffer.concat(chunks))
}

/** Delete cache entries per policy; best-effort, never throws. */
async function sweepCache(): Promise<void> {
  const dir = cacheDir()
  try {
    const names = await readdir(dir)
    const entries = await Promise.all(
      names.map(async entryName => {
        const info = await stat(join(dir, entryName)).catch(() => undefined)
        return info === undefined ? undefined : { name: entryName, mtimeMs: info.mtimeMs, size: info.size }
      }),
    )
    const present = entries.filter((entry): entry is { name: string; mtimeMs: number; size: number } => entry !== undefined)
    for (const doomed of filesToEvict(present, Date.now(), CACHE_MAX_AGE_MS, CACHE_MAX_COUNT)) {
      await unlink(join(dir, doomed)).catch(() => undefined)
    }
  } catch {
    // A cache we cannot sweep is still a working cache.
  }
}

let swept = false

/** Run the sweep once per process, on first use. */
async function sweepOnce(): Promise<void> {
  if (swept) return
  swept = true
  await sweepCache()
}

let probeTask: Promise<ProbeResult> | undefined

/** Which kinds this machine can convert. One COM binding pass, cached. */
async function probe(refresh: boolean): Promise<ProbeResult & { powershell?: string; error?: string }> {
  if (refresh) probeTask = undefined
  if (probeTask === undefined) {
    probeTask = (async (): Promise<ProbeResult> => {
      const powershell = powershellPath()
      const script = converterScript()
      if (powershell === undefined || script === undefined) return { kinds: [], engines: {} }
      const outcome = await queue.run(() =>
        spawnWithTimeout(powershell, probeArgs(script), { timeoutMs: PROBE_TIMEOUT_MS }),
      )
      if (outcome.timedOut) return { kinds: [], engines: {} }
      return parseProbeOutput(outcome.stdout)
    })()
  }
  const result = await probeTask
  return { ...result, powershell: powershellPath() }
}

/** What we remember about one cached PDF, so a cache hit can still name its engine. */
interface CacheMeta {
  engine?: string
  kind: OfficeKind
  bytes: number
  createdAt: number
}

/** Read the sidecar metadata for a cached artifact; absent or broken is fine. */
async function readMeta(path: string): Promise<CacheMeta | undefined> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as Partial<CacheMeta>
    return typeof parsed.kind === 'string' ? (parsed as CacheMeta) : undefined
  } catch {
    return undefined
  }
}

/** Convert one uploaded document, using or filling the cache. */
async function convertBytes(
  payload: Uint8Array,
  kind: OfficeKind,
): Promise<{ ok: true; pdf: Uint8Array; engine?: string; cached: boolean } | { ok: false; error: string; status: number }> {
  const powershell = powershellPath()
  const script = converterScript()
  if (powershell === undefined) return { ok: false, error: 'no PowerShell interpreter found', status: 503 }
  if (script === undefined) {
    return { ok: false, error: 'the converter script is missing from this installation', status: 503 }
  }

  await sweepOnce()
  const dir = cacheDir()
  await mkdir(dir, { recursive: true })

  const key = cacheKey(payload, kind, bytes => createHash('sha256').update(bytes).digest('hex'))
  const outputPath = join(dir, `out-${key}.pdf`)
  const metaPath = join(dir, `meta-${key}.json`)

  const cached = await readFile(outputPath).catch(() => undefined)
  if (cached !== undefined && cached.byteLength > 0) {
    // The sidecar is what lets a hit report the same engine a miss did; without
    // it the label would vanish on every view after the first.
    const meta = await readMeta(metaPath)
    return {
      ok: true,
      pdf: new Uint8Array(cached),
      ...(meta?.engine !== undefined ? { engine: meta.engine } : {}),
      cached: true,
    }
  }

  const inputPath = join(dir, `in-${key}.${kind === 'docx' ? 'docx' : 'pptx'}`)
  await writeFile(inputPath, payload)

  try {
    const request: ConvertRequest = {
      powershell,
      scriptPath: script,
      source: inputPath,
      dest: outputPath,
      kind,
      timeoutMs: CONVERT_TIMEOUT_MS,
    }
    // Serialized with the probe as well: a probe and a conversion at the same
    // time would be two suites fighting over the same COM state.
    const result = await queue.run(() => convert(request, spawnWithTimeout))
    if (!result.ok) {
      return { ok: false, error: result.error ?? 'conversion failed', status: 502 }
    }
    const pdf = await readFile(outputPath).catch(() => undefined)
    if (pdf === undefined || pdf.byteLength === 0) {
      return { ok: false, error: 'the converter reported success but wrote no output', status: 502 }
    }
    const meta: CacheMeta = {
      ...(result.engine !== undefined ? { engine: result.engine } : {}),
      kind,
      bytes: pdf.byteLength,
      createdAt: Date.now(),
    }
    await writeFile(metaPath, JSON.stringify(meta)).catch(() => undefined)
    return { ok: true, pdf: new Uint8Array(pdf), ...(result.engine !== undefined ? { engine: result.engine } : {}), cached: false }
  } finally {
    // The input is a copy of bytes the host already has; the PDF is the artifact
    // worth keeping.
    await unlink(inputPath).catch(() => undefined)
  }
}

/** Read one request header, case-insensitively. */
function headerOf(request: WebRequest, name: string): string | undefined {
  const direct = request.headers[name] ?? request.headers[name.toLowerCase()]
  if (typeof direct === 'string') return direct
  if (Array.isArray(direct) && direct.length > 0) return direct[0]
  return undefined
}

/**
 * Refuse cross-site conversions.
 *
 * A page on another origin must not be able to make this machine launch an
 * Office process: that is a denial-of-service lever, and the fix is one header
 * comparison. Browsers send `Origin` on every cross-origin POST, so a mismatch
 * against `Host` is decisive. A missing `Origin` means a non-browser caller
 * (the smoke script, curl) and is allowed through — those already need local
 * access to the port.
 */
function isSameOrigin(request: WebRequest): boolean {
  const origin = headerOf(request, 'origin')
  if (origin === undefined || origin === '') return true
  const host = headerOf(request, 'host')
  if (host === undefined || host === '') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** The route handler: dispatch on the path under `BASE`. */
async function handle(request: WebRequest, response: WebResponse): Promise<void> {
  let url: URL
  try {
    url = new URL(request.url ?? '/', 'http://dsh.internal')
  } catch {
    writeJson(response, 400, { ok: false, error: 'malformed request URL' })
    return
  }

  const route = url.pathname.slice(BASE.length)

  if (route === '/health') {
    const result = await probe(url.searchParams.get('refresh') === '1')
    writeJson(response, 200, {
      ok: true,
      service: name,
      version: '0.1.0',
      convertPath: `${BASE}/convert`,
      kinds: result.kinds,
      engines: result.engines,
      ...(result.powershell !== undefined ? { powershell: result.powershell } : {}),
      ...(converterScript() === undefined ? { error: 'converter script missing' } : {}),
    })
    return
  }

  if (route !== '/convert') {
    writeJson(response, 404, { ok: false, error: `unknown route ${url.pathname}` })
    return
  }

  if (request.method !== 'POST') {
    writeJson(response, 405, { ok: false, error: 'use POST with the document bytes as the body' })
    return
  }

  if (!isSameOrigin(request)) {
    writeJson(response, 403, { ok: false, error: 'cross-origin conversion requests are refused' })
    return
  }

  const extension = (url.searchParams.get('ext') ?? '').toLowerCase()
  if (!isConvertible(extension)) {
    writeJson(response, 415, { ok: false, error: `not a convertible extension: "${extension}"` })
    return
  }
  const kind = kindOfExtension(extension)
  if (kind === undefined) {
    writeJson(response, 415, { ok: false, error: `not a convertible extension: "${extension}"` })
    return
  }

  let payload: Uint8Array
  try {
    payload = await readBody(request, MAX_UPLOAD_BYTES)
  } catch (error) {
    writeJson(response, 413, { ok: false, error: error instanceof Error ? error.message : String(error) })
    return
  }
  if (payload.byteLength === 0) {
    writeJson(response, 400, { ok: false, error: 'empty body' })
    return
  }

  const result = await convertBytes(payload, kind)
  if (!result.ok) {
    console.warn(`[${name}] conversion failed (${kind}): ${result.error}`)
    writeJson(response, result.status, { ok: false, error: result.error })
    return
  }

  response.statusCode = 200
  response.setHeader('Content-Type', 'application/pdf')
  response.setHeader('Content-Length', String(result.pdf.byteLength))
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Office-Render-Kind', kind)
  response.setHeader('X-Office-Render-Cache', result.cached ? 'hit' : 'miss')
  if (result.engine !== undefined) response.setHeader('X-Office-Render-Engine', result.engine)
  response.end(result.pdf)
}

/**
 * Host-side apply.
 *
 * @param rawCtx - the host context, narrowed structurally in `dsh-seams.ts`.
 */
export function apply(rawCtx: unknown): void {
  const ctx = rawCtx as OfficeRenderContext

  if (ctx?.webServer === undefined) {
    console.warn(`[${name}] ctx.webServer is not available; faithful rendering stays off.`)
    return
  }

  ctx.effect(
    () =>
      ctx.webServer!.register({
        kind: 'prefix',
        path: BASE,
        handler: handle,
      }),
    `${name}: ${BASE} routes`,
  )

  console.log(`[${name}] mounted ${BASE}/health and ${BASE}/convert`)
}
