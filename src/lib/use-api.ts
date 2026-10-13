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

function withPinHeader(init: RequestInit | undefined, pin: string): RequestInit {
  return { ...init, headers: { ...((init?.headers as Record<string, string> | undefined) || {}), 'x-erp-pin': pin } }
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
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
  if (!json.success) throw new Error(json.error?.message || `Request failed (${res.status})`)
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
