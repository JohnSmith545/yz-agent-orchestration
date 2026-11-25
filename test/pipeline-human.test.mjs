// Tests for the Human task box of the Agents diagram (public/pipeline-human.js, drawn by pipeline-view.js): what
// waits on you, in the Human review head's own split; up to three flows standing there, then +N; one more chip row
// for its count line; its name a button that says where it goes; and the wiring: a click (or Enter) on it shows the
// Human review list (agents-page.js), the box is redrawn when the list's counts change, and every file is loaded and
// checked. Browser files in a vm with a bare window.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = f => fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8')
const ctx = vm.createContext({ window: {} })
for (const f of ['pipeline-tickets.js', 'pipeline-details.js', 'pipeline-human.js', 'pipeline-view.js']) vm.runInContext(read(f), ctx)
const { PipelineHuman: H, PipelineView: V } = ctx.window
const HUMAN = { id: 'human', kind: 'step', label: 'Human task', role: 'human' }
const tk = i => ({ id: `t${i}`, title: `Flow <${i}>`, stage: { node: 'human', status: 'waiting', path: [] }, updatedAt: `2026-11-1${i}T10:00:00Z` })
const count = (html, re) => (html.match(re) || []).length

test('countText: questions then by-hand work, as the Human review head splits them; nothing else, and empty when none', () => {
  assert.equal(H.countText({ ask: 8, hand: 2, blocked: 3, ticket: 60 }), '8 questions · 2 by hand')
  assert.equal(H.countText({ ask: 1, hand: 0 }), '1 question')
  assert.equal(H.countText({ hand: 1 }), '1 by hand')
  assert.equal(H.countText({ ask: 0, hand: 0, ticket: 9 }), '')
  assert.equal(H.countText(null), '')
})

test('inner: the name, the count line, up to three flows standing here and +N for the rest', () => {
  const five = H.inner(HUMAN, { list: [1, 2, 3, 4, 5].map(tk), counts: { ask: 8, hand: 2 } })
  assert.match(five, /<span class="pl-name">Human task<\/span>/)
  assert.match(five, /<p class="pl-human-count"><i class="hr-dot" aria-hidden="true"><\/i>8 questions<\/p><p class="pl-human-count"><i class="hr-dot" aria-hidden="true"><\/i>2 by hand<\/p>/)
  assert.equal(count(five, /class="pl-chip[ "]/g), 3)
  assert.match(five, />\+2</)
  assert.match(five, /Flow &lt;1&gt;/, 'titles are escaped')
  const none = H.inner(HUMAN, { counts: { ask: 0, hand: 0 } })
  assert.match(none, /class="pl-human-count is-calm"><i class="hr-dot is-calm" aria-hidden="true"><\/i>Nothing waits on you</)
  assert.doesNotMatch(none, /pl-chips|pl-more/)
  assert.match(H.inner(HUMAN, { counts: null }), />Loading…</, 'the live page before the first read of the list')
  // a saved orchestration (the bank page, QA B-5) has no counts at all: no count line and never Loading
  const saved = H.inner(HUMAN, {})
  assert.doesNotMatch(saved, /Loading|pl-human-count/)
  assert.match(saved, /aria-label="Human task\.">/)
  assert.doesNotMatch(V.nodeInner(HUMAN, {}), /Loading/)
  assert.match(fs.readFileSync(path.join(HERE, '..', 'public', 'pipeline-view.js'), 'utf8'), /const counts = humanReview \? window\.HumanReview\?\.data\?\.counts \|\| null : undefined/)
})

test('inner: its name is a button that says what waits and where a click goes; no settings, no pill, no push mark', () => {
  const html = H.inner(HUMAN, { list: [tk(1)], counts: { ask: 1, hand: 0 } })
  assert.match(html, /^<button type="button" class="pl-node-head" aria-label="Human task: 1 question, 1 flow waiting here\. Show Human review\.">/)
  assert.doesNotMatch(html, /pl-mark|ac-pill|data-ar-act/)
})

test('rows: a line per kind waiting (one when none), plus at most three chips', () => {
  assert.deepEqual([H.rows(undefined, null), H.rows([], null), H.rows([1, 2].map(tk), null), H.rows([1, 2, 3, 4, 5].map(tk), null)], [1, 1, 3, 4])
  assert.deepEqual([H.rows([]), H.rows([1, 2].map(tk))], [0, 2], 'no counts (a saved orchestration): chips only')
  assert.deepEqual([H.rows([], { ask: 8, hand: 2 }), H.rows([1, 2, 3, 4].map(tk), { hand: 1 })], [2, 4])
  assert.deepEqual([...H.countParts({ ask: 8, hand: 2 })], ['8 questions', '2 by hand'])
})

test('pipeline-view draws the Human task box with this file, and every other box as before', () => {
  assert.equal(V.nodeInner(HUMAN, { list: [tk(1)], counts: { ask: 2 } }), H.inner(HUMAN, { list: [tk(1)], counts: { ask: 2 } }))
  assert.match(V.nodeInner({ id: 'qa', kind: 'agent', label: 'QA', role: 'qa' }, {}), /QA, no tickets\. Show details\./)
})

test('wired: a click on the box shows the list; the box is redrawn when the list changes; loaded before the view, and checked', () => {
  const page = read('agents-page.js')
  assert.match(page, /role === 'human'\) return window\.HumanReview\?\.show\(\)/)
  assert.match(read('human-review.js'), /doc\.dispatchEvent\(new CustomEvent\('humanreview:change'\)\)/)
  assert.match(read('pipeline-view.js'), /addEventListener\('humanreview:change'/)
  const html = read('index.html')
  assert.ok(html.indexOf('<script src="pipeline-human.js"></script>') < html.indexOf('<script src="pipeline-view.js"></script>'))
  assert.ok(html.indexOf('<script src="pipeline-labels.js"></script>') < html.indexOf('<script src="pipeline-layout.js"></script>'))
  const check = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).scripts.check
  for (const f of ['public/pipeline-human.js', 'public/pipeline-labels.js', 'pipeline-hand.mjs']) assert.ok(check.includes(`node --check ${f}`), f)
  assert.match(read('pipeline.css'), /\.pl-node\.r-human \{ border-left: 3px solid var\(--warn\); \}/)
})
