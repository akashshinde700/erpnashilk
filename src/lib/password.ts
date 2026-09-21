import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * Password hashing helpers (server-only, node:crypto).
 * Format stored in User.passwordHash: "<hexSalt>:<hexHash>" (scrypt, N=16384 default).
 */

export const DEMO_PASSWORD = 'demo1234'

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 32).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  // Demo fallback: users created before the auth phase (or via Users module without password)
  // can sign in with the shared demo password.
  if (!stored) return password === DEMO_PASSWORD
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  try {
    const candidate = scryptSync(password, salt, 32)
    const expected = Buffer.from(hash, 'hex')
    return candidate.length === expected.length && timingSafeEqual(candidate, expected)
  } catch {
    return false
  }
}
