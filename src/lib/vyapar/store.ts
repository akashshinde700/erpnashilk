import { randomBytes } from 'node:crypto'
import { ApiError } from '@/lib/erp-helpers'
import type { VyaparSnapshot } from '@/lib/vyapar/backup'

/**
 * The snapshot the server read from an uploaded Vyapar backup, held in memory until the user
 * finishes importing (same idea as the Tally connector's jobs, src/lib/tally/connector.ts).
 *
 * Why in memory: the browser must not hold or send the backup's data — the import route reads it
 * server-side, exactly like the Tally import. Nothing is written to disk or the database.
 *
 * A snapshot is a few hundred KB (parties + items). It is dropped after 30 minutes, when the
 * company's next backup is read, or when the user closes the flow.
 */

const TTL_MS = 30 * 60 * 1000
const MAX_PER_COMPANY = 2

interface Entry {
  id: string
  companyId: string
  createdAt: number
  snapshot: VyaparSnapshot
}

const store: Map<string, Entry> = (globalThis as unknown as { __vyaparSnapshots?: Map<string, Entry> }).__vyaparSnapshots ?? new Map()
;(globalThis as unknown as { __vyaparSnapshots?: Map<string, Entry> }).__vyaparSnapshots = store

function sweep() {
  const now = Date.now()
  for (const [id, e] of store) if (now - e.createdAt > TTL_MS) store.delete(id)
}

export function putSnapshot(companyId: string, snapshot: VyaparSnapshot): string {
  sweep()
  const mine = [...store.values()].filter((e) => e.companyId === companyId).sort((a, b) => b.createdAt - a.createdAt)
  for (const old of mine.slice(MAX_PER_COMPANY - 1)) store.delete(old.id)
  const id = randomBytes(9).toString('hex')
  store.set(id, { id, companyId, createdAt: Date.now(), snapshot })
  return id
}

export function getSnapshot(companyId: string, id: unknown): { id: string; snapshot: VyaparSnapshot } {
  sweep()
  const key = typeof id === 'string' ? id : ''
  const entry = key ? store.get(key) : undefined
  if (!entry || entry.companyId !== companyId) {
    throw new ApiError('Upload the Vyapar backup again — the file is no longer open (it is kept for 30 minutes).', 409)
  }
  return { id: entry.id, snapshot: entry.snapshot }
}

export function dropSnapshot(companyId: string, id: unknown) {
  const entry = typeof id === 'string' ? store.get(id) : undefined
  if (entry && entry.companyId === companyId) store.delete(entry.id)
}

/** What the browser gets after an upload: everything except the full party / item lists. */
export function snapshotView(id: string, snapshot: VyaparSnapshot) {
  const { parties, items, ...rest } = snapshot
  return {
    snapshotId: id,
    ...rest,
    sample: {
      parties: parties.slice(0, 5),
      items: items.slice(0, 5),
    },
    lists: {
      customers: parties.filter((p) => p.kind === 'customer' && p.active).length,
      suppliers: parties.filter((p) => p.kind === 'supplier' && p.active).length,
      items: items.filter((i) => i.active).length,
      openingStock: items.filter((i) => i.active && i.stockQty > 0).length,
    },
  }
}
