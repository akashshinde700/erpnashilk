'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Minus, Plus, ReceiptText, Search, ShoppingBag, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageHeader, SelectInput } from '@/components/erp/kit'
import { PAYMENT_MODES, fmtMoney } from '@/lib/erp-constants'
import { apiPost, useList } from '@/lib/use-api'

/**
 * POS — counter billing, the "walk-in customer" mode of the ERP.
 *
 * Tap items on the left, take the money on the right, one press to charge. Each sale is an
 * ordinary cash-sale sales invoice (`isCashSale`), so stock, the day book, GST and Tally all see
 * it exactly like an invoice raised from the Sales screen — the POS is a faster front door, not a
 * second set of books. Walk-in customers are billed to the company's `CASH` ledger + CGST/SGST.
 */

interface PosItem {
  id: string
  code?: string | null
  name?: string | null
  sellingPrice?: number | null
  gstRate?: number | null
  uom?: string | null
  onHand?: number | null
  type?: string | null
  barcode?: string | null
}

interface CartLine {
  itemId: string
  name: string
  qty: number
  rate: number
  gstRate: number
}

const r2 = (n: number) => Math.round(n * 100) / 100

const cartTotals = (lines: CartLine[]) => {
  const taxable = lines.reduce((s, l) => s + l.qty * l.rate, 0)
  const tax = lines.reduce((s, l) => s + (l.qty * l.rate * (l.gstRate || 0)) / 100, 0)
  return { taxable: r2(taxable), tax: r2(tax), total: r2(taxable + tax) }
}

