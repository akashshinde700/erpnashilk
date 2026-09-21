'use client'

import * as React from 'react'
import { CheckCheck, Hash, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Column, DataTable, Field, PageHeader, SectionCard, StatusBadge, TextInput } from '@/components/erp/kit'
import { fmtDateTime } from '@/lib/erp-constants'
import { apiPatch, useList } from '@/lib/use-api'

interface CompanyProfile {
  id: string
  name: string
  gstin?: string | null
  pan?: string | null
  addressLine?: string | null
  city?: string | null
  state?: string | null
  stateCode?: string | null
  phone?: string | null
  email?: string | null
  logoText?: string | null
}

type ProfileForm = { [K in keyof Omit<CompanyProfile, 'id'>]: string }

const EMPTY_PROFILE: ProfileForm = {
  name: '', gstin: '', pan: '', addressLine: '', city: '', state: '', stateCode: '', phone: '', email: '', logoText: '',
}

interface SeqRow {
  id: string
  docType: string
  prefix: string
  financialYear: string
  nextNumber: number
}

interface NotificationRow {
  id: string
  title: string
  message?: string | null
  level: string
  read: boolean
  createdAt: string
}

export default function SettingsModule({ companyId }: { companyId: string }) {
  const settings = useList<CompanyProfile>(`/api/settings?companyId=${companyId}`)
  const numbering = useList<{ seqs?: SeqRow[] }>(`/api/numbering?companyId=${companyId}`)
  const notifications = useList<{ items?: NotificationRow[]; unreadCount?: number }>(`/api/notifications?companyId=${companyId}`)

  const [form, setForm] = React.useState<ProfileForm>(EMPTY_PROFILE)
  const [saving, setSaving] = React.useState(false)
  const [markingAll, setMarkingAll] = React.useState(false)

  React.useEffect(() => {
    const d = settings.data
    if (d) {
      setForm({
        name: d.name || '',
        gstin: d.gstin || '',
        pan: d.pan || '',
        addressLine: d.addressLine || '',
        city: d.city || '',
        state: d.state || '',
        stateCode: d.stateCode || '',
        phone: d.phone || '',
        email: d.email || '',
        logoText: d.logoText || '',
      })
    }
  }, [settings.data])

  async function saveProfile() {
    if (!form.name.trim()) {
      toast.error('Company name is required')
      return
    }
    setSaving(true)
    try {
      await apiPatch('/api/settings', { companyId, ...form, name: form.name.trim(), userName: 'admin' })
      toast.success('Company profile updated')
      await settings.refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update company profile')
    } finally {
      setSaving(false)
    }
  }

  async function markAllRead() {
    setMarkingAll(true)
    try {
      await apiPatch('/api/notifications', { companyId, all: true })
      toast.success('All notifications marked as read')
      await notifications.refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to mark notifications read')
    } finally {
      setMarkingAll(false)
    }
  }

  const seqColumns: Column<SeqRow>[] = [
    { key: 'docType', header: 'Doc Type', render: (r) => <span className="font-mono text-xs font-semibold">{r.docType}</span> },
    { key: 'prefix', header: 'Prefix', render: (r) => <span className="font-mono text-xs">{r.prefix}</span> },
    { key: 'fy', header: 'Financial Year', render: (r) => <span className="font-mono text-xs">{r.financialYear}</span> },
    { key: 'next', header: 'Next Number', className: 'text-right', render: (r) => <span className="tabular-nums">{r.nextNumber}</span> },
    {
      key: 'sample',
      header: 'Next Document No',
      render: (r) => <span className="font-mono text-xs">{`${r.prefix}-${r.financialYear}-${String(r.nextNumber).padStart(6, '0')}`}</span>,
    },
  ]

  const unread = notifications.data?.unreadCount ?? 0
  const notificationItems = notifications.data?.items ?? []

  return (
    <div>
      <PageHeader title="Settings" description="Company profile, document numbering and notifications" />

      <div className="space-y-4">
        <SectionCard
          title="Company Profile"
          actions={
            <Button size="sm" onClick={() => void saveProfile()} disabled={saving}>
              <Save className="h-4 w-4 mr-1.5" />
              {saving ? 'Saving…' : 'Save'}
            </Button>
          }
        >
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Company Name" required className="sm:col-span-2 lg:col-span-3">
              <TextInput
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Acme Precision Manufacturing Pvt Ltd"
              />
            </Field>
            <Field label="GSTIN">
              <TextInput
                value={form.gstin}
                onChange={(e) => setForm((f) => ({ ...f, gstin: e.target.value }))}
                placeholder="27ABCDE1234F1Z5"
              />
            </Field>
            <Field label="PAN">
              <TextInput
                value={form.pan}
                onChange={(e) => setForm((f) => ({ ...f, pan: e.target.value }))}
                placeholder="ABCDE1234F"
              />
            </Field>
            <Field label="Logo Text">
              <TextInput
                value={form.logoText}
                onChange={(e) => setForm((f) => ({ ...f, logoText: e.target.value }))}
                placeholder="ACME"
              />
            </Field>
            <Field label="Address" className="sm:col-span-2">
              <TextInput
                value={form.addressLine}
                onChange={(e) => setForm((f) => ({ ...f, addressLine: e.target.value }))}
                placeholder="Plot 14, MIDC Industrial Area"
              />
            </Field>
            <Field label="City">
              <TextInput value={form.city} onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))} placeholder="Pune" />
            </Field>
            <Field label="State">
              <TextInput
                value={form.state}
                onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))}
                placeholder="Maharashtra"
              />
            </Field>
            <Field label="State Code">
              <TextInput
                value={form.stateCode}
                onChange={(e) => setForm((f) => ({ ...f, stateCode: e.target.value }))}
                placeholder="27"
              />
            </Field>
            <Field label="Phone">
              <TextInput value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} placeholder="+91 98200 00000" />
            </Field>
            <Field label="Email">
              <TextInput
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="accounts@acme.in"
              />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground mt-4">
            State code drives the GST split — same-state parties get CGST + SGST, other states get IGST.
          </p>
        </SectionCard>

        <SectionCard
          title="Document Numbering"
          actions={<Hash className="h-4 w-4 text-muted-foreground" />}
        >
          <DataTable
            columns={seqColumns}
            rows={numbering.data?.seqs ?? []}
            loading={numbering.loading}
            emptyText="No sequences yet — created automatically with the first document"
            pageSize={10}
          />
          <p className="text-xs text-muted-foreground mt-3">
            Numbers auto-advance every financial year (Apr–Mar).
          </p>
        </SectionCard>

        <SectionCard
          title="Notifications"
          actions={
            <Button variant="outline" size="sm" onClick={() => void markAllRead()} disabled={markingAll || unread === 0}>
              <CheckCheck className="h-4 w-4 mr-1.5" />
              Mark all read
            </Button>
          }
        >
          <p className="text-sm text-muted-foreground mb-3">
            <span className="font-semibold text-foreground">{unread}</span> unread notification{unread === 1 ? '' : 's'}
            {notificationItems.length > 0 ? ` · showing latest ${notificationItems.length}` : ''}
          </p>
          {notificationItems.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No notifications</p>
          ) : (
            <div className="divide-y rounded-lg border">
              {notificationItems.map((n) => (
                <div key={n.id} className="flex items-start gap-3 px-3 py-2.5">
                  <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${n.read ? 'bg-muted-foreground/30' : 'bg-sky-500'}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium truncate">{n.title}</span>
                      <StatusBadge status={n.level} />
                    </div>
                    {n.message && <p className="text-xs text-muted-foreground mt-0.5">{n.message}</p>}
                  </div>
                  <span className="text-[11px] text-muted-foreground whitespace-nowrap">{fmtDateTime(n.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  )
}
