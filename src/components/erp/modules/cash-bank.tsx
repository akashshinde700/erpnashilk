'use client'

import * as React from 'react'
import { toast } from 'sonner'
import {
  ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Banknote, Calculator, FileText, HandCoins, Landmark, Pencil, Plus, Receipt, Trash2, Users, Wallet,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Column, ConfirmAction, DataTable, DateCell, DateInput, Field, FormDialog, Money, NumberInput, PageHeader,
  SelectInput, StatCard, StatusBadge, TextInput, openCreate,
} from '@/components/erp/kit'
import { ApiRequestError, apiDelete, apiGet, apiPatch, apiPost, useList } from '@/lib/use-api'
import { fmtDate, fmtMoney } from '@/lib/erp-constants'

// ---------- Types ----------

interface Account {
  id: string; type: string; name: string
  bankName?: string | null; accountNo?: string | null; ifsc?: string | null; branch?: string | null
  upiId?: string | null; holderName?: string | null
  openingBalance: number; openingDate?: string | null
  printOnInvoice: boolean; isDefault: boolean; active: boolean
  balance: number
}

interface Txn {
  id: string; number: string; date: string; type: string
  fromAccountId?: string | null; toAccountId?: string | null
  fromAccountName?: string | null; toAccountName?: string | null
  amount: number; category?: string | null; categoryLabel?: string | null
  loanId?: string | null; loanName?: string | null
  principal?: number | null; interest?: number | null
  reference?: string | null; notes?: string | null
}

interface Loan {
  id: string; name: string; lender?: string | null; loanAccountNo?: string | null
  principal: number; interestRate: number; processingFee: number; startDate: string
  termMonths?: number | null; emiAmount?: number | null; receivedAccountId?: string | null; receivedAccountName?: string | null
  status: string; notes?: string | null
  principalPaid: number; interestPaid: number; outstanding: number; emiCount: number; lastEmiDate?: string | null
}

interface LedgerItem {
  id: string; date: string | null; type: string; typeLabel: string; number: string; party: string; description: string
  accountId: string; accountName: string; moneyIn: number; moneyOut: number; balance: number
}
interface History {
  items: LedgerItem[]; totals: { count: number; moneyIn: number; moneyOut: number }
  opening: number; closing: number; filtered: boolean
  pendingCheques: { count: number; toReceive: number; toPay: number }
  parties: { id: string; name: string }[]; types: { value: string; label: string }[]
}

interface StatementRow {
  id: string; kind: 'opening' | 'payment' | 'expense' | 'txn'; date: string; type: string; ref: string; party: string
  in: number; out: number; balance: number; clearedDate?: string | null
}
interface Statement {
  account: Account; opening: number; closing: number; totalIn: number; totalOut: number; rows: StatementRow[]
}

// ---------- Helpers ----------

const today = () => new Date().toISOString().slice(0, 10)
const fyStart = () => {
  const d = new Date()
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1
  return `${y}-04-01`
}
const r2 = (n: number) => Math.round(n * 100) / 100
const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)

const IN_CATEGORIES = [
  { value: 'CAPITAL', label: 'Owner capital' },
  { value: 'OTHER_INCOME', label: 'Other income' },
  { value: 'OTHER', label: 'Other' },
]
const OUT_CATEGORIES = [
  { value: 'DRAWINGS', label: 'Drawings (owner withdrawal)' },
  { value: 'OTHER_EXPENSE', label: 'Other expense' },
  { value: 'OTHER', label: 'Other' },
]
const TRANSFER_KINDS = [
  { value: 'DEPOSIT', label: 'Cash → Bank (deposit)' },
  { value: 'WITHDRAW', label: 'Bank → Cash (withdrawal)' },
  { value: 'BANK', label: 'Bank → Bank' },
]

function maskAcc(no?: string | null) {
  if (!no) return ''
  return no.length > 4 ? `••••${no.slice(-4)}` : no
}

function Pill({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'green' | 'blue' | 'amber' }) {
  const cls = {
    muted: 'bg-muted text-muted-foreground',
    green: 'bg-success-soft text-success ring-1 ring-inset ring-success-border',
    blue: 'bg-info-soft text-info ring-1 ring-inset ring-info-border',
    amber: 'bg-warning-soft text-warning ring-1 ring-inset ring-warning-border',
  }[tone]
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>{children}</span>
}

// ---------- Account form ----------

interface AccountForm {
  type: string; name: string; bankName: string; accountNo: string; ifsc: string; branch: string; holderName: string; upiId: string
  openingBalance: number; openingDate: string; printOnInvoice: boolean; isDefault: boolean; active: boolean
}
const freshAccount = (type = 'BANK'): AccountForm => ({
  type, name: '', bankName: '', accountNo: '', ifsc: '', branch: '', holderName: '', upiId: '',
  openingBalance: 0, openingDate: today(), printOnInvoice: false, isDefault: false, active: true,
})

// ========== Module ==========

