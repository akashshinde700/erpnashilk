import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir, uptime as osUptime } from 'node:os'
import { dirname, join } from 'node:path'
import { POST as createCode } from '@/app/api/import-center/tally/connector/route'
import { POST as heartbeatRoute } from '@/app/api/tally-connector/heartbeat/route'
import { POST as pairRoute } from '@/app/api/tally-connector/pair/route'
import { POST as pingRoute } from '@/app/api/tally-connector/ping/route'
import { db } from '@/lib/db'
import { CONNECTOR_LATEST_VERSION, PAIRING_TTL_MS } from '@/lib/tally/connector'
import { readZipEntries, zipEntryNames } from '@/lib/vyapar/zip'
import * as connector from '../connector/tally/manuflow-tally-connector.mjs'
import { finish } from '../connector/tally/manuflow-tally-connector.mjs'
import { buildPackage, connectorVersion } from '../scripts/build-connector-package.mjs'
import { apiRequest, call } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant } from './helpers/seed'

// The Windows customer package of the connector, and the connector behaviour it relies on. Everything runs against
// the real ManuFlow routes and a mock TallyPrime — never a real TallyPrime, never a real pairing code.

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const ROOT = process.cwd()
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8')
let dir = ''
let tally: ReturnType<typeof Bun.serve>
let manuflow: ReturnType<typeof Bun.serve>
const savedFlag = process.env.TALLY_CONNECTOR_POC

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mf-connector-package-'))
  tally = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('<ENVELOPE><HEADER><STATUS>0</STATUS></HEADER></ENVELOPE>') })
  manuflow = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    fetch(req) {
      const p = new URL(req.url).pathname
      if (p === '/api/tally-connector/pair') return pairRoute(req)
      if (p === '/api/tally-connector/heartbeat') return heartbeatRoute(req)
      if (p === '/api/tally-connector/ping') return pingRoute()
      return new Response('not found', { status: 404 })
    },
  })
})
afterAll(() => {
  tally.stop(true); manuflow.stop(true)
  rmSync(dir, { recursive: true, force: true })
  if (savedFlag === undefined) delete process.env.TALLY_CONNECTOR_POC
  else process.env.TALLY_CONNECTOR_POC = savedFlag
})

// ---------------------------------------------------------------- the package

