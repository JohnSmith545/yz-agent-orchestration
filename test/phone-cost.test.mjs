// Tests for phone-cost.mjs, the one quiet line under the phone's message box: what a message costs, from the
// median of the recent `phone` spend lines (spend.mjs) once there are at least 3, else a fixed sentence.
// FACTORY_DATA_DIR points at a temp folder BEFORE the imports, so the spend file is never data/spend.jsonl.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-cost-test-'))
const C = await import('../phone-cost.mjs')
const { SPEND_FILE, recentCosts } = await import('../spend.mjs')

test('fewer than 3 phone turns: the fixed sentence', () => {
  assert.equal(C.costLine([]), C.COST_FIXED)
  assert.equal(C.costLine([0.14, 0.2]), C.COST_FIXED)
  assert.equal(C.COST_FIXED, 'Each message costs a few cents.')
})

test('3 or more: about the median, in cents, or in dollars from one dollar', () => {
  assert.equal(C.costLine([0.12, 0.14, 0.9]), 'Each message costs about 14 cents.')
  assert.equal(C.costLine([0.1, 0.12, 0.16, 0.2]), 'Each message costs about 14 cents.', 'the middle two, averaged')
  assert.equal(C.costLine([0.011, 0.01, 0.009]), 'Each message costs about 1 cent.')
  assert.equal(C.costLine([0.001, 0.002, 0.003]), 'Each message costs less than a cent.')
  assert.equal(C.costLine([1.2, 1.25, 1.3]), 'Each message costs about $1.25.')
})

test('only well-formed numbers count', () => {
  assert.equal(C.costLine([0.14, 'x', null, NaN, -1, 0.14, 0.14]), 'Each message costs about 14 cents.')
  assert.equal(C.costLine(null), C.COST_FIXED)
})

test('recentCosts reads the newest lines of one kind from the spend file; phoneCost uses the phone kind', () => {
  const lines = [['phone', 0.1], ['relay', 5], ['phone', 0.2], ['chat', 3], ['phone', 0.3]].map(([kind, usd], i) => JSON.stringify({ at: `2026-11-2${i}T10:00:00.000Z`, kind, usd }))
  fs.writeFileSync(SPEND_FILE, `${lines.join('\n')}\nnot json\n`)
  assert.deepEqual(recentCosts('phone'), [0.1, 0.2, 0.3])
  assert.deepEqual(recentCosts('phone', 2), [0.2, 0.3])
  assert.equal(C.phoneCost(), 'Each message costs about 20 cents.')
  fs.rmSync(SPEND_FILE)
  assert.deepEqual(recentCosts('phone'), [])
  assert.equal(C.phoneCost(), C.COST_FIXED)
})
