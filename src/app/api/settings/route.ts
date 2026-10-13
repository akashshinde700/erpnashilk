import { db } from '@/lib/db'
import { ApiError, companyRequired, handleError, logAudit, ok, requireWrite } from '@/lib/erp-helpers'
import { hashPassword, verifyPassword } from '@/lib/password'

const EDITABLE = ['name', 'gstin', 'pan', 'addressLine', 'city', 'state', 'stateCode', 'phone', 'email', 'logoText', 'bankAccountName', 'bankAccountNumber', 'bankIfsc', 'bankUpiId', 'bankName', 'bankBranch', 'pincode', 'invoiceTerms', 'quotationTerms'] as const
type EditableField = (typeof EDITABLE)[number]

const PROFILE_SELECT = {
  id: true,
  name: true,
  gstin: true,
  pan: true,
  addressLine: true,
  city: true,
  state: true,
  stateCode: true,
  phone: true,
  email: true,
  logoText: true,
  bankAccountName: true,
  bankAccountNumber: true,
  bankIfsc: true,
  bankUpiId: true,
  bankName: true,
  bankBranch: true,
  pincode: true,
  invoiceTerms: true,
  quotationTerms: true,
  logoImage: true,
  signatureImage: true,
  roundOffTotals: true,
  lockEnabled: true, // Security PIN on/off — the PIN hash itself is never returned
} as const

const IMAGE_FIELDS = ['logoImage', 'signatureImage'] as const
const IMAGE_PREFIXES = ['data:image/png;base64,', 'data:image/jpeg;base64,', 'data:image/webp;base64,']
const MAX_IMAGE_CHARS = 700_000 // ≈500 KB of image data

/** null / '' removes the image; otherwise a PNG/JPEG/WebP data URL within the size cap. */
function imageValue(v: unknown, label: string): string | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v !== 'string' || !IMAGE_PREFIXES.some((p) => v.startsWith(p))) throw new ApiError(`${label} must be a PNG, JPG or WebP image`, 400)
  if (v.length > MAX_IMAGE_CHARS) throw new ApiError(`${label} is too large — use an image under 500 KB`, 400)
  return v
}

// GET /api/settings?companyId= → company profile (singleton for tenant)
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const company = await db.company.findUnique({ where: { id: companyId }, select: PROFILE_SELECT })
    if (!company) throw new ApiError('Company not found', 404)
    return ok(company)
  } catch (e) {
    return handleError(e)
  }
}

// PATCH /api/settings { companyId, ...editable fields, userName? } → update profile + CONFIG audit
export async function PATCH(req: Request) {
  try {
    requireWrite(req, 'settings')
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body?.companyId)

    const data: Record<string, string | boolean | null> = {}
    for (const f of EDITABLE) {
      if (f in body) {
        const s = body[f] === null || body[f] === undefined ? null : String(body[f]).trim()
        data[f] = s === '' && f !== 'name' ? null : s
      }
    }
    for (const f of IMAGE_FIELDS) {
      if (f in body) data[f] = imageValue(body[f], f === 'logoImage' ? 'Logo' : 'Signature')
    }
    if ('roundOffTotals' in body) {
      if (typeof body.roundOffTotals !== 'boolean') throw new ApiError('roundOffTotals must be true or false', 400)
      data.roundOffTotals = body.roundOffTotals
    }
    // ---- Security PIN (document lock) ----
    let pinChanged = false
    if ('lockEnabled' in body || 'newPin' in body) {
      const cur = await db.company.findUnique({ where: { id: companyId }, select: { lockEnabled: true, lockPinHash: true } })
      if (!cur) throw new ApiError('Company not found', 404)
      const newPin = body.newPin === undefined || body.newPin === null || body.newPin === '' ? null : String(body.newPin)
      if ('lockEnabled' in body && typeof body.lockEnabled !== 'boolean') throw new ApiError('lockEnabled must be true or false', 400)
      const wantEnabled: boolean = 'lockEnabled' in body ? body.lockEnabled : cur.lockEnabled
      if (newPin !== null && !/^\d{4,6}$/.test(newPin)) throw new ApiError('Security PIN must be 4 to 6 digits', 400)
      const disabling = cur.lockEnabled && !wantEnabled
      if (cur.lockPinHash && (newPin !== null || disabling)) {
        const currentPin = typeof body.currentPin === 'string' || typeof body.currentPin === 'number' ? String(body.currentPin) : ''
        if (!currentPin) throw new ApiError('Enter the current security PIN', 400)
        if (!verifyPassword(currentPin, cur.lockPinHash)) throw new ApiError('Current security PIN is wrong', 400)
      }
      if (wantEnabled && !cur.lockPinHash && newPin === null) throw new ApiError('Set a 4–6 digit PIN to turn on the security lock', 400)
      // Turning the lock off forgets the PIN; turning it back on asks for a fresh one.
      if (!wantEnabled && cur.lockEnabled) data.lockPinHash = null
      else if (newPin !== null) { data.lockPinHash = hashPassword(newPin); pinChanged = true }
      if ('lockEnabled' in body) data.lockEnabled = wantEnabled
    }
    if ('name' in data && !data.name) throw new ApiError('Company name cannot be empty', 400)
    if (typeof data.pincode === 'string' && data.pincode && !/^\d{6}$/.test(data.pincode)) throw new ApiError('Pincode must be 6 digits', 400)
    if (Object.keys(data).length === 0) throw new ApiError('No editable fields provided', 400)

    const company = await db.$transaction(async (tx) => {
      const updated = await tx.company.update({ where: { id: companyId }, data: data as { name: string }, select: PROFILE_SELECT })
      await logAudit(tx as never, {
        companyId,
        userName: body?.userName,
        action: 'CONFIG',
        entity: 'COMPANY',
        entityId: companyId,
        details: 'lockEnabled' in data || pinChanged
          ? `Security PIN ${data.lockEnabled === false ? 'disabled' : pinChanged ? 'set/changed' : 'enabled'}`
          : 'Company profile updated',
      })
      return updated
    })
    return ok(company, 'Company profile updated')
  } catch (e) {
    return handleError(e)
  }
}
