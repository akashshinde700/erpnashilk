import { NextRequest, NextResponse } from 'next/server'

/**
 * Demo-grade identity gate: every /api/* request (except public auth endpoints)
 * must carry the identity headers the client api() helper attaches from the
 * stored session. Server-side role checks per entity live in erp-helpers.
 */
const PUBLIC_API = new Set(['/api/auth/login', '/api/auth/logout'])

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  if (!pathname.startsWith('/api/')) return NextResponse.next()
  if (PUBLIC_API.has(pathname)) return NextResponse.next()

  const userId = req.headers.get('x-erp-user-id')
  const role = req.headers.get('x-erp-role')
  if (!userId || !role) {
    return NextResponse.json(
      { success: false, error: { code: 'UNAUTHORIZED', message: 'Sign in to continue' } },
      { status: 401 },
    )
  }
  return NextResponse.next()
}

export const config = {
  matcher: '/api/:path*',
}
