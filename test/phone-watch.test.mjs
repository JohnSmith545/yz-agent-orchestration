// Tests for the visibility of phone access (review point 3): every change of remote.enabled, remote.bind or the PIN
// hash that the watcher sees is an event (phone-auth.mjs noteRemote), compared with the last values seen, kept in
// phone-auth.json; a PIN hash that phone-pin did not write (no matching pinMark) is called out as changed outside the
// setup command. Sign-ins, lockouts, escalations, PIN and config changes all reach the Log. phone-notice.js, the
// desktop half, turns the new ones into toasts and keeps a Phone on badge in the rail while phone access is on.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-watch-test-'))
const HERE = path.dirname(fileURLToPath(import.meta.url))
const A = await import('../phone-auth.mjs')
const { hashPin } = await import('../send-pin.mjs')

const dir = process.env.FACTORY_DATA_DIR
let n = 0
const store = () => A.makeAuthStore({ file: path.join(dir, `auth-${n++}.json`), log: () => {} })
const H1 = hashPin('12345678', { N: 1024 })
const H2 = hashPin('87654321', { N: 1024 })
const view = (wanted, bind, pinHash) => ({ wanted, bind, pinHash })

test('nothing set up: nothing is said and no file is written (no remote block changes nothing)', () => {
  const file = path.join(dir, `auth-${n++}.json`)
  const s = A.makeAuthStore({ file, log: () => {} })
  assert.deepEqual(s.noteRemote(view(false, '', '')), [])
  assert.equal(fs.existsSync(file), false)
})

test('a block that appears while nobody looked is said at once: from nothing, everything is a change', () => {
  const s = store()
  assert.deepEqual(s.noteRemote(view(true, '192.168.1.36', H1)).map(e => e.kind), ['config', 'config', 'pin'])
  assert.deepEqual(s.noteRemote(view(true, '192.168.1.36', H1)), [], 'and then nothing until the next change')
})

test('turned on, turned off and a new address are each one event, said in plain words', () => {
  const s = store()
  s.noteRemote(view(false, '', ''))
  assert.deepEqual(s.noteRemote(view(true, '192.168.1.36', '')).map(e => e.text), ['Phone access was turned on in config.json.', 'Phone access now listens on 192.168.1.36.'])
  assert.deepEqual(s.noteRemote(view(true, '192.168.1.36', '')), [], 'nothing new: nothing said')
  assert.deepEqual(s.noteRemote(view(true, '100.101.102.103', '')).map(e => e.text), ['Phone access now listens on 100.101.102.103 (it was 192.168.1.36).'])
  assert.deepEqual(s.noteRemote(view(false, '100.101.102.103', '')).map(e => e.text), ['Phone access was turned off in config.json.'])
  assert.ok(s.events().every(e => e.kind === 'config'))
})

test('a PIN changed by phone-pin says so; one changed any other way is called out', () => {
  const s = store()
  s.markPin(H1)
  s.noteRemote(view(true, '192.168.1.36', H1))
  s.markPin(H2) // what phone-pin does as it writes the hash
  const byCommand = s.noteRemote(view(true, '192.168.1.36', H2))
  assert.equal(byCommand.length, 1)
  assert.equal(byCommand[0].kind, 'pin')
  assert.equal(byCommand[0].text, 'The phone PIN was changed with phone-pin.')
  const outside = s.noteRemote(view(true, '192.168.1.36', H1))
  assert.equal(outside[0].kind, 'pin')
  assert.match(outside[0].text, /changed outside the setup command/)
  assert.match(outside[0].text, /turn phone access off/)
  assert.equal(outside[0].outside, true)
})

test('the hash itself is never kept or shown: only a fingerprint of it', () => {
  const s = store()
  s.noteRemote(view(true, '192.168.1.36', H1))
  s.markPin(H2)
  const file = fs.readFileSync(path.join(dir, `auth-${n - 1}.json`), 'utf8')
  assert.equal(file.includes(H1), false)
  assert.equal(file.includes(H2), false)
})

test('the Log gets sign-ins, lockouts, escalations, PIN and config changes, and a damaged file', () => {
  const s = store()
  s.login({ pin: '12345678', pinHash: H1, address: '100.64.1.2', sessionHours: 4 })
  for (let i = 0; i < 5; i++) s.login({ pin: '00000000', pinHash: H1, address: '192.168.1.9', sessionHours: 4 })
  s.noteRemote(view(false, '', ''))
  s.noteRemote(view(true, '192.168.1.36', H1))
  const texts = s.logEvents().map(e => e.text)
  assert.ok(texts.includes('A phone signed in from 100.64.1.2.'))
  assert.ok(texts.some(t => /locked for 15 minutes/.test(t)))
  assert.ok(texts.includes('Phone access was turned on in config.json.'))
  assert.ok(s.logEvents().every(e => e.kind === 'phone' && e.flow === null))
  assert.equal(texts.some(t => /Wrong PIN/.test(t)), false, 'single wrong tries stay on the Phone card, not in the Log')
})

