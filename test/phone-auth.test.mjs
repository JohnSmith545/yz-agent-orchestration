// Tests for phone-auth.mjs: the phone PIN, the five-try lock kept on disk, the sessions (a random token in an
// HttpOnly SameSite=Strict cookie, kept only as a hash), the per-session CSRF token, expiry and Sign out
// everywhere. Every store works on a temp file with an injected clock, so nothing here touches data/.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const A = await import('../phone-auth.mjs')
const { hashPin } = await import('../send-pin.mjs')

const PIN = '8302917465'
const HASH = hashPin(PIN, { N: 1024 })
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-auth-test-'))
let n = 0
function fresh({ start = Date.parse('2026-11-25T09:00:00Z') } = {}) {
  const file = path.join(dir, `auth-${n++}.json`)
  const clock = { t: start }
  const logged = []
  const make = () => A.makeAuthStore({ file, now: () => clock.t, log: l => logged.push(l) })
  return { file, clock, logged, store: make(), make }
}
const login = (store, pin = PIN, address = '192.168.1.50', sessionHours = 12) => store.login({ pin, pinHash: HASH, address, sessionHours })

test('the phone PIN is 6 to 12 digits, nothing else', () => {
  for (const p of ['123456', '000000', '123456789012']) assert.equal(A.phonePinProblem(p), null, p)
  assert.match(A.phonePinProblem('12345'), /at least 6 digits/)
  assert.match(A.phonePinProblem('1234567890123'), /at most 12 digits/)
  for (const p of ['12345a', 'abcdef', '12 3456', '123456\n', '１２３４５６']) assert.match(A.phonePinProblem(p), /only digits/, p)
  for (const p of [undefined, null, 123456, ['123456']]) assert.ok(A.phonePinProblem(p), String(p))
})

test('the right PIN signs in: a 256-bit token, kept on disk only as its hash, with the login listed', () => {
  const { store, file } = fresh()
  const r = login(store)
  assert.equal(r.ok, true)
  assert.match(r.token, /^[A-Za-z0-9_-]{43}$/) // 32 random bytes, base64url
  const disk = fs.readFileSync(file, 'utf8')
  assert.equal(disk.includes(r.token), false, 'the token itself is never stored')
  assert.equal(disk.includes(PIN), false, 'the PIN is never stored')
  const saved = JSON.parse(disk)
  assert.equal(saved.sessions.length, 1)
  assert.match(saved.sessions[0].id, /^[0-9a-f]{64}$/)
  assert.deepEqual(store.events().map(e => e.kind), ['login'])
  assert.equal(store.events()[0].address, '192.168.1.50')
})

test('two sign-ins get two different tokens', () => {
  const { store } = fresh()
  assert.notEqual(login(store).token, login(store).token)
})

test('a wrong PIN is refused with the tries left, and nothing is signed in', () => {
  const { store } = fresh()
  const r = login(store, '111111')
  assert.equal(r.ok, false)
  assert.equal(r.status, 401)
  assert.match(r.error, /Wrong PIN\. 4 tries left/)
  assert.equal(store.read().sessions.length, 0)
})

test('5 wrong tries lock sign-in for 15 minutes: even the right PIN is refused, and the lock is listed and logged once', () => {
  const { store, clock, logged } = fresh()
  for (let i = 0; i < 4; i++) assert.equal(login(store, '000000').status, 401)
  const fifth = login(store, '000000')
  assert.equal(fifth.status, 429)
  assert.match(fifth.error, /locked for 15 more minutes/)
  const during = login(store)
  assert.equal(during.ok, false)
  assert.equal(during.status, 429)
  assert.equal(store.read().sessions.length, 0)
  assert.equal(logged.length, 1)
  assert.match(logged[0], /5 wrong PINs/)
  assert.ok(store.events().some(e => e.kind === 'lockout'))
  clock.t += 14 * 60_000
  assert.equal(login(store).status, 429)
  clock.t += 61_000
  assert.equal(login(store).ok, true, 'open again after 15 minutes')
})

test('the lock and the count of wrong tries survive a restart (a new store on the same file)', () => {
  const { store, make, clock } = fresh()
  for (let i = 0; i < 3; i++) login(store, '000000')
  const second = make()
  assert.match(login(second, '000000').error, /1 try left/, 'the count went on from 3')
  assert.equal(login(second, '000000').status, 429)
  const third = make()
  assert.equal(login(third).status, 429, 'still locked after another restart')
  assert.ok(third.lockedFor() > 0)
  clock.t += 15 * 60_000 + 1
  assert.equal(third.lockedFor(), 0)
})

test('the right PIN clears the count of wrong tries', () => {
  const { store } = fresh()
  for (let i = 0; i < 4; i++) login(store, '000000')
  assert.equal(login(store).ok, true)
  assert.match(login(store, '000000').error, /4 tries left/)
})

