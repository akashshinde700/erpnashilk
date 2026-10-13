import { db } from '@/lib/db'
import { ApiError } from '@/lib/erp-helpers'
import { verifyPassword } from '@/lib/password'

/**
 * Document lock (Settings → Security): when enabled, cancelling / deleting / editing a SAVED document
 * needs the company's security PIN in the `x-erp-pin` header. The client asks for it on a 423 reply.
 */
export async function requireSecurityPin(req: Request, companyId: string) {
  const c = await db.company.findUnique({ where: { id: companyId }, select: { lockEnabled: true, lockPinHash: true } })
  if (!c?.lockEnabled || !c.lockPinHash) return
  const pin = req.headers.get('x-erp-pin') || ''
  if (!pin) throw new ApiError('PIN_REQUIRED', 423)
  if (!verifyPassword(pin, c.lockPinHash)) throw new ApiError('Wrong security PIN', 423)
}
