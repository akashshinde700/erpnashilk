'use client'

import * as React from 'react'
import { FileText, Loader2, MessageCircle, Pencil, Phone, Receipt, ShoppingCart, Truck, Wallet, ClipboardList, PackageCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { DateCell, Money, StatusBadge, openCreate } from '@/components/erp/kit'
import { apiGet } from '@/lib/use-api'
import { cn } from '@/lib/utils'
import { gstTypeLabel } from '@/components/erp/party-form'
import type { PartyKind, PartyRecord } from '@/components/erp/party-form'

// ---------- API shape (/api/parties/[kind]/[id]) ----------

interface Summary {
  billed: number; received?: number; paid?: number; openingBalance: number; outstanding: number
  overdue: number; overdueCount: number; openOrders: number; openOrderValue: number; creditLimit: number; lastActivity: string | null
}
interface Inv { id: string; number: string; date: string; dueDate: string | null; status: string; grandTotal: number; paidAmount: number; outstanding: number; overdueDays: number; salesOrder?: string | null; supplierInvNo?: string | null }
interface Pay { id: string; number: string; date: string; amount: number; mode: string; reference: string | null; invoice: string | null }
interface CustomerSide {
  party: PartyRecord; summary: Summary
  enquiries: { id: string; number: string; date: string; status: string }[]
  quotations: { id: string; number: string; date: string; validUntil: string | null; status: string; grandTotal: number }[]
  orders: { id: string; number: string; orderDate: string; deliveryDate: string | null; status: string; grandTotal: number; dispatchedPct: number; invoicedPct: number; workOrders: string[] }[]
  workOrders: { id: string; number: string; status: string; plannedQty: number; producedQty: number; startDate: string; dueDate: string | null; salesOrder: string | null; item: { code: string; name: string } | null }[]
  deliveries: { id: string; number: string; date: string; status: string; vehicleNo: string | null; salesOrder: string | null }[]
  invoices: Inv[]; payments: Pay[]
}
interface SupplierSide {
  party: PartyRecord; summary: Summary
  orders: { id: string; number: string; orderDate: string; expectedDate: string | null; status: string; grandTotal: number }[]
  grns: { id: string; number: string; date: string; status: string; po: string | null }[]
  invoices: Inv[]; payments: Pay[]
}
interface Overview { kind: PartyKind; asCustomer: CustomerSide | null; asSupplier: SupplierSide | null }

/** Open a document in its module and highlight the row. */
function openDoc(module: string, id: string) {
  try { sessionStorage.setItem('erp_deep_link', JSON.stringify({ module, id, ts: Date.now() })) } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent('erp:deep-link', { detail: { module, id } }))
  window.dispatchEvent(new CustomEvent('erp:goto', { detail: module }))
}

