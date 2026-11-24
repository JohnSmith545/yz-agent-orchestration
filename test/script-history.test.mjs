// Tests for public/script-history.js: the pure side of the SCRIPT History list. Each logged
// run (GET /api/script/log) becomes one row's words: when, the first line of the idea, what
// came back (Prompt, Questions, Stopped, or Did not finish), the cost when there is one, and
// the Sent with titles. The summary line counts the runs. A browser script in a vm, no DOM.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ctx = { window: {} }
for (const f of ['shell.js', 'script-text.js', 'script-history.js']) vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8'), ctx)
const H = ctx.window.ScriptHistory
const plain = v => JSON.parse(JSON.stringify(v))

const NOW = Date.parse('2026-11-24T12:00:00Z')
const PROMPT = '```\nSituation: a\nTone: b\n```'
const run = o => ({ id: 'r1', at: '2026-11-24T11:57:00Z', ms: 9000, text: 'Reminder texts for a clinic', output: PROMPT, ok: true, error: '', cancelled: false, cost: 0.034, context: { used: [], skipped: [] }, ...o })

test('the summary line counts the runs kept', () => {
  assert.equal(H.summary(12), 'History · 12 runs')
  assert.equal(H.summary(1), 'History · 1 run')
  assert.equal(H.summary(0), 'History · no runs')
})

test('a row: when (short, with the exact time), the idea, Prompt, the cost', () => {
  const r = plain(H.row(run(), { now: NOW }))
  assert.equal(r.id, 'r1')
  assert.equal(r.when, '3m')
  assert.ok(r.exact.length > 5, 'the exact time, for the title')
  assert.equal(r.idea, 'Reminder texts for a clinic')
  assert.equal(r.kind, 'prompt')
  assert.equal(r.label, 'Prompt')
  assert.equal(r.cost, '$0.03')
  assert.equal(r.sent, '')
})

test('what came back: Questions, Stopped, Did not finish', () => {
  assert.equal(H.row(run({ output: '1. Who?\n2. Why?' }), { now: NOW }).label, 'Questions')
  assert.equal(H.row(run({ cancelled: true, ok: false }), { now: NOW }).label, 'Stopped')
  assert.equal(H.row(run({ ok: false, error: 'Boom.', output: '```\nSituation: a\n' }), { now: NOW }).label, 'Did not finish')
  assert.equal(H.row(run({ output: '   ' }), { now: NOW }).label, 'Did not finish', 'an empty answer')
})

test('the idea is its first line with words, cut with an ellipsis when long', () => {
  assert.equal(H.row(run({ text: '\n\n  First line here  \nsecond' }), { now: NOW }).idea, 'First line here')
  const long = H.row(run({ text: 'x'.repeat(200) }), { now: NOW }).idea
  assert.ok(long.length <= 81 && long.endsWith('…'), long)
  assert.equal(H.row(run({ text: '' }), { now: NOW }).idea, '(no text)')
})

test('no cost shows nothing; Sent with lists the titles when context was used', () => {
  assert.equal(H.row(run({ cost: null }), { now: NOW }).cost, '')
  assert.equal(H.row(run({ cost: 0 }), { now: NOW }).cost, '')
  const r = H.row(run({ context: { used: [{ title: 'Brand voice', chars: 9 }, { title: 'Audience' }], skipped: [{ title: 'X', why: 'big' }] } }), { now: NOW })
  assert.equal(r.sent, 'Sent with: Brand voice, Audience')
  assert.equal(H.row(run({ context: null }), { now: NOW }).sent, '')
})

test('runs: only well-formed entries from the log answer, in the order given', () => {
  const list = H.runs({ runs: [run({ id: 'a' }), null, { id: 5 }, run({ id: 'b' })] })
  assert.deepEqual(plain(list.map(r => r.id)), ['a', 'b'])
  assert.deepEqual(plain(H.runs(null)), [])
  assert.deepEqual(plain(H.runs({ runs: 'x' })), [])
})

test('restoreEvent: a logged run as the state machine restore event', () => {
  const ev = plain(H.restoreEvent(run({ context: { used: [{ title: 'A' }], skipped: [] } })))
  assert.deepEqual(ev, { type: 'restore', text: 'Reminder texts for a clinic', output: PROMPT, ok: true, error: '', cancelled: false, context: { used: [{ title: 'A' }], skipped: [] } })
})
