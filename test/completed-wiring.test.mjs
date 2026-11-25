// Tests for where a new request starts and Home: the pile-up reminder sits above the Ask drawer's composer and in the
// Tickets page's Pass a task (the form on each ticket, and the bulk bar), filled by completed-view.js and repainted
// after each draw; the composer and the forms still work (a reminder, never a block); Home has its waiting line slot.
// The reminder itself (at 7, not at 6) is tested in completed-view.test.mjs; here, that each page carries it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = f => fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8')

test('the Ask drawer: the reminder slot sits between the transcript and the composer, painted when the drawer is drawn', () => {
  const src = read('factory-chat.js')
  assert.match(src, /<div class="fc-log" id="fcLog" aria-live="polite"><\/div>\s*<div class="fc-remind" data-cv-reminder hidden><\/div>\s*<form class="fc-form" id="fcForm">/)
  assert.match(src, /window\.CompletedView\?\.paint\(box\)/)
  assert.doesNotMatch(src, /piled[^\n]*disabled|data-cv-reminder[^\n]*disabled/, 'never a block on the composer')
})

test('the Tickets page: Pass a task carries the reminder on each ticket and in the bulk bar, painted after each draw', () => {
  const src = read('factory.js')
  assert.match(src, /<form class="fx-pass" data-pass="\$\{esc\(t\.id\)\}">\s*<div data-cv-reminder hidden><\/div>/)
  assert.match(src, /bar\.innerHTML = `<div class="fx-bulk-remind" data-cv-reminder hidden><\/div>/)
  assert.ok((src.match(/window\.CompletedView\?\.paint\(/g) || []).length >= 2)
})

test('Home: the waiting line slot under Human review', () => {
  const html = read('index.html')
  assert.ok(html.indexOf('<div id="homeOutputs" data-cv-line hidden></div>') > html.indexOf('<div id="homeHuman" hidden></div>'))
})

test('a slot is filled with the reminder at the limit and emptied below it (the paint rule, in a vm with a tiny DOM)', () => {
  const slot = { _cvHtml: undefined, innerHTML: '', hidden: true, hasAttribute: a => a === 'data-cv-reminder' }
  const doc = { querySelectorAll: () => [slot], addEventListener() {}, dispatchEvent() {} }
  const window = { document: doc, Shell: { onRoute() {} } }
  const ctx = vm.createContext({ window, setInterval: () => 0, CustomEvent: class {}, fetch: async () => ({ ok: true, json: async () => ({}) }) })
  vm.runInContext(read('completed-view.js'), ctx)
  const C = window.CompletedView
  const sum = n => ({ waiting: Array.from({ length: n }, (_, i) => ({ id: `f${i}` })), counts: { waiting: n, overdue: 0 }, max: 7, warnAfterDays: 2, piled: n >= 7 })
  C.setData(sum(7))
  C.paint(doc)
  assert.equal(slot.hidden, false)
  assert.match(slot.innerHTML, /7 outputs wait for your sign-off\. Mark them completed before a new request\./)
  C.setData(sum(6))
  C.paint(doc)
  assert.equal(slot.hidden, true)
  assert.equal(slot.innerHTML, '')
})