test('a missing or broken PIN hash signs no one in, and does not count as a wrong try', () => {
  const { store } = fresh()
  for (const pinHash of ['', 'nonsense', null]) {
    const r = store.login({ pin: PIN, pinHash, address: '192.168.1.50', sessionHours: 12 })
    assert.equal(r.ok, false)
    assert.equal(r.status, 503)
  }
  assert.equal(store.read().fails, 0)
})

test('the PIN is checked with the scrypt hash and a constant-time compare (send-pin.mjs verifyPin)', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'phone-auth.mjs'), 'utf8')
  assert.match(src, /import \{[^}]*verifyPin[^}]*\} from '\.\/send-pin\.mjs'/)
  assert.match(src, /timingSafeEqual/, 'the session lookup and the CSRF check compare in constant time too')
  assert.match(fs.readFileSync(path.join(HERE, '..', 'send-pin.mjs'), 'utf8'), /return timingSafeEqual\(derive\(pin, h\), h\.key\)/)
})

test('a session is found by its token and carries its CSRF token; garbage finds nothing', () => {
  const { store } = fresh()
  const { token } = login(store)
  const s = store.session(token, 12)
  assert.ok(s)
  assert.equal(s.csrf, A.csrfOf(token))
  for (const t of ['', null, undefined, 'x', token.slice(0, -1), `${token}x`, token.replace(/^./, c => (c === 'A' ? 'B' : 'A')), 42]) assert.equal(store.session(t, 12), null, String(t))
})

test('a session expires after sessionHours, and a lower setting shortens sessions already open', () => {
  const { store, clock } = fresh()
  const { token } = login(store, PIN, '192.168.1.50', 12)
  clock.t += 11 * 3600_000
  assert.ok(store.session(token, 12))
  assert.equal(store.session(token, 10), null, 'the setting went down to 10 hours: that applies now')
  clock.t += 3600_000 + 1
  assert.equal(store.session(token, 12), null, 'expired after 12 hours')
  login(store)
  assert.equal(store.read().sessions.length, 1, 'the expired one is pruned at the next sign-in')
})

test('sign out ends one session; Sign out everywhere ends them all and is listed', () => {
  const { store } = fresh()
  const a = login(store).token
  const b = login(store).token
  const c = login(store).token
  store.logout(a)
  assert.equal(store.session(a, 12), null)
  assert.ok(store.session(b, 12))
  assert.equal(store.signOutEverywhere(), 2)
  assert.equal(store.session(b, 12), null)
  assert.equal(store.session(c, 12), null)
  assert.deepEqual(store.events().slice(0, 2).map(e => e.kind), ['signout-all', 'signout'])
})

test('the CSRF token is tied to the session token and checked in constant time', () => {
  const t1 = 'a'.repeat(43)
  const t2 = 'b'.repeat(43)
  assert.notEqual(A.csrfOf(t1), A.csrfOf(t2))
  assert.equal(A.csrfOf(t1), A.csrfOf(t1))
  assert.equal(A.csrfOk(t1, A.csrfOf(t1)), true)
  for (const h of [undefined, '', A.csrfOf(t2), `${A.csrfOf(t1)}x`, A.csrfOf(t1).slice(1), ['x']]) assert.equal(A.csrfOk(t1, h), false, String(h))
})

test('the cookie is HttpOnly, SameSite=Strict, scoped to /phone, and lasts the session; clearing it ends it at once', () => {
  const c = A.sessionCookie('tok', 12)
  assert.match(c, /^phone_session=tok; /)
  assert.match(c, /; HttpOnly/)
  assert.match(c, /; SameSite=Strict/)
  assert.match(c, /; Path=\/phone/)
  assert.match(c, /; Max-Age=43200/)
  assert.match(A.clearCookie(), /^phone_session=; .*Max-Age=0/)
  assert.match(A.clearCookie(), /HttpOnly/)
})

test('the token is read from a Cookie header among others, and only a well-formed one', () => {
  assert.equal(A.tokenFromCookie(`a=1; phone_session=${'z'.repeat(43)}; b=2`), 'z'.repeat(43))
  assert.equal(A.tokenFromCookie('a=1'), '')
  assert.equal(A.tokenFromCookie(undefined), '')
  assert.equal(A.tokenFromCookie('phone_session=<script>'), '')
})

test('a broken auth file signs everyone out and locks sign-in; a lock this process knows of holds', () => {
  const { store, file, clock } = fresh()
  const { token } = login(store)
  fs.writeFileSync(file, '{ not json')
  assert.equal(store.session(token, 12), null)
  assert.equal(login(store).status, 429, 'damage locks sign-in for the lock time')
  clock.t += 15 * 60_000 + 1
  assert.equal(login(store).ok, true, 'then a sign-in works and the file is good again')
})

