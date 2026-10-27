import { db } from '@/lib/db'
import { ok, fail, handleError, companyRequired, nextDocNumber, computeGst, isInterState, postStock, logAudit, notify, ApiError, r2, requireWrite, requireRead } from '@/lib/erp-helpers'
import { emitEvent } from '@/lib/emit-event'
import { assertOnOrAfterOpening, chequeDetails, ensureCashFor, postingAccount } from '@/lib/accounts'
import { businessDate } from '@/lib/business-date'
import { claimIdempotency, type Idempotency } from '@/lib/idempotency'
import { CASH_TX, type CashOverride, assertCashNotNegative, dayWindow, negativeCashOverride, refuseDuplicate, sameIstDay } from '@/lib/cash-guard'
import { ADVANCE, ADVANCE_ADJ, PURCHASE_RETURN, SALES_RETURN, advanceApplied, paymentKindModule, purchaseReturnRefunds, salesReturnCredits } from '@/lib/party-credits'

// GET /api/payments?companyId=&type=RECEIPT|PAYMENT&customerId=&supplierId=&invoiceId=&q=&accountId=&cheques=postdated|all
export async function GET(req: Request) {
  try {
    requireRead(req, 'payments') // Phase 5: financial read permission
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const type = (searchParams.get('type') || '').trim()
    const customerId = (searchParams.get('customerId') || '').trim()
    const supplierId = (searchParams.get('supplierId') || '').trim()
    const invoiceId = (searchParams.get('invoiceId') || '').trim()
    const q = (searchParams.get('q') || '').trim()
    const accountId = (searchParams.get('accountId') || '').trim()
    const cheques = (searchParams.get('cheques') || '').trim()

    const where: any = { companyId }
    if (accountId) where.accountId = accountId
    // postdated = cheques not yet cleared (PENDING / DEPOSITED); all = every cheque payment
    if (cheques === 'postdated') where.chequeStatus = { in: ['PENDING', 'DEPOSITED'] }
    else if (cheques === 'all') where.mode = 'CHEQUE'
    if (type) where.type = type
    if (customerId) where.customerId = customerId
    if (supplierId) where.supplierId = supplierId
    if (invoiceId) where.invoiceId = invoiceId
    if (q) where.number = { contains: q }

    // Payment has no Prisma relations (plain customerId/supplierId/invoiceId strings) — resolve names via JS mapping
    const rows = await db.payment.findMany({ where, orderBy: { date: 'desc' } })

    const customerIds = Array.from(new Set(rows.filter((r) => r.customerId).map((r) => r.customerId as string)))
    const supplierIds = Array.from(new Set(rows.filter((r) => r.supplierId).map((r) => r.supplierId as string)))
    const salesIds = rows.filter((r) => r.invoiceType === 'SALES' && r.invoiceId).map((r) => r.invoiceId as string)
    const purchaseIds = rows.filter((r) => r.invoiceType === 'PURCHASE' && r.invoiceId).map((r) => r.invoiceId as string)

    const [customers, suppliers, salesInvoices, purchaseInvoices, accounts] = await Promise.all([
      customerIds.length ? db.customer.findMany({ where: { companyId, id: { in: customerIds } }, select: { id: true, name: true } }) : Promise.resolve([] as { id: string; name: string }[]),
      supplierIds.length ? db.supplier.findMany({ where: { companyId, id: { in: supplierIds } }, select: { id: true, name: true } }) : Promise.resolve([] as { id: string; name: string }[]),
      salesIds.length ? db.salesInvoice.findMany({ where: { companyId, id: { in: salesIds } }, select: { id: true, number: true } }) : Promise.resolve([] as { id: string; number: string }[]),
      purchaseIds.length ? db.purchaseInvoice.findMany({ where: { companyId, id: { in: purchaseIds } }, select: { id: true, number: true } }) : Promise.resolve([] as { id: string; number: string }[]),
      db.moneyAccount.findMany({ where: { companyId }, select: { id: true, name: true } }),
    ])
    const accountMap = new Map(accounts.map((a) => [a.id, a.name]))

    // Phase 4: return numbers for refunds; source numbers for applications; applied / remaining for advances
    const srIds = rows.filter((r) => r.invoiceType === SALES_RETURN && r.invoiceId).map((r) => r.invoiceId as string)
    const prIds = rows.filter((r) => r.invoiceType === PURCHASE_RETURN && r.invoiceId).map((r) => r.invoiceId as string)
    const srcIds = Array.from(new Set(rows.filter((r) => r.allocatedFromId).map((r) => r.allocatedFromId as string)))
    const advIds = rows.filter((r) => r.invoiceType === ADVANCE).map((r) => r.id)
    const [srRows, prRows, srcPays, srcRets, applied] = await Promise.all([
      srIds.length ? db.salesReturn.findMany({ where: { companyId, id: { in: srIds } }, select: { id: true, number: true } }) : [],
      prIds.length ? db.purchaseReturn.findMany({ where: { companyId, id: { in: prIds } }, select: { id: true, number: true } }) : [],
      srcIds.length ? db.payment.findMany({ where: { companyId, id: { in: srcIds } }, select: { id: true, number: true } }) : [],
      srcIds.length ? db.salesReturn.findMany({ where: { companyId, id: { in: srcIds } }, select: { id: true, number: true } }) : [],
      advanceApplied(db, companyId, advIds),
    ])
    const sourceNumber = new Map<string, string>([...srcPays, ...srcRets].map((x) => [x.id, x.number]))

    const customerMap = new Map(customers.map((c) => [c.id, c.name]))
    const supplierMap = new Map(suppliers.map((s) => [s.id, s.name]))
    const numberMap = new Map<string, string>()
    for (const inv of salesInvoices) numberMap.set(inv.id, inv.number)
    for (const inv of purchaseInvoices) numberMap.set(inv.id, inv.number)
    for (const ret of [...srRows, ...prRows]) numberMap.set(ret.id, ret.number)

    const items = rows.map((r) => ({
      ...r,
      customer: r.customerId ? { name: customerMap.get(r.customerId) ?? null } : null,
      supplier: r.supplierId ? { name: supplierMap.get(r.supplierId) ?? null } : null,
      invoiceNumber: r.invoiceId ? numberMap.get(r.invoiceId) ?? null : null,
      accountName: r.accountId ? accountMap.get(r.accountId) ?? null : null,
      // ADVANCE | ADVANCE_APPLIED | CREDIT_APPLIED (return credit on another invoice) | REFUND | null (invoice payment / note)
      kind: r.invoiceType === ADVANCE ? 'ADVANCE' : r.mode === ADVANCE_ADJ ? 'ADVANCE_APPLIED' : r.allocatedFromId ? 'CREDIT_APPLIED'
        : r.invoiceType === SALES_RETURN || r.invoiceType === PURCHASE_RETURN ? 'REFUND' : null,
      sourceNumber: r.allocatedFromId ? sourceNumber.get(r.allocatedFromId) ?? null : null,
      ...(r.invoiceType === ADVANCE ? { applied: applied.get(r.id) || 0, remaining: r2(r.amount - (applied.get(r.id) || 0)) } : {}),
    }))
    return ok({ items, total: items.length })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/payments
// { companyId, type: 'RECEIPT'|'PAYMENT', customerId?|supplierId?, invoiceType: 'SALES'|'PURCHASE',
//   invoiceId, amount, mode?, date?, reference?, notes?, accountId?, chequeNo?, chequeDate?, userName? }
// Phase 4 (see src/lib/party-credits.ts):
//   invoiceType 'ADVANCE'         — RECEIPT from a customer before any invoice (no invoiceId; no post-dated cheque)
//   invoiceType 'SALES_RETURN'    — PAYMENT refunding a customer, invoiceId = the sales return (≤ its remaining credit)
//   invoiceType 'PURCHASE_RETURN' — RECEIPT of a refund from a supplier, invoiceId = the purchase return (≤ remaining)
// accountId defaults by mode (CASH → cash account, else default bank). A CHEQUE dated after today is
// post-dated: chequeStatus PENDING, not counted in account balances until it is CLEARED (PATCH .../[id]).
export async function POST(req: Request) {
  let idem: Idempotency | null = null
  try {
    requireWrite(req, 'payments')
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body.companyId)

    const type = body.type
    if (!['RECEIPT', 'PAYMENT'].includes(type)) throw new ApiError('type must be RECEIPT or PAYMENT', 400)
    const invoiceType = body.invoiceType ? String(body.invoiceType) : (type === 'RECEIPT' ? 'SALES' : 'PURCHASE')
    // Phase 5: the side of the business this money belongs to (customer / supplier) needs its own module too
    requireWrite(req, paymentKindModule({ type, invoiceType }))
    const override = negativeCashOverride(req, body)
    idem = await claimIdempotency(req, companyId, 'POST /api/payments', body)
    if (idem.replay) return idem.replay
    if ([ADVANCE, SALES_RETURN, PURCHASE_RETURN].includes(invoiceType)) return await advanceOrRefund(body, companyId, type, invoiceType, override, idem)
    if (type === 'RECEIPT' && invoiceType !== 'SALES') throw new ApiError('RECEIPT payments must reference a SALES invoice', 400)
    if (type === 'PAYMENT' && invoiceType !== 'PURCHASE') throw new ApiError('PAYMENT payments must reference a PURCHASE invoice', 400)
    if (!body.invoiceId) throw new ApiError('invoiceId is required', 400)
    // Credit / debit notes are created only by Sales / Purchase Returns (they also move stock)
    if (body.mode === 'CREDIT_NOTE' || body.mode === 'DEBIT_NOTE') throw new ApiError('Use Sales Return / Purchase Return to create credit or debit notes', 400)

    const amount = r2(Number(body.amount))
    if (!(amount > 0)) throw new ApiError('amount must be greater than 0', 400)

    const customerId = type === 'RECEIPT' ? body.customerId : null
    const supplierId = type === 'PAYMENT' ? body.supplierId : null
    const partyType = type === 'RECEIPT' ? 'CUSTOMER' : 'SUPPLIER'
    if (type === 'RECEIPT' && !customerId) throw new ApiError('customerId is required for RECEIPT', 400)
    if (type === 'PAYMENT' && !supplierId) throw new ApiError('supplierId is required for PAYMENT', 400)

    const date = businessDate(body.date)
    const mode = String(body.mode || 'NEFT')
    // Post-dated = cheque dated after today (IST calendar day)
    const cheque = chequeDetails(mode, body.chequeNo, body.chequeDate)
    const chequeStatus = cheque.chequeStatus
    const message = type === 'RECEIPT' ? 'Receipt recorded' : 'Payment recorded'

    await ensureCashFor(companyId, mode, body.accountId ? String(body.accountId) : null)
    const result = await db.$transaction(async (tx) => {
      const t = tx as any
      // Party validation (tenant scope)
      if (customerId) {
        const c = await tx.customer.findFirst({ where: { id: customerId, companyId } })
        if (!c) throw new ApiError('Customer not found', 404)
      }
      if (supplierId) {
        const s = await tx.supplier.findFirst({ where: { id: supplierId, companyId } })
        if (!s) throw new ApiError('Supplier not found', 404)
      }

      // Invoice load with tenant guard
      const invoice = invoiceType === 'SALES'
        ? await tx.salesInvoice.findFirst({ where: { id: body.invoiceId, companyId } })
        : await tx.purchaseInvoice.findFirst({ where: { id: body.invoiceId, companyId } })
      if (!invoice) throw new ApiError(invoiceType === 'SALES' ? 'Sales invoice not found' : 'Purchase invoice not found', 404)
      if (invoice.status === 'CANCELLED') throw new ApiError('Invoice is cancelled', 400)
      const invParty = invoiceType === 'SALES' ? (invoice as any).customerId : (invoice as any).supplierId
      if (invParty !== (customerId || supplierId)) {
        throw new ApiError(`Invoice ${invoice.number} belongs to a different ${invoiceType === 'SALES' ? 'customer' : 'supplier'}`, 400)
      }

      const outstanding = r2(invoice.grandTotal - invoice.paidAmount)
      if (amount > outstanding + 0.01) throw new ApiError(`Amount exceeds outstanding (₹${outstanding.toFixed(2)})`)
      await refuseDuplicatePayment(tx, companyId, { type, customerId, supplierId, amount, mode, date }, body.confirmDuplicate)

      const number = await nextDocNumber(t, companyId, type === 'RECEIPT' ? 'RCPT' : 'PYMT', date)
      const account = await postingAccount(tx, companyId, mode, body.accountId ? String(body.accountId) : null)
      assertOnOrAfterOpening(account, date, 'This payment')
      const accountId = account.id
      const payment = await tx.payment.create({
        data: {
          companyId,
          number,
          type,
          partyType,
          customerId: customerId || null,
          supplierId: supplierId || null,
          invoiceType,
          invoiceId: body.invoiceId,
          amount,
          mode,
          date,
          accountId,
          ...cheque,
          reference: body.reference ?? null,
          notes: body.notes ?? null,
        },
      })

      // Relative increment (locks the invoice row) — concurrent payments can't overwrite each other
      const invModel = invoiceType === 'SALES' ? t.salesInvoice : t.purchaseInvoice
      const inc = await invModel.updateMany({
        where: { id: invoice.id, status: { not: 'CANCELLED' } },
        data: { paidAmount: { increment: amount } },
      })
      if (inc.count !== 1) throw new ApiError('Invoice was just cancelled — refresh and try again', 409)
      const fresh = await invModel.findUniqueOrThrow({ where: { id: invoice.id } })
      const newPaid = r2(fresh.paidAmount)
      if (newPaid > r2(fresh.grandTotal) + 0.01) {
        throw new ApiError(`Amount exceeds outstanding (₹${r2(fresh.grandTotal - (newPaid - amount)).toFixed(2)})`, 400)
      }
      const newStatus = fresh.grandTotal - newPaid <= 0.01 ? 'PAID' : 'PARTIALLY_PAID'
      await invModel.update({ where: { id: invoice.id }, data: { status: newStatus } })

      await logAudit(t, {
        companyId, userName: body.userName, action: 'CREATE', entity: 'Payment', entityId: payment.id,
        details: `${type === 'RECEIPT' ? 'Receipt' : 'Payment'} ${number} • ₹${amount.toFixed(2)} ${type === 'RECEIPT' ? 'against' : 'towards'} ${invoice.number} (${invoiceType})${chequeStatus ? ' — post-dated cheque' : ''}`,
      })
      if (type === 'PAYMENT') {
        await assertCashNotNegative(tx, { companyId, accounts: [{ accountId }], from: date, override, what: `Payment ${number}`, entity: 'Payment', entityId: payment.id, userName: body.userName })
      }

      const out = {
        ...payment,
        invoiceNumber: invoice.number,
        invoiceStatus: newStatus,
        outstandingAfter: r2(fresh.grandTotal - newPaid),
      }
      await idem!.done(tx, out, message)
      return out
    }, CASH_TX)

    void emitEvent({ companyId, title: 'Payment recorded', message: `${type} ₹${amount.toFixed(2)} — ${partyType}`, topic: 'finance' })

    return ok(result, message)
  } catch (e) {
    await idem?.release()
    return handleError(e)
  }
}

/**
 * Customer advance (money in, no invoice — a liability until applied) or a return refund (customer refund out /
 * supplier refund in, against the return's remaining credit). The return row is locked first, so concurrent
 * refunds cannot both pass the remaining check; post-dated cheques are refused for advances.
 */
async function advanceOrRefund(body: any, companyId: string, type: string, invoiceType: string, override: CashOverride, idem: Idempotency) {
  if (body.mode === 'CREDIT_NOTE' || body.mode === 'DEBIT_NOTE' || body.mode === 'ADVANCE_ADJ') throw new ApiError('Choose a payment mode (cash, bank, UPI, cheque…)', 400)
  const amount = r2(Number(body.amount))
  if (!(amount > 0)) throw new ApiError('amount must be greater than 0', 400)
  const date = businessDate(body.date)
  const mode = String(body.mode || 'CASH')
  const cheque = chequeDetails(mode, body.chequeNo, body.chequeDate)

  const isAdvance = invoiceType === ADVANCE
  const isSalesRefund = invoiceType === SALES_RETURN
  if (isAdvance && type !== 'RECEIPT') throw new ApiError('An advance is money received from a customer (type RECEIPT)', 400)
  if (isSalesRefund && type !== 'PAYMENT') throw new ApiError('A refund to a customer is money paid out (type PAYMENT)', 400)
  if (invoiceType === PURCHASE_RETURN && type !== 'RECEIPT') throw new ApiError('A refund from a supplier is money received (type RECEIPT)', 400)
  if (isAdvance && cheque.chequeStatus) throw new ApiError('A post-dated cheque cannot be taken as an advance — record it when the cheque date arrives', 400)
  if (isAdvance && body.invoiceId) throw new ApiError('An advance is received before any invoice — leave the invoice empty', 400)
  if (!isAdvance && !body.invoiceId) throw new ApiError('invoiceId (the return) is required for a refund', 400)
  const message = isAdvance ? 'Advance recorded' : 'Refund recorded'

  await ensureCashFor(companyId, mode, body.accountId ? String(body.accountId) : null)
  const result = await db.$transaction(async (tx) => {
    const t = tx as any
    let customerId: string | null = null
    let supplierId: string | null = null
    let against = ''
    if (isAdvance) {
      const c = body.customerId ? await tx.customer.findFirst({ where: { id: String(body.customerId), companyId } }) : null
      if (!c) throw new ApiError(body.customerId ? 'Customer not found' : 'customerId is required for an advance', body.customerId ? 404 : 400)
      customerId = c.id
      against = 'advance'
    } else if (isSalesRefund) {
      // Lock the return, then check what is still owed to the customer
      const lock = await tx.salesReturn.updateMany({ where: { id: String(body.invoiceId), companyId, status: 'POSTED' }, data: { updatedAt: new Date() } })
      const ret = await tx.salesReturn.findFirst({ where: { id: String(body.invoiceId), companyId } })
      if (!ret) throw new ApiError('Sales return not found', 404)
      if (lock.count !== 1) throw new ApiError(`Sales return ${ret.number} is cancelled`, 400)
      if (body.customerId && String(body.customerId) !== ret.customerId) throw new ApiError(`Sales return ${ret.number} belongs to a different customer`, 400)
      const credit = (await salesReturnCredits(tx, companyId, [ret])).get(ret.id)!
      if (amount > credit.remaining + 0.005) throw new ApiError(`Refund exceeds the credit left on ${ret.number} (₹${credit.remaining.toFixed(2)})`, 400)
      customerId = ret.customerId
      against = `refund on credit note ${ret.number}`
    } else {
      const lock = await tx.purchaseReturn.updateMany({ where: { id: String(body.invoiceId), companyId, status: 'POSTED' }, data: { updatedAt: new Date() } })
      const ret = await tx.purchaseReturn.findFirst({ where: { id: String(body.invoiceId), companyId } })
      if (!ret) throw new ApiError('Purchase return not found', 404)
      if (lock.count !== 1) throw new ApiError(`Purchase return ${ret.number} is cancelled`, 400)
      if (body.supplierId && String(body.supplierId) !== ret.supplierId) throw new ApiError(`Purchase return ${ret.number} belongs to a different supplier`, 400)
      const due = (await purchaseReturnRefunds(tx, companyId, [ret])).get(ret.id)!
      if (amount > due.remaining + 0.005) throw new ApiError(`Refund exceeds what is still due on ${ret.number} (₹${due.remaining.toFixed(2)})`, 400)
      supplierId = ret.supplierId
      against = `refund on debit note ${ret.number}`
    }

    const account = await postingAccount(tx, companyId, mode, body.accountId ? String(body.accountId) : null)
    assertOnOrAfterOpening(account, date, isAdvance ? 'This advance' : 'This refund')
    await refuseDuplicatePayment(tx, companyId, { type, customerId, supplierId, amount, mode, date }, body.confirmDuplicate)
    const number = await nextDocNumber(t, companyId, type === 'RECEIPT' ? 'RCPT' : 'PYMT', date)
    const payment = await tx.payment.create({
      data: {
        companyId, number, type, partyType: customerId ? 'CUSTOMER' : 'SUPPLIER', customerId, supplierId,
        invoiceType, invoiceId: isAdvance ? null : String(body.invoiceId), amount, mode, date, accountId: account.id,
        ...cheque, reference: body.reference ?? null, notes: body.notes ?? null,
      },
    })
    await logAudit(t, {
      companyId, userName: body.userName, action: 'CREATE', entity: 'Payment', entityId: payment.id,
      details: `${type === 'RECEIPT' ? 'Receipt' : 'Payment'} ${number} • ₹${amount.toFixed(2)} ${against} (${mode})${cheque.chequeStatus ? ' — post-dated cheque' : ''}`,
    })
    if (type === 'PAYMENT') {
      await assertCashNotNegative(tx, { companyId, accounts: [{ accountId: account.id }], from: date, override, what: `Refund ${number}`, entity: 'Payment', entityId: payment.id, userName: body.userName })
    }
    await idem.done(tx, payment, message)
    return payment
  }, CASH_TX)
  void emitEvent({ companyId, title: isAdvance ? 'Advance received' : 'Refund recorded', message: `${type} ₹${amount.toFixed(2)}`, topic: 'finance' })
  return ok(result, message)
}

/**
 * Phase 5 duplicate warning: a payment of the same kind (in / out) to the same party, same amount and mode on the
 * same IST day → 409 POSSIBLE_DUPLICATE unless `confirmDuplicate: true`.
 */
async function refuseDuplicatePayment(tx: { payment: typeof db.payment }, companyId: string, p: { type: string; customerId: string | null; supplierId: string | null; amount: number; mode: string; date: Date }, confirmed: unknown) {
  if (confirmed === true) return
  const rows = await tx.payment.findMany({
    where: {
      companyId, type: p.type, mode: p.mode, amount: { gte: p.amount - 0.005, lte: p.amount + 0.005 }, date: dayWindow(p.date),
      ...(p.customerId ? { customerId: p.customerId } : { supplierId: p.supplierId }),
    },
    select: { number: true, date: true }, orderBy: { number: 'asc' }, take: 20,
  })
  refuseDuplicate(rows.filter((r) => sameIstDay(r.date, p.date)).map((r) => r.number), confirmed, 'party, amount and mode')
}
