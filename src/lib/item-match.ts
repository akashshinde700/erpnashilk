/**
 * Item-name matching shared by the client (suggestions while adding) and the server (duplicate guard).
 * "MS Plate 10 mm", "ms-plate 10MM" and "MS Plate 10mm" all normalise to "msplate10mm".
 */

export const normalizeItemName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

export interface MatchCandidate { id: string; code?: string | null; name?: string | null }

/**
 * Existing items whose name is the same or a likely misspelling of `name`
 * (same letters/digits ignoring case, spaces and punctuation; or 1–2 typos for longer names).
 * `exact` is set when the normalised names are identical — that is a duplicate, not a new item.
 */
export function findSimilarItems<T extends MatchCandidate>(items: T[], name: string): { exact: T | null; similar: T[] } {
  const n = normalizeItemName(name)
  if (n.length < 3) return { exact: null, similar: [] }
  const allowed = n.length >= 12 ? 2 : n.length >= 6 ? 1 : 0
  let exact: T | null = null
  const scored: { item: T; d: number }[] = []
  for (const it of items) {
    const m = normalizeItemName(it.name || '')
    if (!m) continue
    if (m === n) { exact = exact ?? it; continue }
    const d = levenshtein(n, m)
    if (d <= allowed || (Math.min(n.length, m.length) >= 6 && (m.includes(n) || n.includes(m)))) scored.push({ item: it, d })
  }
  scored.sort((a, b) => a.d - b.d)
  return { exact, similar: scored.slice(0, 5).map((s) => s.item) }
}