test('the list of events is capped and newest first; the Log gets the lockouts only', () => {
  const { store, clock } = fresh()
  for (let i = 0; i < 70; i++) { login(store); clock.t += 1000 }
  const ev = store.events()
  assert.equal(ev.length, A.EVENTS_MAX)
  assert.ok(ev[0].at > ev.at(-1).at)
  for (let i = 0; i < 5; i++) login(store, '000000')
  const log = store.logEvents()
  assert.equal(log.length, 1)
  assert.equal(log[0].kind, 'phone')
  assert.equal(log[0].flow, null)
  assert.match(log[0].text, /Phone sign-in was locked for 15 minutes after 5 wrong PINs/)
})

// ═══ review round: the guess budget, a damaged file, a failed write ═══

const lockOnce = store => { for (let i = 0; i < 5; i++) login(store, '000000') }

test('3 lockouts within 24 hours escalate: the third says so, once, and it is listed', () => {
  const { store, clock, logged } = fresh()
  lockOnce(store)
  clock.t += 15 * 60_000 + 1
  lockOnce(store)
  clock.t += 15 * 60_000 + 1
  for (let i = 0; i < 4; i++) assert.equal(login(store, '000000').escalated, undefined)
  const third = login(store, '000000')
  assert.equal(third.status, 429)
  assert.equal(third.escalated, true)
  assert.ok(store.events().some(e => e.kind === 'escalate'))
  assert.ok(logged.some(l => /3 lockouts/.test(l)))
})

test('lockouts more than 24 hours apart do not escalate', () => {
  const { store, clock } = fresh()
  lockOnce(store)
  clock.t += 13 * 3600_000
  lockOnce(store)
  clock.t += 13 * 3600_000
  for (let i = 0; i < 4; i++) login(store, '000000')
  assert.equal(login(store, '000000').escalated, undefined)
})

test('a correct sign-in resets the wrong tries but NOT the lockout count', () => {
  const { store, clock } = fresh()
  lockOnce(store)
  clock.t += 15 * 60_000 + 1
  assert.equal(login(store).ok, true)
  lockOnce(store)
  clock.t += 15 * 60_000 + 1
  assert.equal(login(store).ok, true)
  assert.match(login(store, '000000').error, /4 tries left/, 'the wrong-try count did reset')
  for (let i = 0; i < 3; i++) login(store, '000000')
  assert.equal(login(store, '000000').escalated, true)
})

test('a damaged auth file is kept beside it, and sign-in is locked for the lock time, even after a restart', () => {
  const { store, file, clock, make } = fresh()
  const { token } = login(store)
  fs.writeFileSync(file, '{ damaged')
  const restarted = make()
  const r = login(restarted)
  assert.equal(r.status, 429)
  assert.equal(restarted.session(token, 12), null)
  const kept = fs.readdirSync(path.dirname(file)).filter(f => f.startsWith(`${path.basename(file)}.damaged-`))
  assert.equal(kept.length, 1)
  assert.equal(fs.readFileSync(path.join(path.dirname(file), kept[0]), 'utf8'), '{ damaged')
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).lockedUntil, 'a good file with the lock is written back')
  assert.ok(restarted.events().some(e => e.kind === 'damaged'))
  assert.equal(make().lockedFor() > 0, true, 'another restart: still locked')
  clock.t += 15 * 60_000 + 1
  assert.equal(login(make()).ok, true)
})

test('a missing auth file is a first start, not damage: no lock', () => {
  const { store } = fresh()
  assert.equal(store.lockedFor(), 0)
  assert.equal(login(store).ok, true)
})

test('a failed write never loses a wrong try: the count is kept in memory too, the larger one wins', () => {
  const file = path.join(dir, `auth-${n++}.json`)
  let failing = false
  const store = A.makeAuthStore({ file, now: () => Date.parse('2026-11-25T09:00:00Z'), log: () => {}, write: (f, t) => { if (failing) throw new Error('EPERM'); fs.writeFileSync(f, t) } })
  login(store, '000000')
  login(store, '000000')
  failing = true
  assert.equal(login(store, '000000').status, 401, 'a failed write still answers')
  assert.equal(login(store, '000000').status, 401)
  failing = false
  assert.equal(login(store, '000000').status, 429, 'the fifth try locks although the disk saw only two')
})

test('a sign-in whose session cannot be saved is refused, not half done', () => {
  const file = path.join(dir, `auth-${n++}.json`)
  const store = A.makeAuthStore({ file, log: () => {}, write: () => { throw new Error('EPERM') } })
  const r = login(store)
  assert.equal(r.ok, false)
  assert.equal(r.status, 503)
})

test('Sign out everywhere counts only the sessions still live', () => {
  const { store, clock } = fresh()
  login(store, PIN, 'a', 12)
  clock.t += 2 * 3600_000
  login(store, PIN, 'b', 12)
  assert.equal(store.signOutEverywhere(1), 1, 'with 1 hour sessions now, only the one made just now is live')
  assert.equal(store.events()[0].count, 1)
})
