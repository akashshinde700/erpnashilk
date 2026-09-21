'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiResponse } from '@/lib/erp-constants'

// ============ Low-level api client ============

/** Attach session identity headers for server-side RBAC (middleware + requireWrite). */
function identityHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem('erp_user')
    if (!raw) return {}
    const s = JSON.parse(raw) as { user?: { id?: string; name?: string; role?: string } }
    const u = s.user
    const h: Record<string, string> = {}
    if (u?.id) h['x-erp-user-id'] = u.id
    if (u?.name) h['x-erp-user-name'] = encodeURIComponent(u.name)
    if (u?.role) h['x-erp-role'] = u.role
    return h
  } catch { return {} }
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...identityHeaders(), ...(init?.headers || {}) },
  })
  const json = (await res.json()) as ApiResponse<T>
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
  urlRef.current = url

  const refetch = useCallback(async () => {
    const u = urlRef.current
    if (!u) return
    setLoading(true)
    setError(null)
    try {
      const d = await apiGet<T>(u)
      setData(d)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refetch()
  }, [url, refetch])

  return { data, loading, error, refetch, setData }
}
