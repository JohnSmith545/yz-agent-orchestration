// Tests for how the phone page boots (public/phone.html, public/phone-app.js). QA (2026-11-26): in 40 quick reloads
// one page had an empty body 0.8 s after load, with no 429 and no error. The page drew nothing at all until its first
// answer (GET /phone/api/me) came back, and a script that had not run left phone-app.js to throw on a missing
// object. Now the page holds a quiet Loading line from the first paint, every script phone-app.js needs comes before
// it, and phone-app.js waits for the page's load event when one is missing (then starts, or says to reload).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = f => fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n')
const NEEDS = ['PhoneState', 'PhoneText', 'PhoneChat', 'PhoneView', 'PhoneAgents', 'PhoneComposer', 'PhoneChatLive']

test('the page shows a quiet Loading line from the first paint, before any script has run', () => {
  const html = read('phone.html')
  const app = html.slice(html.indexOf('<div id="app"'), html.indexOf('</div>', html.indexOf('<div id="app"')))
  assert.match(app, /<p class="ph-muted ph-boot" role="status">Loading…<\/p>/)
  assert.match(app, /<noscript>/)
})

test('every object phone-app.js needs is set by a script loaded before it, and phone-app.js is last', () => {
  const html = read('phone.html')
  const order = [...html.matchAll(/<script src="\/phone\/([^"]+)"><\/script>/g)].map(m => m[1])
  assert.equal(order.at(-1), 'phone-app.js')
  const setBy = {}
  for (const f of order) for (const m of read(f).matchAll(/window\.(Phone[A-Za-z]+) = /g)) setBy[m[1]] = f
  for (const name of NEEDS) {
    assert.ok(setBy[name], `${name} is set by one of the page scripts`)
    assert.ok(order.indexOf(setBy[name]) < order.indexOf('phone-app.js'), `${name} (${setBy[name]}) comes before phone-app.js`)
  }
  assert.doesNotMatch(html, /<script[^>]*\s(async|defer)[\s>]/, 'no async or defer: the scripts run in the order written')
  const app = read('phone-app.js')
  for (const name of NEEDS) assert.ok(app.includes(`'${name}'`), `phone-app.js checks for ${name}`)
})

/** phone-app.js alone in a vm: a page whose other scripts have not run. */
function bootWith(objects = {}) {
  const el = { innerHTML: '<p class="ph-muted ph-boot" role="status">Loading…</p>' }
  const listeners = []
  const fetched = []
  const window = {
    ...objects,
    document: { getElementById: id => (id === 'app' ? el : null) },
    addEventListener: (type, fn, opts) => listeners.push({ type, fn, opts }),
    fetch: async url => (fetched.push(url), { status: 401, json: async () => ({}) }),
  }
  vm.runInNewContext(read('phone-app.js'), { window, console })
  return { el, listeners, fetched, window }
}

test('a script that has not run yet: no throw, the Loading line stays, and it waits once for the page load event', () => {
  const b = bootWith({ PhoneState: {}, PhoneText: {} })
  assert.match(b.el.innerHTML, /Loading…/)
  const load = b.listeners.filter(l => l.type === 'load')
  assert.equal(load.length, 1)
  assert.equal(load[0].opts?.once, true)
  assert.deepEqual(b.fetched, [], 'nothing asked of the PC before the page can draw')
})

test('still missing after the page loaded: it says so in plain words, with no blank page and no loop', () => {
  const b = bootWith({})
  b.listeners.find(l => l.type === 'load').fn()
  assert.match(b.el.innerHTML, /did not load completely\. Reload it to try again\./)
  assert.equal(b.listeners.filter(l => l.type === 'load').length, 1, 'it does not wait again')
})
