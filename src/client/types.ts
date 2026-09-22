/**
 * The wire contract with this plugin's own host half. Types only — the client
 * bundle must not reach for Node.
 */

/** Which converter a file needs. */
export type OfficeKind = 'docx' | 'pptx'

/** `GET /office-render/health`. */
export interface HealthResponse {
  ok: boolean
  service: string
  version: string
  /** Where to POST a document. Sent by the host so the path lives in one place. */
  convertPath: string
  /** Kinds this machine can actually convert. Empty means: do not register. */
  kinds: OfficeKind[]
  /** The COM engine that answered per kind, for the health line in the UI. */
  engines: Partial<Record<OfficeKind, string>>
  powershell?: string
  error?: string
}

/** A failed conversion, as the route reports it. */
export interface ConvertFailure {
  ok: false
  error: string
}
