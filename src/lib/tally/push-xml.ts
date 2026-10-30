/**
 * Pure half of the Tally connector push: the flag and the envelope checks.
 *
 * Kept away from the database / request helpers so the unit tests (and the connector's own copy of
 * these rules) can import it without a Next.js request context.
 */

export const PUSH_FLAG = 'TALLY_CONNECTOR_PUSH'
/** Tally's own limit is far higher, but a sales voucher is a few KB — anything bigger is a bug. */
export const MAX_PUSH_XML_BYTES = 256 * 1024

export function pushEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[PUSH_FLAG] === '1'
}

/**
 * Sanity-check an envelope before it is handed to the connector. Returns an error code, or null.
 *
 * The connector repeats these checks (it must not trust the server blindly either), so a bug here
 * cannot turn into an arbitrary write against Tally.
 */
export function checkPushXml(xml: unknown): string | null {
  if (typeof xml !== 'string' || !xml.trim()) return 'empty'
  if (Buffer.byteLength(xml, 'utf8') > MAX_PUSH_XML_BYTES) return 'too_large'
  // A DTD / external entity would let the document define its own entities — never allow it.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return 'unsafe_xml'
  if (!/<TALLYREQUEST>\s*Import Data\s*<\/TALLYREQUEST>/i.test(xml)) return 'not_an_import'
  if (!/<ENVELOPE[\s>]/i.test(xml) || !/<\/ENVELOPE>\s*$/i.test(xml)) return 'not_an_envelope'
  const vouchers = xml.match(/<VOUCHER[\s>]/gi) ?? []
  if (vouchers.length !== 1) return 'one_voucher_only'
  if (!/ACTION\s*=\s*"Create"/i.test(xml)) return 'not_a_create'
  return null
}
