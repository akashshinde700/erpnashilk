/**
 * CRM constants shared by the screen and the API.
 *
 * The pipeline is an ordered set of stages; the order drives "advance to the next stage", the
 * board columns and the weighted forecast. WON and LOST are terminal — they leave the open
 * pipeline and are reported separately.
 */

export const LEAD_STAGES = ['NEW', 'CONTACTED', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST'] as const
export type LeadStage = (typeof LEAD_STAGES)[number]

/** Open stages — a lead here still counts towards the pipeline. */
export const OPEN_STAGES: LeadStage[] = ['NEW', 'CONTACTED', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION']
export const CLOSED_STAGES: LeadStage[] = ['WON', 'LOST']

export const STAGE_LABEL: Record<LeadStage, string> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  QUALIFIED: 'Qualified',
  PROPOSAL: 'Proposal sent',
  NEGOTIATION: 'Negotiation',
  WON: 'Won',
  LOST: 'Lost',
}

/** Default win probability per stage (used when a lead is moved and has none of its own). */
export const STAGE_PROBABILITY: Record<LeadStage, number> = {
  NEW: 10, CONTACTED: 25, QUALIFIED: 45, PROPOSAL: 60, NEGOTIATION: 80, WON: 100, LOST: 0,
}

/** Tailwind classes for the stage chip / board header. */
export const STAGE_TONE: Record<LeadStage, string> = {
  NEW: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
  CONTACTED: 'bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300',
  QUALIFIED: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300',
  PROPOSAL: 'bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300',
  NEGOTIATION: 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
  WON: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  LOST: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
}

export const LEAD_SOURCES = ['WEBSITE', 'REFERRAL', 'EXHIBITION', 'CALL', 'WHATSAPP', 'WALK_IN', 'OTHER'] as const
export const SOURCE_LABEL: Record<string, string> = {
  WEBSITE: 'Website', REFERRAL: 'Referral', EXHIBITION: 'Exhibition / expo',
  CALL: 'Cold call', WHATSAPP: 'WhatsApp', WALK_IN: 'Walk-in', OTHER: 'Other',
}

export const ACTIVITY_KINDS = ['CALL', 'MEETING', 'EMAIL', 'WHATSAPP', 'VISIT', 'NOTE'] as const
export const ACTIVITY_LABEL: Record<string, string> = {
  CALL: 'Call', MEETING: 'Meeting', EMAIL: 'Email', WHATSAPP: 'WhatsApp', VISIT: 'Visit', NOTE: 'Note',
}

export const isOpenStage = (stage?: string | null): boolean => OPEN_STAGES.includes((stage || '') as LeadStage)

export const isValidStage = (stage: unknown): stage is LeadStage => LEAD_STAGES.includes(String(stage) as LeadStage)

/** Next stage in the pipeline ('NEGOTIATION' → 'WON'), or null when already closed. */
export function nextStage(stage: LeadStage): LeadStage | null {
  const i = OPEN_STAGES.indexOf(stage)
  if (i < 0 || i === OPEN_STAGES.length - 1) return null
  return OPEN_STAGES[i + 1]
}

/** Weighted value of a deal (value × probability) — the forecast number. */
export function weighted(value: number | null | undefined, probability: number | null | undefined): number {
  return Math.round(((Number(value) || 0) * (Number(probability) || 0))) / 100
}

/** Whole days from today (local) until a date; negative = overdue. Mirrors the Machines module. */
export function daysUntil(d: string | Date | null | undefined): number | null {
  if (!d) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const [y, m, day] = String(d).slice(0, 10).split('-').map(Number)
  const due = new Date(y, (m || 1) - 1, day || 1)
  return Math.round((due.getTime() - today.getTime()) / 86_400_000)
}