function Kpi({ label, value, tone, hint }: { label: string; value: React.ReactNode; tone?: 'red' | 'amber' | 'green'; hint?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={cn('mt-0.5 text-lg font-semibold tabular-nums', tone === 'red' && 'text-destructive', tone === 'amber' && 'text-warning', tone === 'green' && 'text-success')}>{value}</p>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">{text}</p>
}

function Progress({ pct }: { pct: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted"><div className="h-full bg-success" style={{ width: `${pct}%` }} /></div>
      <span className="text-xs tabular-nums text-muted-foreground">{pct}%</span>
    </div>
  )
}

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

type TimelineRow = { date: string; type: string; ref: string; text: string; amount?: number; status?: string; module: string; id: string }

// ---------- Customer side ----------

function CustomerPanel({ d, close }: { d: CustomerSide; close: () => void }) {
  const s = d.summary
  const go = (module: string, data: Record<string, string | number | undefined>) => { close(); openCreate(module, data) }
  const open = (module: string, id: string) => { close(); openDoc(module, id) }
  const timeline: TimelineRow[] = [
    ...d.enquiries.map((x) => ({ date: x.date, type: 'Enquiry', ref: x.number, text: 'Enquiry received', status: x.status, module: 'enquiries', id: x.id })),
    ...d.quotations.map((x) => ({ date: x.date, type: 'Quotation', ref: x.number, text: 'Quotation sent', amount: x.grandTotal, status: x.status, module: 'quotations', id: x.id })),
    ...d.orders.map((x) => ({ date: x.orderDate, type: 'Sales Order', ref: x.number, text: `Order${x.workOrders.length ? ` · production ${x.workOrders.join(', ')}` : ''}`, amount: x.grandTotal, status: x.status, module: 'sales-orders', id: x.id })),
    ...d.deliveries.map((x) => ({ date: x.date, type: 'Delivery', ref: x.number, text: `Dispatch${x.salesOrder ? ` for ${x.salesOrder}` : ''}${x.vehicleNo ? ` · ${x.vehicleNo}` : ''}`, status: x.status, module: 'deliveries', id: x.id })),
    ...d.invoices.map((x) => ({ date: x.date, type: 'Invoice', ref: x.number, text: x.outstanding > 0 ? `Due ${inr(x.outstanding)}` : 'Settled', amount: x.grandTotal, status: x.status, module: 'sales-invoices', id: x.id })),
    ...d.payments.map((x) => ({ date: x.date, type: 'Receipt', ref: x.number, text: `${x.mode}${x.invoice ? ` against ${x.invoice}` : ''}`, amount: x.amount, module: 'payments', id: x.id })),
  ].sort((a, b) => +new Date(b.date) - +new Date(a.date))
  const nextDue = d.invoices.filter((i) => i.outstanding > 0 && i.status !== 'CANCELLED').sort((a, b) => +new Date(a.dueDate || a.date) - +new Date(b.dueDate || b.date))[0]
  const creditUsed = s.creditLimit > 0 ? Math.round((s.outstanding / s.creditLimit) * 100) : null

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => go('quotations', { customerId: d.party.id })}><FileText className="mr-1.5 h-4 w-4" />Quotation</Button>
        <Button size="sm" variant="outline" onClick={() => go('sales-orders', { customerId: d.party.id })}><ShoppingCart className="mr-1.5 h-4 w-4" />Sales Order</Button>
        <Button size="sm" variant="outline" onClick={() => go('sales-invoices', { customerId: d.party.id })}><Receipt className="mr-1.5 h-4 w-4" />Invoice</Button>
        <Button size="sm" onClick={() => go('payments', { type: 'RECEIPT', partyId: d.party.id, ...(nextDue ? { invoiceId: nextDue.id, amount: nextDue.outstanding } : {}) })}>
          <Wallet className="mr-1.5 h-4 w-4" />Receive Payment
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Kpi label="Total billed" value={inr(s.billed)} />
        <Kpi label="Received" value={inr(s.received || 0)} tone="green" />
        <Kpi label="Outstanding" value={inr(s.outstanding)} tone={s.outstanding > 0 ? 'amber' : undefined}
          hint={s.openingBalance ? `incl. opening ${inr(s.openingBalance)}` : creditUsed !== null ? `${creditUsed}% of credit limit` : undefined} />
        <Kpi label="Overdue" value={inr(s.overdue)} tone={s.overdue > 0 ? 'red' : undefined} hint={s.overdueCount ? `${s.overdueCount} invoice(s)` : 'Nothing overdue'} />
        <Kpi label="Open orders" value={s.openOrders} hint={s.openOrders ? inr(s.openOrderValue) : undefined} />
      </div>

      <Tabs defaultValue="timeline" className="gap-3">
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="orders">Orders &amp; Production ({d.orders.length})</TabsTrigger>
          <TabsTrigger value="invoices">Invoices ({d.invoices.length})</TabsTrigger>
          <TabsTrigger value="payments">Payments ({d.payments.length})</TabsTrigger>
          <TabsTrigger value="quotes">Quotes ({d.quotations.length + d.enquiries.length})</TabsTrigger>
          <TabsTrigger value="deliveries">Deliveries ({d.deliveries.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="timeline"><TimelineTable rows={timeline} open={open} /></TabsContent>

        <TabsContent value="orders" className="grid gap-4">
          {d.orders.length === 0 ? <Empty text="No sales orders yet" /> : (
            <Table>
              <TableHeader><TableRow><TableHead>Order</TableHead><TableHead>Date</TableHead><TableHead>Status</TableHead><TableHead>Dispatched</TableHead><TableHead>Invoiced</TableHead><TableHead className="text-right">Value</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {d.orders.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell><button className="font-medium hover:underline" onClick={() => open('sales-orders', o.id)}>{o.number}</button>{o.workOrders.length > 0 && <p className="text-[11px] text-muted-foreground">Production: {o.workOrders.join(', ')}</p>}</TableCell>
                    <TableCell><DateCell value={o.orderDate} /></TableCell>
                    <TableCell><StatusBadge status={o.status} /></TableCell>
                    <TableCell><Progress pct={o.dispatchedPct} /></TableCell>
                    <TableCell><Progress pct={o.invoicedPct} /></TableCell>
                    <TableCell className="text-right"><Money value={o.grandTotal} /></TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTIALLY_DISPATCHED'].includes(o.status) && o.dispatchedPct < 100 && (
                        <Button size="sm" variant="ghost" className="h-7" onClick={() => go('deliveries', { soId: o.id })}><Truck className="mr-1 h-3.5 w-3.5" />Dispatch</Button>
                      )}
                      {o.invoicedPct < 100 && o.status !== 'DRAFT' && o.status !== 'CANCELLED' && (
                        <Button size="sm" variant="ghost" className="h-7" onClick={() => go('sales-invoices', { soId: o.id })}><Receipt className="mr-1 h-3.5 w-3.5" />Invoice</Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {d.workOrders.length > 0 && (
            <div>
              <p className="mb-2 text-sm font-medium">Production jobs for this customer</p>
              <Table>
                <TableHeader><TableRow><TableHead>Work order</TableHead><TableHead>Item</TableHead><TableHead>For order</TableHead><TableHead>Status</TableHead><TableHead>Progress</TableHead><TableHead>Due</TableHead></TableRow></TableHeader>
                <TableBody>
                  {d.workOrders.map((w) => (
                    <TableRow key={w.id}>
                      <TableCell><button className="font-medium hover:underline" onClick={() => open('work-orders', w.id)}>{w.number}</button></TableCell>
                      <TableCell className="text-sm">{w.item ? `${w.item.code} — ${w.item.name}` : '—'}</TableCell>
                      <TableCell className="text-sm">{w.salesOrder || '—'}</TableCell>
                      <TableCell><StatusBadge status={w.status} /></TableCell>
                      <TableCell><Progress pct={w.plannedQty ? Math.min(100, Math.round((w.producedQty / w.plannedQty) * 100)) : 0} /></TableCell>
                      <TableCell><DateCell value={w.dueDate} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="invoices">
          <InvoiceTable rows={d.invoices} open={(id) => open('sales-invoices', id)}
            pay={(i) => go('payments', { type: 'RECEIPT', partyId: d.party.id, invoiceId: i.id, amount: i.outstanding })} />
        </TabsContent>
        <TabsContent value="payments"><PaymentTable rows={d.payments} open={(id) => open('payments', id)} /></TabsContent>

        <TabsContent value="quotes">
          {d.quotations.length + d.enquiries.length === 0 ? <Empty text="No enquiries or quotations yet" /> : (
            <Table>
              <TableHeader><TableRow><TableHead>Document</TableHead><TableHead>Date</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Value</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {d.quotations.map((q) => (
                  <TableRow key={q.id}>
                    <TableCell><button className="font-medium hover:underline" onClick={() => open('quotations', q.id)}>{q.number}</button><p className="text-[11px] text-muted-foreground">Quotation{q.validUntil ? ` · valid till ${new Date(q.validUntil).toLocaleDateString('en-IN')}` : ''}</p></TableCell>
                    <TableCell><DateCell value={q.date} /></TableCell>
                    <TableCell><StatusBadge status={q.status} /></TableCell>
                    <TableCell className="text-right"><Money value={q.grandTotal} /></TableCell>
                    <TableCell className="text-right">
                      {['SENT', 'APPROVED'].includes(q.status) && <Button size="sm" variant="ghost" className="h-7" onClick={() => go('sales-orders', { quotationId: q.id })}>Make order</Button>}
                    </TableCell>
                  </TableRow>
                ))}
                {d.enquiries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell><button className="font-medium hover:underline" onClick={() => open('enquiries', e.id)}>{e.number}</button><p className="text-[11px] text-muted-foreground">Enquiry</p></TableCell>
                    <TableCell><DateCell value={e.date} /></TableCell>
                    <TableCell><StatusBadge status={e.status} /></TableCell>
                    <TableCell />
                    <TableCell className="text-right">
                      {e.status === 'OPEN' && <Button size="sm" variant="ghost" className="h-7" onClick={() => go('quotations', { customerId: d.party.id, enquiryId: e.id })}>Quote</Button>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>

        <TabsContent value="deliveries">
          {d.deliveries.length === 0 ? <Empty text="No deliveries yet" /> : (
            <Table>
              <TableHeader><TableRow><TableHead>Challan</TableHead><TableHead>Date</TableHead><TableHead>Order</TableHead><TableHead>Vehicle</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
              <TableBody>
                {d.deliveries.map((x) => (
                  <TableRow key={x.id}>
                    <TableCell><button className="font-medium hover:underline" onClick={() => open('deliveries', x.id)}>{x.number}</button></TableCell>
                    <TableCell><DateCell value={x.date} /></TableCell>
                    <TableCell className="text-sm">{x.salesOrder || '—'}</TableCell>
                    <TableCell className="text-sm">{x.vehicleNo || '—'}</TableCell>
                    <TableCell><StatusBadge status={x.status} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ---------- Supplier side ----------

function SupplierPanel({ d, close }: { d: SupplierSide; close: () => void }) {
  const s = d.summary
  const go = (module: string, data: Record<string, string | number | undefined>) => { close(); openCreate(module, data) }
  const open = (module: string, id: string) => { close(); openDoc(module, id) }
  const timeline: TimelineRow[] = [
    ...d.orders.map((x) => ({ date: x.orderDate, type: 'Purchase Order', ref: x.number, text: 'Order placed', amount: x.grandTotal, status: x.status, module: 'purchase-orders', id: x.id })),
    ...d.grns.map((x) => ({ date: x.date, type: 'GRN', ref: x.number, text: `Goods received${x.po ? ` against ${x.po}` : ''}`, status: x.status, module: 'grns', id: x.id })),
    ...d.invoices.map((x) => ({ date: x.date, type: 'Bill', ref: x.number, text: x.outstanding > 0 ? `Payable ${inr(x.outstanding)}` : 'Settled', amount: x.grandTotal, status: x.status, module: 'purchase-invoices', id: x.id })),
    ...d.payments.map((x) => ({ date: x.date, type: 'Payment', ref: x.number, text: `${x.mode}${x.invoice ? ` against ${x.invoice}` : ''}`, amount: x.amount, module: 'payments', id: x.id })),
  ].sort((a, b) => +new Date(b.date) - +new Date(a.date))
  const nextDue = d.invoices.filter((i) => i.outstanding > 0 && i.status !== 'CANCELLED').sort((a, b) => +new Date(a.dueDate || a.date) - +new Date(b.dueDate || b.date))[0]

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => go('purchase-orders', { supplierId: d.party.id })}><ShoppingCart className="mr-1.5 h-4 w-4" />Purchase Order</Button>
        <Button size="sm" onClick={() => go('payments', { type: 'PAYMENT', partyId: d.party.id, ...(nextDue ? { invoiceId: nextDue.id, amount: nextDue.outstanding } : {}) })}>
          <Wallet className="mr-1.5 h-4 w-4" />Make Payment
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Kpi label="Total purchases" value={inr(s.billed)} />
        <Kpi label="Paid" value={inr(s.paid || 0)} tone="green" />
        <Kpi label="Payable" value={inr(s.outstanding)} tone={s.outstanding > 0 ? 'amber' : undefined} hint={s.openingBalance ? `incl. opening ${inr(s.openingBalance)}` : undefined} />
        <Kpi label="Overdue" value={inr(s.overdue)} tone={s.overdue > 0 ? 'red' : undefined} hint={s.overdueCount ? `${s.overdueCount} bill(s)` : 'Nothing overdue'} />
        <Kpi label="Open POs" value={s.openOrders} hint={s.openOrders ? inr(s.openOrderValue) : undefined} />
      </div>
      <Tabs defaultValue="timeline" className="gap-3">
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="orders">Purchase Orders ({d.orders.length})</TabsTrigger>
          <TabsTrigger value="grns">GRNs ({d.grns.length})</TabsTrigger>
          <TabsTrigger value="invoices">Bills ({d.invoices.length})</TabsTrigger>
          <TabsTrigger value="payments">Payments ({d.payments.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="timeline"><TimelineTable rows={timeline} open={open} /></TabsContent>
        <TabsContent value="orders">
          {d.orders.length === 0 ? <Empty text="No purchase orders yet" /> : (
            <Table>
              <TableHeader><TableRow><TableHead>PO</TableHead><TableHead>Date</TableHead><TableHead>Expected</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Value</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {d.orders.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell><button className="font-medium hover:underline" onClick={() => open('purchase-orders', o.id)}>{o.number}</button></TableCell>
                    <TableCell><DateCell value={o.orderDate} /></TableCell>
                    <TableCell><DateCell value={o.expectedDate} /></TableCell>
                    <TableCell><StatusBadge status={o.status} /></TableCell>
                    <TableCell className="text-right"><Money value={o.grandTotal} /></TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {['APPROVED', 'PARTIALLY_RECEIVED'].includes(o.status) && <Button size="sm" variant="ghost" className="h-7" onClick={() => go('grns', { poId: o.id })}><PackageCheck className="mr-1 h-3.5 w-3.5" />Receive</Button>}
                      {['PARTIALLY_RECEIVED', 'RECEIVED'].includes(o.status) && <Button size="sm" variant="ghost" className="h-7" onClick={() => go('purchase-invoices', { poId: o.id })}><Receipt className="mr-1 h-3.5 w-3.5" />Bill</Button>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>
        <TabsContent value="grns">
          {d.grns.length === 0 ? <Empty text="No goods received yet" /> : (
            <Table>
              <TableHeader><TableRow><TableHead>GRN</TableHead><TableHead>Date</TableHead><TableHead>PO</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
              <TableBody>
                {d.grns.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell><button className="font-medium hover:underline" onClick={() => open('grns', g.id)}>{g.number}</button></TableCell>
                    <TableCell><DateCell value={g.date} /></TableCell>
                    <TableCell className="text-sm">{g.po || '—'}</TableCell>
                    <TableCell><StatusBadge status={g.status} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>
        <TabsContent value="invoices">
          <InvoiceTable rows={d.invoices} open={(id) => open('purchase-invoices', id)}
            pay={(i) => go('payments', { type: 'PAYMENT', partyId: d.party.id, invoiceId: i.id, amount: i.outstanding })} payLabel="Pay" />
        </TabsContent>
        <TabsContent value="payments"><PaymentTable rows={d.payments} open={(id) => open('payments', id)} /></TabsContent>
      </Tabs>
    </div>
  )
}

// ---------- shared tables ----------

function TimelineTable({ rows, open }: { rows: TimelineRow[]; open: (module: string, id: string) => void }) {
  if (!rows.length) return <Empty text="No activity yet" />
  return (
    <div className="max-h-[420px] overflow-y-auto rounded-lg border">
      <Table>
        <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Type</TableHead><TableHead>Document</TableHead><TableHead>Details</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Amount</TableHead></TableRow></TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={`${r.module}-${r.id}`}>
              <TableCell><DateCell value={r.date} /></TableCell>
              <TableCell className="text-xs text-muted-foreground">{r.type}</TableCell>
              <TableCell><button className="font-medium hover:underline" onClick={() => open(r.module, r.id)}>{r.ref}</button></TableCell>
              <TableCell className="max-w-64 truncate text-sm">{r.text}</TableCell>
              <TableCell>{r.status ? <StatusBadge status={r.status} /> : null}</TableCell>
              <TableCell className="text-right">{r.amount !== undefined ? <Money value={r.amount} /> : null}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function InvoiceTable({ rows, open, pay, payLabel = 'Receive' }: { rows: Inv[]; open: (id: string) => void; pay: (i: Inv) => void; payLabel?: string }) {
  if (!rows.length) return <Empty text="No invoices yet" />
  return (
    <Table>
      <TableHeader><TableRow><TableHead>Invoice</TableHead><TableHead>Date</TableHead><TableHead>Due</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Total</TableHead><TableHead className="text-right">Paid</TableHead><TableHead className="text-right">Pending</TableHead><TableHead /></TableRow></TableHeader>
      <TableBody>
        {rows.map((i) => (
          <TableRow key={i.id}>
            <TableCell>
              <button className="font-medium hover:underline" onClick={() => open(i.id)}>{i.number}</button>
              {(i.salesOrder || i.supplierInvNo) && <p className="text-[11px] text-muted-foreground">{i.salesOrder ? `SO ${i.salesOrder}` : `Bill ${i.supplierInvNo}`}</p>}
            </TableCell>
            <TableCell><DateCell value={i.date} /></TableCell>
            <TableCell>
              <DateCell value={i.dueDate} />
              {i.overdueDays > 0 && <p className="text-[11px] font-medium text-destructive">{i.overdueDays} days overdue</p>}
            </TableCell>
            <TableCell><StatusBadge status={i.status} /></TableCell>
            <TableCell className="text-right"><Money value={i.grandTotal} /></TableCell>
            <TableCell className="text-right"><Money value={i.paidAmount} /></TableCell>
            <TableCell className={cn('text-right font-medium', i.outstanding > 0 && 'text-warning')}><Money value={i.outstanding} /></TableCell>
            <TableCell className="text-right">
              {i.outstanding > 0 && i.status !== 'CANCELLED' && <Button size="sm" variant="ghost" className="h-7" onClick={() => pay(i)}><Wallet className="mr-1 h-3.5 w-3.5" />{payLabel}</Button>}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function PaymentTable({ rows, open }: { rows: Pay[]; open: (id: string) => void }) {
  if (!rows.length) return <Empty text="No payments yet" />
  return (
    <Table>
      <TableHeader><TableRow><TableHead>Payment</TableHead><TableHead>Date</TableHead><TableHead>Mode</TableHead><TableHead>Against</TableHead><TableHead>Reference</TableHead><TableHead className="text-right">Amount</TableHead></TableRow></TableHeader>
      <TableBody>
        {rows.map((p) => (
          <TableRow key={p.id}>
            <TableCell><button className="font-medium hover:underline" onClick={() => open(p.id)}>{p.number}</button></TableCell>
            <TableCell><DateCell value={p.date} /></TableCell>
            <TableCell className="text-sm">{p.mode}</TableCell>
            <TableCell className="text-sm">{p.invoice || 'On account'}</TableCell>
            <TableCell className="text-sm">{p.reference || '—'}</TableCell>
            <TableCell className="text-right"><Money value={p.amount} /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

// ---------- dialog ----------

/** Party 360: everything about one customer / supplier (both sides for a "Both" party). */
export function PartyViewDialog({ open, onOpenChange, kind, id, onEdit }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  kind: PartyKind
  id: string | null
  onEdit?: () => void
}) {
  const [data, setData] = React.useState<Overview | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [side, setSide] = React.useState<PartyKind>(kind)

  React.useEffect(() => {
    if (!open || !id) return
    setData(null); setError(null); setSide(kind)
    apiGet<Overview>(`/api/parties/${kind}/${id}`).then(setData).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
  }, [open, id, kind])

  const close = () => onOpenChange(false)
  const party = data ? (data.asCustomer?.party ?? data.asSupplier?.party) : null
  const both = !!(data?.asCustomer && data?.asSupplier)
  const phone = party?.phone ? party.phone.replace(/\D/g, '') : ''
  const outstanding = data?.asCustomer?.summary.outstanding ?? 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {party?.name ?? 'Party'}
            {party && <span className="text-sm font-normal text-muted-foreground">{party.code}</span>}
            {both && <span className="rounded bg-info-soft px-1.5 py-0.5 text-[10px] font-medium text-info">Customer + Supplier</span>}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              {party?.gstin && <span>GSTIN <span className="font-mono">{party.gstin}</span></span>}
              {party?.gstType && gstTypeLabel(party.gstType) && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{gstTypeLabel(party.gstType)}</span>
              )}
              {party?.contactPerson && <span>{party.contactPerson}</span>}
              {party?.city && <span>{[party.city, party.state].filter(Boolean).join(', ')}</span>}
              {party?.email && <a className="hover:underline" href={`mailto:${party.email}`}>{party.email}</a>}
              {phone && <a className="inline-flex items-center gap-1 hover:underline" href={`tel:${phone}`}><Phone className="h-3 w-3" />{party?.phone}</a>}
              {phone && outstanding > 0 && (
                <a className="inline-flex items-center gap-1 text-success hover:underline" target="_blank" rel="noopener noreferrer"
                  href={`https://wa.me/91${phone.slice(-10)}?text=${encodeURIComponent(`Namaste ${party?.contactPerson || party?.name}, a gentle reminder that ₹${outstanding.toLocaleString('en-IN')} is outstanding on your account. Kindly arrange payment. Thank you.`)}`}>
                  <MessageCircle className="h-3 w-3" />WhatsApp reminder
                </a>
              )}
              {onEdit && <button className="inline-flex items-center gap-1 hover:underline" onClick={() => { close(); onEdit() }}><Pencil className="h-3 w-3" />Edit details</button>}
            </div>
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-sm text-destructive">{error}</p>}
        {!data && !error && <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}

        {data && both && (
          <div className="inline-flex w-fit rounded-lg border p-0.5 text-sm">
            {(['customer', 'supplier'] as const).map((k) => (
              <button key={k} onClick={() => setSide(k)}
                className={cn('rounded-md px-3 py-1', side === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}>
                {k === 'customer' ? <><ClipboardList className="mr-1 inline h-3.5 w-3.5" />As customer</> : <><Truck className="mr-1 inline h-3.5 w-3.5" />As supplier</>}
              </button>
            ))}
          </div>
        )}
        {data && (side === 'customer' || !data.asSupplier) && data.asCustomer && <CustomerPanel d={data.asCustomer} close={close} />}
        {data && (side === 'supplier' || !data.asCustomer) && data.asSupplier && <SupplierPanel d={data.asSupplier} close={close} />}
      </DialogContent>
    </Dialog>
  )
}
