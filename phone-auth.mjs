// Who is signed in on a phone: the phone PIN, the five-try lock, the sessions and their CSRF tokens.
//
// THE PIN is 6 to 12 digits, set by the person in a terminal (`node tools/factory.mjs phone-pin`,
// tools/phone-cli.mjs) and kept only as its salted scrypt hash in config.json (remote.pinHash). It is checked
// with send-pin.mjs verifyPin: scrypt, then a constant-time compare. The PIN itself is never stored, logged or
// returned. It is a different secret from the send PIN on purpose: a phone PIN typed on a phone in a café is
// not the secret that pushes code.
//
// THE LOCK: 5 wrong PINs lock phone sign-in for 15 minutes, for EVERY address (an attacker can change address;
// the user can wait or sign in at the PC). While locked, even the right PIN is refused without being checked.
// The count and the lock are kept ON DISK, so restarting the dashboard does not reset them, and a lock this
// process has seen holds even if the file is damaged. Each lockout writes one line to the console and one event
// the orchestration Log shows (logEvents). ⚠️ Safety over convenience: anyone on the network can lock the user
// out of their phone for 15 minutes by guessing badly. That is the price of a lock they cannot get around.
//
// A SESSION is a random 256-bit token (32 bytes, base64url) in an HttpOnly, SameSite=Strict cookie scoped to
// /phone. Only its SHA-256 is kept, so the auth file alone signs no one in. A session lasts `sessionHours` from
// sign-in (absolute, never extended by use); a lower setting shortens sessions already open. Sign out everywhere
// (the desktop Settings page) drops them all.
//
// ⚠️ The cookie has no Secure flag: phone access is plain HTTP on a private network (README, Phone access), and
// a browser drops a Secure cookie over HTTP. Tailscale encrypts the link; home Wi-Fi with WPA2 or better
// encrypts the air. Anyone who can read the traffic on the network itself can read the cookie.
//
// THE CSRF TOKEN is an HMAC of the session token (csrfOf): a page on another site can neither read the cookie
// nor compute it, and nothing extra is stored. Every write on the phone API sends it in a header.
//
//   phonePinProblem(pin)          why a new phone PIN is refused, or null
//   makeAuthStore({ file, now, log })   { login, session, logout, signOutEverywhere, lockedFor, events, logEvents, read }
//   csrfOf(token) / csrfOk(token, header)
//   sessionCookie(token, hours) / clearCookie() / tokenFromCookie(header)

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { writeAtomic } from './atomic-write.mjs'
import { DATA_ROOT } from './project-store.mjs'
import { validPinHash, verifyPin } from './send-pin.mjs'

/** Machine-wide, never per project: the lock and the sessions belong to the PC, whichever project is open. */
export const AUTH_FILE = path.join(DATA_ROOT, 'phone-auth.json')
export const LOCK = Object.freeze({ tries: 5, ms: 15 * 60_000 })
export const EVENTS_MAX = 50
const SESSIONS_MAX = 20
const COOKIE = 'phone_session'
const TOKEN = /^[A-Za-z0-9_-]{43}$/
export const EVENT_KINDS = Object.freeze(['login', 'wrong', 'lockout', 'signout', 'signout-all'])

export function phonePinProblem(pin) {
  if (typeof pin !== 'string') return 'The phone PIN must be typed as digits.'
  if (!/^[0-9]*$/.test(pin)) return 'The phone PIN is only digits (0 to 9).'
  if (pin.length < 6) return 'The phone PIN needs at least 6 digits.'
  if (pin.length > 12) return 'The phone PIN has at most 12 digits.'
  return null
}

