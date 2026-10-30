'use client'

import * as React from 'react'
import { toast } from 'sonner'
import {
  ArrowRight, CalendarClock, Check, Flame, Pencil, Phone, Plus, Target, Trash2, TrendingUp, Trophy, UserPlus, X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Column, ConfirmAction, DataTable, DateInput, Field, FormDialog, Money, NumberInput, PageHeader,
  SectionCard, SelectInput, StatCard, TextInput,
} from '@/components/erp/kit'
import { fmtDate, fmtMoney } from '@/lib/erp-constants'
import { apiDelete, apiPatch, apiPost, useList } from '@/lib/use-api'
import {
  ACTIVITY_KINDS, ACTIVITY_LABEL, LEAD_SOURCES, LEAD_STAGES, OPEN_STAGES, SOURCE_LABEL, STAGE_LABEL,
  STAGE_PROBABILITY, STAGE_TONE, daysUntil, nextStage, type LeadStage,
} from '@/lib/crm'

/**
 * CRM — the sales side of the funnel, which the ERP was missing:
 *
 *   Pipeline   leads as cards by stage, advance / win / lose them
 *   Leads      the same records as a table, with the create + edit form
 *   Follow-ups calls, meetings and reminders booked against a lead
 *
 * Winning a lead (`Convert`) creates the Customer master from it and links the two, so the
 * quotation / order can be raised without retyping the party.
 */

interface ActivityRow {
  id: string
  leadId: string
  kind: string
  summary: string
  notes?: string | null
  dueDate?: string | null
  doneAt?: string | null
  owner?: string | null
  lead?: { id: string; code: string; name: string; companyName?: string | null } | null
}

interface LeadRow {
  id: string
  code: string
  name: string
  companyName?: string | null
  phone?: string | null
  email?: string | null
  city?: string | null
  source: string
  stage: LeadStage
  value: number
  probability: number
  owner?: string | null
  expectedCloseDate?: string | null
  lostReason?: string | null
  notes?: string | null
  customerId?: string | null
  convertedAt?: string | null
  activities?: ActivityRow[]
}

interface LeadsResponse {
  items: LeadRow[]
  total: number
  summary?: { total: number; open: number; pipelineValue: number; weightedValue: number; won: number; lost: number; wonValue: number }
}

interface LeadForm {
  name: string
  companyName: string
  phone: string
  email: string
  city: string
  source: string
  stage: LeadStage
  value: number
  probability: number
  owner: string
  expectedCloseDate: string
  notes: string
}

const emptyLead: LeadForm = {
  name: '', companyName: '', phone: '', email: '', city: '', source: 'OTHER', stage: 'NEW',
  value: 0, probability: STAGE_PROBABILITY.NEW, owner: '', expectedCloseDate: '', notes: '',
}

const isoDate = (d?: string | null) => (d ? String(d).slice(0, 10) : '')

const stageOptions = LEAD_STAGES.map((s) => ({ value: s, label: STAGE_LABEL[s] }))
const sourceOptions = LEAD_SOURCES.map((s) => ({ value: s, label: SOURCE_LABEL[s] }))

/** "in 3 days" / "2 days ago" for a due date. */
function dueLabel(d: string): { text: string; overdue: boolean } {
  const days = daysUntil(d)
  if (days === null) return { text: '—', overdue: false }
  if (days < 0) return { text: `${-days} day${days === -1 ? '' : 's'} overdue`, overdue: true }
  if (days === 0) return { text: 'due today', overdue: false }
  return { text: `in ${days} day${days === 1 ? '' : 's'}`, overdue: false }
}

