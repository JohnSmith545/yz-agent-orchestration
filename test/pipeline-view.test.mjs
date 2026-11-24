// Tests for the pure part of public/pipeline-view.js: the inside of one diagram box (its name, the red mark
// for pushes outside QA, at most four ticket chips and a +N) and the graph signature that decides when the
// diagram is rebuilt rather than patched. Browser files in a vm with a bare window.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { pipelineGraph } from '../pipeline.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ctx = vm.createContext({ window: {} })
for (const f of ['pipeline-tickets.js', 'pipeline-details.js', 'pipeline-view.js']) vm.runInContext(fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8'), ctx)
const V = ctx.window.PipelineView
const node = { id: 'qa', kind: 'agent', label: 'QA', role: 'qa' }
const tk = (i, status = 'testing') => ({ id: `t${i}`, title: `Ticket ${i}`, stage: { node: 'qa', status, path: [] }, updatedAt: `2026-11-1${i}T10:00:00Z` })
const count = (html, re) => (html.match(re) || []).length

test('a box shows its name and one chip per ticket, up to four, then +N', () => {
  const six = V.nodeInner(node, { list: [1, 2, 3, 4, 5, 6].map(i => tk(i)) })
  assert.match(six, /<span class="pl-name">QA<\/span>/)
  assert.equal(count(six, /class="pl-chip[ "]/g), 4)
  assert.match(six, />\+2</)
  const two = V.nodeInner(node, { list: [tk(1), tk(2)] })
  assert.equal(count(two, /class="pl-chip[ "]/g), 2)
  assert.doesNotMatch(two, /pl-more/)
})

test('an empty box has no chip list at all', () => {
  assert.doesNotMatch(V.nodeInner(node, {}), /pl-chips/)
})

test('a push outside QA puts the red mark on the box, said in words for a screen reader too', () => {
  const html = V.nodeInner(node, { pushes: 2 })
  assert.match(html, /class="pl-mark" title="Pushed 2 times outside QA today"/)
  assert.match(html, /aria-label="QA, no tickets, Pushed 2 times outside QA today\. Show details\."/)
  assert.doesNotMatch(V.nodeInner(node, { pushes: 0 }), /pl-mark/)
})

test('the box name is a button, so the keyboard reaches every node', () => {
  assert.match(V.nodeInner(node, { list: [tk(1)] }), /^<button type="button" class="pl-node-head" aria-label="QA, 1 ticket\. Show details\.">/)
})

test('the graph signature changes with the graph, not with a fresh copy of the same one', () => {
  const a = pipelineGraph({ coordinator: 'Master', pipeline: { producers: ['Agent 1'] } })
  const b = pipelineGraph({ coordinator: 'Master', pipeline: { producers: ['Agent 1'] } })
  const c = pipelineGraph({ coordinator: 'Master', pipeline: { producers: ['Agent 1', 'Agent 2'] } })
  assert.equal(V.signature(a), V.signature(b))
  assert.notEqual(V.signature(a), V.signature(c))
})
