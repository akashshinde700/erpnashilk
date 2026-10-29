'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { ApiResponse } from '@/lib/erp-constants'

// ============ Low-level api client ============

/**
 * Identity travels in the httpOnly session cookie (sent automatically on same-origin
 * fetches). The currently selected tenant rides along as x-company-id so every call —
 * including ones that don't pass companyId explicitly — targets the company on screen.
 */
function tenantHeader(): Record<string, string> {
  if (typeof window === 'undefined') return {}
  try {
    const cid = window.localStorage.getItem('erp_company_id')
    return cid ? { 'x-company-id': cid } : {}
  } catch { return {} }
}

/** Fired when the server says the session is gone; the app shell signs the user out. */
export const UNAUTHORIZED_EVENT = 'erp:unauthorized'

// ============ Security PIN (document lock) ============

/** Asks the user for the security PIN; resolves null when they cancel. */
export type PinPrompt = (reason: string | null) => Promise<string | null>

let pinPrompt: PinPrompt | null = null
let cachedPin: { pin: string; until: number } | null = null
const PIN_TTL_MS = 5 * 60 * 1000

/** The app shell registers its PIN dialog here; pass null to unregister. */
export function setPinPrompt(fn: PinPrompt | null) {
  pinPrompt = fn
}

function rememberedPin(): string | null {
  if (cachedPin && cachedPin.until > Date.now()) return cachedPin.pin
  cachedPin = null
  return null
}

async function askPin(reason: string | null): Promise<string | null> {
  if (pinPrompt) return pinPrompt(reason)
  if (typeof window === 'undefined') return null
  const v = window.prompt(reason ? `${reason}. Enter the security PIN:` : 'Enter the security PIN to continue:')
  return v ? v.trim() || null : null
}

const PIN_ERRORS = ['PIN_REQUIRED', 'Wrong security PIN']

/** Thrown by rawApi on a 423 PIN reply so api() can prompt and retry. */
class PinError extends Error {}

/** A refused request: the server's message, plus its error code / details (Phase 5: NEGATIVE_CASH, POSSIBLE_DUPLICATE…). */
export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly details?: unknown) { super(message) }
}

// ============ Money confirmations (Cash & Bank Phase 5) ============

/**
 * 'duplicate': the server found the same entry on the same day — save anyway?
 * 'negative-cash': the entry takes a cash account below zero — only a Tenant Admin / Super Admin is asked
 * (others just see the message). Resolves true to save anyway.
 */
export type MoneyPrompt = (ask: { kind: 'duplicate' | 'negative-cash'; message: string }) => Promise<boolean>

let moneyPrompt: MoneyPrompt | null = null

/** The app shell registers its confirmation dialog here; pass null to unregister. */
export function setMoneyPrompt(fn: MoneyPrompt | null) {
  moneyPrompt = fn
}

async function askMoney(kind: 'duplicate' | 'negative-cash', message: string): Promise<boolean> {
  if (moneyPrompt) return moneyPrompt({ kind, message })
  return typeof window !== 'undefined' && window.confirm(`${message}\n\nSave anyway?`)
}

/** Role of the signed-in user, as stored by the login screen ('' when unknown). */
export function currentRole(): string {
  if (typeof window === 'undefined') return ''
  try {
    const raw = window.localStorage.getItem('erp_user')
    return raw ? (JSON.parse(raw) as { user?: { role?: string } }).user?.role || '' : ''
  } catch { return '' }
}

const OVERRIDE_ROLES = ['TENANT_ADMIN', 'SUPER_ADMIN']

/**
 * Requests that create money documents carry an Idempotency-Key. The server saves a keyed request at most once and
 * answers a repeat of it with the first answer, so:
 *  - a request whose answer was lost (network error) or that is "still being processed" is retried automatically,
 *    with the SAME key, a few times;
 *  - if the outcome is still unknown after that, the key is remembered for this exact request (URL + body) for
 *    10 minutes: when the user saves the same entry again it goes out with the same key, so it cannot be recorded
 *    twice — the server either replays the saved result or saves it once;
 *  - an identical request already in flight is not sent a second time (double click, Enter + click).
 * Other requests (reads, cheque actions, edits…) carry no key and are never retried.
 */
