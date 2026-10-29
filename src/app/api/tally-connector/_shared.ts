import { ApiError } from '@/lib/erp-helpers'

const MAX_BODY_BYTES = 4 * 1024
/** Job results carry Tally records (up to 20 000 short rows). */
export const MAX_RESULT_BYTES = 8 * 1024 * 1024 // below the ~10 MB request body the middleware passes on

/** Small JSON body from the connector (no session; the size is capped before parsing). */
export async function connectorBody(req: Request, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get('content-length') || 0)
  if (declared > maxBytes) throw new ApiError('Request too large', 413)
  const text = await req.text()
  if (Buffer.byteLength(text) > maxBytes) throw new ApiError('Request too large', 413)
  try {
    const v = text ? JSON.parse(text) : {}
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    throw new ApiError('Invalid request body', 400)
  }
}
