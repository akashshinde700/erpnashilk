/**
 * TallyPrime connectivity check over its XML-over-HTTP interface.
 *
 * TallyPrime answers XML ENVELOPE requests by HTTP POST when it runs as a server
 * (Exchange > Data Synchronization: "TallyPrime act as" Server / Both; default port 9000; at least
 * one company loaded). It listens on the user's PC / LAN — a cloud-hosted ManuFlow server cannot
 * reach it, so the endpoint is configured by the server administrator only (TALLY_HTTP_URL), for
 * installations where ManuFlow runs on the same machine or network as Tally. It is never taken
 * from a request (that would let users make the server probe internal addresses).
 *
 * The check sends one small Export envelope and reports "connected" only when an HTTP reply that
 * looks like a Tally XML envelope arrives. It does not list companies or read data: that request
 * format and its mapping have not been verified yet (docs/tally-connector.md).
 */

export type TallyStatus = 'not_configured' | 'invalid_config' | 'connected' | 'unreachable' | 'timeout' | 'invalid_response'

export interface TallyCheck {
  status: TallyStatus
  message: string
  /** host:port that was checked (never credentials). */
  endpoint?: string
  latencyMs?: number
  checkedAt: string
}

export const TALLY_DEFAULT_TIMEOUT_MS = 4000
export const TALLY_MAX_RESPONSE_BYTES = 256 * 1024

// Export request with the documented ENVELOPE / HEADER layout. The report id does not exist on
// purpose: Tally answers with a small STATUS envelope instead of exporting company data.
export const TALLY_HEALTH_REQUEST =
  '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE>' +
  '<ID>ManuFlow Connectivity Check</ID></HEADER><BODY><DESC><STATICVARIABLES>' +
  '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY></ENVELOPE>'

const now = () => new Date().toISOString()

/** Read TALLY_HTTP_URL: http(s) only, no credentials, no path / query. */
export function tallyEndpoint(env: Record<string, string | undefined> = process.env): { url: string; endpoint: string } | { error: TallyCheck } | null {
  const raw = (env.TALLY_HTTP_URL || '').trim()
  if (!raw) return null
  const invalid = (message: string) => ({ error: { status: 'invalid_config' as const, message, checkedAt: now() } })
  let u: URL
  try { u = new URL(raw) } catch { return invalid('TALLY_HTTP_URL is not a valid URL (example: http://192.168.1.20:9000)') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return invalid('TALLY_HTTP_URL must start with http:// or https://')
  if (u.username || u.password) return invalid('TALLY_HTTP_URL must not contain a user name or password')
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) return invalid('TALLY_HTTP_URL must be just the address and port, e.g. http://192.168.1.20:9000')
  return { url: `${u.protocol}//${u.host}/`, endpoint: u.host }
}

/** Read at most `max` bytes of the body; null when it is larger. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks))
}

/** Does the body look like a Tally XML reply? (root ENVELOPE or RESPONSE, closed; no DTD / entities) */
export function looksLikeTallyXml(body: string): boolean {
  const s = body.replace(/^\ufeff/, '').trim().replace(/^<\?xml[^>]*\?>\s*/i, '')
  if (/<!DOCTYPE|<!ENTITY/i.test(s)) return false
  const m = /^<(ENVELOPE|RESPONSE)[\s>]/i.exec(s)
  if (!m) return false
  return new RegExp(`</${m[1]}>\\s*$`, 'i').test(s)
}

export async function checkTally(url: string, endpoint: string, opts: { timeoutMs?: number; maxBytes?: number; fetchImpl?: typeof fetch } = {}): Promise<TallyCheck> {
  const timeoutMs = opts.timeoutMs ?? TALLY_DEFAULT_TIMEOUT_MS
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const started = Date.now()
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: { 'content-type': 'text/xml; charset=utf-8' },
      body: TALLY_HEALTH_REQUEST,
      signal: ctrl.signal,
      redirect: 'manual',
    })
    const body = await readCapped(res, opts.maxBytes ?? TALLY_MAX_RESPONSE_BYTES)
    const latencyMs = Date.now() - started
    if (res.status !== 200) return { status: 'invalid_response', message: `${endpoint} answered HTTP ${res.status} — that is not a TallyPrime XML server`, endpoint, latencyMs, checkedAt: now() }
    if (body === null) return { status: 'invalid_response', message: `${endpoint} sent an unexpectedly large reply — not treated as Tally`, endpoint, latencyMs, checkedAt: now() }
    if (!looksLikeTallyXml(body)) return { status: 'invalid_response', message: `${endpoint} answered, but not with a Tally XML envelope — check the address and that TallyPrime runs as a server`, endpoint, latencyMs, checkedAt: now() }
    return {
      status: 'connected',
      message: `TallyPrime's XML server answered at ${endpoint}. Company listing and data import from Tally are not available yet.`,
      endpoint, latencyMs, checkedAt: now(),
    }
  } catch (e) {
    if (ctrl.signal.aborted || (e instanceof Error && e.name === 'AbortError')) {
      return { status: 'timeout', message: `No reply from ${endpoint} within ${Math.round(timeoutMs / 1000)} s — is TallyPrime open with a company loaded and running as a server?`, endpoint, checkedAt: now() }
    }
    return { status: 'unreachable', message: `Could not connect to ${endpoint} — TallyPrime is not running as a server there, or a firewall blocks the port`, endpoint, checkedAt: now() }
  } finally {
    clearTimeout(timer)
  }
}
