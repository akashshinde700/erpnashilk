import { beforeEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { POST as commit } from '@/app/api/import-center/commit/route'
import { POST as parse } from '@/app/api/import-center/parse/route'
import { POST as preview } from '@/app/api/import-center/preview/route'
import type { RunResult } from '@/lib/import/run'
import { markFileDuplicates, mergeRunResults, splitParts, withoutLines } from '@/lib/import/wizard-helpers'
import { apiRequest, call, uploadRequest } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant } from './helpers/seed'

// Keeps the browser test honest: e2e/specs/14-file-import.spec.ts answers the wizard with the responses stored in
// e2e/fixtures/tally-masters.api.json. Here the same (made-up) Tally XML goes through the REAL parse / preview / commit
// routes, with the same steps the wizard takes (parts of 500, duplicates across the file left out of the import), and
// the stored responses must be exactly what the routes return today. After an intended API change:
//   UPDATE_E2E_FIXTURES=1 bun test tests/import-e2e-contract.test.ts

const DIR = join(process.cwd(), 'e2e/fixtures')
const XML = readFileSync(join(DIR, 'tally-masters.xml'))
const STORED = join(DIR, 'tally-masters.api.json')

beforeEach(resetDb)

test('the browser test\'s stored API responses are what the real routes return for the fixture', async () => {
  const { company, user } = await seedTenant()
  const up = await call(parse(await uploadRequest('/api/import-center/parse', {
    companyId: company.id, dataType: 'customers', encoding: 'gzip', file: { data: gzipSync(XML), name: 'tally-masters.xml' },
  }, user)))
  expect(up.status).toBe(200)
  const parsed = up.json.data
  const base = { companyId: company.id, dataType: 'customers', source: 'EXCEL', fileName: parsed.fileName, mapping: parsed.suggestion.mapping, options: {} }
  const post = async (handler: (r: Request) => Promise<Response>, path: string, body: Record<string, unknown>) => {
    const r = await call(handler(apiRequest(path, { user, body })))
    expect(r.status).toBe(200)
    return r.json.data
  }
  const previews: RunResult[] = []
  for (const part of splitParts(parsed.table, parsed.headerRow)) previews.push(await post(preview, '/api/import-center/preview', { ...base, ...part }))
  const { fileDuplicates } = markFileDuplicates('customers', mergeRunResults(previews))
  const commits: RunResult[] = []
  const parts = splitParts(withoutLines(parsed.table, parsed.headerRow, new Set(fileDuplicates.keys())), parsed.headerRow)
  for (let i = 0; i < parts.length; i++) {
    commits.push(await post(commit, '/api/import-center/commit', { ...base, ...parts[i], fileName: `${parsed.fileName} (part ${i + 1} of ${parts.length})`, confirm: true }))
  }
  const actual = JSON.parse(JSON.stringify({ parse: parsed, preview: previews, commit: commits }))
  if (process.env.UPDATE_E2E_FIXTURES === '1') writeFileSync(STORED, `${JSON.stringify(actual)}\n`)
  expect(existsSync(STORED)).toBe(true) // never generated silently
  expect(JSON.parse(readFileSync(STORED, 'utf8'))).toEqual(actual)

  // what the browser test relies on
  expect(parsed.table.length).toBe(506)
  expect(previews.length).toBe(2)
  expect([...fileDuplicates.keys()]).toEqual([506])
  expect(commits.reduce((s, c) => s + c.counts.imported, 0)).toBe(503) // 505 parties − 1 GST conflict − 1 repeat
}, 120_000)
