/**
 * The conversion core, deliberately free of Cordis and of `node:child_process`
 * so every decision here is unit-testable without launching an Office suite.
 *
 * The one dangerous operation — spawning a GUI-class COM server — is isolated
 * behind the `SpawnFn` seam. Tests inject a fake; production injects the real
 * spawn. That split also means the timeout/kill policy can be asserted instead
 * of hoped for.
 */

/** Which converter a file needs. */
export type OfficeKind = 'docx' | 'pptx'

/** What the converter script reports back. */
export interface ConverterResult {
  ok: boolean
  engine?: string
  bytes?: number
  error?: string
}

/** Extensions we are willing to hand to a converter. */
const KIND_BY_EXTENSION: Record<string, OfficeKind> = {
  docx: 'docx',
  docm: 'docx',
  dotx: 'docx',
  pptx: 'pptx',
  pptm: 'pptx',
  potx: 'pptx',
}

/** `docx` → `docx`; anything we do not convert → undefined (never guess). */
export function kindOfExtension(extension: string): OfficeKind | undefined {
  return KIND_BY_EXTENSION[extension.replace(/^\./, '').toLowerCase()]
}

/** True for the extensions this plugin claims. */
export function isConvertible(extension: string): boolean {
  return kindOfExtension(extension) !== undefined
}

/**
 * The last stdout line that parses as a JSON object.
 *
 * "Last" is the contract, not a convenience: a COM suite is free to print its
 * own banner before the script's result line, and taking the first JSON-looking
 * line would then parse the wrong thing.
 */
export function parseConverterOutput(stdout: string): ConverterResult {
  const lines = stdout.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]?.trim() ?? ''
    if (!line.startsWith('{') || !line.endsWith('}')) continue
    try {
      const parsed = JSON.parse(line) as Partial<ConverterResult>
      if (typeof parsed.ok !== 'boolean') continue
      return {
        ok: parsed.ok,
        ...(typeof parsed.engine === 'string' ? { engine: parsed.engine } : {}),
        ...(typeof parsed.bytes === 'number' ? { bytes: parsed.bytes } : {}),
        ...(typeof parsed.error === 'string' ? { error: parsed.error } : {}),
      }
    } catch {
      // Not JSON after all; keep walking backwards.
    }
  }
  return { ok: false, error: 'converter produced no parsable result line' }
}

/** The cache identity of one conversion: content + kind, never the path. */
export function cacheKey(payload: Uint8Array, kind: OfficeKind, digest: (bytes: Uint8Array) => string): string {
  return `${kind}-${digest(payload)}`
}

/** One job at a time — a second COM suite instance is a second set of dialogs. */
export interface SerialQueue {
  run<T>(job: () => Promise<T>): Promise<T>
  /** Jobs queued or running right now. */
  size(): number
}

/** Build a FIFO queue whose jobs run strictly one after another. */
export function createQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve()
  let pending = 0

  return {
    run<T>(job: () => Promise<T>): Promise<T> {
      pending++
      const result = tail.then(job, job)
      // The chain must survive a rejected job, or one failure would deadlock
      // every later conversion.
      tail = result.then(
        () => undefined,
        () => undefined,
      )
      return result.finally(() => {
        pending--
      })
    },
    size: () => pending,
  }
}

/** A candidate interpreter, plus whether it exists on this machine. */
export interface PowerShellCandidate {
  path: string
  exists: boolean
}

/**
 * Which interpreter to run the converter with.
 *
 * An explicit override always wins (a machine may have a hardened PowerShell
 * and no `pwsh`, or the reverse). Otherwise the first candidate that exists —
 * the caller passes them in preference order.
 */
export function resolvePowerShell(candidates: PowerShellCandidate[], override?: string): string | undefined {
  if (override !== undefined && override.trim() !== '') return override.trim()
  return candidates.find(candidate => candidate.exists)?.path
}

/** The converter's argv. Paths are arguments, never script literals. */
export function converterArgs(scriptPath: string, source: string, dest: string, kind: OfficeKind): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Source', source, '-Dest', dest, '-Kind', kind]
}

/** `-Probe` argv: report which engines bind, without converting anything. */
export function probeArgs(scriptPath: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Probe']
}

/** One completed spawn. */
export interface SpawnResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Launch a process and collect its output, killing the tree on timeout. */
export type SpawnFn = (
  file: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<SpawnResult>

/** Everything one conversion needs. */
export interface ConvertRequest {
  powershell: string
  scriptPath: string
  source: string
  dest: string
  kind: OfficeKind
  timeoutMs: number
}

/**
 * Run the converter for one file.
 *
 * A timeout is a distinct outcome from a converter error, because the advice
 * differs: a timeout usually means a dialog is waiting for a human, so the
 * caller must not simply retry in a loop.
 */
export async function convert(request: ConvertRequest, spawn: SpawnFn): Promise<ConverterResult> {
  const outcome = await spawn(
    request.powershell,
    converterArgs(request.scriptPath, request.source, request.dest, request.kind),
    { timeoutMs: request.timeoutMs },
  )

  if (outcome.timedOut) {
    return { ok: false, error: `conversion timed out after ${Math.round(request.timeoutMs / 1000)}s` }
  }

  const reported = parseConverterOutput(outcome.stdout)
  if (reported.ok) return reported

  const detail = reported.error ?? outcome.stderr.trim() ?? `converter exited with ${outcome.code}`
  return { ok: false, error: detail }
}

/** Which engines bound during the last probe. */
export interface ProbeResult {
  /** Kinds this machine can convert. */
  kinds: OfficeKind[]
  /** Engine actually bound per kind, for the health payload. */
  engines: Partial<Record<OfficeKind, string>>
}

/** Read a `-Probe` run's verdict out of its stdout. */
export function parseProbeOutput(stdout: string): ProbeResult {
  const lines = stdout.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]?.trim() ?? ''
    if (!line.startsWith('{') || !line.endsWith('}')) continue
    try {
      const parsed = JSON.parse(line) as { ok?: boolean; engines?: Record<string, string> }
      if (parsed.ok !== true) continue
      const engines: Partial<Record<OfficeKind, string>> = {}
      for (const kind of ['docx', 'pptx'] as const) {
        const engine = parsed.engines?.[kind]
        if (typeof engine === 'string' && engine !== '') engines[kind] = engine
      }
      return { kinds: (['docx', 'pptx'] as const).filter(kind => engines[kind] !== undefined), engines }
    } catch {
      // keep walking
    }
  }
  return { kinds: [], engines: {} }
}

/** One cache-directory entry, as the sweep sees it. */
export interface CacheEntry {
  name: string
  mtimeMs: number
  size: number
}

/** Sweep policy: age first, then count. Never returns a name it should keep. */
export function filesToEvict(entries: CacheEntry[], now: number, maxAgeMs: number, maxCount: number): string[] {
  const doomed = new Set<string>()

  for (const entry of entries) {
    if (now - entry.mtimeMs > maxAgeMs) doomed.add(entry.name)
  }

  const survivors = entries.filter(entry => !doomed.has(entry.name)).sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const entry of survivors.slice(maxCount)) doomed.add(entry.name)

  return [...doomed]
}

/** Bytes → the closest whole unit, for messages. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
