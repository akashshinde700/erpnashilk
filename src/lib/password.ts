import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * Password hashing helpers (server-only, node:crypto).
 * Format stored in User.passwordHash: "<hexSalt>:<hexHash>" (scrypt, N=16384 default).
 */

// Only used by the dev seed script (prisma/seed.ts); never accepted as a fallback at login.
export const DEMO_PASSWORD = 'demo1234'

export const MIN_PASSWORD_LENGTH = 8

/** Returns an error message, or null when the password is acceptable. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
  }
  if (password.length > 128) return 'Password is too long'
  return null
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 32).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  // A user without a password cannot sign in until an admin sets one.
  if (!stored) return false
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
