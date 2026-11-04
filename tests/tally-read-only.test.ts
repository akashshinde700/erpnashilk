import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { POST as createJobRoute } from '@/app/api/import-center/tally/jobs/route'
import { TALLY_HEALTH_REQUEST, checkTally, decodeTallyBody, looksLikeTallyXml } from '@/lib/tally/client'
import { db } from '@/lib/db'
import { recordHeartbeat } from '@/lib/tally/connector'
import { JOB_TYPES } from '@/lib/tally/jobs'
import * as connector from '../connector/tally/manuflow-tally-connector.mjs'
import { apiRequest, call } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant } from './helpers/seed'

// The connector is strictly read-only: TallyPrime → ManuFlow. These tests fail if a write path comes back.

const IMPORT_XML = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import Data</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>' +
  '<BODY><DATA><TALLYMESSAGE><VOUCHER VCHTYPE="Sales" ACTION="Create"><VOUCHERNUMBER>X-1</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>'
const REPLY = '<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA></DATA></BODY></ENVELOPE>'

const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
  const p = join(d, n)
  return statSync(p).isDirectory() ? walk(p) : [p]
})

const tallyBodies: string[] = []
let tallyReply: () => Response = () => new Response(REPLY)
let tally: ReturnType<typeof Bun.serve>
// A hostile or buggy ManuFlow: hands out whatever job the test sets, and records what comes back
let serverJob: Record<string, unknown> | null = null
const results: Record<string, unknown>[] = []
let server: ReturnType<typeof Bun.serve>
let dir = ''

beforeAll(() => {
  tally = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      tallyBodies.push(await req.text())
      return tallyReply()
    },
  })
  server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      if (new URL(req.url).pathname.endsWith('/result')) {
        results.push(await req.json())
        return Response.json({ success: true, data: { accepted: true } })
      }
      return Response.json({ success: true, data: { nextHeartbeatSec: 30, job: serverJob } })
    },
  })
  dir = mkdtempSync(join(tmpdir(), 'mf-read-only-test-'))
})
afterAll(() => {
  tally.stop(true)
  server.stop(true)
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  tallyBodies.length = 0
  results.length = 0
  serverJob = null
  tallyReply = () => new Response(REPLY)
})

const tallyUrl = () => `http://127.0.0.1:${tally.port}/`
const heartbeat = () => connector.heartbeatOnce(
  { server: `http://127.0.0.1:${server.port}`, token: 'mftc_test', tally: tallyUrl() },
  join(dir, 'connector.json'),
)

describe('connector program never writes to Tally', () => {
  test('the write functions are gone', () => {
    const exported = connector as unknown as Record<string, unknown>
    expect(exported.pushVoucher).toBeUndefined()
    expect(exported.pushProblem).toBeUndefined()
    expect(exported.PUSH_MAX_BYTES).toBeUndefined()
    // the complete list of things the connector can be asked to do: read-only exports only (Phase E added the masters)
    expect(Object.keys(connector.JOBS).sort()).toEqual([
      'export-customers', 'export-godowns', 'export-groups', 'export-items', 'export-ledgers', 'export-stockgroups', 'export-suppliers',
      'export-units', 'list-companies',
    ])
  })

  test('only a single plain Export request passes the guard', () => {
    expect(connector.isExportRequest(connector.TALLY_HEALTH_REQUEST)).toBe(true)
    for (const def of Object.values(connector.JOBS)) expect(connector.isExportRequest(def.request('A & B ACTION="Create" <Ltd>'))).toBe(true)
    expect(connector.isExportRequest(IMPORT_XML)).toBe(false)
    expect(connector.isExportRequest(IMPORT_XML.replace('Import Data', 'Export'))).toBe(false) // a voucher behind an Export header
    expect(connector.isExportRequest(connector.TALLY_HEALTH_REQUEST + IMPORT_XML)).toBe(false) // a second envelope
    expect(connector.isExportRequest('<ENVELOPE><HEADER><TALLYREQUEST>import data</TALLYREQUEST></HEADER></ENVELOPE>')).toBe(false)
    expect(connector.isExportRequest('<!DOCTYPE x [<!ENTITY a "b">]>' + connector.TALLY_HEALTH_REQUEST)).toBe(false)
    expect(connector.isExportRequest('')).toBe(false)
    expect(connector.isExportRequest(undefined)).toBe(false)
  })

  test('a company name cannot inject a write into an Export request', () => {
    const evil = `</SVCURRENTCOMPANY></STATICVARIABLES></DESC></BODY></ENVELOPE>${IMPORT_XML}`
    const xml = connector.JOBS['export-customers'].request(evil)
    expect(connector.isExportRequest(xml)).toBe(true)
    expect(xml).not.toContain('<VOUCHER')
    expect(xml).not.toContain('<TALLYREQUEST>Import')
  })

  test('a push-voucher job from the server is refused: Tally gets only the health check', async () => {
    serverJob = { id: 'job_1', type: 'push-voucher', xml: IMPORT_XML }
    const r = await heartbeat()
    expect(r.job).toMatchObject({ type: 'push-voucher', ok: false })
    expect(tallyBodies).toEqual([connector.TALLY_HEALTH_REQUEST])
    expect(results).toEqual([{ jobId: 'job_1', ok: false, error: 'tally_error' }])
  })

  test('XML attached to a valid read job is ignored: the connector sends its own Export', async () => {
    serverJob = { id: 'job_2', type: 'export-items', company: 'Shree', xml: IMPORT_XML, payload: IMPORT_XML }
    await heartbeat()
    expect(tallyBodies).toEqual([connector.TALLY_HEALTH_REQUEST, connector.JOBS['export-items'].request('Shree')])
    expect(tallyBodies.join('')).not.toMatch(/Import Data|<VOUCHER|ACTION=/)
  })

  test('other write-like job names are refused without contacting Tally', async () => {
    for (const type of ['import-vouchers', 'create-ledger', 'alter', 'delete', '__proto__', 'constructor']) {
      tallyBodies.length = 0
      serverJob = { id: `job_${type}`, type, company: 'Shree', xml: IMPORT_XML }
      expect((await heartbeat()).job).toMatchObject({ ok: false })
      expect(tallyBodies).toEqual([connector.TALLY_HEALTH_REQUEST])
    }
  })
})

