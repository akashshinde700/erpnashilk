import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError, getActor } from '@/lib/erp-helpers'

/**
 * Idempotency-Key support for money-creating requests (Cash & Bank Phase 5).
 *
 * A client sends one `Idempotency-Key` header per form submission and the same key when it retries that
 * submission. Without the header nothing changes.
 *
 *  1. claimIdempotency() inserts the key as PENDING — committed on its own, BEFORE the business transaction. The
 *     unique (companyId, key) index lets exactly one of several concurrent requests with the key claim it.
 *  2. The winner runs the business transaction and calls done(tx, data, message) INSIDE it: the key becomes DONE
 *     with the response in the same commit as the documents. Either both are saved or neither.
 *  3. Losers / retries: DONE with the same request → the stored response is returned again (header
 *     `Idempotent-Replay: true`), nothing is created; still PENDING → 409 IDEMPOTENCY_IN_PROGRESS; the key was used
 *     for a different request (body, route or user) → 422 IDEMPOTENCY_KEY_REUSED.
 *  4. A request that fails calls release(): its PENDING row is removed, so a retry runs normally (nothing was
 *     committed). A process that dies mid-request leaves a PENDING row; after 10 minutes — far beyond the 30 s
 *     transaction timeout, so its transaction can no longer commit — a retry takes it over. The takeover changes the
 *     claim stamp (updatedAt), so a late done() of the old claim fails instead of committing a second set of documents.
 *  5. Keys are kept 7 days (purged now and then on claim).
 */

const KEY_RE = /^[A-Za-z0-9_\-:.]{8,100}$/
// Age limits are checked in SQL against the database clock (Prisma stores DATETIME in UTC), never the app clock
const STALE_MINUTES = 10
const KEEP_DAYS = 7

type Tx = Prisma.TransactionClient

export interface Idempotency {
  /** Stored response to send back for a repeated request (nothing else to do), else null. */
  replay: Response | null
  /** Inside the business transaction, with exactly what the route returns via ok(data, message). */
  done: (tx: Tx, data: unknown, message: string) => Promise<void>
  /** After a failure: frees the key so a retry runs again. Never throws. */
  release: () => Promise<void>
}

const NONE: Idempotency = { replay: null, done: async () => {}, release: async () => {} }

/** JSON with object keys sorted, so the same body always hashes the same. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

export async function purgeIdempotencyKeys() {
  await db.$executeRaw`DELETE FROM IdempotencyKey WHERE createdAt < UTC_TIMESTAMP(3) - INTERVAL ${KEEP_DAYS} DAY`
}

export async function claimIdempotency(req: Request, companyId: string, route: string, body: unknown): Promise<Idempotency> {
  const raw = req.headers.get('idempotency-key')
  if (raw === null) return NONE
  const key = raw.trim()
  if (!KEY_RE.test(key)) throw new ApiError('Idempotency-Key must be 8–100 letters, digits or - _ : .', 400, 'IDEMPOTENCY_KEY_INVALID')
  const userId = getActor(req)?.userId ?? ''
  const requestHash = createHash('sha256').update(`${route}\n${stable(body)}`).digest('hex')
  if (Math.random() < 0.02) void purgeIdempotencyKeys().catch(() => {})

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const row = await db.idempotencyKey.create({ data: { companyId, key, userId, route, requestHash } })
      return claimed(row.id, row.updatedAt)
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e
    }
    const existing = await db.idempotencyKey.findUnique({ where: { companyId_key: { companyId, key } } })
    if (!existing) continue // released between our insert and read — claim again
    if (existing.userId !== userId || existing.route !== route || existing.requestHash !== requestHash) {
      throw new ApiError('This Idempotency-Key was already used for a different request', 422, 'IDEMPOTENCY_KEY_REUSED')
    }
    if (existing.status === 'DONE') {
      return {
        ...NONE,
        replay: new NextResponse(existing.response ?? 'null', {
          status: existing.statusCode ?? 200,
          headers: { 'content-type': 'application/json', 'Idempotent-Replay': 'true' },
        }),
      }
    }
    // Take over a claim older than STALE_MINUTES (its process died): new stamp, so the old claim can no longer finish
    const stamp = new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1))
    const took = await db.$executeRaw`UPDATE IdempotencyKey SET updatedAt = ${stamp} WHERE id = ${existing.id} AND status = 'PENDING' AND updatedAt = ${existing.updatedAt} AND updatedAt < UTC_TIMESTAMP(3) - INTERVAL ${STALE_MINUTES} MINUTE`
    if (took === 1) return claimed(existing.id, stamp)
    throw new ApiError('This request is already being processed — wait a moment, then refresh to see whether it was saved', 409, 'IDEMPOTENCY_IN_PROGRESS')
  }
  throw new ApiError('This request is already being processed — wait a moment, then refresh to see whether it was saved', 409, 'IDEMPOTENCY_IN_PROGRESS')
}

function claimed(id: string, stamp: Date): Idempotency {
  return {
    replay: null,
    async done(tx, data, message) {
      const r = await tx.idempotencyKey.updateMany({
        where: { id, status: 'PENDING', updatedAt: stamp },
        data: { status: 'DONE', statusCode: 200, response: JSON.stringify({ success: true, data, message }) },
      })
      if (r.count !== 1) throw new ApiError('This request was taken over by a retry — refresh and check before saving again', 409, 'IDEMPOTENCY_IN_PROGRESS')
    },
    async release() {
      await db.idempotencyKey.deleteMany({ where: { id, status: 'PENDING', updatedAt: stamp } }).catch(() => {})
    },
  }
}