export default function PosModule({ companyId }: { companyId: string }) {
  const items = useList<{ items: PosItem[] }>(`/api/items?companyId=${companyId}&pageSize=0`)
  const all = items.data?.items ?? []

  const [q, setQ] = React.useState('')
  const [cart, setCart] = React.useState<CartLine[]>([])
  const [mode, setMode] = React.useState('CASH')
  const [tendered, setTendered] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [last, setLast] = React.useState<{ number: string; total: number; change: number } | null>(null)
  const searchRef = React.useRef<HTMLInputElement>(null)

  const needle = q.trim().toLowerCase()
  const shown = (needle
    ? all.filter((i) => `${i.code ?? ''} ${i.name ?? ''} ${i.barcode ?? ''}`.toLowerCase().includes(needle))
    : all
  ).slice(0, 60)

  const totals = cartTotals(cart)

  function add(item: PosItem) {
    setCart((c) => {
      const found = c.find((l) => l.itemId === item.id)
      if (found) return c.map((l) => (l.itemId === item.id ? { ...l, qty: r2(l.qty + 1) } : l))
      return [...c, { itemId: item.id, name: `${item.code ? `${item.code} — ` : ''}${item.name ?? ''}`, qty: 1, rate: Number(item.sellingPrice) || 0, gstRate: Number(item.gstRate) || 0 }]
    })
    setQ('')
    setLast(null)
    searchRef.current?.focus()
  }

  function setQty(itemId: string, qty: number) {
    setCart((c) => c.flatMap((l) => (l.itemId !== itemId ? [l] : qty <= 0 ? [] : [{ ...l, qty: r2(qty) }])))
  }

  function reset() {
    setCart([])
    setTendered('')
    setQ('')
    setLast(null)
  }

  async function charge() {
    if (!cart.length) { toast.error('Cart is empty'); return }
    setBusy(true)
    try {
      const res = await apiPost<{ number: string; grandTotal: number }>('/api/sales-invoices', {
        companyId,
        isCashSale: true,
        deductStock: true,
        lines: cart.map((l) => ({ itemId: l.itemId, qty: l.qty, rate: l.rate, discountPct: 0, gstRate: l.gstRate, cessRate: 0 })),
        receivedAmount: totals.total,
        receivedMode: mode,
        notes: 'POS counter sale',
      })
      const change = tendered.trim() === '' ? 0 : r2(Number(tendered) - totals.total)
      setLast({ number: res?.number || 'saved', total: totals.total, change: change > 0 ? change : 0 })
      toast.success(`Sale ${res?.number || ''} saved`, { description: `${mode} · ${fmtMoney(totals.total)}` })
      setCart([])
      setTendered('')
      void items.refetch()
      searchRef.current?.focus()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the sale')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader
        title="POS"
        description="Counter billing — a sale here is a cash-sale tax invoice, so stock and GST stay in step"
        actions={<Button size="sm" variant="outline" onClick={reset} disabled={!cart.length}><X className="h-4 w-4 mr-1.5" />Clear</Button>}
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        {/* ---------- left: catalogue ---------- */}
        <div className="rounded-xl border">
          <div className="flex items-center gap-2 border-b p-3">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchRef}
                autoFocus
                className="h-9 pl-8"
                value={q}
                placeholder="Scan barcode or search item… (Enter adds the first match)"
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && shown[0]) { e.preventDefault(); add(shown[0]) }
                  if (e.key === 'Escape') setQ('')
                }}
              />
            </div>
            <span className="whitespace-nowrap text-xs text-muted-foreground">{shown.length} item(s)</span>
          </div>
          <div className="grid max-h-[62vh] gap-2 overflow-y-auto p-3 sm:grid-cols-2 xl:grid-cols-3">
            {shown.map((i) => (
              <button
                key={i.id} type="button" aria-label={`Add ${i.name}`} onClick={() => add(i)}
                className="rounded-lg border p-2.5 text-left transition hover:border-emerald-400 hover:bg-emerald-50/50 dark:hover:bg-emerald-950/20"
              >
                <p className="truncate text-sm font-medium">{i.name}</p>
                <p className="truncate text-[11px] text-muted-foreground">{i.code || '—'}{i.uom ? ` · ${i.uom}` : ''}</p>
                <div className="mt-1 flex items-center justify-between">
                  <span className="text-sm font-medium tabular-nums">{fmtMoney(i.sellingPrice)}</span>
                  <span className="text-[11px] text-muted-foreground">{i.gstRate ?? 0}% GST</span>
                </div>
              </button>
            ))}
            {!shown.length && (
              <p className="col-span-full py-10 text-center text-sm text-muted-foreground">
                {items.loading ? 'Loading items…' : 'No item matches that search'}
              </p>
            )}
          </div>
        </div>

        {/* ---------- right: cart ---------- */}
        <div className="flex flex-col rounded-xl border">
          <div className="flex items-center justify-between border-b p-3">
            <span className="flex items-center gap-1.5 text-sm font-medium"><ShoppingBag className="h-4 w-4" />Cart</span>
            <span className="text-xs text-muted-foreground">{cart.length} line(s)</span>
          </div>

          <div className="max-h-[38vh] flex-1 space-y-2 overflow-y-auto p-3">
            {cart.map((l) => (
              <div key={l.itemId} className="rounded-md border p-2">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate text-xs font-medium">{l.name}</p>
                  <Button type="button" variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setQty(l.itemId, 0)}>
                    <Trash2 className="h-3 w-3 text-red-600" />
                  </Button>
                </div>
                <div className="mt-1 flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <Button type="button" variant="outline" size="sm" className="h-6 w-6 p-0" onClick={() => setQty(l.itemId, l.qty - 1)}>
                      <Minus className="h-3 w-3" />
                    </Button>
                    <input
                      className="h-6 w-12 rounded border bg-transparent px-1 text-center text-xs tabular-nums"
                      value={l.qty}
                      onChange={(e) => setQty(l.itemId, Number(e.target.value) || 0)}
                      aria-label={`Quantity ${l.name}`}
                    />
                    <Button type="button" variant="outline" size="sm" className="h-6 w-6 p-0" onClick={() => setQty(l.itemId, l.qty + 1)}>
                      <Plus className="h-3 w-3" />
                    </Button>
                  </div>
                  <span className="text-xs tabular-nums">{fmtMoney(l.qty * l.rate)}</span>
                </div>
                <p className="mt-0.5 text-[10px] text-muted-foreground">@ {fmtMoney(l.rate)} · {l.gstRate}% GST</p>
              </div>
            ))}
            {!cart.length && (
              <p className="py-8 text-center text-xs text-muted-foreground">Tap an item to start the bill</p>
            )}
          </div>

          <div className="space-y-2 border-t p-3">
            <div className="flex justify-between text-xs"><span className="text-muted-foreground">Taxable</span><span className="tabular-nums">{fmtMoney(totals.taxable)}</span></div>
            <div className="flex justify-between text-xs"><span className="text-muted-foreground">GST</span><span className="tabular-nums">{fmtMoney(totals.tax)}</span></div>
            <div className="flex justify-between text-base font-semibold"><span>Total</span><span className="tabular-nums">{fmtMoney(totals.total)}</span></div>

            <div className="grid grid-cols-2 gap-2">
              <label className="grid gap-1">
                <span className="text-[11px] text-muted-foreground">Payment</span>
                <SelectInput value={mode} onChange={setMode} options={PAYMENT_MODES.filter((m) => m === 'CASH' || m === 'UPI' || m === 'BANK' || m === 'CHEQUE').map((m) => ({ value: m, label: m }))} />
              </label>
              <label className="grid gap-1">
                <span className="text-[11px] text-muted-foreground">Cash received</span>
                <Input className="h-9" inputMode="decimal" value={tendered} placeholder={String(totals.total || '')}
                  onChange={(e) => setTendered(e.target.value.replace(/[^\d.]/g, ''))} />
              </label>
            </div>
            {tendered.trim() !== '' && Number(tendered) >= totals.total && totals.total > 0 && (
              <div className="flex justify-between text-xs font-medium text-emerald-700 dark:text-emerald-400">
                <span>Change</span><span className="tabular-nums">{fmtMoney(Number(tendered) - totals.total)}</span>
              </div>
            )}

            <Button className="h-11 w-full text-base" disabled={busy || !cart.length} onClick={() => void charge()}>
              <ReceiptText className="h-4 w-4 mr-2" />
              {busy ? 'Saving…' : `Charge ${fmtMoney(totals.total)}`}
            </Button>

            {last && (
              <div className="rounded-md border border-emerald-300 bg-emerald-50 p-2 text-xs text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
                <p className="font-medium">Sale {last.number} saved — {fmtMoney(last.total)}</p>
                {last.change > 0 && <p>Return change: {fmtMoney(last.change)}</p>}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