describe('customer package (scripts/build-connector-package.mjs)', () => {
  test('versioned zip with the connector, installer, uninstaller, guide, VERSION and SHA256SUMS', () => {
    const r = buildPackage({ out: join(dir, 'pkg') })
    const v = connector.VERSION
    expect([r.version, connectorVersion()]).toEqual([v, v])
    expect(v).toBe(CONNECTOR_LATEST_VERSION) // ManuFlow tells older connectors that this version exists
    const zip = readFileSync(r.zipPath)
    expect(r.zipPath.endsWith(`manuflow-tally-connector-${v}-windows.zip`)).toBe(true)
    expect(readFileSync(`${r.zipPath}.sha256`, 'utf8')).toBe(`${sha256(zip)}  manuflow-tally-connector-${v}-windows.zip\n`)
    const d = `manuflow-tally-connector-${v}`
    expect(zipEntryNames(zip)).toEqual([
      `${d}/manuflow-tally-connector.mjs`, `${d}/windows/install-connector.ps1`, `${d}/windows/uninstall-connector.ps1`,
      `${d}/INSTALL.md`, `${d}/VERSION`, `${d}/SHA256SUMS`,
    ])
    const entries = Object.fromEntries(readZipEntries(zip, () => true).map((e) => [e.name.slice(d.length + 1), e.data]))
    expect(entries['manuflow-tally-connector.mjs'].equals(readFileSync(join(ROOT, 'connector/tally/manuflow-tally-connector.mjs')))).toBe(true)
    expect(entries.VERSION.toString()).toBe(`${v}\n`)
    // every checksum in SHA256SUMS is the file's own
    const sums = entries.SHA256SUMS.toString().trim().split('\n').map((l) => l.split('  '))
    expect(sums.map(([, p]) => p)).toEqual(['manuflow-tally-connector.mjs', 'windows/install-connector.ps1', 'windows/uninstall-connector.ps1', 'INSTALL.md', 'VERSION'])
    for (const [h, p] of sums) expect([p, sha256(entries[p])]).toEqual([p, h])
    // Windows PowerShell 5.1: UTF-8 with BOM and CRLF line endings
    for (const p of ['windows/install-connector.ps1', 'windows/uninstall-connector.ps1']) {
      const b = entries[p]
      expect([p, b[0], b[1], b[2]]).toEqual([p, 0xef, 0xbb, 0xbf])
      expect(/[^\r]\n/.test(b.toString('utf8'))).toBe(false)
      // exactly the current (corrected) script, only with the BOM and CRLF added
      expect(b.subarray(3).toString('utf8')).toBe(src(`connector/tally/${p}`).replace(/\r?\n/g, '\r\n'))
    }
    expect(entries['INSTALL.md'].toString('utf8')).toBe(src('connector/tally/INSTALL.md'))
    // no secrets: no token, no saved settings, no real pairing code
    const all = Object.values(entries).map((b) => b.toString('utf8')).join('\n')
    expect(all).not.toMatch(/mftc_[a-f0-9]{24}_[A-Za-z0-9_-]{43}|"token"\s*:\s*"mftc_|PRIVATE KEY/)
  })

  test('the same sources always give the same package (reproducible checksum)', () => {
    const a = buildPackage({ out: join(dir, 'a') })
    const b = buildPackage({ out: join(dir, 'b') })
    expect(a.zipSha).toBe(b.zipSha)
  })
})

// ---------------------------------------------------------------- connector behaviour used by the installer

describe('connector commands the installer relies on', () => {
  beforeEach(async () => { await resetDb(); process.env.TALLY_CONNECTOR_POC = '1' })
  const newCode = async (user: Awaited<ReturnType<typeof seedTenant>>['user']) =>
    (await call(createCode(apiRequest('/api/import-center/tally/connector', { method: 'POST', user })))).json.data.code as string
  let n = 0
  const cfg = () => join(dir, `cfg${++n}`, 'connector.json')
  const server = () => `http://127.0.0.1:${manuflow.port}`

  test('pair with the code on standard input (not the command line); status and version never show the token', async () => {
    const { user } = await seedTenant()
    const path = cfg()
    const logs: string[] = []
    const code = await newCode(user)
    const argv = ['pair', '--server', server(), '--code-stdin', '--tally', `http://127.0.0.1:${tally.port}`, '--config', path]
    expect(argv.join(' ')).not.toContain(code)
    expect(await connector.main(argv, (m: string) => logs.push(m), { stdin: () => `${code}\r\n` })).toBe(0)
    const saved = connector.loadConfig(path)
    expect(saved.token).toMatch(/^mftc_/)
    expect(saved.deviceId).toMatch(/^[a-f0-9]{32}$/)
    expect(await connector.main(['status', '--config', path], (m: string) => logs.push(m))).toBe(0)
    expect(await connector.main(['version'], (m: string) => logs.push(m))).toBe(0)
    const text = logs.join('\n')
    expect(text).toContain(`Connector ${connector.VERSION}`)
    expect(text).toContain(saved.deviceId.slice(0, 8))
    expect(text).not.toContain(saved.token)
    expect(text).not.toContain(saved.deviceId) // only a short form
    expect(text).not.toContain(code)
    // the paired connector checks in (heartbeat) with its device identity
    expect((await connector.heartbeatOnce(connector.loadConfig(path), path)).ok).toBe(true)
    expect((await db.tallyConnector.findFirstOrThrow({ where: { activeFor: { not: null } } })).version).toBe(connector.VERSION)
  })

  test('a wrong or expired code fails with a message and saves nothing', async () => {
    const { user } = await seedTenant()
    const logs: string[] = []
    const wrong = cfg()
    expect(await connector.main(['pair', '--server', server(), '--code-stdin', '--config', wrong], (m: string) => logs.push(m), { stdin: () => 'ABCDE-FGHJK' })).toBe(1)
    expect(logs.pop()).toContain('wrong or was already used')
    expect(connector.loadConfig(wrong)).toBeNull()
    const code = await newCode(user)
    const realNow = Date.now
    Date.now = () => realNow() + PAIRING_TTL_MS + 1000
    try {
      const expired = cfg()
      expect(await connector.main(['pair', '--server', server(), '--code-stdin', '--config', expired], (m: string) => logs.push(m), { stdin: () => code })).toBe(1)
      expect(logs.pop()).toContain('expired')
      expect(connector.loadConfig(expired)).toBeNull()
    } finally { Date.now = realNow }
  })

  test('TLS certificate checks switched off: nothing is sent to an https ManuFlow', async () => {
    expect(connector.tlsProblem('https://erp.example.com', { NODE_TLS_REJECT_UNAUTHORIZED: '0' } as unknown as NodeJS.ProcessEnv)).toContain('switched off')
    expect(connector.tlsProblem('https://erp.example.com', {} as unknown as NodeJS.ProcessEnv)).toBe('')
    expect(connector.tlsProblem('http://127.0.0.1:3000', { NODE_TLS_REJECT_UNAUTHORIZED: '0' } as unknown as NodeJS.ProcessEnv)).toBe('') // local testing only
    const saved = process.env.NODE_TLS_REJECT_UNAUTHORIZED
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    try {
      await expect(connector.pair({ server: 'https://erp.example.com', code: 'ABCDE-FGHJK', path: cfg() })).rejects.toThrow('switched off')
      expect((await connector.pingServer('https://erp.example.com')).ok).toBe(false)
    } finally {
      if (saved === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = saved
    }
  })

  test('plain http to another computer and redirects are refused (the token never leaves over plain http)', () => {
    expect(connector.validateServerUrl('http://erp.example.com').error).toContain('https')
    expect(connector.validateServerUrl('https://user:pw@erp.example.com').error).toBeTruthy()
    expect(src('connector/tally/manuflow-tally-connector.mjs')).toMatch(/redirect: 'error'/)
  })
})

// ---------------------------------------------------------------- stale lock (S2): connector side

describe('lock file left by a stopped task or a shutdown (connector 0.3.2)', () => {
  test('a lock last touched before this Windows start is taken over even if its process number is in use again', () => {
    const path = join(dir, 'lock-boot', 'connector.json')
    mkdirSync(dirname(path), { recursive: true })
    const now = Date.now()
    // a live process (the parent stands in for an unrelated process that got the same number after a restart)
    writeFileSync(`${path}.lock`, String(process.ppid))
    const touched = new Date(now - 5 * 60_000) // 5 minutes ago: before a start 1 minute ago (beyond the 2-minute clock allowance)
    utimesSync(`${path}.lock`, touched, touched)
    expect(connector.acquireLock(path, now, now - 60_000)).toBe(true)
    expect(readFileSync(`${path}.lock`, 'utf8')).toBe(String(process.pid))
    connector.releaseLock(path)
  })

  test('a lock touched since this start by a live process still blocks (a connector that is really running)', () => {
    const path = join(dir, 'lock-live', 'connector.json')
    mkdirSync(dirname(path), { recursive: true })
    const now = Date.now()
    writeFileSync(`${path}.lock`, String(process.ppid))
    expect(connector.acquireLock(path, now, now - 60 * 60_000)).toBe(false) // started an hour ago, touched just now
    // the clock corrected by up to 2 minutes after the start does not count as "before the start"
    const touched = new Date(now - 90_000)
    utimesSync(`${path}.lock`, touched, touched)
    expect(connector.acquireLock(path, now, now - 60_000)).toBe(false)
    expect(readFileSync(`${path}.lock`, 'utf8')).toBe(String(process.ppid)) // left alone
  })

  test('boot time comes from the uptime', () => {
    const now = Date.now()
    expect(Math.abs(connector.bootTime(now) - (now - osUptime() * 1000))).toBeLessThan(2000)
    expect(connector.bootTime(now)).toBeLessThanOrEqual(now)
  })
})

// ---------------------------------------------------------------- installer / uninstaller (static: no PowerShell here)

/** PowerShell tokens that matter for structure: brackets outside strings and comments. → problems found */
function powershellStructure(text: string): string[] {
  const problems: string[] = []
  const stack: { ch: string; line: number }[] = []
  const pairs: Record<string, string> = { ')': '(', '}': '{', ']': '[' }
  let line = 1
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\n') { line++; continue }
    if (c === '<' && text[i + 1] === '#') { // block comment
      const end = text.indexOf('#>', i + 2)
      if (end < 0) { problems.push(`unclosed <# at line ${line}`); break }
      line += text.slice(i, end).split('\n').length - 1; i = end + 1; continue
    }
    if (c === '#') { while (i < text.length && text[i] !== '\n') i++; i--; continue }
    if (c === '`') { i++; if (text[i] === '\n') line++; continue } // escaped character / line continuation
    if (c === "'") { // single-quoted: '' is a quote
      let j = i + 1
      for (; j < text.length; j++) { if (text[j] === "'") { if (text[j + 1] === "'") { j++; continue } break } if (text[j] === '\n') line++ }
      if (j >= text.length) problems.push(`unclosed ' at line ${line}`)
      i = j; continue
    }
    if (c === '"') { // double-quoted: ` escapes; $( ) may contain single-quoted text
      let j = i + 1
      for (; j < text.length; j++) { if (text[j] === '`') { j++; continue } if (text[j] === '"') break; if (text[j] === '\n') line++ }
      if (j >= text.length) problems.push(`unclosed " at line ${line}`)
      i = j; continue
    }
    if ('({['.includes(c)) stack.push({ ch: c, line })
    else if (')}]'.includes(c)) {
      const open = stack.pop()
      if (!open || open.ch !== pairs[c]) problems.push(`'${c}' at line ${line} does not close ${open ? `'${open.ch}' from line ${open.line}` : 'anything'}`)
    }
  }
  for (const o of stack) problems.push(`'${o.ch}' from line ${o.line} is never closed`)
  return problems
}

// Every cmdlet the scripts use: built into Windows PowerShell 5.1 / 7 and the ScheduledTasks module, or defined there
const KNOWN_CMDLETS = new Set([
  'Get-Command', 'Get-Item', 'Get-ItemProperty', 'Get-ChildItem', 'Get-Content', 'Get-Acl', 'Set-Acl', 'Get-Date', 'Get-CimInstance',
  'Test-Path', 'Resolve-Path', 'Split-Path', 'Join-Path', 'New-Item', 'Copy-Item', 'Move-Item', 'Remove-Item', 'New-Object',
  'Select-Object', 'Where-Object', 'ForEach-Object', 'Out-Null', 'Write-Host', 'Write-Warning', 'Read-Host', 'Start-Sleep',
  'ConvertFrom-Json', 'New-TimeSpan', 'New-ScheduledTaskAction', 'New-ScheduledTaskTrigger', 'New-ScheduledTaskPrincipal',
  'New-ScheduledTaskSettingsSet', 'Register-ScheduledTask', 'Unregister-ScheduledTask', 'Start-ScheduledTask', 'Stop-ScheduledTask',
  'Get-ScheduledTask', 'Get-ScheduledTaskInfo', 'Stop-Process', 'Set-ExecutionPolicy', 'Get-FileHash',
])
function unknownCommands(text: string): string[] {
  const code = text.replace(/<#[\s\S]*?#>/g, '').split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n')
  const defined = new Set([...code.matchAll(/^function ([A-Z][A-Za-z]+-[A-Za-z]+)/gm)].map((m) => m[1]))
  const used = new Set([...code.matchAll(/(?<![\w$.-])([A-Z][a-z]+-[A-Z][A-Za-z]+)\b/g)].map((m) => m[1]))
  return [...used].filter((c) => !KNOWN_CMDLETS.has(c) && !defined.has(c))
}
/** A regex written in a script as '...' (PowerShell and JavaScript read these the same way) */
function psRegex(text: string, name: string): RegExp {
  const m = new RegExp(`\\$${name} = '([^']+)'`).exec(text)
  if (!m) throw new Error(`${name} not found`)
  return new RegExp(m[1])
}

describe('Windows installer and uninstaller (checked statically — PowerShell is NOT available here; Windows runs are pending)', () => {
  const inst = src('connector/tally/windows/install-connector.ps1')
  const uninst = src('connector/tally/windows/uninstall-connector.ps1')
  const at = (s: string) => { const i = inst.indexOf(s); if (i < 0) throw new Error(`not in installer: ${s}`); return i }
  const main = at('# ---------------------------------------------------------------- main')

  test('both scripts: plain ASCII, brackets and strings balanced, only known cmdlets or their own functions', () => {
    for (const [name, text] of [['install', inst], ['uninstall', uninst]] as const) {
      expect([name, /[^\x00-\x7f]/.test(text)]).toEqual([name, false])
      expect([name, powershellStructure(text)]).toEqual([name, []])
      expect([name, unknownCommands(text)]).toEqual([name, []])
      expect(text).toContain('#Requires -RunAsAdministrator')
      expect(text).toContain('#Requires -Version 5.1')
    }
    // functions are defined before the main part runs (a script runs top to bottom)
    for (const m of inst.matchAll(/^function ([A-Za-z-]+)/gm)) expect([m[1], (m.index ?? 0) < main]).toEqual([m[1], true])
    // the structure check itself catches mistakes
    expect(powershellStructure('if ($a) { "x" ')).toEqual(["'{' from line 1 is never closed"])
    expect(powershellStructure("Write-Host 'it''s' # )")).toEqual([])
  })

  test('B1: Node.js version from "node -v" (no quoted expression on the command line); missing or < 18 stops with a clear message', () => {
    expect(inst).not.toMatch(/-p ['"]process\.versions/) // the old check: its quotes are damaged by Windows PowerShell 5.1
    expect(inst).toContain('$out = @(& $Exe -v)')
    expect(inst).not.toMatch(/& \$Exe -v \| Select-Object/) // stopping the pipeline early can leave a wrong exit code
    const re = /\[regex\]::Match\(\[string\]\$out\[0\], '([^']+)'\)/.exec(inst)
    const v = new RegExp(re![1])
    const major = (s: string) => { const m = v.exec(s); return m ? Number(m[1]) : null }
    expect([major('v20.11.1'), major('v18.0.0\r'), major('  v22.3.0'), major('v8.17.0'), major('v16.20.2')]).toEqual([20, 18, 22, 8, 16])
    expect([major(''), major('node: not found'), major('20.1.0'), major('vX.1.2')]).toEqual([null, null, null, null])
    expect(inst).toMatch(/if \(\$null -eq \$major\) \{ throw/)
    expect(inst).toMatch(/if \(\$major -lt 18\) \{ throw "Node\.js \$major is too old/)
    expect(inst).toContain('open a NEW') // C5: a window opened before Node.js was installed does not see it
  })

  test('S6: -InstallDir is checked before anything is changed; drives, system folders, links and unrelated folders are refused', () => {
    expect(at('$InstallDir = Assert-SafeInstallDir $InstallDir')).toBeGreaterThan(main)
    for (const change of ['New-ProtectedFolder $InstallDir', 'Set-ConnectorFolderAcl $InstallDir', 'Copy-Item -LiteralPath $Source', 'Stop-ScheduledTask -TaskName $TaskName']) {
      expect([change, at('$InstallDir = Assert-SafeInstallDir $InstallDir') < at(change)]).toEqual([change, true])
    }
    const fn = inst.slice(at('function Assert-SafeInstallDir'), at('function Test-ProtectedFolder'))
    expect(fn).toContain('must not be a drive')
    expect(fn).toContain('not a network path')
    expect(fn).toMatch(/\$env:SystemRoot, \$env:ProgramFiles, \$\{env:ProgramFiles\(x86\)\}, \$env:ProgramW6432, \$env:ProgramData/)
    expect(fn).toContain('Test-UnderFolder $full $env:SystemRoot')
    expect(fn).toContain('is a link (junction or symbolic link)')
    expect(fn).toContain('which is not part of the connector')
    expect(inst).toContain("$OwnFiles = @('manuflow-tally-connector.mjs', 'VERSION', 'connector.json', 'connector.json.tmp', 'connector.json.lock', 'logs')")
    // no recursive permission change by path: the folder itself, then the already-checked items one by one
    expect(inst).not.toMatch(/icacls[^\n]*\/T\b/)
    expect(inst).not.toMatch(/\/inheritance:r/)
  })

  test('S1: folder owned by Administrators, protected, created already protected; untrusted or foreign settings are never used silently', () => {
    expect(inst).toContain('$acl.SetOwner((New-Object System.Security.Principal.SecurityIdentifier($SidAdmins)))')
    expect(inst).toContain('$acl.SetAccessRuleProtection($true, $false)')
    expect(inst).toContain("@(@($SidAdmins, 'FullControl'), @($SidSystem, 'FullControl'), @($SidLocalService, 'Modify'))")
    expect(inst).toContain('[System.IO.Directory]::CreateDirectory($Dir, $sec)') // 5.1
    expect(inst).toContain("'System.IO.FileSystemAclExtensions' -as [type]") // 7
    expect(inst).toMatch(/& icacls\.exe \$item\.FullName \/setowner "\*\$SidAdmins" \/Q/)
    expect(inst).toMatch(/& icacls\.exe \$item\.FullName \/reset \/Q/)
    // an existing folder: owner check, then "was it protected?" before its settings are believed
    expect(inst).toMatch(/if \(\$TrustedOwners -notcontains \$owner\) \{\s+throw/)
    expect(inst).toContain('$protected = $existed -and (Test-ProtectedFolder $InstallDir)')
    expect(inst).toMatch(/if \(\$hasConfig -and -not \$protected\) \{\s+if \(-not \$Repair\) \{\s+throw/)
    expect(inst).toMatch(/elseif \(\$hasConfig -and -not \$saved\) \{\s+if \(-not \$Repair\) \{ throw/)
    // the saved settings must look like the connector's own
    const token = psRegex(inst, 'TokenPattern')
    expect(token.test(`mftc_${'a'.repeat(24)}_${'B'.repeat(43)}`)).toBe(true)
    expect(token.test('mftc_fake')).toBe(false)
    expect(psRegex(inst, 'DeviceIdPattern').test('0123456789abcdef0123456789abcdef')).toBe(true)
    expect(inst).toContain("if ([string]$c.server -notmatch '^https://[^/\\s]+$') { return $null }")
    // a different ManuFlow address: stop (nothing changed) unless -Repair
    expect(inst).toMatch(/if \(\(Get-Origin \$saved\.server\) -ne \(Get-Origin \$Server\)\) \{/)
    expect(inst).toContain('but the ManuFlow address here is $Server ($how). Nothing was changed.')
    // all of this is decided before the task is stopped or a file is written
    for (const change of ['Stop-ScheduledTask -TaskName $TaskName', 'New-ProtectedFolder $InstallDir', 'Copy-Item -LiteralPath $Source']) {
      expect([change, at('$protected = $existed') < at(change) && at('Get-Origin $saved.server') < at(change)]).toEqual([change, true])
    }
    // an untrusted file is moved aside only with -Repair, never deleted, and only after the folder is protected
    expect(inst).toContain('$setAside = $hasConfig -and $Repair -and (-not $protected -or -not $saved)')
    expect(at('Move-Item -LiteralPath $Config')).toBeGreaterThan(at('Set-ConnectorFolderAcl $InstallDir'))
  })

  test('S2: upgrade waits for the task to stop and removes the lock only if no connector process holds it', () => {
    expect(at('Remove-StaleLock $Config')).toBeGreaterThan(at('Stop-ScheduledTask -TaskName $TaskName'))
    expect(at('Remove-StaleLock $Config')).toBeLessThan(at('Copy-Item -LiteralPath $Source'))
    const fn = inst.slice(at('function Remove-StaleLock'), at('function Get-LogTail'))
    expect(fn).toContain('Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $lockPid"')
    expect(fn).toMatch(/\$proc\.Name -ieq 'node\.exe'/)
    expect(fn).toContain("IndexOf('manuflow-tally-connector'")
    expect(fn).toMatch(/if \(\$isConnector\) \{\s+throw "A connector is still running/)
    expect(fn.indexOf('Remove-Item -LiteralPath $lock')).toBeGreaterThan(fn.indexOf('if ($isConnector) {\n      throw'))
  })

  test('S3: links into a user profile are found and LOCAL SERVICE runs Node.js once in a test task, before a code is used', () => {
    const fn = inst.slice(at('function Get-NodeRealPaths'), at('function Invoke-AsLocalService'))
    expect(fn).toContain('$item.LinkType')
    expect(fn).toContain('@($item.Target)[0]') // string[] in 5.1, string in 7
    expect(inst).toContain('ProfileList')
    const probe = inst.slice(at('function Invoke-AsLocalService'), at('function Assert-SafeInstallDir'))
    expect(probe).toMatch(/New-ScheduledTaskPrincipal -UserId \$LocalService -LogonType ServiceAccount/)
    expect(probe).toMatch(/finally \{\s+Unregister-ScheduledTask -TaskName \$ProbeTaskName/) // always removed
    expect(at("$probe = Invoke-AsLocalService $NodePath ('\"{0}\" version' -f $Script) $InstallDir")).toBeLessThan(at('$Code | & $NodePath $Script pair'))
    expect(inst).toMatch(/elseif \(\$probe -ne 0\) \{[\s\S]{0,400}throw \$msg/)
  })

  test('S4: existing pairing kept (token and device id); -Tally applied with set-tally; -Code without -Repair not used', () => {
    expect(inst).toContain('$needPairing = $Repair -or -not $Paired')
    expect(inst).toMatch(/if \(\$PSBoundParameters\.ContainsKey\('Tally'\)\) \{\s+& \$NodePath \$Script set-tally --tally \$Tally --config \$Config/)
    expect(inst).toContain("Write-Warning 'This computer is already paired: the code was NOT used. To pair it again, run with -Repair.'")
    // the code: hidden prompt, cleared from memory, to the connector on standard input only, never shown
    expect(inst).toContain('-AsSecureString')
    expect(inst).toContain('[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)')
    expect(inst).toMatch(/\$Code \| & \$NodePath \$Script pair --server \$Server --code-stdin --tally \$Tally --config \$Config/)
    expect(inst).not.toMatch(/--code \$Code|Write-(Host|Output|Verbose|Warning)[^\n]*\$Code/)
    expect(psRegex(inst, 'TokenPattern').source).toBe('^mftc_[a-f0-9]{24}_[A-Za-z0-9_-]{43}$')
    // nothing is downloaded or installed from the internet
    expect(inst).not.toMatch(/Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|npm install|curl /i)
    expect(inst).toMatch(/\$Server -notmatch '\^https:\/\//)
  })

  test('S5: task registered as LOCAL SERVICE with both triggers, started, and Running/267009 — otherwise "NOT complete"', () => {
    expect(inst).toContain("SecurityIdentifier($SidLocalService)")
    expect(inst).toMatch(/New-ScheduledTaskPrincipal -UserId \$LocalService -LogonType ServiceAccount -RunLevel Limited/)
    expect(inst).toContain('New-ScheduledTaskTrigger -AtStartup')
    expect(inst).toMatch(/-RepetitionInterval \(New-TimeSpan -Minutes 5\)/)
    expect(inst).toContain('-ExecutionTimeLimit ([TimeSpan]::Zero)')
    expect(inst).toContain('-MultipleInstances IgnoreNew')
    expect(inst).toMatch(/run --config "\{1\}" --log-file "\{2\}"/)
    expect(inst).toContain('$TaskRunning = 267009')
    expect(inst).toMatch(/if \(\$state -ne 'Running' -or \$result -ne \$TaskRunning\) \{/)
    expect(inst).toContain('The installation is NOT complete.')
    expect(inst).toMatch(/if \(@\(\$task\.Triggers\)\.Count -ne 2\)/)
    expect(inst).toMatch(/if \(-not \$runsAsLocalService\) \{ throw/)
    // "Installed" is printed only after the check
    expect(at("Write-Host (\"Installed: ")).toBeGreaterThan(at('The installation is NOT complete.'))
  })

  test('C1: UTF-8 console output while the scripts run (restored afterwards); the log is read as UTF-8', () => {
    for (const text of [inst, uninst]) {
      expect(text).toContain('[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)')
      expect(text).toContain('[Console]::OutputEncoding = $PreviousOutputEncoding')
    }
    expect(inst).toContain('Get-Content -LiteralPath $Path -Tail $Lines -Encoding UTF8')
    expect(inst).not.toMatch(/Get-Content[^\n]*-Tail(?![^\n]*-Encoding UTF8)/)
  })

  test('C4 + uninstall: -WhatIf removes nothing and says so; "Removed" only when gone; pairing kept unless -RemoveSettings', () => {
    expect(uninst).toContain("[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]")
    expect(uninst).toMatch(/if \(\$PSCmdlet\.ShouldProcess\(\$TaskName, 'Stop and remove the scheduled task'\)\)/)
    expect(uninst).toMatch(/if \(\$PSCmdlet\.ShouldProcess\(\$Path, "Delete \$What"\)\) \{\s+Remove-Item -LiteralPath \$Path -Force\s+if \(Test-Path -LiteralPath \$Path\) \{ Write-Warning "Could not delete \$Path" \} else \{ Write-Host "Removed \$Path" \}/)
    expect(uninst).toMatch(/elseif \(\$whatIf\) \{\s+\$data \| ForEach-Object \{ \[void\]\$PSCmdlet\.ShouldProcess/)
    expect(uninst).toContain("if ($whatIf) { Write-Host 'WhatIf: nothing was removed.' }")
    expect(uninst).toMatch(/\$Force -or \$PSCmdlet\.ShouldContinue\(/)
    // every "Removed" message follows a check that the thing is really gone
    for (const m of uninst.matchAll(/Write-Host "Removed/g)) expect(uninst.slice(Math.max(0, (m.index ?? 0) - 160), m.index)).toMatch(/Test-Path|Get-ScheduledTask/)
    expect(uninst).not.toMatch(/Remove-Item[^\n]*-Recurse/)
    expect(uninst).not.toMatch(/Tally(Prime)?\\|tally\.exe|ProgramFiles/i)
    expect(uninst).toContain("Remove-OwnFile (Join-Path $InstallDir 'manuflow-tally-connector.mjs')")
    expect(uninst).toMatch(/if \(\$RemoveSettings\) \{/)
    // the lock only when no connector process holds it
    expect(uninst).toMatch(/\$proc\.Name -ieq 'node\.exe'[\s\S]{0,200}Write-Warning "A connector is still running/)
  })

  test('C2, C3, C5: the guides describe the watchdog, the copied-identity risk and the new PowerShell window', () => {
    const guide = src('connector/tally/INSTALL.md')
    const internal = src('docs/tally-connector-windows.md')
    expect(internal).toContain('only\napplies when the task **cannot be started**')
    expect(internal).toContain('next 5-minute trigger starts the connector again')
    expect(guide).toContain('Windows starts it again within 5 minutes')
    expect(guide).toContain('**copying the whole settings file to another computer copies the identity too**')
    expect(internal).toContain('copying the whole `connector.json` copies the\n    identity as well')
    expect(guide).not.toContain('works only on this computer')
    expect(guide).toContain('open a new PowerShell window')
    expect(guide).toContain('-Tail 20 -Encoding UTF8')
  })
})

// ---------------------------------------------------------------- how the program ends (fix for the Windows exit crash)

describe('the program ends without process.exit() (Windows Node.js 23+ crash, nodejs/node#56645)', () => {
  beforeEach(async () => { await resetDb(); process.env.TALLY_CONNECTOR_POC = '1' })
  const SCRIPT = join(ROOT, 'connector/tally/manuflow-tally-connector.mjs')
  // A preload that reports every process.exit() call: on Windows, process.exit() right after a network request is
  // what aborts Node.js 23+ with "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c".
  const spy = () => {
    const f = join(dir, 'exit-spy.mjs')
    writeFileSync(f, "const exit = process.exit.bind(process)\nprocess.exit = (c) => { process.stderr.write('PROCESS_EXIT_CALLED\\n'); return exit(c) }\n")
    return f
  }
  // the real node binary, as the installer and the scheduled task run it
  async function node(args: string[], stdin?: string) {
    const started = Date.now()
    const p = Bun.spawn(['node', '--import', `file://${spy()}`, SCRIPT, ...args], { stdin: stdin === undefined ? 'ignore' : 'pipe', stdout: 'pipe', stderr: 'pipe' })
    if (stdin !== undefined && p.stdin) { p.stdin.write(stdin); p.stdin.end() }
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    return { out, err, code, ms: Date.now() - started }
  }

  test('the entry point sets the exit code and lets Node.js end by itself; process.exit() is only an unref\'d safety net', () => {
    const s = src('connector/tally/manuflow-tally-connector.mjs')
    const entry = s.slice(s.indexOf('if (process.argv[1] && fileURLToPath(import.meta.url)'))
    expect(entry).toContain('main().then(finish,')
    expect(entry).not.toContain('process.exit')
    const fin = s.slice(s.indexOf('export function finish('), s.indexOf('if (process.argv[1] && fileURLToPath'))
    expect(fin).toContain('proc.exitCode = code')
    expect(fin).toContain('t.unref()')
    expect(s.match(/fetch\(/g)?.length).toBe(2) // unchanged: Tally and ManuFlow only
  })

  test('finish(): exit code set at once; the safety timer does not keep the program alive and fires only when stuck', async () => {
    const calls: number[] = []
    const proc = { exitCode: undefined as number | undefined, exit: (c: number) => { calls.push(c) } }
    const t = finish(3, proc as unknown as NodeJS.Process, 30)
    expect(proc.exitCode).toBe(3)
    expect(t.hasRef()).toBe(false)
    expect(calls).toEqual([])
    await Bun.sleep(80)
    expect(calls).toEqual([3])
  })

  test('check (Tally + ManuFlow reached): prints both results, exit code 0, process.exit() never called, ends quickly', async () => {
    const r = await node(['check', '--tally', `http://127.0.0.1:${tally.port}`, '--server', `http://127.0.0.1:${manuflow.port}`, '--config', join(dir, 'none', 'connector.json')])
    expect(r.out).toContain(`Tally: connected at 127.0.0.1:${tally.port}`)
    expect(r.out).toContain('ManuFlow: ')
    expect(r.out).toContain('can be reached')
    expect(r.err).not.toContain('PROCESS_EXIT_CALLED')
    expect(r.code).toBe(0)
    expect(r.ms).toBeLessThan(5000) // well before the 10 s safety net
  })

  test('check with Tally unreachable: exit code 1, still without process.exit()', async () => {
    const r = await node(['check', '--tally', 'http://127.0.0.1:9', '--server', `http://127.0.0.1:${manuflow.port}`, '--config', join(dir, 'none', 'connector.json')])
    expect(r.out).toContain('Tally: unreachable')
    expect(r.err).not.toContain('PROCESS_EXIT_CALLED')
    expect(r.code).toBe(1)
  })

  test('pair --code-stdin exactly as the installer runs it: exit code 0 after saving, without process.exit()', async () => {
    const { user } = await seedTenant()
    const code = (await call(createCode(apiRequest('/api/import-center/tally/connector', { method: 'POST', user })))).json.data.code as string
    const path = join(dir, 'spawned-pair', 'connector.json')
    const r = await node(['pair', '--server', `http://127.0.0.1:${manuflow.port}`, '--code-stdin', '--tally', `http://127.0.0.1:${tally.port}`, '--config', path], `${code}\r\n`)
    expect(r.out).toContain('Paired.')
    expect(r.err).not.toContain('PROCESS_EXIT_CALLED')
    expect(r.code).toBe(0)
    expect(connector.loadConfig(path).token).toMatch(/^mftc_/)
    expect(r.out + r.err).not.toContain(code)
  })
})
