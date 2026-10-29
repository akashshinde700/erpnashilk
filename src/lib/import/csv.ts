// Client + server safe (no Node APIs).

/**
 * Dependency-free CSV parser: handles quoted fields with escaped "" and
 * embedded delimiters/newlines, both \n and \r\n line endings, and a UTF-8 BOM.
 * Returns rows of string cells; fully-blank rows are dropped unless keepBlank (then each record
 * keeps its position, so index + 1 is the record number).
 */
export function parseCsv(text: string, delimiter = ',', opts: { keepBlank?: boolean } = {}): string[][] {
  const s = text.replace(/^\ufeff/, '')
  const rows: string[][] = []
  let cur: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"') {
      inQuotes = true
      i++
      continue
    }
    if (ch === delimiter) {
      cur.push(field)
      field = ''
      i++
      continue
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++
      cur.push(field)
      field = ''
      rows.push(cur)
      cur = []
      i++
      continue
    }
    field += ch
    i++
  }
  if (field !== '' || cur.length > 0) {
    cur.push(field)
    rows.push(cur)
  }
  return opts.keepBlank ? rows : rows.filter((r) => r.some((c) => c.trim() !== ''))
}

/** Delimiter of a CSV / TSV export: the most frequent of , ; TAB in the first non-empty line (outside quotes). */
export function sniffDelimiter(text: string): string {
  const line = text.replace(/^\ufeff/, '').split(/\r?\n/).find((l) => l.trim() !== '') ?? ''
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 }
  let inQuotes = false
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes
    else if (!inQuotes && ch in counts) counts[ch]++
  }
  let best = ','
  for (const d of [';', '\t']) if (counts[d] > counts[best]) best = d
  return best
}
