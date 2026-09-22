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
export type OfficeKind = 'docx' | 'pptx';
/** What the converter script reports back. */
export interface ConverterResult {
    ok: boolean;
    engine?: string;
    bytes?: number;
    error?: string;
}
/** `docx` → `docx`; anything we do not convert → undefined (never guess). */
export declare function kindOfExtension(extension: string): OfficeKind | undefined;
/** True for the extensions this plugin claims. */
export declare function isConvertible(extension: string): boolean;
/**
 * The last stdout line that parses as a JSON object.
 *
 * "Last" is the contract, not a convenience: a COM suite is free to print its
 * own banner before the script's result line, and taking the first JSON-looking
 * line would then parse the wrong thing.
 */
export declare function parseConverterOutput(stdout: string): ConverterResult;
/** The cache identity of one conversion: content + kind, never the path. */
export declare function cacheKey(payload: Uint8Array, kind: OfficeKind, digest: (bytes: Uint8Array) => string): string;
/** One job at a time — a second COM suite instance is a second set of dialogs. */
export interface SerialQueue {
    run<T>(job: () => Promise<T>): Promise<T>;
    /** Jobs queued or running right now. */
    size(): number;
}
/** Build a FIFO queue whose jobs run strictly one after another. */
export declare function createQueue(): SerialQueue;
/** A candidate interpreter, plus whether it exists on this machine. */
export interface PowerShellCandidate {
    path: string;
    exists: boolean;
}
/**
 * Which interpreter to run the converter with.
 *
 * An explicit override always wins (a machine may have a hardened PowerShell
 * and no `pwsh`, or the reverse). Otherwise the first candidate that exists —
 * the caller passes them in preference order.
 */
export declare function resolvePowerShell(candidates: PowerShellCandidate[], override?: string): string | undefined;
/** The converter's argv. Paths are arguments, never script literals. */
export declare function converterArgs(scriptPath: string, source: string, dest: string, kind: OfficeKind): string[];
/** `-Probe` argv: report which engines bind, without converting anything. */
export declare function probeArgs(scriptPath: string): string[];
/** One completed spawn. */
export interface SpawnResult {
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}
/** Launch a process and collect its output, killing the tree on timeout. */
export type SpawnFn = (file: string, args: string[], options: {
    timeoutMs: number;
}) => Promise<SpawnResult>;
/** Everything one conversion needs. */
export interface ConvertRequest {
    powershell: string;
    scriptPath: string;
    source: string;
    dest: string;
    kind: OfficeKind;
    timeoutMs: number;
}
/**
 * Run the converter for one file.
 *
 * A timeout is a distinct outcome from a converter error, because the advice
 * differs: a timeout usually means a dialog is waiting for a human, so the
 * caller must not simply retry in a loop.
 */
export declare function convert(request: ConvertRequest, spawn: SpawnFn): Promise<ConverterResult>;
/** Which engines bound during the last probe. */
export interface ProbeResult {
    /** Kinds this machine can convert. */
    kinds: OfficeKind[];
    /** Engine actually bound per kind, for the health payload. */
    engines: Partial<Record<OfficeKind, string>>;
}
/** Read a `-Probe` run's verdict out of its stdout. */
export declare function parseProbeOutput(stdout: string): ProbeResult;
/** One cache-directory entry, as the sweep sees it. */
export interface CacheEntry {
    name: string;
    mtimeMs: number;
    size: number;
}
/** Sweep policy: age first, then count. Never returns a name it should keep. */
export declare function filesToEvict(entries: CacheEntry[], now: number, maxAgeMs: number, maxCount: number): string[];
/** Bytes → the closest whole unit, for messages. */
export declare function formatBytes(bytes: number): string;
