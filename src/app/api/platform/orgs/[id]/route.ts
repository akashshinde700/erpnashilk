import { db } from '@/lib/db'
import { ApiError, handleError, logAudit, ok, requirePlatformAdmin } from '@/lib/erp-helpers'
import { hashPassword } from '@/lib/password'
import { loadOrg, orgRow } from '@/lib/platform'
import { generatePassword } from '@/lib/subscription'

type Ctx = { params: Promise<{ id: string }> }

async function customerOrg(id: string) {
  const org = await db.company.findUnique({ where: { id } })
  if (!org || org.isPlatform) throw new ApiError('Organization not found', 404)
  return org
}

const limitValue = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Math.round(Number(v))
  if (!Number.isFinite(n) || n < 0) throw new ApiError('Limits must be 0 (unlimited) or more', 400)
  return n
}

const fmt = (d: Date) => d.toISOString().slice(0, 10)

// PATCH /api/platform/orgs/[id] { action, ... }
//   setPlan { planId|null } · markPaid { cycle? } · extendTrial { days? } · suspend · activate
//   customize { maxUsers, maxWarehouses, maxItems } (null = plan default) · resetCustom
//   setPaidUntil { date|null } · resetPassword → { password, email } · loginAs (audit only)
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const me = await requirePlatformAdmin(req)
    const { id } = await params
    const org = await customerOrg(id)
    const body = await req.json().catch(() => ({}))
    const action = String(body.action || '')
    let details = ''
    let extra: Record<string, unknown> = {}

    switch (action) {
      case 'setPlan': {
        const planId = body.planId ? String(body.planId) : null
        const plan = planId ? await db.plan.findUnique({ where: { id: planId } }) : null
        if (planId && !plan) throw new ApiError('Plan not found', 400)
        await db.company.update({ where: { id }, data: { planId } })
        details = `Plan set to ${plan?.name || 'none'}`
        break
      }
      case 'markPaid': {
        const cycle = body.cycle === 'YEARLY' || body.cycle === 'MONTHLY' ? body.cycle : org.billingCycle
        const now = new Date()
        const base = org.paidUntil && org.paidUntil > now ? new Date(org.paidUntil) : now
        if (cycle === 'YEARLY') base.setFullYear(base.getFullYear() + 1)
        else base.setMonth(base.getMonth() + 1)
        await db.company.update({ where: { id }, data: { paidUntil: base, billingCycle: cycle, status: 'ACTIVE' } })
        details = `Payment recorded (${cycle.toLowerCase()}) — paid until ${fmt(base)}`
        break
      }
      case 'setPaidUntil': {
        const d = body.date ? new Date(body.date) : null
        if (d && isNaN(d.getTime())) throw new ApiError('Invalid date', 400)
        await db.company.update({ where: { id }, data: { paidUntil: d } })
        details = `Paid-until set to ${d ? fmt(d) : 'none'}`
        break
      }
      case 'extendTrial': {
        const days = Math.max(1, Math.min(365, Math.round(Number(body.days ?? 7)) || 7))
        const now = new Date()
        const base = org.trialEndsAt && org.trialEndsAt > now ? new Date(org.trialEndsAt) : now
        base.setDate(base.getDate() + days)
        await db.company.update({ where: { id }, data: { trialEndsAt: base } })
        details = `Trial extended by ${days} days — ends ${fmt(base)}`
        break
      }
      case 'suspend':
      case 'activate': {
        await db.company.update({ where: { id }, data: { status: action === 'suspend' ? 'SUSPENDED' : 'ACTIVE' } })
        details = action === 'suspend' ? 'Organization suspended' : 'Organization re-activated'
        break
      }
      case 'customize': {
        const data = {
          maxUsers: limitValue(body.maxUsers),
          maxWarehouses: limitValue(body.maxWarehouses),
          maxItems: limitValue(body.maxItems),
        }
        await db.company.update({ where: { id }, data })
        details = `Custom limits — users ${data.maxUsers ?? 'plan'}, warehouses ${data.maxWarehouses ?? 'plan'}, items ${data.maxItems ?? 'plan'}`
        break
      }
      case 'resetCustom': {
        await db.company.update({ where: { id }, data: { maxUsers: null, maxWarehouses: null, maxItems: null } })
        details = 'Custom limits removed — back to plan limits'
        break
      }
      case 'resetPassword': {
        const admin = await db.user.findFirst({ where: { companyId: id, role: 'TENANT_ADMIN' }, orderBy: { createdAt: 'asc' } })
        if (!admin) throw new ApiError('This organization has no Tenant Admin user', 400)
        const password = generatePassword()
        await db.user.update({ where: { id: admin.id }, data: { passwordHash: hashPassword(password), active: true } })
        details = `Admin password reset for ${admin.email}`
        extra = { password, email: admin.email }
        break
      }
      case 'loginAs': {
        details = 'Platform admin opened this organization'
        break
      }
      default:
        throw new ApiError('Unknown action', 400)
    }

    await logAudit(db as never, { companyId: id, userName: me.name, action: 'CONFIG', entity: 'COMPANY', entityId: id, details })
    const fresh = await loadOrg(id)
    return ok({ org: orgRow(fresh!), ...extra }, details)
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/platform/orgs/[id] { confirmName } — permanently removes the organization and all its data.
export async function DELETE(req: Request, { params }: Ctx) {
  try {
    await requirePlatformAdmin(req)
    const { id } = await params
    const org = await customerOrg(id)
    const body = await req.json().catch(() => ({}))
    if (String(body.confirmName || '').trim() !== org.name) {
      throw new ApiError('Type the organization name exactly to confirm deletion', 400)
    }
    const w = { companyId: id }
    await db.$transaction(async (tx) => {
      // Children before parents (foreign keys are RESTRICT); document lines cascade with their headers.
      await tx.stockLedger.deleteMany({ where: w })
      await tx.stockBalance.deleteMany({ where: w })
      await tx.payment.deleteMany({ where: w })
      await tx.expense.deleteMany({ where: w })
      await tx.notification.deleteMany({ where: w })
      await tx.numberSeq.deleteMany({ where: w })
      await tx.auditLog.deleteMany({ where: w })
      await tx.qcInspection.deleteMany({ where: w })
      await tx.productionEntry.deleteMany({ where: w })
      await tx.materialIssue.deleteMany({ where: w })
      await tx.salesInvoice.deleteMany({ where: w })
      await tx.purchaseInvoice.deleteMany({ where: w })
      await tx.deliveryChallan.deleteMany({ where: w })
      await tx.grn.deleteMany({ where: w })
      await tx.workOrder.deleteMany({ where: w })
      await tx.salesOrder.deleteMany({ where: w })
      await tx.quotation.deleteMany({ where: w })
      await tx.enquiry.deleteMany({ where: w })
      await tx.purchaseOrder.deleteMany({ where: w })
      await tx.purchaseRequisition.deleteMany({ where: w })
      await tx.bom.deleteMany({ where: w })
      await tx.item.deleteMany({ where: w })
      await tx.customer.deleteMany({ where: w })
      await tx.supplier.deleteMany({ where: w })
      await tx.warehouse.deleteMany({ where: w })
      await tx.machine.deleteMany({ where: w })
      await tx.plant.deleteMany({ where: w })
      await tx.user.deleteMany({ where: w })
      await tx.company.delete({ where: { id } })
    }, { timeout: 120000 })
    console.info(`[platform] organization deleted: ${org.name} (${id})`)
    return ok({ id }, 'Organization deleted')
  } catch (e) {
    return handleError(e)
  }
}
