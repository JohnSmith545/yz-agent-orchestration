// Tests for public/flow-head.js, the head of an opened flow: its title, one
// meta line and the why, and the ONE ? of the opened flow. A browser script, so
// it runs in a vm with a stub window.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const window = {
  FlowDrawer: { md: s => `<p>${s}</p>` },
  Shell: { ago: iso => (iso === '2026-11-13T10:00:00Z' ? '2m' : '3m') },
}
vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', 'flow-head.js'), 'utf8'), { window })
const H = window.FlowHead
const parts = { tickets: () => '', envPill: e => (e ? `<span>${e}</span>` : ''), statusPill: s => `<span>${s}</span>`, statuses: ['open', 'done'] }
const flow = updatedAt => ({ id: 'f', title: 'T', agent: 'Agent 3', env: 'dev', status: 'open', why: 'Short why.', updatedAt })

test('only the time changes: the sub (meta line and why) is the same markup, so it is never redrawn and an open more or menu stays open', () => {
  const a = H.html(flow('2026-11-13T10:00:00Z'), parts)
  const b = H.html(flow('2026-11-13T10:01:00Z'), parts)
  assert.equal(a.sub, b.sub)
  assert.match(a.sub, /<span class="fl-updated" data-updated><\/span>/, 'a slot the time is written into as text')
  assert.equal(a.updated, 'updated 2m')
  assert.equal(b.updated, 'updated 3m')
})

test('the head shows the full path from Request to Output as a step line, under the meta line (FlowRoute.line)', () => {
  window.FlowRoute = { line: f => `<nav class="rt-line" data-for="${f.id}"></nav>` }
  try {
    const { sub } = H.html(flow('2026-11-13T10:00:00Z'), parts)
    assert.match(sub, /<div class="fl-open-meta">[\s\S]*<\/div><nav class="rt-line" data-for="f"><\/nav>/)
  } finally {
    delete window.FlowRoute
  }
  assert.doesNotMatch(H.html(flow('2026-11-13T10:00:00Z'), parts).sub, /rt-line/, 'nothing when the route script is not there')
})

test('the opened flow has ONE ? whose popover says what each Output block is, in one short paragraph each', () => {
  for (const name of ['Story', 'Picture', 'How to test', 'Details']) assert.match(H.HELP, new RegExp(`<b>${name}</b>`), name)
  assert.match(H.HELP, /<dfn data-term="verified"/, 'the proof marks are still explained there')
})

test('many tickets: three chips, then a +N chip that opens the rest in place, remembered for the life of the page', () => {
  const tickets = Array.from({ length: 15 }, (_, i) => `ABC-${101 + i}`)
  const chips = f => (f.tickets || []).map(t => `<i class="tk">${t}</i>`).join('')
  const p = { ...parts, tickets: chips }
  const f = { ...flow('2026-11-13T10:00:00Z'), id: 'many', tickets }
  const shut = H.html(f, p).sub
  assert.equal((shut.match(/class="tk"/g) || []).length, 3, 'three shown')
  assert.match(shut, /<button type="button" class="fl-tk-more" data-tk-more="many" aria-expanded="false" title="Show all 15 tickets">\+12<\/button>/)
  H.expandTickets('many')
  const open = H.html(f, p).sub
  assert.equal((open.match(/class="tk"/g) || []).length, 15, 'all shown once opened')
  assert.doesNotMatch(open, /data-tk-more/)
  const few = H.html({ ...f, id: 'few', tickets: tickets.slice(0, 3) }, p).sub
  assert.doesNotMatch(few, /data-tk-more/, 'three or fewer: no +N chip')
})