describe('connector program has one read-only way to reach Tally', () => {
  const source = readFileSync(join(process.cwd(), 'connector/tally/manuflow-tally-connector.mjs'), 'utf8')

  test('every job, including a hostile company name, sends only Export requests', async () => {
    for (const type of Object.keys(connector.JOBS)) {
      serverJob = { id: `job_${type}`, type, company: 'A</SVCURRENTCOMPANY><VOUCHER ACTION="Create">' }
      await heartbeat()
    }
    expect(tallyBodies.length).toBe(Object.keys(connector.JOBS).length * 2) // health check + the job
    for (const body of tallyBodies) expect(connector.isExportRequest(body)).toBe(true)
  })

  test('it has no other network or process access', () => {
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]).sort()
    expect(imports).toEqual(['node:fs', 'node:os', 'node:path', 'node:url'])
    expect(source).not.toMatch(/child_process|node:net|node:http|node:dgram|\beval\(|new Function|import\(/)
    // One fetch for Tally behind the guard, one for ManuFlow
    expect(source.match(/\bfetch\(/g)?.length).toBe(2)
    expect(source).toMatch(/if \(!isExportRequest\(xml\)\) throw[\s\S]{0,160}return fetch\(url/)
    expect(source).not.toMatch(/Import Data|Tally-Import/)
  })
})

describe('server cannot queue or send a Tally write', () => {
  const savedPoc = process.env.TALLY_CONNECTOR_POC
  const savedPush = process.env.TALLY_CONNECTOR_PUSH
  beforeEach(async () => {
    await resetDb()
    process.env.TALLY_CONNECTOR_POC = '1'
    process.env.TALLY_CONNECTOR_PUSH = '1' // the old switch must do nothing
  })
  afterEach(() => {
    if (savedPoc === undefined) delete process.env.TALLY_CONNECTOR_POC
    else process.env.TALLY_CONNECTOR_POC = savedPoc
    if (savedPush === undefined) delete process.env.TALLY_CONNECTOR_PUSH
    else process.env.TALLY_CONNECTOR_PUSH = savedPush
  })

  test('the job endpoint refuses push-voucher, even with the old switch set', async () => {
    const { user } = await seedTenant()
    const r = await call(createJobRoute(apiRequest('/api/import-center/tally/jobs', { body: { type: 'push-voucher', xml: IMPORT_XML }, user })))
    expect(r.status).toBe(400)
    expect(JOB_TYPES.every((t) => t === 'list-companies' || t.startsWith('export-'))).toBe(true)
  })

  test('a heartbeat reply never carries XML; a planted job of another type is failed, never handed out', async () => {
    const { company } = await seedTenant()
    const c = await db.tallyConnector.create({
      data: { id: 'c'.repeat(24), companyId: company.id, activeFor: company.id, secretHash: 'x', pairedAt: new Date(), pairedBy: 'u' },
    })
    // The job table has no column for XML; a type name is all that could be planted
    await db.tallyJob.create({ data: { id: 'j1', companyId: company.id, connectorId: c.id, type: 'push-voucher', status: 'queued', createdBy: 'u' } })
    const reply = await recordHeartbeat({ ...c, via: 'current' }, { tally: { status: 'connected' } })
    expect(reply.job).toBeUndefined()
    expect(JSON.stringify(reply)).not.toMatch(/Import Data|<VOUCHER|"xml"|"payload"|push/)
    expect((await db.tallyJob.findUnique({ where: { id: 'j1' } }))!.status).toBe('failed')
    expect(JSON.stringify(Object.keys(db.tallyJob.fields))).not.toMatch(/xml|payload/i)
  })

  test('the push route and its code are gone; nothing in the app refers to a push', () => {
    const root = process.cwd()
    for (const f of ['src/app/api/import-center/tally/push/route.ts', 'src/lib/tally/push.ts', 'src/lib/tally/push-xml.ts', 'src/lib/tally/voucher-purchase.ts']) {
      expect([f, existsSync(join(root, f))]).toEqual([f, false])
    }
    const hits = [...walk(join(root, 'src')), ...walk(join(root, 'connector'))]
      .filter((f) => /push-voucher|tally\/push|TALLY_CONNECTOR_PUSH|Push to Tally|pushToTally|pushVoucher/.test(readFileSync(f, 'utf8')))
    expect(hits).toEqual([])
  })

  test('connector and Import Center code cannot reach the voucher builders', () => {
    const root = process.cwd()
    const files = [
      'connector/tally/manuflow-tally-connector.mjs', 'src/lib/tally/connector.ts', 'src/lib/tally/jobs.ts', 'src/lib/tally/client.ts', 'src/lib/tally/to-import.ts',
      ...walk(join(root, 'src/app/api/tally-connector')).map((f) => f.slice(root.length + 1)),
      ...walk(join(root, 'src/app/api/import-center/tally')).map((f) => f.slice(root.length + 1)),
    ]
    const bad = files.filter((f) => /tally\/(voucher|masters|load-invoice)|voucherToXml|<TALLYREQUEST>\s*Import/.test(readFileSync(join(root, f), 'utf8')))
    expect(bad).toEqual([])
  })
})

describe('UTF-16 replies to the health check', () => {
  const bom = (enc: 'le' | 'be', s: string, withBom = true) => {
    const le = Buffer.from(s, 'utf16le')
    const body = enc === 'le' ? le : Buffer.from(le).swap16()
    return withBom ? Buffer.concat([Buffer.from(enc === 'le' ? [0xff, 0xfe] : [0xfe, 0xff]), body]) : body
  }
  const cases: [string, Buffer][] = [
    ['UTF-8', Buffer.from(REPLY)],
    ['UTF-8 with BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(REPLY)])],
    ['UTF-16 LE with BOM', bom('le', REPLY)],
    ['UTF-16 BE with BOM', bom('be', REPLY)],
    ['UTF-16 LE without BOM', bom('le', REPLY, false)],
    ['UTF-16 BE without BOM', bom('be', REPLY, false)],
    ['UTF-16 LE with an XML header', bom('le', `<?xml version="1.0" encoding="UTF-16"?>${REPLY}`)],
  ]

  for (const [name, buf] of cases) {
    test(`connector: ${name} counts as connected`, async () => {
      tallyReply = () => new Response(new Uint8Array(buf))
      expect((await connector.checkTally(tallyUrl())).status).toBe('connected')
    })
    test(`server check: ${name} counts as connected`, async () => {
      tallyReply = () => new Response(new Uint8Array(buf))
      expect((await checkTally(tallyUrl(), `127.0.0.1:${tally.port}`)).status).toBe('connected')
    })
  }

  test('UTF-16 text that is not Tally is still refused', async () => {
    tallyReply = () => new Response(bom('le', '<html>router</html>'))
    expect((await connector.checkTally(tallyUrl())).status).toBe('invalid_response')
    expect((await checkTally(tallyUrl(), `127.0.0.1:${tally.port}`)).status).toBe('invalid_response')
    expect(looksLikeTallyXml(decodeTallyBody(bom('le', '<!DOCTYPE x>' + REPLY)))).toBe(false)
  })

  test('a job reply in UTF-16 without a BOM is read too', async () => {
    const list = '<ENVELOPE><BODY><DATA><COLLECTION><COMPANY NAME="Shree"><STARTINGFROM>20260401</STARTINGFROM></COMPANY></COLLECTION></DATA></BODY></ENVELOPE>'
    tallyReply = () => new Response(bom('le', list, false))
    const r = await connector.runJob(tallyUrl(), { id: 'x', type: 'list-companies' })
    expect(r).toMatchObject({ ok: true, records: [{ name: 'Shree', startingFrom: '2026-04-01' }] })
  })
})

describe('Tally-Import.bat is the one manual write exception', () => {
  const root = process.cwd()
  const BAT = 'public/downloads/tally/Tally-Import.bat'
  const bat = () => readFileSync(join(root, BAT), 'utf8')

  test('it can write to Tally, and says so', () => {
    expect(bat()).toContain('curl -s -m 30 -X POST')
    expect(bat()).toContain('WRITES DATA INTO TALLYPRIME')
    expect(bat()).toContain('EXPLICIT HUMAN APPROVAL')
    expect(bat()).toContain('manual write exception')
  })

  test('the docs describe it as a manual write exception that needs human approval', () => {
    const doc = readFileSync(join(root, 'docs/tally-connector.md'), 'utf8')
    expect(doc).toContain('Manual write exception: `Tally-Import.bat`')
    expect(doc).toContain('writes data into TallyPrime')
    expect(doc).toContain('explicit human approval before each run')
    expect(readFileSync(join(root, 'docs/tally-and-einvoice-export.md'), 'utf8')).toContain('explicit human approval')
  })

  test('nothing else in public/ can post to Tally', () => {
    const files = walk(join(root, 'public')).map((f) => f.slice(root.length + 1))
    expect(files.filter((f) => /\.(bat|cmd|ps1|vbs|sh)$/i.test(f))).toEqual([BAT])
    const text = files.filter((f) => /\.(js|mjs|html|xml|txt|json)$/i.test(f))
    expect(text.filter((f) => /Import Data|UploadData|\bcurl\b|:9000\b/.test(readFileSync(join(root, f), 'utf8')))).toEqual([])
  })

  test('the app only offers it as a download and never runs it', () => {
    const src = walk(join(root, 'src'))
    const uses = src.filter((f) => /Tally-Import|TALLY_IMPORT_BAT_PATH/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(root.length + 1)).sort()
    expect(uses).toEqual(['src/components/erp/modules/sales-invoices.tsx', 'src/components/erp/modules/settings.tsx', 'src/lib/tally/masters.ts'])
    for (const f of ['src/components/erp/modules/sales-invoices.tsx', 'src/components/erp/modules/settings.tsx']) {
      expect(readFileSync(join(root, f), 'utf8')).toContain('<a href={TALLY_IMPORT_BAT_PATH} download="Tally-Import.bat">')
    }
    const tallyCode = src.filter((f) => /[\\/]tally(-connector)?[\\/]/.test(f.slice(root.length)))
    expect(tallyCode.filter((f) => /child_process/.test(readFileSync(f, 'utf8')))).toEqual([])
  })

  test('on the server, only the fixed health check can contact Tally', () => {
    const tallyCode = walk(join(root, 'src')).filter((f) => /[\\/]tally(-connector)?[\\/]/.test(f.slice(root.length)))
    const callers = tallyCode.filter((f) => /\bfetch\b/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(root.length + 1))
    expect(callers).toEqual(['src/lib/tally/client.ts'])
    const client = readFileSync(join(root, 'src/lib/tally/client.ts'), 'utf8')
    expect(client.match(/^\s*body: [^,\n]+/gm)?.map((b) => b.trim())).toEqual(['body: TALLY_HEALTH_REQUEST'])
    expect(connector.isExportRequest(TALLY_HEALTH_REQUEST)).toBe(true)
  })
})

describe('db/custom.db.backup stays out of git', () => {
  const git = (...args: string[]) => spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf8' })

  test('it is ignored and not tracked', () => {
    expect(git('check-ignore', '-q', '--no-index', 'db/custom.db.backup').status).toBe(0)
    expect(git('ls-files', 'db/custom.db.backup').stdout).toBe('')
  })

  test('a plain git add cannot pick it up', () => {
    const r = git('add', '--dry-run', 'db/custom.db.backup')
    expect(r.status).not.toBe(0)
    expect(r.stdout).toBe('')
  })
})