// ═══ the desktop half: public/phone-notice.js ═══

const window = { Shell: { ago: () => '1m' } }
vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', 'phone-notice.js'), 'utf8'), { window })
const N = window.PhoneNotice

test('the notices are the events newer than the last seen, of the kinds that matter, oldest first', () => {
  const events = [
    { at: '2026-11-25T10:05:00.000Z', kind: 'pin', text: 'The phone PIN was changed outside the setup command.', outside: true },
    { at: '2026-11-25T10:04:00.000Z', kind: 'wrong', address: 'x' },
    { at: '2026-11-25T10:03:00.000Z', kind: 'login', address: '100.64.1.2' },
    { at: '2026-11-25T10:00:00.000Z', kind: 'config', text: 'Phone access was turned on in config.json.' },
  ]
  const fresh = N.fresh(events, '2026-11-25T10:01:00.000Z')
  assert.deepEqual(JSON.parse(JSON.stringify(fresh)).map(e => e.kind), ['login', 'pin'])
  assert.equal(N.textOf(fresh[0]), 'A phone signed in from 100.64.1.2.')
  assert.equal(N.urgent(fresh[1]), true)
  assert.equal(N.urgent(fresh[0]), false)
  assert.equal(N.fresh(events, '2026-11-25T10:06:00.000Z').length, 0)
})

// QA 2026-11-26: an urgent notice raised in one tab marked it seen for the whole browser, so other tabs never showed it.
// Urgent ones now stay in EVERY tab until dismissed in this browser; the seen marker only moves for the passing ones.
test('plan: an urgent notice shows in each tab until dismissed in this browser; a passing one shows once per browser', () => {
  const P = (...a) => JSON.parse(JSON.stringify(N.plan(...a))) // out of the vm realm, for deepEqual
  const now = Date.parse('2026-11-25T12:00:00.000Z')
  const events = [
    { at: '2026-11-25T10:03:00.000Z', kind: 'login', address: '100.64.1.2' },
    { at: '2026-11-25T10:05:00.000Z', kind: 'lockout', address: '100.64.1.9' },
  ]
  const tabA = P(events, { seenAt: '2026-11-25T10:00:00.000Z', dismissed: [], shownHere: [], now })
  assert.deepEqual(tabA.show.map(e => e.kind), ['login', 'lockout'])
  assert.equal(tabA.seenAt, '2026-11-25T10:03:00.000Z', 'the seen marker moves past the passing one only')
  // tab B opens after tab A raised both: the lockout still shows there, the sign-in does not again
  const tabB = P(events, { seenAt: tabA.seenAt, dismissed: [], shownHere: [], now })
  assert.deepEqual(tabB.show.map(e => e.kind), ['lockout'])
  // the next poll in tab A raises nothing twice
  assert.deepEqual(P(events, { seenAt: tabA.seenAt, dismissed: [], shownHere: tabA.show.map(N.keyOf), now }).show, [])
  // dismissed in this browser: no tab shows it again, and tab A takes it down
  const after = P(events, { seenAt: tabA.seenAt, dismissed: [N.keyOf(events[1])], shownHere: [N.keyOf(events[1])], now })
  assert.deepEqual(after.show, [])
  assert.deepEqual(after.close, [N.keyOf(events[1])])
  // an urgent notice older than a week is not raised again
  assert.deepEqual(P(events, { seenAt: '', dismissed: [], shownHere: [], now: now + 8 * 86_400_000 }).show.filter(e => e.kind === 'lockout'), [])
})

test('the rail badge: Phone on, a link to the Phone card, only while phone access is on', () => {
  assert.match(N.badgeHtml(true), /href="#\/settings"/)
  assert.match(N.badgeHtml(true), /Phone on/)
  assert.equal(N.badgeHtml(false), '')
})

test('index.html loads phone-notice.js', () => {
  assert.match(fs.readFileSync(path.join(HERE, '..', 'public', 'index.html'), 'utf8'), /<script src="phone-notice\.js"><\/script>/)
})

// ═══ the watcher itself (phone-wiring.mjs watchRemote) ═══

test('the watcher looks at once and on every tick, and skips a config.json that does not parse', async () => {
  const { watchRemote } = await import('../phone-wiring.mjs')
  const s = store()
  let block = { wanted: false, bind: '', pinHash: '' }
  const w = watchRemote({ reader: () => block, auth: s, every: 60_000 })
  block = { wanted: true, bind: '192.168.1.36', pinHash: '' }
  w.look()
  assert.deepEqual(s.events().map(e => e.text), ['Phone access now listens on 192.168.1.36.', 'Phone access was turned on in config.json.'])
  block = { unreadable: true, wanted: false, bind: '', pinHash: '' }
  w.look()
  assert.equal(s.events().length, 2, 'a file that does not parse says nothing about a change')
  w.stop()
})