const KEYED: [string, RegExp][] = [
  ['POST', /^\/api\/(payments|expenses|account-txns|loans|sales-invoices|purchase-invoices)\/?(\?|$)/],
  ['POST', /^\/api\/loans\/[^/?]+\/emi\/?(\?|$)/],
  ['PATCH', /^\/api\/(payments|sales-returns)\/[^/?]+\/?(\?|$)/], // action 'apply' only (see isKeyed)
]

function isKeyed(method: string, url: string, body: BodyInit | null | undefined) {
  if (!KEYED.some(([m, re]) => m === method && re.test(url))) return false
  if (method !== 'PATCH') return true
  try { return (JSON.parse(String(body ?? '{}')) as { action?: unknown }).action === 'apply' } catch { return false }
}

function newKey(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined
  return c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const UNCERTAIN_MS = 10 * 60_000
/** Keys of keyed requests whose outcome is unknown, by request signature (method + URL + body). */
const uncertain = new Map<string, { key: string; until: number }>()
/** Keyed requests in flight, by request signature. */
const inflight = new Map<string, Promise<unknown>>()

function keyFor(sig: string): string {
  const now = Date.now()
  for (const [k, v] of uncertain) if (v.until < now) uncertain.delete(k)
  return uncertain.get(sig)?.key ?? newKey()
}

const isUncertain = (e: unknown) => e instanceof TypeError || (e instanceof ApiRequestError && e.code === 'IDEMPOTENCY_IN_PROGRESS')

function withPinHeader(init: RequestInit | undefined, pin: string): RequestInit {
  return { ...init, headers: { ...((init?.headers as Record<string, string> | undefined) || {}), 'x-erp-pin': pin } }
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const method = (init?.method || 'GET').toUpperCase()
  if (!isKeyed(method, url, init?.body)) return confirmLoop<T>(url, init, method, false)
  const sig = `${method} ${url} ${String(init?.body ?? '')}`
  const running = inflight.get(sig)
  if (running) return running as Promise<T>
  const key = keyFor(sig)
  const p = (async () => {
    try {
      const out = await confirmLoop<T>(url, { ...init, headers: { ...((init?.headers as Record<string, string> | undefined) || {}), 'Idempotency-Key': key } }, method, true)
      uncertain.delete(sig)
      return out
    } catch (e) {
      if (isUncertain(e)) {
        uncertain.set(sig, { key, until: Date.now() + UNCERTAIN_MS })
        throw new Error(e instanceof ApiRequestError
          ? 'This entry is still being saved. Wait a moment and refresh the list before saving again.'
          : 'The connection was lost, so this entry may already be saved. Refresh the list to check. Saving the same entry again is safe: it will not be recorded twice.')
      }
      uncertain.delete(sig) // a definite answer: nothing more to recover
      // Keys are random, so "used for a different request" only happens when a remembered key's first request was
      // saved after a confirmation (its body then carried the confirmation flag): it is saved, once.
      if (e instanceof ApiRequestError && e.code === 'IDEMPOTENCY_KEY_REUSED') throw new Error('This entry was already saved. Refresh the list to see it.')
      throw e
    } finally {
      inflight.delete(sig)
    }
  })()
  inflight.set(sig, p)
  return p
}

/** A refused duplicate / negative-cash entry can be confirmed and sent again (same key: the refusal saved nothing). */
async function confirmLoop<T>(url: string, init: RequestInit | undefined, method: string, keyed: boolean): Promise<T> {
  let sent = init
  for (let round = 0; ; round++) {
    try {
      return await withRetry<T>(url, sent, keyed)
    } catch (e) {
      if (!(e instanceof ApiRequestError) || round >= 2 || method === 'GET') throw e
      const admin = OVERRIDE_ROLES.includes(currentRole())
      if (e.code === 'NEGATIVE_CASH' && !admin) throw new ApiRequestError(`${e.message} Only a Tenant Admin can save it anyway.`, e.status, e.code, e.details)
      const flag = e.code === 'POSSIBLE_DUPLICATE' ? 'confirmDuplicate' : e.code === 'NEGATIVE_CASH' ? 'allowNegativeCash' : null
      if (!flag) throw e
      if (!(await askMoney(flag === 'confirmDuplicate' ? 'duplicate' : 'negative-cash', e.message))) throw new Error('Not saved: you cancelled.')
      let body: Record<string, unknown> = {}
      try { body = sent?.body ? JSON.parse(String(sent.body)) as Record<string, unknown> : {} } catch { throw e }
      sent = { ...sent, body: JSON.stringify({ ...body, [flag]: true }) }
    }
  }
}

/** Keyed requests: a lost answer (network error) or "still being processed" is retried with the same key. */
async function withRetry<T>(url: string, init: RequestInit | undefined, keyed: boolean): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await pinApi<T>(url, init)
    } catch (e) {
      if (!keyed || !isUncertain(e) || attempt >= 3) throw e
      await wait(700 * (attempt + 1))
    }
  }
}

