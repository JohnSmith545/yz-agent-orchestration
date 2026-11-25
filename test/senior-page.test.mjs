// Tests for the flow page around Senior (QA B-7 and the user's way to lift Senior's hold, B-1): a refused status
// change says why INLINE in the flow menu (no native alert) and the menu goes back to the real status; the by-hand
// checklist of a flow Senior holds offers Finish without Senior, asked once more inline before it posts the release;
// a refused tick or finish says why inline too. Browser files in a vm; the wiring is checked in the source.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const read = f => fs.readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8')
const window = { Shell: { ago: () => '3m' }, UI: { esc: s => String(s) } }
vm.runInNewContext(read('flow-head.js'), { window })
vm.runInNewContext(read('flow-hand.js'), { window, CSS: { escape: s => s } })
const { FlowHead, FlowHand } = window
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

const opts = extra => ({ tickets: () => '', envPill: () => '', statusPill: s => s, statuses: ['open', 'done', 'blocked', 'dropped'], ...extra })
const base = { id: 'keys', title: 'Rotate the keys', agent: 'Agent 1', status: 'open', tickets: [], nodes: [] }
const step = done => ({ id: 'h1', do: 'Rotate the key', expect: 'A new key', done: done ? { by: 'you', at: 'x' } : null })

test('a refused status change is said inline in the open flow menu, with the menu on the real status', () => {
  const h = FlowHead.html(base, opts({ refused: 'Senior reviews the work done by hand before the flow is done: send Senior a message naming flow keys.' })).sub
  assert.match(h, /<details class="fl-more" open>/)
  assert.match(h, /<p class="small fl-refused" role="alert">Senior reviews the work done by hand before the flow is done: send Senior a message naming flow keys\.<\/p>/)
  assert.match(h, /<option selected>open<\/option>/)
  assert.doesNotMatch(FlowHead.html(base, opts()).sub, /fl-refused/)
  const flows = read('flows.js')
  assert.match(flows, /if \(res\.error\) \{\r?\n\s+el\.value = f\.status/, 'the select goes back to the real status')
  assert.match(flows, /opened\.refused = res\.code === 'senior-hold' \? window\.FlowHand\.holdText\(f\) : res\.error/)
  assert.match(flows, /refused: opened\.refused/)
})

test('a flow Senior holds offers Finish without Senior, asked once more inline before the release is posted', () => {
  const held = { ...base, hand: { steps: [step(false)] }, senior: { status: 'due', at: '2026-11-25T10:00:00Z' } }
  const h = FlowHand.html(held)
  assert.match(h, /<button type="button" class="link fh-release" data-hand-release>Finish without Senior<\/button>/)
  const ask = FlowHand.html(held, { releasing: true })
  assert.match(text(ask), /Finish it with no Senior review\? It counts as slipped through on the scorecard\. Finish Cancel/)
  assert.match(ask, /data-hand-release-yes/)
  assert.match(ask, /data-hand-release-no/)
  for (const f of [{ ...held, senior: undefined }, { ...held, senior: { status: 'passed', by: 'Senior', at: 'x' } }, { ...held, status: 'done' }]) {
    assert.doesNotMatch(FlowHand.html(f), /data-hand-release/, JSON.stringify(f.senior))
  }
  assert.doesNotMatch(FlowHand.html(held, { readonly: true }), /data-hand-release/)
  // a flow written before the hold was recorded: its route plans Senior and it has steps, so Senior holds it too
  const older = { ...base, hand: { steps: [step(false)] }, progress: [{ node: 'human', role: 'human', state: 'current' }, { node: 'senior', role: 'senior', state: 'upcoming' }] }
  assert.match(FlowHand.html(older), /data-hand-release/)
  assert.doesNotMatch(FlowHand.html({ ...older, qa: { status: 'testing' } }), /data-hand-release/, 'code is QA work')
})

test('wired: the release posts to senior-release; a refused tick or finish is said inline, never with a native alert', () => {
  const hand = read('flow-hand.js')
  assert.match(hand, /\/api\/flows\/\$\{enc\(f\.id\)\}\/senior-release/)
  assert.doesNotMatch(hand, /window\.alert|\balert\(/)
  assert.match(hand, /class="fh-refused" role="alert"/)
  assert.match(read('human.css'), /\.fh-refused \{/)
  assert.match(read('flows.css'), /\.fl-refused \{/)
})
