// Tests for App.collapseDispatches in public/app.js (spec 5, Home Messages):
// consecutive subagent dispatches from one parent fold into one row with a
// count; every other row passes through untouched. app.js skips its DOM code
// when there is no document, so it runs here in a vm with a bare window.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const window = {}
vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', 'app.js'), 'utf8'), { window })
const { collapseDispatches } = window.App
const plain = v => JSON.parse(JSON.stringify(v))

const prompt = { t: '2026-11-12T10:05:00Z', from: 'You', to: 'Coordinator', text: 'go', via: 'prompt' }
const sub = (n, from = 'Coordinator') => ({ t: `2026-11-12T10:0${n}:00Z`, from, to: `subagent: task ${n}`, text: `brief ${n}`, via: 'subagent' })
const message = { t: '2026-11-12T10:00:00Z', from: 'Agent 1', to: 'Coordinator', text: 'done', via: 'message' }

test('[prompt, subagent, subagent, message] is 3 rows with the two dispatches folded in the middle', () => {
  const rows = plain(collapseDispatches([prompt, sub(4), sub(3), message]))
  assert.equal(rows.length, 3)
  assert.deepEqual(rows[0], prompt)
  assert.equal(rows[1].kind, 'dispatches')
  assert.equal(rows[1].count, 2)
  assert.equal(rows[1].from, 'Coordinator')
  assert.deepEqual(rows[1].rows, [sub(4), sub(3)])
  assert.equal(rows[1].t, sub(4).t)
  assert.deepEqual(rows[2], message)
})

test('one lone dispatch stays a plain row', () => {
  assert.deepEqual(plain(collapseDispatches([prompt, sub(4), message])), [prompt, sub(4), message])
})

test('dispatches from two different parents are two groups, not one', () => {
  const rows = plain(collapseDispatches([sub(5, 'Coordinator'), sub(4, 'Coordinator'), sub(3, 'Agent 2'), sub(2, 'Agent 2')]))
  assert.deepEqual(rows.map(r => [r.kind, r.from, r.count]), [['dispatches', 'Coordinator', 2], ['dispatches', 'Agent 2', 2]])
})

test('dispatches split by another row are not merged across it', () => {
  const rows = plain(collapseDispatches([sub(5), sub(4), message, sub(3), sub(2)]))
  assert.deepEqual(rows.map(r => r.kind || r.via), ['dispatches', 'message', 'dispatches'])
})

test('an empty or missing list is empty', () => {
  assert.deepEqual(plain(collapseDispatches([])), [])
  assert.deepEqual(plain(collapseDispatches(undefined)), [])
})

test('other rows are the same objects, untouched', () => {
  const rows = collapseDispatches([prompt, message])
  assert.equal(rows[0], prompt)
  assert.equal(rows[1], message)
})