async function pinApi<T>(url: string, init?: RequestInit): Promise<T> {
  // Re-use a PIN entered in the last 5 minutes so repeated actions don't re-ask.
  const known = rememberedPin()
  const sentInit = known && init?.method && init.method.toUpperCase() !== 'GET' ? withPinHeader(init, known) : init
  try {
    return await rawApi<T>(url, sentInit)
  } catch (e) {
    if (!(e instanceof PinError)) throw e
    if (e.message === 'Wrong security PIN') cachedPin = null
    const pin = await askPin(e.message === 'Wrong security PIN' ? 'Wrong security PIN' : null)
    if (!pin) throw new Error('Security PIN is required for this action')
    try {
      const out = await rawApi<T>(url, withPinHeader(init, pin))
      cachedPin = { pin, until: Date.now() + PIN_TTL_MS }
      return out
    } catch (e2) {
      if (e2 instanceof PinError) {
        cachedPin = null
        throw new Error(e2.message === 'PIN_REQUIRED' ? 'Security PIN is required for this action' : e2.message)
      }
      throw e2
    }
  }
}

async function rawApi<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...tenantHeader(), ...(init?.headers || {}) },
  })
  let json: ApiResponse<T>
  try {
    json = (await res.json()) as ApiResponse<T>
  } catch {
    throw new Error(`Request failed (${res.status})`)
  }
  if (res.status === 401 && !url.startsWith('/api/auth/login') && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT, { detail: json.error?.message }))
  }
  if (res.status === 423 && PIN_ERRORS.includes(json.error?.message || '')) throw new PinError(json.error?.message)
  if (!json.success) throw new ApiRequestError(json.error?.message || `Request failed (${res.status})`, res.status, json.error?.code || 'ERR', json.error?.details)
  return json.data as T
}

/** multipart/form-data POST (file uploads) — same tenant header, 401 handling and error shape as api(). */
export async function apiUpload<T>(url: string, form: FormData): Promise<T> {
  const res = await fetch(url, { method: 'POST', body: form, credentials: 'same-origin', headers: tenantHeader() })
  let json: ApiResponse<T>
  try {
    json = (await res.json()) as ApiResponse<T>
  } catch {
    throw new Error(`Upload failed (${res.status})`)
  }
  if (res.status === 401 && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT, { detail: json.error?.message }))
  }
  if (!json.success) throw new Error(json.error?.message || `Upload failed (${res.status})`)
  return json.data as T
}

export const apiGet = <T,>(url: string) => api<T>(url)
export const apiPost = <T,>(url: string, body: unknown) => api<T>(url, { method: 'POST', body: JSON.stringify(body) })
export const apiPatch = <T,>(url: string, body: unknown) => api<T>(url, { method: 'PATCH', body: JSON.stringify(body) })
export const apiDelete = <T,>(url: string) => api<T>(url, { method: 'DELETE' })

// ============ useList: fetch with refetch ============

export function useList<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(!!url)
  const [error, setError] = useState<string | null>(null)
  const urlRef = useRef(url)

  const refetch = useCallback(async () => {
    const u = urlRef.current
    if (!u) return
    setLoading(true)
    setError(null)
    try {
      const d = await apiGet<T>(u)
      setData(d)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load'
      setError(msg)
      // Surface load failures instead of showing an empty table (one toast per URL).
      toast.error('Could not load data', { id: `load:${u}`, description: msg })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    urlRef.current = url
    void refetch()
  }, [url, refetch])

  return { data, loading, error, refetch, setData }
}
