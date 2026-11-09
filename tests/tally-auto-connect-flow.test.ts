import { describe, expect, test } from 'bun:test'
import type { ConnectorStatus } from '@/lib/tally/connector'
import {
  CONNECT_DEADLINE_MS, CONNECT_STEPS, LIST_AUTO_RETRIES, autoConnectProgress, connectFailure, pollDelay,
  type ConnectStep, type StepState,
} from '@/lib/tally/flow'

// The automatic connection of Import from Tally (step 1): what the screen shows is derived only from what the server
// reports. The screens themselves are tested in e2e/specs/13-tally-import.spec.ts.

const st = (state: ConnectorStatus['state'], message = ''): ConnectorStatus => ({ state, message })
const row = (steps: Record<ConnectStep, StepState>) => CONNECT_STEPS.map((s) => steps[s.key]).join(' ')
const none = { listing: false, companies: null, error: '' }

describe('automatic connection: steps only as far as the server has confirmed', () => {
  test('each server state', () => {
    const cases: [ConnectorStatus | null, string, string][] = [
      [null, 'active pending pending pending pending', 'working'], // searching: nothing known yet
      [st('connecting'), 'done active pending pending pending', 'working'], // paired, no check-in yet
      [st('reconnecting'), 'done active pending pending pending', 'working'],
      [st('offline'), 'done active pending pending pending', 'working'], // heartbeat too old
      [st('tally_error'), 'done done done active pending', 'working'], // checked in with token + device id; Tally not answering
      [st('connected'), 'done done done done active', 'working'], // companies not read yet
      [st('not_paired'), 'failed pending pending pending pending', 'needs-pairing'],
      [st('pairing'), 'failed pending pending pending pending', 'needs-pairing'],
      [st('auth_failed'), 'done done failed pending pending', 'needs-pairing'], // expired token / other computer
      [st('outdated'), 'done done done failed pending', 'blocked'],
      [st('unavailable'), 'failed pending pending pending pending', 'blocked'],
    ]
    for (const [conn, steps, kind] of cases) {
      const a = autoConnectProgress(conn, none)
      expect([conn?.state, row(a.steps), a.outcome.kind]).toEqual([conn?.state, steps, kind])
    }
  })

  test('companies: done only when the list is in (an empty list counts: the company step says so)', () => {
    const c = st('connected')
    expect(row(autoConnectProgress(c, { listing: true, companies: null, error: '' }).steps)).toBe('done done done done active')
    expect(autoConnectProgress(c, { listing: false, companies: [{}, {}], error: '' }).outcome.kind).toBe('ready')
    expect(autoConnectProgress(c, { listing: false, companies: [], error: '' }).outcome.kind).toBe('ready')
    // a re-read in progress is not "ready" yet
    expect(autoConnectProgress(c, { listing: true, companies: [{}], error: '' }).outcome.kind).toBe('working')
    // the connection dropping during discovery takes the steps back
    expect(row(autoConnectProgress(st('reconnecting'), { listing: true, companies: null, error: '' }).steps)).toBe('done active pending pending pending')
  })

  test('first-time pairing and re-pairing are never shown as connected', () => {
    for (const s of ['not_paired', 'pairing', 'auth_failed'] as const) {
      const a = autoConnectProgress(st(s), { listing: false, companies: [{}], error: '' })
      expect([s, a.outcome.kind, a.steps.tally, a.steps.companies]).toEqual([s, 'needs-pairing', 'pending', 'pending'])
    }
  })
})

describe('waiting and giving up', () => {
  test('checks back off from 1.5 s to at most 8 s; the wait ends after 75 s; the list is retried twice', () => {
    expect([1, 2, 3, 4, 5, 10].map(pollDelay)).toEqual([1500, 2400, 3840, 6144, 8000, 8000])
    expect(pollDelay(0)).toBe(1500)
    expect(CONNECT_DEADLINE_MS).toBe(75_000)
    expect(LIST_AUTO_RETRIES).toBe(2)
  })

  test('what failed, why, and what to do — for each state the connection can be left in', () => {
    expect(connectFailure(null, { error: '' }, 'Failed to fetch').title).toBe('ManuFlow could not be reached')
    expect(connectFailure(st('offline'), { error: '' }, '').title).toBe('The Tally connector is not responding')
    expect(connectFailure(st('connecting'), { error: '' }, '').why[0]).toContain('has not checked in yet')
    const tally = connectFailure(st('tally_error', 'TallyPrime did not answer in time.'), { error: '' }, '')
    expect([tally.title, tally.why]).toEqual(['TallyPrime is not reachable', ['TallyPrime did not answer in time.']])
    expect(connectFailure(st('connected'), { error: 'Took too long.' }, '').why).toEqual(['Took too long.'])
    expect(connectFailure(st('outdated', 'too old'), { error: '' }, '').title).toContain('needs an update')
    expect(connectFailure(st('unavailable', 'off'), { error: '' }, '').todo[0]).toContain('Excel / CSV')
    for (const s of ['offline', 'tally_error', 'connected'] as const) expect(connectFailure(st(s), { error: '' }, '').todo.join(' ')).toContain('Retry')
  })

  test('the texts never contain a token or a secret-looking value', () => {
    const all = JSON.stringify(['offline', 'tally_error', 'connected', 'outdated', 'unavailable', 'connecting']
      .map((s) => connectFailure(st(s as ConnectorStatus['state'], 'msg'), { error: 'e' }, 'n')))
    expect(all).not.toMatch(/mftc_|token|password|secret/i)
  })
})
