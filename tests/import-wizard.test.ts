import { beforeEach, describe, expect, test } from 'bun:test'
import { db } from '@/lib/db'
import { POST as parse } from '@/app/api/import-center/parse/route'
import { POST as preview } from '@/app/api/import-center/preview/route'
import { IMPORT_DATA_TYPES, findDataType, suggestMapping } from '@/lib/import/fields'
import { parseImportFile } from '@/lib/import/parse-file'
import { DATA_TYPE_MR, friendlyError, problemRowsCsv, reportCell, templateCsv } from '@/lib/import/wizard-helpers'
import type { RunRow } from '@/lib/import/run'
import { apiRequest, call, uploadRequest } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant } from './helpers/seed'

describe('wizard helpers', () => {
  test('every data type has a Marathi label; unavailable ones offer no template', () => {
    for (const d of IMPORT_DATA_TYPES) {
      expect(DATA_TYPE_MR[d.key]?.name).toBeTruthy()
      if (!d.available) expect(templateCsv(d.key)).toBeNull()
    }
    expect(findDataType('credit-notes')?.available).toBe(false)
    expect(findDataType('company-info')?.available).toBe(false)
  })

  test('each sample template maps every field of its data type by itself', () => {
    for (const d of IMPORT_DATA_TYPES.filter((x) => x.available)) {
      const csv = templateCsv(d.key) as string
      const p = parseImportFile(Buffer.from(csv), `${d.key}.csv`)
      const s = suggestMapping(d, p.rows[0].cells)
      expect([d.key, Object.keys(s.mapping).sort()]).toEqual([d.key, d.fields.map((f) => f.key).sort()])
    }
  })

  test('problem-row CSV lists only rows that need attention and neutralises formulas', () => {
    const rows: RunRow[] = [
      { line: 2, status: 'ready', messages: [], warnings: [], values: { name: 'Fine' } },
      { line: 3, status: 'error', messages: ['GST rate is blank'], warnings: [], values: { name: '=HYPERLINK("x")' } },
      { line: 4, status: 'imported', messages: [], warnings: ['Purchase price is blank — saved as 0'], values: { name: 'Warned' } },
      { line: 5, status: 'duplicate', messages: ['Duplicate name A — skipped'], warnings: [], values: { name: 'A' } },
    ]
    const out = problemRowsCsv(rows).split('\n')
    expect(out[0]).toBe('Row,Status,Name,Problems,Warnings')
    expect(out).toHaveLength(4) // header + 3 (the clean row is left out)
    expect(out[1]).toContain(`"'=HYPERLINK(""x"")"`)
    expect(reportCell('-5')).toBe("'-5")
    expect(reportCell('@cmd')).toBe("'@cmd")
  })

  test('friendly errors in Marathi for generic failures; server validation text kept', () => {
    expect(friendlyError(new TypeError('Failed to fetch'))).toContain('सर्व्हरशी संपर्क तुटला')
    expect(friendlyError(new Error('Your role is not allowed to modify import-center'))).toContain('परवानगी नाही')
    expect(friendlyError(new Error('The file is larger than 2 MB'))).toContain('फाइल खूप मोठी')
    expect(friendlyError(new Error('Something went wrong on the server — please try again'))).toContain('सर्व्हरवर अडचण')
    expect(friendlyError(new Error('Map the required fields: GST rate %'))).toBe('Map the required fields: GST rate %')
  })
})

describe('sample templates pass the real import validation', () => {
  beforeEach(resetDb)

  test('customers, suppliers and items templates are fully ready in preview (and nothing is written)', async () => {
    const { company, user } = await seedTenant()
    for (const [key, options] of [['customers', {}], ['suppliers', {}], ['items', { itemType: 'RAW' }]] as const) {
      const up = await call(parse(await uploadRequest('/api/import-center/parse', { companyId: company.id, dataType: key, file: { data: Buffer.from(templateCsv(key) as string), name: `${key}.csv` } }, user)))
      expect(up.status).toBe(200)
      const p = up.json.data
      const pv = await call(preview(apiRequest('/api/import-center/preview', { user, body: { companyId: company.id, dataType: key, table: p.table, headerRow: p.headerRow, mapping: p.suggestion.mapping, options } })))
      expect([key, pv.json.data.counts.ready, pv.json.data.counts.errors]).toEqual([key, 2, 0])
    }
    expect(await db.customer.count() + await db.supplier.count() + await db.item.count()).toBe(0)
  })
})
