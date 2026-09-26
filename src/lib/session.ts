import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Signed session cookie (server-only, node:crypto).
 * Token = base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload, SESSION_SECRET)).
 * The payload carries a fingerprint of the user's password hash (`pv`), so changing
 * or resetting a password invalidates every session issued before it.
 */

export const SESSION_COOKIE = 'erp_session'
export const SESSION_TTL_SEC = 12 * 60 * 60

export interface SessionPayload {
  uid: string // user id
  cid: string // user's home company id
  role: string
  name: string
  pv: string // password-hash fingerprint
  exp: number // unix seconds
}

function secret(): string {
  const s = process.env.SESSION_SECRET || ''
  if (s.length >= 32) return s
  if (process.env.NODE_ENV === 'production') throw new Error('SESSION_SECRET is not configured (min 32 chars)')
  return 'dev-only-insecure-session-secret-do-not-use-in-prod'
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url')
const sign = (data: string) => createHmac('sha256', secret()).update(data).digest('base64url')

export function passwordVersion(passwordHash: string | null | undefined): string {
  return createHash('sha256').update(passwordHash || '').digest('hex').slice(0, 16)
}

export function signSession(p: Omit<SessionPayload, 'exp'>): string {
  const body = b64(JSON.stringify({ ...p, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC }))
  return `${body}.${sign(body)}`
}

export function verifySession(token: string | undefined | null): SessionPayload | null {
  if (!token) return null
  const [body, mac] = token.split('.')
  if (!body || !mac) return null
  const expected = Buffer.from(sign(body))
  const given = Buffer.from(mac)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload
    if (!p.uid || !p.role || typeof p.exp !== 'number' || p.exp < Date.now() / 1000) return null
    return p
  } catch {
    return null
  }
}

export function sessionCookie(token: string): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SEC}${secure}`
}

export function clearSessionCookie(): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
}

// ============ Login throttling (single-process, in-memory) ============
// 5 failed attempts per (ip, email) within 15 minutes → locked for the rest of the window.

const WINDOW_MS = 15 * 60 * 1000
const MAX_FAILS = 5
const fails = new Map<string, { count: number; first: number }>()

export function loginBlocked(key: string): number {
  const f = fails.get(key)
  if (!f) return 0
  const left = f.first + WINDOW_MS - Date.now()
  if (left <= 0) { fails.delete(key); return 0 }
  return f.count >= MAX_FAILS ? Math.ceil(left / 60000) : 0
}

export function loginFailed(key: string) {
  const now = Date.now()
  const f = fails.get(key)
  if (!f || f.first + WINDOW_MS < now) fails.set(key, { count: 1, first: now })
  else f.count++
  if (fails.size > 10000) {
    for (const [k, v] of fails) if (v.first + WINDOW_MS < now) fails.delete(k)
  }
}

export function loginSucceeded(key: string) {
  fails.delete(key)
}

export function clientIp(req: Request): string {
  return (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown'
}