const sha = s => createHash('sha256').update(s).digest('hex')
const same = (a, b) => {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

export const csrfOf = token => createHmac('sha256', String(token)).update('phone-csrf').digest('base64url')
export const csrfOk = (token, header) => typeof header === 'string' && !!header && same(csrfOf(token), header)

export const sessionCookie = (token, hours) => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/phone; Max-Age=${Math.round(hours * 3600)}`
export const clearCookie = () => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/phone; Max-Age=0`

export function tokenFromCookie(header) {
  for (const part of String(header ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at < 0 || part.slice(0, at).trim() !== COOKIE) continue
    const v = part.slice(at + 1).trim()
    return TOKEN.test(v) ? v : ''
  }
  return ''
}

const isTime = v => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const EMPTY = () => ({ fails: 0, lockedUntil: null, sessions: [], events: [] })

/** The file, cleaned: anything malformed is dropped, so a hand edit can add nothing that signs anyone in. */
function clean(raw) {
  const s = EMPTY()
  if (!raw || typeof raw !== 'object') return s
  s.fails = Number.isInteger(raw.fails) && raw.fails >= 0 && raw.fails < LOCK.tries ? raw.fails : 0
  s.lockedUntil = isTime(raw.lockedUntil) ? raw.lockedUntil : null
  s.sessions = (Array.isArray(raw.sessions) ? raw.sessions : [])
    .filter(x => x && /^[0-9a-f]{64}$/.test(x.id) && isTime(x.createdAt) && isTime(x.expiresAt))
    .map(x => ({ id: x.id, createdAt: x.createdAt, expiresAt: x.expiresAt, address: String(x.address || '').slice(0, 64) }))
  s.events = (Array.isArray(raw.events) ? raw.events : [])
    .filter(e => e && isTime(e.at) && EVENT_KINDS.includes(e.kind))
    .map(e => ({ at: e.at, kind: e.kind, address: String(e.address || '').slice(0, 64), ...(Number.isInteger(e.count) ? { count: e.count } : {}) }))
    .slice(-EVENTS_MAX)
  return s
}

export function makeAuthStore({ file = AUTH_FILE, now = Date.now, log = line => console.log(line), verify = verifyPin } = {}) {
  /** The latest lock this process has seen: a damaged or deleted file never lifts it early. */
  let knownLock = 0

  function read() {
    try {
      return clean(JSON.parse(readFileSync(file, 'utf8')))
    } catch {
      return EMPTY()
    }
  }
  const iso = t => new Date(t).toISOString()
  const write = s => writeAtomic(file, `${JSON.stringify({ ...s, events: s.events.slice(-EVENTS_MAX) }, null, 2)}\n`)
  const event = (s, kind, address = '', extra = {}) => s.events.push({ at: iso(now()), kind, address: String(address || '').slice(0, 64), ...extra })
  const live = (x, hours) => {
    const end = Math.min(Date.parse(x.expiresAt), Date.parse(x.createdAt) + hours * 3600_000)
    return now() < end
  }

  function lockedFor(s = read()) {
    const until = Math.max(knownLock, s.lockedUntil ? Date.parse(s.lockedUntil) : 0)
    return Math.max(0, until - now())
  }
  const minutes = ms => Math.max(1, Math.ceil(ms / 60_000))
  const lockedAnswer = ms => ({ ok: false, status: 429, error: `Too many wrong PINs. Phone sign-in is locked for ${minutes(ms)} more minutes.`, lockedFor: ms })

  function login({ pin, pinHash, address, sessionHours }) {
    const s = read()
    const left = lockedFor(s)
    if (left > 0) return lockedAnswer(left)
    if (!validPinHash(pinHash)) return { ok: false, status: 503, error: 'Phone access has no PIN yet: set one at the PC with node tools/factory.mjs phone-pin.' }
    if (s.lockedUntil) s.lockedUntil = null // a lock that ran out: forget it
    if (typeof pin !== 'string' || !verify(pin, pinHash)) {
      s.fails += 1
      event(s, 'wrong', address)
      if (s.fails >= LOCK.tries) {
        knownLock = now() + LOCK.ms
        s.lockedUntil = iso(knownLock)
        s.fails = 0
        event(s, 'lockout', address)
        write(s)
        log(`phone: ${LOCK.tries} wrong PINs, the last from ${address || 'an unknown address'}: phone sign-in is locked for ${LOCK.ms / 60_000} minutes.`)
        return lockedAnswer(LOCK.ms)
      }
      write(s)
      const tries = LOCK.tries - s.fails
      return { ok: false, status: 401, error: `Wrong PIN. ${tries} ${tries === 1 ? 'try' : 'tries'} left before a 15 minute lock.` }
    }
    const token = randomBytes(32).toString('base64url')
    const at = now()
    s.fails = 0
    s.sessions = [...s.sessions.filter(x => live(x, sessionHours)), { id: sha(token), createdAt: iso(at), expiresAt: iso(at + sessionHours * 3600_000), address: String(address || '').slice(0, 64) }].slice(-SESSIONS_MAX)
    event(s, 'login', address)
    write(s)
    return { ok: true, token, csrf: csrfOf(token), expiresAt: iso(at + sessionHours * 3600_000) }
  }

  /** The session for a cookie token, or null: unknown, malformed or expired. */
  function session(token, sessionHours) {
    if (typeof token !== 'string' || !TOKEN.test(token)) return null
    const id = sha(token)
    const s = read()
    let found = null
    for (const x of s.sessions) if (same(x.id, id)) found = x // every entry is compared: the time says nothing about which
    if (!found || !live(found, sessionHours)) return null
    return { id, csrf: csrfOf(token), expiresAt: found.expiresAt, address: found.address }
  }

  function logout(token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) return false
    const id = sha(token)
    const s = read()
    const mine = s.sessions.find(x => same(x.id, id))
    if (!mine) return false
    s.sessions = s.sessions.filter(x => x !== mine)
    event(s, 'signout', mine.address)
    write(s)
    return true
  }

  function signOutEverywhere() {
    const s = read()
    const count = s.sessions.filter(x => now() < Date.parse(x.expiresAt)).length
    s.sessions = []
    event(s, 'signout-all', '', { count })
    write(s)
    return count
  }

  /** Newest first. */
  const events = () => read().events.slice().reverse()

  /** The lockouts as orchestration Log events (score-routes.mjs `extra`): no flow, no agent, one plain line. */
  const logEvents = () => read().events.filter(e => e.kind === 'lockout').map(e => ({
    at: e.at, kind: 'phone', flow: null, agent: null, cell: null,
    text: `Phone sign-in was locked for ${LOCK.ms / 60_000} minutes after ${LOCK.tries} wrong PINs${e.address ? ` (the last from ${e.address})` : ''}.`,
  }))

  return { read, login, session, logout, signOutEverywhere, lockedFor: () => lockedFor(), events, logEvents }
}
