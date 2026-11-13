// The send PIN: a secret only the person knows, which every Send needs
// (pr-routes.mjs). It stops anything that drives the page for them: the chat
// agent's browser, a website that rebinds its name to this machine, a tab left
// open. The person sets it in their own terminal (`node tools/factory.mjs
// pr-pin`, tools/pr-pin.mjs); only its scrypt hash is kept, in config.json as
// pr.pinHash. The PIN itself is never stored, logged or returned.
//
//   hashPin(pin, { N? })        'scrypt$N$r$p$<salt base64>$<hash base64>'
//   validPinHash(s)             the shape and sane parameters
//   verifyPin(pin, hash)        scryptSync, then timingSafeEqual
//   pinProblem(pin)             why a new PIN is refused, or null
//   makeLock({ max, ms, now })  five wrong tries lock sending for ten minutes
//   withPinHash(text, hash)     config.json's text with pr.pinHash set, every other line as it was
//   sharedLock                  the one five-try lock, for sending and for the Settings page

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { withPrKeys } from './config-write.mjs'

const KEYLEN = 32
const B64 = /^[A-Za-z0-9+/]+={0,2}$/

function parse(hash) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([^$]+)\$([^$]+)$/.exec(typeof hash === 'string' ? hash : '')
  if (!m) return null
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])]
  // at most 64 MiB of memory (128 N r) and 4 passes: a hash in config.json must not be able to stall the server
  if (N < 1024 || (N & (N - 1)) !== 0 || r < 1 || p < 1 || p > 4 || 128 * N * r > 64 * 1024 * 1024) return null
  if (!B64.test(m[4]) || !B64.test(m[5])) return null
  const salt = Buffer.from(m[4], 'base64')
  const key = Buffer.from(m[5], 'base64')
  return salt.length >= 4 && key.length === KEYLEN ? { N, r, p, salt, key } : null
}

const derive = (pin, { N, r, p, salt }) => scryptSync(pin, salt, KEYLEN, { N, r, p, maxmem: 256 * N * r })

export function hashPin(pin, { N = 16384, r = 8, p = 1 } = {}) {
  const salt = randomBytes(16)
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${derive(String(pin), { N, r, p, salt }).toString('base64')}`
}

export const validPinHash = hash => !!parse(hash)

export function verifyPin(pin, hash) {
  const h = parse(hash)
  if (!h || typeof pin !== 'string' || !pin) return false
  try {
    return timingSafeEqual(derive(pin, h), h.key)
  } catch {
    return false // a hash scrypt cannot run counts as a wrong PIN
  }
}

export function pinProblem(pin) {
  if (typeof pin !== 'string' || /[\r\n]/.test(pin)) return 'A send PIN is one line.'
  return pin.length < 6 ? 'A send PIN needs at least 6 characters.' : null
}

/** `max` wrong tries lock for `ms`; `locked()` is the time left (0 when open); a right PIN clears the count. */
export function makeLock({ max = 5, ms = 10 * 60_000, now = Date.now } = {}) {
  let fails = 0
  let until = 0
  return {
    locked() {
      if (until && until <= now()) until = 0
      return until ? until - now() : 0
    },
    fail() {
      if (++fails >= max) { until = now() + ms; fails = 0 }
    },
    ok() { fails = 0 },
  }
}

/** config.json's text with pr.pinHash set, every other line as it was (config-write.mjs). */
export const withPinHash = (text, hash) => withPrKeys(text, { pinHash: hash })

/**
 * The ONE lock for this server: a wrong PIN to send (pr-routes.mjs) and a wrong current PIN on the
 * Settings page (settings-routes.mjs) count toward the same five tries.
 */
let shared = makeLock()
export const sharedLock = { get: () => shared, reset() { shared = makeLock() } }
