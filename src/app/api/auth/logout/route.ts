import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { logAudit } from '@/lib/erp-helpers'
import { db } from '@/lib/db'
import { SESSION_COOKIE, clearSessionCookie, verifySession } from '@/lib/session'

// POST /api/auth/logout → ok({ success: true }) and clears the session cookie.
// The audit row uses the verified session only and never blocks the sign-out.
export async function POST() {
  const session = verifySession((await cookies()).get(SESSION_COOKIE)?.value)
  if (session) {
    try {
      await logAudit(db as never, {
        companyId: session.cid,
        userName: session.name,
        action: 'LOGOUT',
        entity: 'USER',
        entityId: session.uid,
        details: 'Signed out',
      })
    } catch {
      // ignore audit failures — logout must always succeed
    }
  }
  const res = NextResponse.json({ success: true, data: { success: true }, message: '' })
  res.headers.append('Set-Cookie', clearSessionCookie())
  return res
}
