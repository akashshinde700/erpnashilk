import { passwordVersion } from '@/lib/session'

/**
 * Build a request the way it reaches a route handler after middleware.ts: the identity
 * headers are the ones middleware sets from a verified session cookie. Route helpers
 * (sessionUser) still re-check the user, role and password version against the database.
 */
export interface TestUser { id: string; name: string; role: string; passwordHash?: string | null }

export function apiRequest(path: string, opts: { method?: string; body?: unknown; user?: TestUser | null; headers?: Record<string, string> } = {}) {
  const headers = new Headers({ 'content-type': 'application/json', ...(opts.headers ?? {}) })
  if (opts.user) {
    headers.set('x-erp-user-id', opts.user.id)
    headers.set('x-erp-role', opts.user.role)
    headers.set('x-erp-user-name', encodeURIComponent(opts.user.name))
    headers.set('x-erp-pv', passwordVersion(opts.user.passwordHash ?? null))
  }
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST')
  return new Request(`http://test.local${path}`, {
    method,
    headers,
    body: opts.body === undefined || method === 'GET' ? undefined : JSON.stringify(opts.body),
  })
}

/** multipart/form-data request with a real Content-Length (as browsers send it). */
export async function uploadRequest(path: string, fields: Record<string, string | Blob | { data: Uint8Array | string; name: string }>, user?: TestUser | null) {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string' || v instanceof Blob) form.set(k, v)
    else form.set(k, new File([v.data as BlobPart], v.name))
  }
  const draft = new Request(`http://test.local${path}`, { method: 'POST', body: form })
  const contentType = draft.headers.get('content-type') || '' // read before the body is consumed
  const body = new Uint8Array(await draft.arrayBuffer())
  const base = apiRequest(path, { method: 'POST', user })
  const headers = new Headers(base.headers)
  headers.set('content-type', contentType)
  headers.set('content-length', String(body.byteLength))
  return new Request(`http://test.local${path}`, { method: 'POST', headers, body })
}

export interface ApiResult<T = any> { status: number; json: { success: boolean; data?: T; message?: string; error?: { code: string; message: string } } }

export async function call<T = any>(res: Response | Promise<Response>): Promise<ApiResult<T>> {
  const r = await res
  return { status: r.status, json: await r.json() }
}

/** Route context for dynamic segments ({ params: Promise<...> } in Next 16). */
export const ctx = <P extends Record<string, string>>(params: P) => ({ params: Promise.resolve(params) })
