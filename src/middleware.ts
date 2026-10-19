import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE, verifySession } from '@/lib/session'

/**
 * Identity gate for /api/*. The signed httpOnly session cookie is the only source of
 * identity: client-sent x-erp-* headers are always stripped, and for authenticated
 * calls they are re-set here from the verified token. Route helpers (companyRequired /
 * sessionUser in erp-helpers) re-check the user against the DB and enforce the tenant.
 */
const PUBLIC_API = new Set(['/api/auth/login', '/api/auth/logout'])
const IDENTITY_HEADERS = ['x-erp-user-id', 'x-erp-role', 'x-erp-user-name', 'x-erp-pv']

function unauthorized(message = 'Sign in to continue') {
  return NextResponse.json({ success: false, error: { code: 'UNAUTHORIZED', message } }, { status: 401 })
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  if (!pathname.startsWith('/api/')) return NextResponse.next()

  // CSRF: state-changing calls must come from this site when the browser says where they came from.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.get('origin')
    const host = req.headers.get('x-forwarded-host') || req.headers.get('host')
    if (origin && host && new URL(origin).host !== host) {
      return NextResponse.json({ success: false, error: { code: 'FORBIDDEN', message: 'Cross-site request blocked' } }, { status: 403 })
    }
  }

  const headers = new Headers(req.headers)
  for (const h of IDENTITY_HEADERS) headers.delete(h)

  if (!PUBLIC_API.has(pathname)) {
    const s = verifySession(req.cookies.get(SESSION_COOKIE)?.value)
    if (!s) return unauthorized()
    headers.set('x-erp-user-id', s.uid)
    headers.set('x-erp-role', s.role)
    headers.set('x-erp-user-name', encodeURIComponent(s.name))
    headers.set('x-erp-pv', s.pv)
  }
  return NextResponse.next({ request: { headers } })
}

export const config = {
  matcher: '/api/:path*',
  runtime: 'nodejs',
}