export default function CashBankModule({ companyId }: { companyId: string }) {
  const accounts = useList<{ items: Account[] }>(`/api/accounts?companyId=${companyId}`)
  const txns = useList<{ items: Txn[] }>(`/api/account-txns?companyId=${companyId}`)
  const loans = useList<{ items: Loan[]; outstanding: number }>(`/api/loans?companyId=${companyId}`)

  // ----- Transactions (unified history) -----
  const [hAccount, setHAccount] = React.useState('')
  const [hType, setHType] = React.useState('')
  const [hParty, setHParty] = React.useState('')
  const [hFrom, setHFrom] = React.useState(fyStart)
  const [hTo, setHTo] = React.useState(today)
  const historyQs = new URLSearchParams({
    companyId, ...(hAccount ? { accountId: hAccount } : {}), ...(hType ? { type: hType } : {}), ...(hParty ? { partyId: hParty } : {}),
    ...(hFrom ? { from: hFrom } : {}), ...(hTo ? { to: hTo } : {}),
  }).toString()
  const history = useList<History>(`/api/cash-bank/transactions?${historyQs}`)

  const allAccounts = accounts.data?.items ?? []
  const activeAccounts = allAccounts.filter((a) => a.active)
  const cashAccounts = activeAccounts.filter((a) => a.type === 'CASH')
  const bankAccounts = activeAccounts.filter((a) => a.type === 'BANK')
  const defaultCash = cashAccounts.find((a) => a.isDefault) ?? cashAccounts[0]
  const cashTotal = r2(allAccounts.filter((a) => a.type === 'CASH').reduce((s, a) => s + a.balance, 0))
  const bankTotal = r2(allAccounts.filter((a) => a.type === 'BANK').reduce((s, a) => s + a.balance, 0))
  const loanRows = loans.data?.items ?? []
  const openLoans = loanRows.filter((l) => l.status === 'OPEN')
  const txnRows = txns.data?.items ?? []
  const adjustRows = txnRows.filter((t) => t.type === 'ADJUST_IN' || t.type === 'ADJUST_OUT')
  const contraRows = txnRows.filter((t) => t.type === 'CONTRA')

  const accountOpts = (list: Account[]) => list.map((a) => ({ value: a.id, label: `${a.name} (${fmtMoney(a.balance)})` }))

  function refreshAll() {
    void accounts.refetch(); void txns.refetch(); void loans.refetch(); void history.refetch()
  }

  // ----- Account dialog -----
  const [accOpen, setAccOpen] = React.useState(false)
  const [accEditing, setAccEditing] = React.useState<Account | null>(null)
  const [accForm, setAccForm] = React.useState<AccountForm>(freshAccount())
  const [accSaving, setAccSaving] = React.useState(false)
  const setAcc = <K extends keyof AccountForm>(k: K, v: AccountForm[K]) => setAccForm((f) => ({ ...f, [k]: v }))

  function newAccount(type: 'BANK' | 'CASH') {
    setAccEditing(null); setAccForm(freshAccount(type)); setAccOpen(true)
  }
  // No cash account yet (it is no longer created just by opening this page): set it up explicitly
  function setupCash() {
    setAccEditing(null); setAccForm({ ...freshAccount('CASH'), name: 'Cash in Hand', isDefault: true }); setAccOpen(true)
  }
  const hasCash = allAccounts.some((a) => a.type === 'CASH')
  function editAccount(a: Account) {
    setAccEditing(a)
    setAccForm({
      type: a.type, name: a.name, bankName: a.bankName || '', accountNo: a.accountNo || '', ifsc: a.ifsc || '', branch: a.branch || '',
      holderName: a.holderName || '', upiId: a.upiId || '', openingBalance: a.openingBalance || 0,
      openingDate: a.openingDate ? String(a.openingDate).slice(0, 10) : '', printOnInvoice: a.printOnInvoice, isDefault: a.isDefault, active: a.active,
    })
    setAccOpen(true)
  }
  async function saveAccount() {
    const f = accForm
    if (!f.name.trim()) { toast.error('Account name is required'); return }
    if (f.ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(f.ifsc.trim().toUpperCase())) { toast.error('IFSC must look like SBIN0001234'); return }
    if (Math.abs(f.openingBalance || 0) >= 0.005 && !f.openingDate) { toast.error('Opening date is required when there is an opening balance'); return }
    setAccSaving(true)
    try {
      const payload = {
        companyId, name: f.name.trim(), openingBalance: f.openingBalance, openingDate: f.openingDate || null, isDefault: f.isDefault,
        ...(f.type === 'BANK' ? {
          bankName: f.bankName, accountNo: f.accountNo, ifsc: f.ifsc.trim().toUpperCase(), branch: f.branch,
          holderName: f.holderName, upiId: f.upiId, printOnInvoice: f.printOnInvoice,
        } : {}),
      }
      if (accEditing) {
        await apiPatch(`/api/accounts/${accEditing.id}`, { ...payload, active: f.active })
        toast.success('Account updated')
      } else {
        await apiPost('/api/accounts', { ...payload, type: f.type })
        toast.success(f.type === 'BANK' ? 'Bank account added' : 'Cash account added')
      }
      setAccOpen(false); refreshAll()
    } catch (e) { toast.error(errMsg(e, 'Failed to save account')) } finally { setAccSaving(false) }
  }
  async function deleteAccount(a: Account) {
    try {
      await apiDelete(`/api/accounts/${a.id}?companyId=${companyId}`)
      toast.success('Account deleted'); refreshAll()
    } catch (e) { toast.error(errMsg(e, 'Failed to delete account')) }
  }

  // ----- Statement -----
  const [stmtAccount, setStmtAccount] = React.useState<Account | null>(null)
  const [stmtFrom, setStmtFrom] = React.useState(fyStart)
  const [stmtTo, setStmtTo] = React.useState(today)
  const [stmt, setStmt] = React.useState<Statement | null>(null)
  const [stmtLoading, setStmtLoading] = React.useState(false)
  const [unclearedOnly, setUnclearedOnly] = React.useState(false)

  const loadStatement = React.useCallback(async (acc: Account, from: string, to: string) => {
    setStmtLoading(true)
    try {
      const qs = new URLSearchParams({ companyId, ...(from ? { from } : {}), ...(to ? { to } : {}) })
      setStmt(await apiGet<Statement>(`/api/accounts/${acc.id}/statement?${qs.toString()}`))
    } catch (e) { toast.error(errMsg(e, 'Failed to load statement')) } finally { setStmtLoading(false) }
  }, [companyId])

  function openStatement(a: Account) {
    setStmt(null); setUnclearedOnly(false); setStmtAccount(a)
    void loadStatement(a, stmtFrom, stmtTo)
  }
  async function toggleCleared(row: StatementRow, cleared: boolean) {
    if (!stmtAccount || row.kind === 'opening') return
    try {
      const clearedDate = cleared ? today() : null
      await apiPatch(`/api/accounts/${stmtAccount.id}/reconcile`, { companyId, kind: row.kind, id: row.id, clearedDate })
      setStmt((s) => s && ({ ...s, rows: s.rows.map((r) => (r.id === row.id && r.kind === row.kind ? { ...r, clearedDate } : r)) }))
    } catch (e) { toast.error(errMsg(e, 'Failed to update')) }
  }
  const isBankStmt = stmtAccount?.type === 'BANK'
  const clearedNet = stmt ? r2(stmt.rows.filter((r) => r.kind === 'opening' || r.clearedDate).reduce((s, r) => s + r.in - r.out, 0)) : 0
  const stmtRows = stmt ? stmt.rows.filter((r) => !unclearedOnly || (r.kind !== 'opening' && !r.clearedDate)) : []

  // ----- Add / reduce money -----
  const [adjOpen, setAdjOpen] = React.useState<null | 'ADJUST_IN' | 'ADJUST_OUT'>(null)
  const [adjAccount, setAdjAccount] = React.useState('')
  const [adjAmount, setAdjAmount] = React.useState(0)
  const [adjDate, setAdjDate] = React.useState(today)
  const [adjCategory, setAdjCategory] = React.useState('CAPITAL')
  const [adjNotes, setAdjNotes] = React.useState('')
  const [adjSaving, setAdjSaving] = React.useState(false)

  function openAdjust(type: 'ADJUST_IN' | 'ADJUST_OUT') {
    setAdjAccount(defaultCash?.id ?? ''); setAdjAmount(0); setAdjDate(today()); setAdjNotes('')
    setAdjCategory(type === 'ADJUST_IN' ? 'CAPITAL' : 'DRAWINGS'); setAdjOpen(type)
  }
  async function saveAdjust() {
    if (!adjOpen) return
    if (!adjAccount) { toast.error('Select an account'); return }
    if (!(adjAmount > 0)) { toast.error('Enter an amount'); return }
    setAdjSaving(true)
    try {
      await apiPost('/api/account-txns', {
        companyId, type: adjOpen, amount: adjAmount, date: adjDate, category: adjCategory, notes: adjNotes || undefined,
        ...(adjOpen === 'ADJUST_IN' ? { toAccountId: adjAccount } : { fromAccountId: adjAccount }),
      })
      toast.success(adjOpen === 'ADJUST_IN' ? 'Money added' : 'Money reduced')
      setAdjOpen(null); refreshAll()
    } catch (e) { toast.error(errMsg(e, 'Failed to save')) } finally { setAdjSaving(false) }
  }

  // ----- Money In / Money Out choosers: route to the existing flows -----
  const [chooser, setChooser] = React.useState<null | 'IN' | 'OUT'>(null)
  function choose(action: () => void) { setChooser(null); action() }
  const goTo = (module: string) => window.dispatchEvent(new CustomEvent('erp:goto', { detail: module }))

  // ----- Adjust cash to the amount physically counted -----
  // Excess → Add money (Other income), shortage → Reduce money (Other expense): the existing entries, which reach
  // the cash balance, P&L and balance sheet. A zero difference saves nothing.
  const [cntOpen, setCntOpen] = React.useState(false)
  const [cntAccount, setCntAccount] = React.useState('')
  const [cntDate, setCntDate] = React.useState(today)
  const [cntCounted, setCntCounted] = React.useState(0)
  const [cntBalance, setCntBalance] = React.useState<number | null>(null)
  const [cntReviewed, setCntReviewed] = React.useState<number | null>(null) // difference the user is confirming
  const [cntSaving, setCntSaving] = React.useState(false)
  const cntDiff = cntBalance === null ? null : r2(cntCounted - cntBalance)
  // Nothing chosen yet → the default cash account (also once the account list finishes loading)
  const cntAccountId = cntAccount || defaultCash?.id || ''

  const balanceOn = React.useCallback(async (accountId: string, date: string) => {
    const qs = new URLSearchParams({ companyId, ...(date ? { to: date } : {}) })
    return (await apiGet<Statement>(`/api/accounts/${accountId}/statement?${qs.toString()}`)).closing
  }, [companyId])

  React.useEffect(() => {
    if (!cntOpen || !cntAccountId) return
    let alive = true
    balanceOn(cntAccountId, cntDate)
      .then((b) => { if (alive) { setCntBalance(b); setCntReviewed(null) } })
      .catch((e) => { if (alive) toast.error(errMsg(e, 'Could not load the cash balance')) })
    return () => { alive = false }
  }, [cntOpen, cntAccountId, cntDate, balanceOn])

  function openCount() {
    setCntAccount(''); setCntDate(today()); setCntCounted(0); setCntBalance(null); setCntReviewed(null); setCntOpen(true)
  }
  async function saveCount() {
    if (!cntAccountId) { toast.error('Select a cash account'); return }
    if (!Number.isFinite(cntCounted) || cntCounted < 0) { toast.error('Enter the cash you counted (0 or more)'); return }
    if (cntDiff === null) { toast.error('The cash balance is still loading'); return }
    // Step 1: review the difference
    if (cntReviewed === null) {
      if (Math.abs(cntDiff) < 0.005) { toast.success('Counted cash matches the books — nothing to adjust'); setCntOpen(false); return }
      setCntReviewed(cntDiff); return
    }
    setCntSaving(true)
    try {
      // Step 2: re-check the balance right before saving; if it moved, show the new difference first
      const fresh = await balanceOn(cntAccountId, cntDate)
      const diff = r2(cntCounted - fresh)
      if (fresh !== cntBalance || diff !== cntReviewed) {
        setCntBalance(fresh); setCntReviewed(Math.abs(diff) < 0.005 ? null : diff)
        toast.error('The cash balance changed meanwhile — please review the new difference')
        return
      }
      const counted = fmtMoney(cntCounted)
      const books = fmtMoney(fresh)
      // expectedBalance: the server refuses the entry (409 BALANCE_CHANGED) if the books moved since this review
      await apiPost('/api/account-txns', diff > 0
        ? { companyId, type: 'ADJUST_IN', toAccountId: cntAccountId, amount: diff, category: 'OTHER_INCOME', date: cntDate, expectedBalance: fresh, notes: `Cash count: counted ${counted}, books ${books} — excess` }
        : { companyId, type: 'ADJUST_OUT', fromAccountId: cntAccountId, amount: -diff, category: 'OTHER_EXPENSE', date: cntDate, expectedBalance: fresh, notes: `Cash count: counted ${counted}, books ${books} — shortage` })
      toast.success(diff > 0 ? `Cash excess of ${fmtMoney(diff)} recorded as other income` : `Cash shortage of ${fmtMoney(-diff)} recorded as other expense`)
      setCntOpen(false); refreshAll()
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === 'BALANCE_CHANGED') {
        const now = (e.details as { balance?: number } | undefined)?.balance
        if (typeof now === 'number') {
          const d = r2(cntCounted - now)
          setCntBalance(now); setCntReviewed(Math.abs(d) < 0.005 ? null : d)
        }
        toast.error('The cash balance changed meanwhile — please review the new difference')
      } else toast.error(errMsg(e, 'Failed to adjust cash'))
    } finally { setCntSaving(false) }
  }

  // ----- Contra transfer -----
  const [trOpen, setTrOpen] = React.useState(false)
  const [trKind, setTrKind] = React.useState('DEPOSIT')
  const [trFrom, setTrFrom] = React.useState('')
  const [trTo, setTrTo] = React.useState('')
  const [trAmount, setTrAmount] = React.useState(0)
  const [trDate, setTrDate] = React.useState(today)
  const [trRef, setTrRef] = React.useState('')
  const [trNotes, setTrNotes] = React.useState('')
  const [trSaving, setTrSaving] = React.useState(false)
  const trFromList = trKind === 'DEPOSIT' ? cashAccounts : bankAccounts
  const trToList = (trKind === 'WITHDRAW' ? cashAccounts : bankAccounts).filter((a) => a.id !== trFrom)

  function pickTransferKind(k: string) {
    setTrKind(k)
    const from = (k === 'DEPOSIT' ? cashAccounts : bankAccounts)[0]?.id ?? ''
    const to = (k === 'WITHDRAW' ? cashAccounts : bankAccounts).find((a) => a.id !== from)?.id ?? ''
    setTrFrom(from); setTrTo(to)
  }
  function openTransfer() {
    setTrAmount(0); setTrDate(today()); setTrRef(''); setTrNotes(''); pickTransferKind('DEPOSIT'); setTrOpen(true)
  }
  async function saveTransfer() {
    if (!trFrom || !trTo) { toast.error('Select both accounts'); return }
    if (trFrom === trTo) { toast.error('From and To must be different'); return }
    if (!(trAmount > 0)) { toast.error('Enter an amount'); return }
    setTrSaving(true)
    try {
      await apiPost('/api/account-txns', {
        companyId, type: 'CONTRA', fromAccountId: trFrom, toAccountId: trTo, amount: trAmount, date: trDate,
        reference: trRef || undefined, notes: trNotes || undefined,
      })
      toast.success('Transfer recorded'); setTrOpen(false); refreshAll()
    } catch (e) { toast.error(errMsg(e, 'Failed to save transfer')) } finally { setTrSaving(false) }
  }

  async function deleteTxn(t: Txn) {
    try {
      await apiDelete(`/api/account-txns/${t.id}?companyId=${companyId}`)
      toast.success('Entry deleted'); refreshAll()
    } catch (e) { toast.error(errMsg(e, 'Failed to delete')) }
  }

  // ----- Loans -----
  const [loanOpen, setLoanOpen] = React.useState(false)
  const [loanSaving, setLoanSaving] = React.useState(false)
  const [loanForm, setLoanForm] = React.useState({
    name: '', lender: '', loanAccountNo: '', principal: 0, interestRate: 0, processingFee: 0,
    startDate: today(), termMonths: 0, emiAmount: 0, receivedAccountId: '',
  })
  const setLoan = <K extends keyof typeof loanForm>(k: K, v: (typeof loanForm)[K]) => setLoanForm((f) => ({ ...f, [k]: v }))
  function openLoan() {
    setLoanForm({
      name: '', lender: '', loanAccountNo: '', principal: 0, interestRate: 0, processingFee: 0,
      startDate: today(), termMonths: 0, emiAmount: 0, receivedAccountId: (bankAccounts[0] ?? defaultCash)?.id ?? '',
    })
    setLoanOpen(true)
  }
  // Standard reducing-balance EMI suggestion
  const suggestedEmi = React.useMemo(() => {
    const { principal: p, interestRate: rate, termMonths: n } = loanForm
    if (!(p > 0) || !(n > 0)) return 0
    const r = rate / 1200
    return r2(r > 0 ? (p * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1) : p / n)
  }, [loanForm])
  async function saveLoan() {
    const f = loanForm
    if (!f.name.trim()) { toast.error('Loan name is required'); return }
    if (!(f.principal > 0)) { toast.error('Enter the loan amount'); return }
    if (f.processingFee >= f.principal) { toast.error('Processing fee must be less than the loan amount'); return }
    if (!f.receivedAccountId) { toast.error('Select the account the loan was received in'); return }
    setLoanSaving(true)
    try {
      await apiPost('/api/loans', {
        companyId, ...f, name: f.name.trim(),
        termMonths: f.termMonths > 0 ? f.termMonths : null,
        emiAmount: f.emiAmount > 0 ? f.emiAmount : (suggestedEmi || null),
      })
      toast.success('Loan recorded'); setLoanOpen(false); refreshAll()
    } catch (e) { toast.error(errMsg(e, 'Failed to save loan')) } finally { setLoanSaving(false) }
  }

  const [emiLoan, setEmiLoan] = React.useState<Loan | null>(null)
  const [emiDate, setEmiDate] = React.useState(today)
  const [emiPrincipal, setEmiPrincipal] = React.useState(0)
  const [emiInterest, setEmiInterest] = React.useState(0)
  const [emiAccount, setEmiAccount] = React.useState('')
  const [emiRef, setEmiRef] = React.useState('')
  const [emiSaving, setEmiSaving] = React.useState(false)
  function openEmi(l: Loan) {
    // Pre-fill: one month's interest on the outstanding, the rest of the EMI as principal
    const interest = r2((l.outstanding * (l.interestRate || 0)) / 1200)
    const principal = l.emiAmount ? Math.min(l.outstanding, Math.max(0, r2(l.emiAmount - interest))) : 0
    setEmiLoan(l); setEmiDate(today()); setEmiInterest(interest); setEmiPrincipal(principal); setEmiRef('')
    setEmiAccount((l.receivedAccountId && activeAccounts.some((a) => a.id === l.receivedAccountId) ? l.receivedAccountId : bankAccounts[0]?.id) ?? defaultCash?.id ?? '')
  }
  async function saveEmi() {
    if (!emiLoan) return
    if (!emiAccount) { toast.error('Select the account the EMI was paid from'); return }
    if (!(emiPrincipal + emiInterest > 0)) { toast.error('Enter principal and/or interest'); return }
    if (emiPrincipal > emiLoan.outstanding + 0.01) { toast.error(`Principal exceeds outstanding (${fmtMoney(emiLoan.outstanding)})`); return }
    setEmiSaving(true)
    try {
      const res = await apiPost<{ loanClosed?: boolean }>(`/api/loans/${emiLoan.id}/emi`, {
        companyId, date: emiDate, principal: emiPrincipal, interest: emiInterest, fromAccountId: emiAccount, reference: emiRef || undefined,
      })
      toast.success(res?.loanClosed ? 'EMI recorded — loan fully repaid and closed' : 'EMI recorded')
      setEmiLoan(null); refreshAll()
    } catch (e) { toast.error(errMsg(e, 'Failed to record EMI')) } finally { setEmiSaving(false) }
  }
  async function loanAction(l: Loan, action: 'close' | 'reopen') {
    try {
      await apiPatch(`/api/loans/${l.id}`, { companyId, action })
      toast.success(action === 'close' ? 'Loan closed' : 'Loan reopened'); refreshAll()
    } catch (e) { toast.error(errMsg(e, 'Failed to update loan')) }
  }
  async function deleteLoan(l: Loan) {
    try {
      await apiDelete(`/api/loans/${l.id}?companyId=${companyId}`)
      toast.success('Loan deleted'); refreshAll()
    } catch (e) { toast.error(errMsg(e, 'Failed to delete loan')) }
  }

  // ---------- Columns ----------

  const deleteBtn = (onConfirm: () => void, title: string, message: string) => (
    <ConfirmAction
      tone="destructive" title={title} message={message} onConfirm={onConfirm}
      trigger={<Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive" aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>}
    />
  )

  const adjustColumns: Column<Txn>[] = [
    { key: 'number', header: 'No.', hideOnMobile: true, render: (r) => <span className="font-mono text-xs">{r.number}</span> },
    { key: 'date', header: 'Date', render: (r) => <DateCell value={r.date} /> },
    {
      key: 'type', header: 'Entry',
      render: (r) => r.type === 'ADJUST_IN'
        ? <Pill tone="green"><ArrowDownLeft className="mr-1 h-3 w-3" />Added</Pill>
        : <Pill tone="amber"><ArrowUpRight className="mr-1 h-3 w-3" />Reduced</Pill>,
    },
    { key: 'account', header: 'Account', render: (r) => r.toAccountName || r.fromAccountName || '—' },
    { key: 'category', header: 'Category', hideOnMobile: true, render: (r) => r.categoryLabel || '—' },
    {
      key: 'amount', header: 'Amount', className: 'text-right',
      render: (r) => <Money value={r.amount} className={`font-medium ${r.type === 'ADJUST_IN' ? 'text-success' : 'text-destructive'}`} />,
    },
    { key: 'notes', header: 'Notes', hideOnMobile: true, render: (r) => <span className="block max-w-[200px] truncate" title={r.notes || ''}>{r.notes || '—'}</span> },
    { key: 'actions', header: '', className: 'w-10 text-right', render: (r) => deleteBtn(() => deleteTxn(r), 'Delete entry?', `Delete ${r.number} (${fmtMoney(r.amount)})?`) },
  ]

  const contraColumns: Column<Txn>[] = [
    { key: 'number', header: 'No.', hideOnMobile: true, render: (r) => <span className="font-mono text-xs">{r.number}</span> },
    { key: 'date', header: 'Date', render: (r) => <DateCell value={r.date} /> },
    {
      key: 'route', header: 'Transfer',
      render: (r) => (
        <span className="flex flex-wrap items-center gap-1 text-sm">
          <span>{r.fromAccountName || '—'}</span>
          <ArrowLeftRight className="h-3 w-3 text-muted-foreground" />
          <span>{r.toAccountName || '—'}</span>
        </span>
      ),
    },
    { key: 'amount', header: 'Amount', className: 'text-right', render: (r) => <Money value={r.amount} className="font-medium" /> },
    { key: 'reference', header: 'Reference', hideOnMobile: true, render: (r) => r.reference || '—' },
    { key: 'actions', header: '', className: 'w-10 text-right', render: (r) => deleteBtn(() => deleteTxn(r), 'Delete transfer?', `Delete ${r.number} (${fmtMoney(r.amount)})?`) },
  ]

  const loanColumns: Column<Loan>[] = [
    {
      key: 'name', header: 'Loan',
      render: (r) => (
        <div className="min-w-0">
          <div className="font-medium">{r.name}</div>
          <div className="text-[11px] text-muted-foreground">{[r.lender, r.loanAccountNo].filter(Boolean).join(' • ') || '—'}</div>
        </div>
      ),
    },
    { key: 'principal', header: 'Principal', hideOnMobile: true, render: (r) => <Money value={r.principal} /> },
    { key: 'outstanding', header: 'Outstanding', render: (r) => <Money value={r.outstanding} className="font-medium" /> },
    { key: 'interestPaid', header: 'Interest paid', hideOnMobile: true, render: (r) => <Money value={r.interestPaid} /> },
    {
      key: 'emi', header: 'EMI', hideOnMobile: true,
      render: (r) => (
        <div className="text-xs">
          <div>{r.emiAmount ? fmtMoney(r.emiAmount) : '—'}{r.interestRate ? ` @ ${r.interestRate}%` : ''}</div>
          <div className="text-muted-foreground">{r.emiCount} paid{r.termMonths ? ` of ${r.termMonths}` : ''}</div>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions', header: '', className: 'text-right',
      render: (r) => (
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          {r.status === 'OPEN' && <Button size="sm" variant="outline" className="h-7" onClick={() => openEmi(r)}>Pay EMI</Button>}
          {r.status === 'OPEN' ? (
            <ConfirmAction
              title="Close loan?" onConfirm={() => loanAction(r, 'close')}
              message={r.outstanding > 0.01 ? `${fmtMoney(r.outstanding)} principal is still outstanding. Close "${r.name}" anyway?` : `Close "${r.name}"?`}
              trigger={<Button size="sm" variant="ghost" className="h-7">Close</Button>}
            />
          ) : (
            <Button size="sm" variant="ghost" className="h-7" onClick={() => loanAction(r, 'reopen')}>Reopen</Button>
          )}
          {deleteBtn(() => deleteLoan(r), 'Delete loan?', `Delete "${r.name}" with its receipt and ${r.emiCount} EMI entr${r.emiCount === 1 ? 'y' : 'ies'}? Account balances will change.`)}
        </div>
      ),
    },
  ]

  const hist = history.data
  const IN_TYPES = ['OPENING', 'PAYMENT_IN', 'ADJUST_IN', 'LOAN_IN']
  const historyColumns: Column<LedgerItem>[] = [
    { key: 'date', header: 'Date', sortValue: (r) => r.date || '', render: (r) => (r.date ? <DateCell value={r.date} /> : <span className="text-muted-foreground">—</span>) },
    {
      key: 'typeLabel', header: 'Type',
      render: (r) => <Pill tone={r.type === 'TRANSFER' ? 'blue' : IN_TYPES.includes(r.type) || r.moneyIn ? 'green' : 'amber'}>{r.typeLabel}</Pill>,
    },
    { key: 'number', header: 'No.', hideOnMobile: true, render: (r) => <span className="font-mono text-xs whitespace-nowrap">{r.number || '—'}</span> },
    {
      key: 'party', header: 'Details',
      render: (r) => (
        <div className="min-w-0">
          <p className="truncate max-w-60 text-sm">{r.party || r.typeLabel}</p>
          <p className="truncate max-w-60 text-[11px] text-muted-foreground">{r.description}</p>
        </div>
      ),
    },
    ...(hAccount ? [] : [{ key: 'accountName', header: 'Account', hideOnMobile: true, render: (r: LedgerItem) => <span className="text-sm">{r.accountName}</span> }]),
    { key: 'moneyIn', header: 'Money in', className: 'text-right', sum: true, sumFormat: 'money', render: (r) => (r.moneyIn ? <Money value={r.moneyIn} className="text-success" /> : <span className="text-muted-foreground">—</span>) },
    { key: 'moneyOut', header: 'Money out', className: 'text-right', sum: true, sumFormat: 'money', render: (r) => (r.moneyOut ? <Money value={r.moneyOut} className="text-destructive" /> : <span className="text-muted-foreground">—</span>) },
    // Balance after the row is per account — shown when one account is selected
    ...(hAccount ? [{ key: 'balance', header: 'Balance', className: 'text-right', render: (r: LedgerItem) => <Money value={r.balance} className={`font-medium ${r.balance < 0 ? 'text-destructive' : ''}`} /> }] : []),
  ]

  // ---------- Render ----------

  return (
    <div>
      <PageHeader
        title="Cash & Bank"
        description="Cash in hand, bank accounts, contra transfers, loans and bank reconciliation"
        actions={
          <>
            <Button size="sm" onClick={() => setChooser('IN')}><ArrowDownLeft className="h-4 w-4 mr-1.5" />Money In</Button>
            <Button size="sm" onClick={() => setChooser('OUT')}><ArrowUpRight className="h-4 w-4 mr-1.5" />Money Out</Button>
            <Button size="sm" variant="outline" onClick={openTransfer}><ArrowLeftRight className="h-4 w-4 mr-1.5" />Transfer</Button>
            <Button size="sm" variant="outline" onClick={openCount}><Calculator className="h-4 w-4 mr-1.5" />Adjust Cash</Button>
            <Button size="sm" variant="outline" onClick={() => newAccount('BANK')}><Plus className="h-4 w-4 mr-1.5" />Bank Account</Button>
          </>
        }
      />

      <div className="grid gap-3 grid-cols-1 sm:grid-cols-3 mb-4">
        <StatCard title="Cash in hand" value={fmtMoney(cashTotal)} sub={`${cashAccounts.length} cash account${cashAccounts.length === 1 ? '' : 's'}`} icon={<Wallet className="h-4 w-4" />} toneClass="bg-success-soft text-success" />
        <StatCard title="Bank balance" value={fmtMoney(bankTotal)} sub={`${bankAccounts.length} bank account${bankAccounts.length === 1 ? '' : 's'}`} icon={<Landmark className="h-4 w-4" />} toneClass="bg-info-soft text-info" />
        <StatCard title="Loans outstanding" value={fmtMoney(loans.data?.outstanding ?? 0)} sub={`${openLoans.length} open loan${openLoans.length === 1 ? '' : 's'}`} icon={<HandCoins className="h-4 w-4" />} toneClass="bg-warning-soft text-warning" />
      </div>

      <Tabs defaultValue="accounts">
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList className="w-max">
            <TabsTrigger value="accounts">Accounts</TabsTrigger>
            <TabsTrigger value="transactions">Transactions</TabsTrigger>
            <TabsTrigger value="cash">Cash in Hand</TabsTrigger>
            <TabsTrigger value="contra">Contra</TabsTrigger>
            <TabsTrigger value="loans">Loans</TabsTrigger>
          </TabsList>
        </div>

        {/* ----- Accounts ----- */}
        <TabsContent value="accounts" className="mt-4">
          {accounts.loading && !allAccounts.length ? (
            <p className="text-sm text-muted-foreground">Loading accounts…</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {!accounts.loading && !hasCash && (
                <button
                  type="button" onClick={setupCash}
                  className="flex min-h-[140px] flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-primary/40 text-sm text-success hover:bg-primary/5 dark:hover:bg-primary/10"
                >
                  <Banknote className="h-5 w-5" />Set up Cash in Hand
                  <span className="text-xs text-muted-foreground">Add your opening cash and its date</span>
                </button>
              )}
              {allAccounts.map((a) => (
                <Card key={a.id} className={`py-4 ${a.active ? '' : 'opacity-60'}`}>
                  <CardContent className="px-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-start gap-2">
                        <div className={`shrink-0 rounded-lg p-2 ${a.type === 'CASH' ? 'bg-success-soft text-success' : 'bg-info-soft text-info'}`}>
                          {a.type === 'CASH' ? <Banknote className="h-4 w-4" /> : <Landmark className="h-4 w-4" />}
                        </div>
                        <div className="min-w-0">
                          <p className="truncate font-medium">{a.name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {a.type === 'CASH' ? 'Cash' : [a.bankName, maskAcc(a.accountNo), a.ifsc].filter(Boolean).join(' • ') || 'Bank account'}
                          </p>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center">
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => editAccount(a)} aria-label="Edit account"><Pencil className="h-3.5 w-3.5" /></Button>
                        {deleteBtn(() => deleteAccount(a), 'Delete account?', `Delete "${a.name}"? Only accounts with no entries can be deleted — deactivate it otherwise.`)}
                      </div>
                    </div>
                    <p className={`mt-3 text-2xl font-bold tabular-nums ${a.balance < 0 ? 'text-destructive' : ''}`}>{fmtMoney(a.balance)}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {a.isDefault && <Pill tone="blue">Default</Pill>}
                      {a.printOnInvoice && <Pill tone="green">On invoice</Pill>}
                      {!a.active && <Pill tone="amber">Inactive</Pill>}
                      <Button variant="outline" size="sm" className="ml-auto h-7" onClick={() => openStatement(a)}>
                        <FileText className="h-3.5 w-3.5 mr-1" />Statement
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
              <button
                type="button" onClick={() => newAccount('BANK')}
                className="flex min-h-[140px] flex-col items-center justify-center gap-1 rounded-xl border border-dashed text-sm text-muted-foreground hover:bg-muted/40"
              >
                <Plus className="h-5 w-5" />Add bank account
              </button>
            </div>
          )}
          <div className="mt-3 text-right">
            <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => newAccount('CASH')}>+ Add another cash account (e.g. petty cash)</Button>
          </div>
        </TabsContent>

        {/* ----- Transactions: every money movement of every account ----- */}
        <TabsContent value="transactions" className="mt-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Field label="Account">
              <SelectInput value={hAccount} onChange={setHAccount} options={[{ value: '', label: 'All accounts' }, ...allAccounts.map((a) => ({ value: a.id, label: a.name }))]} />
            </Field>
            <Field label="Type">
              <SelectInput value={hType} onChange={setHType} options={[{ value: '', label: 'All types' }, ...(hist?.types ?? [])]} />
            </Field>
            <Field label="Party">
              <SelectInput value={hParty} onChange={setHParty} options={[{ value: '', label: 'All parties' }, ...(hist?.parties ?? []).map((p) => ({ value: p.id, label: p.name }))]} />
            </Field>
            <Field label="From"><DateInput value={hFrom} onChange={setHFrom} /></Field>
            <Field label="To"><DateInput value={hTo} onChange={setHTo} /></Field>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard title={hFrom ? `Balance before ${fmtDate(hFrom)}` : 'Opening balance'} value={fmtMoney(hist?.opening ?? 0)} icon={<Wallet className="h-4 w-4" />} toneClass="bg-muted text-muted-foreground" />
            <StatCard title="Money in" value={fmtMoney(hist?.totals.moneyIn ?? 0)} icon={<ArrowDownLeft className="h-4 w-4" />} toneClass="bg-success-soft text-success" />
            <StatCard title="Money out" value={fmtMoney(hist?.totals.moneyOut ?? 0)} icon={<ArrowUpRight className="h-4 w-4" />} toneClass="bg-danger-soft text-destructive" />
            <StatCard title={hTo ? `Balance on ${fmtDate(hTo)}` : 'Balance now'} value={fmtMoney(hist?.closing ?? 0)} icon={<Landmark className="h-4 w-4" />} toneClass="bg-info-soft text-info" />
          </div>
          {hist?.filtered && (
            <p className="mt-2 text-xs text-muted-foreground">Money in / out are for the rows shown; the balances are for the whole {hAccount ? 'account' : 'cash & bank'}.</p>
          )}
          {!!hist?.pendingCheques.count && (
            <p className="mt-2 text-xs text-warning">
              {hist.pendingCheques.count} cheque{hist.pendingCheques.count === 1 ? '' : 's'} not cleared yet
              {hist.pendingCheques.toReceive ? ` · ${fmtMoney(hist.pendingCheques.toReceive)} to receive` : ''}
              {hist.pendingCheques.toPay ? ` · ${fmtMoney(hist.pendingCheques.toPay)} to pay` : ''} — not counted in the balance until cleared.
            </p>
          )}
          <div className="mt-3">
            <DataTable
              columns={historyColumns} rows={hist?.items ?? []} loading={history.loading} pageSize={20}
              searchPlaceholder="Search number, party, details…" emptyText="No money movements for these filters"
              csvExport={{
                filename: 'cash-bank-transactions',
                headers: ['Date', 'Type', 'Number', 'Party', 'Details', 'Account', 'Money in', 'Money out', 'Balance'],
                pick: (r) => [r.date ? String(r.date).slice(0, 10) : '', r.typeLabel, r.number, r.party, r.description, r.accountName, r.moneyIn, r.moneyOut, r.balance],
              }}
            />
          </div>
        </TabsContent>

        {/* ----- Cash in hand ----- */}
        <TabsContent value="cash" className="mt-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <p className="mr-auto text-sm text-muted-foreground">Owner capital, drawings and other cash adjustments</p>
            <Button size="sm" onClick={() => openAdjust('ADJUST_IN')}><ArrowDownLeft className="h-4 w-4 mr-1.5" />Add cash</Button>
            <Button size="sm" variant="outline" onClick={() => openAdjust('ADJUST_OUT')}><ArrowUpRight className="h-4 w-4 mr-1.5" />Reduce cash</Button>
          </div>
          <DataTable columns={adjustColumns} rows={adjustRows} loading={txns.loading} searchPlaceholder="Search entries…" emptyText="No cash adjustments yet" />
        </TabsContent>

        {/* ----- Contra ----- */}
        <TabsContent value="contra" className="mt-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <p className="mr-auto text-sm text-muted-foreground">Cash deposits, withdrawals and bank-to-bank transfers</p>
            <Button size="sm" onClick={openTransfer}><ArrowLeftRight className="h-4 w-4 mr-1.5" />Transfer</Button>
          </div>
          <DataTable columns={contraColumns} rows={contraRows} loading={txns.loading} searchPlaceholder="Search transfers…" emptyText="No transfers yet" />
        </TabsContent>

        {/* ----- Loans ----- */}
        <TabsContent value="loans" className="mt-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <p className="mr-auto text-sm text-muted-foreground">Business loans — EMIs split into principal and interest</p>
            <Button size="sm" onClick={openLoan}><Plus className="h-4 w-4 mr-1.5" />Add loan</Button>
          </div>
          <DataTable columns={loanColumns} rows={loanRows} loading={loans.loading} searchPlaceholder="Search loans…" emptyText="No loans recorded" />
        </TabsContent>
      </Tabs>

      {/* ----- Money In / Money Out: pick what kind of money it is ----- */}
      <Dialog open={!!chooser} onOpenChange={(o) => { if (!o) setChooser(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{chooser === 'IN' ? 'Money In' : 'Money Out'}</DialogTitle>
            <DialogDescription>{chooser === 'IN' ? 'Where is the money coming from?' : 'What is the money for?'}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            {(chooser === 'IN' ? [
              { key: 'customer', icon: <Users className="h-5 w-5" />, title: 'From a customer', text: 'Payment against a sales invoice', run: () => openCreate('payments', { type: 'RECEIPT' }) },
              { key: 'advance', icon: <Users className="h-5 w-5" />, title: 'Advance from a customer', text: 'Before an invoice — applied to invoices later', run: () => openCreate('payments', { type: 'RECEIPT', advance: 1 }) },
              { key: 'supplierRefund', icon: <Receipt className="h-5 w-5" />, title: 'Refund from a supplier', text: 'Against a purchase return (debit note)', run: () => goTo('purchase-returns') },
              { key: 'add', icon: <Wallet className="h-5 w-5" />, title: 'Capital or other income', text: 'Owner money, interest received and similar', run: () => openAdjust('ADJUST_IN') },
            ] : [
              { key: 'supplier', icon: <Users className="h-5 w-5" />, title: 'To a supplier', text: 'Payment against a purchase bill', run: () => openCreate('payments', { type: 'PAYMENT' }) },
              { key: 'expense', icon: <Receipt className="h-5 w-5" />, title: 'Expense', text: 'Rent, electricity, salary, freight…', run: () => openCreate('expenses') },
              { key: 'customerRefund', icon: <Users className="h-5 w-5" />, title: 'Refund to a customer', text: 'Against a sales return (credit note)', run: () => goTo('sales-returns') },
              { key: 'reduce', icon: <Wallet className="h-5 w-5" />, title: 'Drawings or other', text: 'Owner withdrawal and similar', run: () => openAdjust('ADJUST_OUT') },
            ]).map((o) => (
              <button
                key={o.key} type="button" onClick={() => choose(o.run)}
                className="flex items-center gap-3 rounded-lg border p-3 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className={`shrink-0 rounded-lg p-2 ${chooser === 'IN' ? 'bg-success-soft text-success' : 'bg-warning-soft text-warning'}`}>{o.icon}</span>
                <span className="min-w-0">
                  <span className="block font-medium">{o.title}</span>
                  <span className="block text-xs text-muted-foreground">{o.text}</span>
                </span>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* ----- Adjust cash to the counted amount ----- */}
      <FormDialog
        open={cntOpen} onOpenChange={setCntOpen} loading={cntSaving} onSubmit={saveCount}
        title="Adjust Cash" description="Count the cash in hand and bring the books in line with it"
        submitLabel={cntReviewed === null ? 'Review' : 'Confirm adjustment'}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Cash account" required className="sm:col-span-2">
            <SelectInput value={cntAccountId} onChange={(v) => { setCntAccount(v); setCntBalance(null); setCntReviewed(null) }} options={cashAccounts.map((a) => ({ value: a.id, label: a.name }))} placeholder={cashAccounts.length ? 'Select…' : 'No cash account — set up Cash in Hand first'} />
          </Field>
          <Field label="As on date" required><DateInput value={cntDate} onChange={(v) => { setCntDate(v); setCntBalance(null); setCntReviewed(null) }} /></Field>
          <Field label="Cash in the books">
            <div className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm tabular-nums">{cntBalance === null ? (cntAccountId ? 'Loading…' : '—') : fmtMoney(cntBalance)}</div>
          </Field>
          <Field label="Cash you counted (₹)" required className="sm:col-span-2">
            <NumberInput value={cntCounted} onChange={(n) => { setCntCounted(n); setCntReviewed(null) }} min={0} step="0.01" />
          </Field>
          {cntDiff !== null && (
            <div className={`sm:col-span-2 rounded-md border p-3 text-sm ${Math.abs(cntDiff) < 0.005 ? '' : cntDiff > 0 ? 'border-success-border bg-success-soft dark:bg-success-soft' : 'border-warning-border bg-warning-soft/30'}`}>
              {Math.abs(cntDiff) < 0.005
                ? 'Counted cash matches the books — nothing will be saved.'
                : cntDiff > 0
                  ? <>Excess of <b>{fmtMoney(cntDiff)}</b> — will be added to cash as <b>Other income</b>.</>
                  : <>Shortage of <b>{fmtMoney(-cntDiff)}</b> — will be taken out of cash as <b>Other expense</b>.</>}
              {cntReviewed !== null && <p className="mt-1 text-xs text-muted-foreground">Press “Confirm adjustment” to save it.</p>}
            </div>
          )}
        </div>
      </FormDialog>

      {/* ----- Account dialog ----- */}
      <FormDialog
        open={accOpen} onOpenChange={setAccOpen} loading={accSaving} onSubmit={saveAccount}
        title={accEditing ? `Edit ${accEditing.name}` : accForm.type === 'BANK' ? 'Add bank account' : 'Add cash account'}
        submitLabel={accEditing ? 'Save' : 'Add account'}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Account name" required className="sm:col-span-2">
            <TextInput value={accForm.name} onChange={(e) => setAcc('name', e.target.value)} placeholder={accForm.type === 'BANK' ? 'e.g. SBI Current A/c' : 'e.g. Petty Cash'} />
          </Field>
          {accForm.type === 'BANK' && (
            <>
              <Field label="Bank name"><TextInput value={accForm.bankName} onChange={(e) => setAcc('bankName', e.target.value)} placeholder="State Bank of India" /></Field>
              <Field label="Account number"><TextInput value={accForm.accountNo} onChange={(e) => setAcc('accountNo', e.target.value)} inputMode="numeric" /></Field>
              <Field label="IFSC"><TextInput value={accForm.ifsc} onChange={(e) => setAcc('ifsc', e.target.value.toUpperCase())} maxLength={11} placeholder="SBIN0001234" /></Field>
              <Field label="Branch"><TextInput value={accForm.branch} onChange={(e) => setAcc('branch', e.target.value)} /></Field>
              <Field label="Account holder name"><TextInput value={accForm.holderName} onChange={(e) => setAcc('holderName', e.target.value)} /></Field>
              <Field label="UPI ID"><TextInput value={accForm.upiId} onChange={(e) => setAcc('upiId', e.target.value)} placeholder="business@okicici" /></Field>
            </>
          )}
          <Field label="Opening balance (₹)"><NumberInput value={accForm.openingBalance} onChange={(n) => setAcc('openingBalance', n)} step="0.01" /></Field>
          <Field label="As of date" required={Math.abs(accForm.openingBalance || 0) >= 0.005}><DateInput value={accForm.openingDate} onChange={(v) => setAcc('openingDate', v)} /></Field>
          <div className="grid gap-2 sm:col-span-2">
            {accForm.type === 'BANK' && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={accForm.printOnInvoice} onCheckedChange={(v) => setAcc('printOnInvoice', v === true)} />
                Print bank details on invoice
              </label>
            )}
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={accForm.isDefault} onCheckedChange={(v) => setAcc('isDefault', v === true)} />
              Default {accForm.type === 'BANK' ? 'bank' : 'cash'} account (used when none is chosen)
            </label>
            {accEditing && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={accForm.active} onCheckedChange={(v) => setAcc('active', v === true)} />
                Active
              </label>
            )}
          </div>
        </div>
      </FormDialog>

      {/* ----- Statement / reconciliation ----- */}
      <Dialog open={!!stmtAccount} onOpenChange={(o) => { if (!o) { setStmtAccount(null); setStmt(null) } }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl max-sm:h-[100dvh] max-sm:max-h-[100dvh] max-sm:max-w-full max-sm:w-full max-sm:rounded-none max-sm:p-4">
          <DialogHeader>
            <DialogTitle>{stmtAccount?.name} — statement</DialogTitle>
            <DialogDescription>
              {isBankStmt ? 'Tick entries as they appear in your bank statement to reconcile.' : 'All money in and out of this account.'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="From"><DateInput value={stmtFrom} onChange={setStmtFrom} className="w-40" /></Field>
            <Field label="To"><DateInput value={stmtTo} onChange={setStmtTo} className="w-40" /></Field>
            <Button size="sm" className="h-9" onClick={() => stmtAccount && loadStatement(stmtAccount, stmtFrom, stmtTo)} disabled={stmtLoading}>
              {stmtLoading ? 'Loading…' : 'Show'}
            </Button>
            {isBankStmt && (
              <label className="ml-auto flex items-center gap-2 text-sm">
                <Checkbox checked={unclearedOnly} onCheckedChange={(v) => setUnclearedOnly(v === true)} />Uncleared only
              </label>
            )}
          </div>
          {stmt && (
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <div className="rounded-md border p-2"><p className="text-[11px] text-muted-foreground">Opening</p><Money value={stmt.opening} className="font-medium" /></div>
              <div className="rounded-md border p-2"><p className="text-[11px] text-muted-foreground">Money in</p><Money value={stmt.totalIn} className="font-medium text-success" /></div>
              <div className="rounded-md border p-2"><p className="text-[11px] text-muted-foreground">Money out</p><Money value={stmt.totalOut} className="font-medium text-destructive" /></div>
              <div className="rounded-md border p-2"><p className="text-[11px] text-muted-foreground">Closing</p><Money value={stmt.closing} className="font-semibold" /></div>
              {isBankStmt && (
                <div className="col-span-2 rounded-md border border-dashed p-2 sm:col-span-4">
                  <span className="text-[11px] text-muted-foreground">As per bank (opening + cleared entries): </span>
                  <Money value={r2(stmt.opening + clearedNet)} className="font-medium" />
                  <span className="text-[11px] text-muted-foreground"> • difference </span>
                  <Money value={r2(stmt.closing - stmt.opening - clearedNet)} className="font-medium" />
                </div>
              )}
            </div>
          )}
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-2 py-2 text-left font-medium">Date</th>
                  <th className="px-2 py-2 text-left font-medium">Particulars</th>
                  <th className="px-2 py-2 text-right font-medium">In</th>
                  <th className="px-2 py-2 text-right font-medium">Out</th>
                  <th className="px-2 py-2 text-right font-medium">Balance</th>
                  {isBankStmt && <th className="px-2 py-2 text-center font-medium">Cleared</th>}
                </tr>
              </thead>
              <tbody>
                {stmt && !unclearedOnly && (
                  <tr className="border-t bg-muted/20">
                    <td className="px-2 py-1.5 text-muted-foreground whitespace-nowrap">{stmtFrom ? fmtDate(stmtFrom) : '—'}</td>
                    <td className="px-2 py-1.5 font-medium">Opening balance</td>
                    <td /><td />
                    <td className="px-2 py-1.5 text-right"><Money value={stmt.opening} /></td>
                    {isBankStmt && <td />}
                  </tr>
                )}
                {stmtRows.map((r) => (
                  <tr key={`${r.kind}-${r.id}`} className="border-t align-top">
                    <td className="px-2 py-1.5 text-muted-foreground whitespace-nowrap">{fmtDate(r.date)}</td>
                    <td className="px-2 py-1.5">
                      <div className="font-medium">{r.type}{r.ref ? <span className="ml-1 font-mono text-[11px] text-muted-foreground">{r.ref}</span> : null}</div>
                      {r.party && <div className="max-w-[260px] truncate text-xs text-muted-foreground" title={r.party}>{r.party}</div>}
                    </td>
                    <td className="px-2 py-1.5 text-right">{r.in ? <Money value={r.in} className="text-success" /> : ''}</td>
                    <td className="px-2 py-1.5 text-right">{r.out ? <Money value={r.out} className="text-destructive" /> : ''}</td>
                    <td className="px-2 py-1.5 text-right"><Money value={r.balance} /></td>
                    {isBankStmt && (
                      <td className="px-2 py-1.5 text-center">
                        {r.kind !== 'opening' && (
                          <div className="flex flex-col items-center gap-0.5">
                            <Checkbox checked={!!r.clearedDate} onCheckedChange={(v) => toggleCleared(r, v === true)} aria-label="Cleared" />
                            {r.clearedDate && <span className="text-[10px] text-muted-foreground whitespace-nowrap">{fmtDate(r.clearedDate)}</span>}
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
                {stmt && !stmtRows.length && (
                  <tr><td colSpan={isBankStmt ? 6 : 5} className="px-2 py-6 text-center text-muted-foreground">No entries in this period</td></tr>
                )}
                {!stmt && (
                  <tr><td colSpan={isBankStmt ? 6 : 5} className="px-2 py-6 text-center text-muted-foreground">{stmtLoading ? 'Loading…' : 'Pick a date range and press Show'}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </DialogContent>
      </Dialog>

      {/* ----- Add / reduce money ----- */}
      <FormDialog
        open={!!adjOpen} onOpenChange={(o) => { if (!o) setAdjOpen(null) }} loading={adjSaving} onSubmit={saveAdjust}
        title={adjOpen === 'ADJUST_IN' ? 'Add cash' : 'Reduce cash'}
        description={adjOpen === 'ADJUST_IN' ? 'Money brought into the business — owner capital, other income…' : 'Money taken out — owner drawings, other expenses…'}
        submitLabel="Save"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Account" required className="sm:col-span-2">
            <SelectInput value={adjAccount} onChange={setAdjAccount} options={accountOpts(activeAccounts)} placeholder="Select account…" />
          </Field>
          <Field label="Amount (₹)" required><NumberInput value={adjAmount} onChange={setAdjAmount} min={0} step="0.01" /></Field>
          <Field label="Date" required><DateInput value={adjDate} onChange={setAdjDate} /></Field>
          <Field label="Category" className="sm:col-span-2">
            <SelectInput value={adjCategory} onChange={setAdjCategory} options={adjOpen === 'ADJUST_IN' ? IN_CATEGORIES : OUT_CATEGORIES} />
          </Field>
          <Field label="Notes" className="sm:col-span-2"><TextInput value={adjNotes} onChange={(e) => setAdjNotes(e.target.value)} placeholder="Remarks…" /></Field>
        </div>
      </FormDialog>

      {/* ----- Transfer ----- */}
      <FormDialog open={trOpen} onOpenChange={setTrOpen} loading={trSaving} onSubmit={saveTransfer} title="Transfer money" description="Contra entry — moves money between your own accounts" submitLabel="Transfer">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Transfer type" required className="sm:col-span-2">
            <SelectInput value={trKind} onChange={pickTransferKind} options={TRANSFER_KINDS} />
          </Field>
          <Field label="From" required>
            <SelectInput value={trFrom} onChange={(v) => { setTrFrom(v); if (v === trTo) setTrTo('') }} options={accountOpts(trFromList)} placeholder={trFromList.length ? 'Select…' : 'No account'} />
          </Field>
          <Field label="To" required>
            <SelectInput value={trTo} onChange={setTrTo} options={accountOpts(trToList)} placeholder={trToList.length ? 'Select…' : 'No account — add one first'} />
          </Field>
          <Field label="Amount (₹)" required><NumberInput value={trAmount} onChange={setTrAmount} min={0} step="0.01" /></Field>
          <Field label="Date" required><DateInput value={trDate} onChange={setTrDate} /></Field>
          <Field label="Reference"><TextInput value={trRef} onChange={(e) => setTrRef(e.target.value)} placeholder="Deposit slip / UTR" /></Field>
          <Field label="Notes"><TextInput value={trNotes} onChange={(e) => setTrNotes(e.target.value)} /></Field>
        </div>
      </FormDialog>

      {/* ----- Add loan ----- */}
      <FormDialog open={loanOpen} onOpenChange={setLoanOpen} loading={loanSaving} onSubmit={saveLoan} title="Add loan" submitLabel="Save loan"
        description="The loan amount (less processing fee) is credited to the chosen account">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Loan name" required className="sm:col-span-2"><TextInput value={loanForm.name} onChange={(e) => setLoan('name', e.target.value)} placeholder="e.g. HDFC Machinery Loan" /></Field>
          <Field label="Lender"><TextInput value={loanForm.lender} onChange={(e) => setLoan('lender', e.target.value)} placeholder="Bank / NBFC / person" /></Field>
          <Field label="Loan account no."><TextInput value={loanForm.loanAccountNo} onChange={(e) => setLoan('loanAccountNo', e.target.value)} /></Field>
          <Field label="Loan amount (₹)" required><NumberInput value={loanForm.principal} onChange={(n) => setLoan('principal', n)} min={0} step="0.01" /></Field>
          <Field label="Processing fee (₹)"><NumberInput value={loanForm.processingFee} onChange={(n) => setLoan('processingFee', n)} min={0} step="0.01" /></Field>
          <Field label="Interest rate (% p.a.)"><NumberInput value={loanForm.interestRate} onChange={(n) => setLoan('interestRate', n)} min={0} step="0.01" /></Field>
          <Field label="Term (months)"><NumberInput value={loanForm.termMonths} onChange={(n) => setLoan('termMonths', n)} min={0} /></Field>
          <Field label="EMI (₹)">
            <NumberInput value={loanForm.emiAmount} onChange={(n) => setLoan('emiAmount', n)} min={0} step="0.01" placeholder={suggestedEmi ? String(suggestedEmi) : undefined} />
          </Field>
          <Field label="Start date" required><DateInput value={loanForm.startDate} onChange={(v) => setLoan('startDate', v)} /></Field>
          <Field label="Received in account" required className="sm:col-span-2">
            <SelectInput value={loanForm.receivedAccountId} onChange={(v) => setLoan('receivedAccountId', v)} options={accountOpts(activeAccounts)} placeholder="Select account…" />
          </Field>
          <p className="text-[11px] text-muted-foreground sm:col-span-2">
            {loanForm.principal > 0 && `Credited: ${fmtMoney(r2(loanForm.principal - loanForm.processingFee))}`}
            {suggestedEmi > 0 && ` • Suggested EMI ${fmtMoney(suggestedEmi)}${loanForm.emiAmount > 0 ? '' : ' (used if EMI is left 0)'}`}
          </p>
        </div>
      </FormDialog>

      {/* ----- Pay EMI ----- */}
      <FormDialog
        open={!!emiLoan} onOpenChange={(o) => { if (!o) setEmiLoan(null) }} loading={emiSaving} onSubmit={saveEmi}
        title={`Pay EMI — ${emiLoan?.name ?? ''}`} submitLabel={`Pay ${fmtMoney(r2(emiPrincipal + emiInterest))}`}
        description={emiLoan ? `Outstanding principal ${fmtMoney(emiLoan.outstanding)}${emiLoan.interestRate ? ` • ${emiLoan.interestRate}% p.a.` : ''}` : undefined}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Principal (₹)" required><NumberInput value={emiPrincipal} onChange={setEmiPrincipal} min={0} step="0.01" /></Field>
          <Field label="Interest (₹)"><NumberInput value={emiInterest} onChange={setEmiInterest} min={0} step="0.01" /></Field>
          <Field label="Date" required><DateInput value={emiDate} onChange={setEmiDate} /></Field>
          <Field label="Paid from" required>
            <SelectInput value={emiAccount} onChange={setEmiAccount} options={accountOpts(activeAccounts)} placeholder="Select account…" />
          </Field>
          <Field label="Reference" className="sm:col-span-2"><TextInput value={emiRef} onChange={(e) => setEmiRef(e.target.value)} placeholder="Auto-debit ref / cheque no." /></Field>
          {emiLoan && (
            <p className="text-[11px] text-muted-foreground sm:col-span-2">
              Outstanding after this EMI: {fmtMoney(Math.max(0, r2(emiLoan.outstanding - emiPrincipal)))}
              {emiLoan.outstanding - emiPrincipal <= 0.01 && ' — the loan will be closed'}
            </p>
          )}
        </div>
      </FormDialog>
    </div>
  )
}
