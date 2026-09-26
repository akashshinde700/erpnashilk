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

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
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
