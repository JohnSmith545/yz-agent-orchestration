// Tests for public/phone-card.js, the Phone card on the Settings page: on or off and why, the address to open, when
// the PIN was set (never the PIN), how many phones are signed in, a lock, the recent sign-ins and lockouts, Sign out
// everywhere and Turn off, and the setup steps with the honest limits. In a vm with a recording fetch, like
// settings-page.test.mjs; plus its place in the Settings page and index.html.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, '..', 'public')
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8')
const window = { Shell: { ago: () => '5m' } }
vm.runInNewContext(read('phone-card.js'), { window, fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) })
const C = window.PhoneCard
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

const ON = {
  remote: { configured: true, enabled: true, off: null, bind: '100.101.102.103', port: 4318, url: 'http://100.101.102.103:4318/phone', hasPin: true, pinSetAt: '2026-11-25T08:00:00.000Z', sessionHours: 12 },
  signedIn: 1, lockedFor: 0,
  events: [{ at: '2026-11-25T09:00:00.000Z', kind: 'lockout', address: '192.168.1.77' }, { at: '2026-11-25T08:30:00.000Z', kind: 'login', address: '100.64.1.2' }, { at: '2026-11-25T08:20:00.000Z', kind: 'signout-all', address: '', count: 2 }],
}

test('on: the address to open, the PIN set date, phones signed in, and both buttons', () => {
  const h = C.html({ data: ON })
  assert.match(h, /^<section class="set-card" aria-label="Phone" data-phone-card>/)
  assert.match(text(h), /On\. Open http:\/\/100\.101\.102\.103:4318\/phone on your phone\./)
  assert.match(text(h), /PIN set 25 Nov/)
  assert.match(text(h), /1 phone signed in now/)
  assert.match(h, /data-phone-signout-all>Sign out everywhere</)
  assert.match(h, /data-phone-off>Turn phone access off</)
})

test('the recent sign-ins and lockouts, in plain words, newest first', () => {
  const t = text(C.html({ data: ON }))
  assert.match(t, /Locked for 15 minutes after 5 wrong PINs · 192\.168\.1\.77/)
  assert.match(t, /Signed in · 100\.64\.1\.2/)
  assert.match(t, /Signed out everywhere \(2\)/)
  assert.ok(t.indexOf('Locked for') < t.indexOf('Signed in ·'))
})

test('off: why it is off, no Turn off button; not set up: the steps say how', () => {
  const off = C.html({ data: { ...ON, remote: { ...ON.remote, enabled: false, url: '', off: 'Phone access is off (remote.enabled is not true).' } } })
  assert.match(text(off), /Off\. Phone access is off \(remote\.enabled is not true\)\./)
  assert.doesNotMatch(off, /data-phone-off/)
  const none = C.html({ data: { remote: { configured: false, enabled: false, hasPin: false }, signedIn: 0, lockedFor: 0, events: [] } })
  assert.match(text(none), /Off\. Not set up yet: follow the steps below\./)
  assert.match(text(none), /No phone PIN yet\./)
  assert.match(text(none), /No sign-ins yet\./)
})

test('a PIN from before the 8-digit rule: the card says to set a new one', () => {
  const h = C.html({ data: { ...ON, remote: { ...ON.remote, enabled: false, newPinNeeded: true, off: 'Set a new phone PIN of 8 digits or more.' } } })
  assert.match(text(h), /Set a new phone PIN of 8 digits or more: run node tools\/factory\.mjs phone-pin\./)
})

test('a lock in force says how long is left', () => {
  assert.match(text(C.html({ data: { ...ON, lockedFor: 9 * 60_000 } })), /Phone sign-in is locked for 9 more minutes after 5 wrong PINs\./)
})

test('the setup steps and the honest limits are on the card', () => {
  const t = text(C.html({ data: ON }))
  for (const s of [/Install Tailscale on this PC and on the phone, and sign in to the same account/, /node tools\/factory\.mjs phone-setup/, /node tools\/factory\.mjs phone-pin/,
    /Restart the dashboard/, /Add to Home Screen/, /plain HTTP/, /The PIN is the only lock/, /Never forward the port on your router/]) assert.match(t, s)
})

test('nothing secret and nothing unescaped: an address from the file is text', () => {
  const h = C.html({ data: { ...ON, events: [{ at: '2026-11-25T09:00:00.000Z', kind: 'login', address: '<img src=x>' }] } })
  assert.doesNotMatch(h, /<img/)
  assert.doesNotMatch(h, /pinHash|scrypt/)
})

test('loading and a failed load', () => {
  assert.match(text(C.html({ data: null })), /Loading…/)
  assert.match(text(C.html({ data: null, error: 'boom' })), /Could not load: boom/)
})

test('the Settings page draws the card in its own page and opens it; index.html loads it', () => {
  const page = read('settings-page.js')
  assert.match(page, /window\.PhoneCard \? window\.PhoneCard\.html\(\) : ''/)
  assert.match(page, /window\.PhoneCard\?\.open\(root\)/)
  const index = read('index.html')
  assert.match(index, /<script src="phone-card\.js"><\/script>/)
})