export default function CrmModule({ companyId }: { companyId: string }) {
  const { data, loading, refetch } = useList<LeadsResponse>(`/api/leads?companyId=${companyId}`)
  const [tab, setTab] = React.useState('pipeline')
  const followUps = useList<{ items: ActivityRow[] }>(tab === 'followups' ? `/api/lead-activities?companyId=${companyId}&open=1` : null)

  const leads = data?.items ?? []
  const summary = data?.summary
  const open = leads.filter((l) => OPEN_STAGES.includes(l.stage))

  const [openForm, setOpenForm] = React.useState(false)
  const [editing, setEditing] = React.useState<LeadRow | null>(null)
  const [form, setForm] = React.useState<LeadForm>(emptyLead)
  const [saving, setSaving] = React.useState(false)

  const [followFor, setFollowFor] = React.useState<LeadRow | null>(null)
  const [followForm, setFollowForm] = React.useState({ kind: 'CALL', summary: '', dueDate: '', notes: '' })
  const [savingFollow, setSavingFollow] = React.useState(false)

  const set = <K extends keyof LeadForm>(k: K, v: LeadForm[K]) => setForm((f) => ({ ...f, [k]: v }))

  function openCreate() {
    setEditing(null)
    setForm(emptyLead)
    setOpenForm(true)
  }

  function openEdit(lead: LeadRow) {
    setEditing(lead)
    setForm({
      name: lead.name, companyName: lead.companyName ?? '', phone: lead.phone ?? '', email: lead.email ?? '',
      city: lead.city ?? '', source: lead.source || 'OTHER', stage: lead.stage, value: lead.value ?? 0,
      probability: lead.probability ?? 0, owner: lead.owner ?? '',
      expectedCloseDate: isoDate(lead.expectedCloseDate), notes: lead.notes ?? '',
    })
    setOpenForm(true)
  }

  async function submit() {
    if (!form.name.trim()) { toast.error('Contact name is required'); return }
    setSaving(true)
    try {
      const body = {
        companyId,
        name: form.name.trim(),
        companyName: form.companyName.trim() || null,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        city: form.city.trim() || null,
        source: form.source,
        stage: form.stage,
        value: form.value,
        probability: form.probability,
        owner: form.owner.trim() || null,
        expectedCloseDate: form.expectedCloseDate || null,
        notes: form.notes.trim() || null,
      }
      if (editing) await apiPatch(`/api/leads/${editing.id}`, body)
      else await apiPost('/api/leads', body)
      toast.success(editing ? 'Lead updated' : 'Lead added to the pipeline')
      setOpenForm(false)
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the lead')
    } finally {
      setSaving(false)
    }
  }

  async function moveStage(lead: LeadRow, stage: LeadStage) {
    if (stage === lead.stage) return
    try {
      await apiPatch(`/api/leads/${lead.id}`, { companyId, action: 'stage', stage })
      toast.success(`${lead.companyName || lead.name} → ${STAGE_LABEL[stage]}`)
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not move the lead')
    }
  }

  async function convert(lead: LeadRow) {
    try {
      const res = await apiPatch<{ customerId: string; created: boolean }>(`/api/leads/${lead.id}`, { companyId, action: 'convert' })
      toast.success(res?.created === false ? 'Already converted' : `Customer created from ${lead.companyName || lead.name}`, {
        description: 'The lead is marked Won and linked to the new customer master.',
      })
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not convert the lead')
    }
  }

  async function remove(lead: LeadRow) {
    try {
      await apiDelete(`/api/leads/${lead.id}?companyId=${companyId}`)
      toast.success('Lead deleted')
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete the lead')
    }
  }

  function openFollow(lead: LeadRow) {
    setFollowFor(lead)
    setFollowForm({ kind: 'CALL', summary: '', dueDate: isoDate(new Date(Date.now() + 86_400_000).toISOString()), notes: '' })
  }

  async function saveFollow() {
    if (!followFor) return
    if (!followForm.summary.trim()) { toast.error('What is the follow-up?'); return }
    setSavingFollow(true)
    try {
      await apiPost('/api/lead-activities', {
        companyId, leadId: followFor.id, kind: followForm.kind,
        summary: followForm.summary.trim(), dueDate: followForm.dueDate || null,
        notes: followForm.notes.trim() || null,
      })
      toast.success('Follow-up booked')
      setFollowFor(null)
      await Promise.all([refetch(), followUps.refetch()])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the follow-up')
    } finally {
      setSavingFollow(false)
    }
  }

  async function completeFollow(a: ActivityRow) {
    try {
      await apiPatch(`/api/lead-activities/${a.id}`, { companyId, done: !a.doneAt })
      if (tab === 'followups') await followUps.refetch()
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update the follow-up')
    }
  }

  // ---------- table ----------
  const columns: Column<LeadRow>[] = [
    { key: 'code', header: 'Lead', render: (r) => <span className="font-medium">{r.code}</span> },
    {
      key: 'name', header: 'Contact',
      render: (r) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{r.name}</p>
          <p className="truncate text-xs text-muted-foreground">{r.companyName || r.phone || '—'}</p>
        </div>
      ),
    },
    {
      key: 'stage', header: 'Stage',
      render: (r) => <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium ${STAGE_TONE[r.stage]}`}>{STAGE_LABEL[r.stage]}</span>,
    },
    { key: 'value', header: 'Deal value', sum: true, sumFormat: 'money', render: (r) => <Money value={r.value} /> },
    { key: 'probability', header: 'Prob.', hideOnMobile: true, render: (r) => <span className="tabular-nums">{r.probability}%</span> },
    {
      key: 'next', header: 'Next follow-up', hideOnMobile: true,
      render: (r) => {
        const a = r.activities?.[0]
        if (!a?.dueDate) return <span className="text-muted-foreground">—</span>
        const d = dueLabel(a.dueDate)
        return (
          <div className="min-w-0">
            <p className="truncate text-xs">{a.summary}</p>
            <p className={`text-[11px] ${d.overdue ? 'text-red-600' : 'text-muted-foreground'}`}>{fmtDate(a.dueDate)} · {d.text}</p>
          </div>
        )
      },
    },
    { key: 'owner', header: 'Owner', hideOnMobile: true, render: (r) => <span className="text-muted-foreground">{r.owner || '—'}</span> },
    {
      key: 'actions', header: '',
      render: (r) => (
        <div className="flex items-center justify-end gap-1">
          {r.stage !== 'WON' && (
            <Button type="button" variant="ghost" size="sm" title="Convert to customer" aria-label={`Convert ${r.code}`} onClick={() => void convert(r)}>
              <UserPlus className="h-3.5 w-3.5 text-emerald-600" />
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" title="Book a follow-up" aria-label={`Follow-up ${r.code}`} onClick={() => openFollow(r)}>
            <CalendarClock className="h-3.5 w-3.5" />
          </Button>
          <Button type="button" variant="ghost" size="sm" title="Edit lead" aria-label={`Edit ${r.code}`} onClick={() => openEdit(r)}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <ConfirmAction
            trigger={<Button type="button" variant="ghost" size="sm" title="Delete lead"><Trash2 className="h-3.5 w-3.5 text-red-600" /></Button>}
            title="Delete lead?"
            message={`${r.code} — ${r.name} and its follow-ups will be removed.`}
            onConfirm={() => void remove(r)}
          />
        </div>
      ),
    },
  ]

  const followColumns: Column<ActivityRow>[] = [
    {
      key: 'summary', header: 'Follow-up',
      render: (a) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{a.summary}</p>
          <p className="truncate text-xs text-muted-foreground">{ACTIVITY_LABEL[a.kind] || a.kind}{a.notes ? ` · ${a.notes}` : ''}</p>
        </div>
      ),
    },
    {
      key: 'lead', header: 'Lead', hideOnMobile: true,
      render: (a) => <span className="text-muted-foreground">{a.lead ? `${a.lead.code} — ${a.lead.companyName || a.lead.name}` : '—'}</span>,
    },
    {
      key: 'due', header: 'Due',
      render: (a) => {
        if (!a.dueDate) return <span className="text-muted-foreground">—</span>
        const d = dueLabel(a.dueDate)
        return (
          <span className={d.overdue ? 'text-red-600 font-medium' : undefined}>
            {fmtDate(a.dueDate)} <span className="text-xs text-muted-foreground">· {d.text}</span>
          </span>
        )
      },
    },
    {
      key: 'done', header: '',
      render: (a) => (
        <Button type="button" variant={a.doneAt ? 'secondary' : 'outline'} size="sm" onClick={() => void completeFollow(a)}>
          <Check className="h-3.5 w-3.5 mr-1" />{a.doneAt ? 'Done' : 'Mark done'}
        </Button>
      ),
    },
  ]

  return (
    <>
      <PageHeader
        title="CRM"
        description="Leads, the sales pipeline and follow-ups — win a lead and it becomes a customer"
        actions={<Button size="sm" onClick={openCreate}><Plus className="h-4 w-4 mr-1.5" />New lead</Button>}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Open pipeline" value={fmtMoney(summary?.pipelineValue ?? 0)} sub={`${summary?.open ?? open.length} open lead(s)`} icon={<Target className="h-4 w-4" />} />
        <StatCard title="Weighted forecast" value={fmtMoney(summary?.weightedValue ?? 0)} sub="Deal value × probability" icon={<TrendingUp className="h-4 w-4" />} toneClass="bg-sky-100 text-sky-600" />
        <StatCard title="Won" value={fmtMoney(summary?.wonValue ?? 0)} sub={`${summary?.won ?? 0} deal(s) closed`} icon={<Trophy className="h-4 w-4" />} toneClass="bg-emerald-100 text-emerald-600" />
        <StatCard title="Lost" value={summary?.lost ?? 0} sub="Closed without an order" icon={<Flame className="h-4 w-4" />} toneClass="bg-red-100 text-red-600" />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="pipeline">Pipeline</TabsTrigger>
          <TabsTrigger value="leads">Leads</TabsTrigger>
          <TabsTrigger value="followups">Follow-ups</TabsTrigger>
        </TabsList>

        <TabsContent value="pipeline" className="mt-4">
          <div className="flex gap-3 overflow-x-auto pb-2">
            {OPEN_STAGES.map((stage) => {
              const cards = leads.filter((l) => l.stage === stage)
              const total = cards.reduce((s, l) => s + (l.value || 0), 0)
              const next = nextStage(stage)
              return (
                <div key={stage} className="min-w-64 flex-1 rounded-xl border bg-muted/20 p-2">
                  <div className="mb-2 flex items-center justify-between px-1">
                    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STAGE_TONE[stage]}`}>{STAGE_LABEL[stage]}</span>
                    <span className="text-[11px] text-muted-foreground">{cards.length} · {fmtMoney(total)}</span>
                  </div>
                  <div className="space-y-2">
                    {cards.map((l) => {
                      const a = l.activities?.[0]
                      const due = a?.dueDate ? dueLabel(a.dueDate) : null
                      return (
                        <div key={l.id} className="rounded-lg border bg-background p-2 shadow-sm">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium">{l.companyName || l.name}</p>
                              <p className="truncate text-[11px] text-muted-foreground">{l.name} · {l.code}</p>
                            </div>
                            <span className="whitespace-nowrap text-xs font-medium tabular-nums">{fmtMoney(l.value)}</span>
                          </div>
                          {a && (
                            <p className={`mt-1 truncate text-[11px] ${due?.overdue ? 'text-red-600' : 'text-muted-foreground'}`}>
                              <CalendarClock className="mr-1 inline h-3 w-3" />{a.summary}{due ? ` · ${due.text}` : ''}
                            </p>
                          )}
                          <div className="mt-2 flex flex-wrap items-center gap-1">
                            {next && (
                              <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-[11px]"
                                aria-label={`Advance ${l.code}`} onClick={() => void moveStage(l, next)}>
                                <ArrowRight className="h-3 w-3 mr-1" />{STAGE_LABEL[next]}
                              </Button>
                            )}
                            <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-[11px]"
                              aria-label={`Follow-up ${l.code}`} onClick={() => openFollow(l)}>
                              <Plus className="h-3 w-3 mr-1" />Follow-up
                            </Button>
                            <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-[11px] text-emerald-700"
                              aria-label={`Convert ${l.code}`} onClick={() => void convert(l)}>
                              <Trophy className="h-3 w-3 mr-1" />Convert
                            </Button>
                            <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-[11px] text-red-600"
                              aria-label={`Mark ${l.code} lost`} onClick={() => void moveStage(l, 'LOST')}>
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                      )
                    })}
                    {!cards.length && <p className="px-1 py-4 text-center text-[11px] text-muted-foreground">Nothing here</p>}
                  </div>
                </div>
              )
            })}
          </div>
        </TabsContent>

        <TabsContent value="leads" className="mt-4">
          <SectionCard title="All leads">
            <DataTable
              columns={columns}
              rows={leads}
              loading={loading}
              searchPlaceholder="Search leads…"
              emptyText="No leads yet — add the first one"
              sortable
              moduleKey="crm"
              savedViewsKey={`${companyId}:crm`}
              csvExport={{ filename: 'crm-leads', pick: (r) => [r.code, r.name, r.companyName || '', r.phone || '', STAGE_LABEL[r.stage], r.value, r.probability, r.owner || ''] }}
              xlsxExport={{ filename: 'crm-leads', headers: ['Code', 'Contact', 'Company', 'Phone', 'Stage', 'Value', 'Probability', 'Owner'], pick: (r) => [r.code, r.name, r.companyName || '', r.phone || '', STAGE_LABEL[r.stage], r.value, r.probability, r.owner || ''] }}
            />
          </SectionCard>
        </TabsContent>

        <TabsContent value="followups" className="mt-4">
          <SectionCard title="Open follow-ups">
            <DataTable
              columns={followColumns}
              rows={followUps.data?.items ?? []}
              loading={followUps.loading}
              searchPlaceholder="Search follow-ups…"
              emptyText="Nothing scheduled — book a follow-up from the pipeline"
              sortable
            />
          </SectionCard>
        </TabsContent>
      </Tabs>

      {/* ---------- create / edit ---------- */}
      <FormDialog
        open={openForm}
        onOpenChange={setOpenForm}
        title={editing ? `Edit ${editing.code}` : 'New lead'}
        description="A prospect plus the deal you expect from them"
        onSubmit={submit}
        loading={saving}
        submitLabel={editing ? 'Update' : 'Save'}
        wide
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Contact name" required>
            <TextInput value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Rahul Deshmukh" />
          </Field>
          <Field label="Company">
            <TextInput value={form.companyName} onChange={(e) => set('companyName', e.target.value)} placeholder="Deccan Auto Systems" />
          </Field>
          <Field label="Phone">
            <TextInput value={form.phone} onChange={(e) => set('phone', e.target.value)} inputMode="tel" maxLength={14} placeholder="9822011223" />
          </Field>
          <Field label="Email">
            <TextInput value={form.email} onChange={(e) => set('email', e.target.value)} type="email" />
          </Field>
          <Field label="City">
            <TextInput value={form.city} onChange={(e) => set('city', e.target.value)} placeholder="Pune" />
          </Field>
          <Field label="Source">
            <SelectInput value={form.source} onChange={(v) => set('source', v)} options={sourceOptions} />
          </Field>
          <Field label="Stage">
            <SelectInput value={form.stage} onChange={(v) => set('stage', v as LeadStage)} options={stageOptions} />
          </Field>
          <Field label="Deal value (₹)">
            <NumberInput value={form.value} min={0} onChange={(n) => set('value', n)} />
          </Field>
          <Field label="Probability %">
            <NumberInput value={form.probability} min={0} max={100} onChange={(n) => set('probability', n)} />
          </Field>
          <Field label="Expected close">
            <DateInput value={form.expectedCloseDate} onChange={(v) => set('expectedCloseDate', v)} />
          </Field>
          <Field label="Owner">
            <TextInput value={form.owner} onChange={(e) => set('owner', e.target.value)} placeholder="Sales person" />
          </Field>
          <Field label="Notes" className="sm:col-span-2">
            <TextInput value={form.notes} onChange={(e) => set('notes', e.target.value)} placeholder="What did they ask for?" />
          </Field>
        </div>
      </FormDialog>

      {/* ---------- follow-up ---------- */}
      <FormDialog
        open={!!followFor}
        onOpenChange={(o) => { if (!o) setFollowFor(null) }}
        title={followFor ? `Follow-up — ${followFor.companyName || followFor.name}` : 'Follow-up'}
        description="Book the next call, meeting or reminder against this lead"
        onSubmit={saveFollow}
        loading={savingFollow}
        submitLabel="Book"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type">
            <SelectInput
              value={followForm.kind}
              onChange={(v) => setFollowForm((f) => ({ ...f, kind: v }))}
              options={ACTIVITY_KINDS.map((k) => ({ value: k, label: ACTIVITY_LABEL[k] }))}
            />
          </Field>
          <Field label="Due date">
            <DateInput value={followForm.dueDate} onChange={(v) => setFollowForm((f) => ({ ...f, dueDate: v }))} />
          </Field>
          <Field label="What is the follow-up?" required className="sm:col-span-2">
            <TextInput
              value={followForm.summary}
              onChange={(e) => setFollowForm((f) => ({ ...f, summary: e.target.value }))}
              placeholder="Send revised quotation for 500 nos"
            />
          </Field>
          <Field label="Notes" className="sm:col-span-2">
            <TextInput value={followForm.notes} onChange={(e) => setFollowForm((f) => ({ ...f, notes: e.target.value }))} />
          </Field>
        </div>
      </FormDialog>
    </>
  )
}

/* Small helper kept for the lead card: a phone that is dialable when present. */
export function LeadPhone({ phone }: { phone?: string | null }) {
  if (!phone) return null
  return (
    <a className="inline-flex items-center gap-1 text-xs text-emerald-700" href={`tel:${phone}`}>
      <Phone className="h-3 w-3" />{phone}
    </a>
  )
}
