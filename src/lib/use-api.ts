'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiResponse } from '@/lib/erp-constants'

// ============ Low-level api client ============

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
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
