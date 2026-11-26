// Tests for learn-runs.mjs: every Learn run kept in data/learn/<YYYY-MM-DD>.json with its pack summary, its proposals
// and what the user did with each; the last good run (the window and the reminder start there); and the rejected
// ideas, with their reasons, that go into the next pack. Temp folders only.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { appendRun, findRun, isRunId, lastRunAt, listRuns, newRunId, rejectedIdeas, setProposal } from '../learn-runs.mjs'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-runs-test-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))
let k = 0
const dir = () => path.join(TMP, `d${k++}`)
const P = (n, over = {}) => ({ n, target: 'Agent 1', action: 'add', rule: `Rule ${n}.`, old: '', flows: ['a'], evidence: 'e', effect: 'f', check: 'c', state: 'open', ...over })
const run = (at, over = {}) => ({ id: newRunId(new Date(at)), at, ok: true, cost: 0.5, window: { from: at, to: at, days: 7, widened: false }, read: 'Read: 1 finished flow', left: '', nothing: null, proposals: [P(1), P(2)], dropped: [], ...over })

test('a run is kept in the file of its local day, with an id that names that day', () => {
  const d = dir()
  const r = run(new Date(2026, 10, 25, 9).toISOString())
  assert.ok(isRunId(r.id))
  assert.ok(r.id.startsWith('2026-11-25-'))
  appendRun(r, d)
  assert.ok(fs.existsSync(path.join(d, '2026-11-25.json')))
  assert.deepEqual(findRun(r.id, d).run, r)
  assert.equal(findRun('2026-11-25-zzzzzz', d), null)
  assert.equal(findRun('../../etc', d), null) // an id that is not one is refused before any path is built
  assert.equal(isRunId('2026-11-25-abc123'), true)
  assert.equal(isRunId('2026-11-25'), false)
})

test('listRuns: every run of every day, newest first; verdicts.json is not a day', () => {
  const d = dir()
  appendRun(run(new Date(2026, 10, 18, 9).toISOString()), d)
  appendRun(run(new Date(2026, 10, 25, 9).toISOString()), d)
  appendRun(run(new Date(2026, 10, 25, 15).toISOString()), d)
  fs.writeFileSync(path.join(d, 'verdicts.json'), '{"changes":[]}')
  fs.writeFileSync(path.join(d, '2026-11-01.json'), 'torn{')
  const list = listRuns(d)
  assert.deepEqual(list.map(r => new Date(r.at).getDate()), [25, 25, 18])
  assert.ok(Date.parse(list[0].at) > Date.parse(list[1].at))
  assert.equal(listRuns(d, 1).length, 1)
  assert.deepEqual(listRuns(path.join(TMP, 'none')), [])
})

test('the last run is the newest GOOD one: a failed run does not reset the window or the reminder', () => {
  const d = dir()
  assert.equal(lastRunAt(d), null)
  appendRun(run(new Date(2026, 10, 18, 9).toISOString()), d)
  appendRun(run(new Date(2026, 10, 25, 9).toISOString(), { ok: false, error: 'The model run stopped.' }), d)
  assert.equal(lastRunAt(d), new Date(2026, 10, 18, 9).toISOString())
})

test('what the user did is kept on the proposal: accepted with the text saved, or rejected with a reason', () => {
  const d = dir()
  const r = run(new Date(2026, 10, 25, 9).toISOString())
  appendRun(r, d)
  setProposal(r.id, 1, { state: 'accepted', text: 'Rule 1, edited.', decidedAt: '2026-11-25T10:00:00.000Z' }, d)
  setProposal(r.id, 2, { state: 'rejected', reason: 'Too slow.', decidedAt: '2026-11-25T10:01:00.000Z' }, d)
  const [p1, p2] = findRun(r.id, d).run.proposals
  assert.equal(p1.state, 'accepted')
  assert.equal(p1.text, 'Rule 1, edited.')
  assert.equal(p2.reason, 'Too slow.')
  assert.equal(setProposal(r.id, 9, { state: 'rejected' }, d), null)
})

test('rejected ideas, newest first, the rule as it read (for a remove, the rule it named), with the reason', () => {
  const d = dir()
  const a = run(new Date(2026, 10, 18, 9).toISOString(), { proposals: [P(1, { state: 'rejected', reason: 'No.' }), P(2, { action: 'remove', rule: '', old: 'Old one.', state: 'rejected' })] })
  const b = run(new Date(2026, 10, 25, 9).toISOString(), { proposals: [P(1, { rule: 'Newer.', state: 'rejected', reason: '' }), P(2, { state: 'accepted' })] })
  appendRun(a, d)
  appendRun(b, d)
  assert.deepEqual(rejectedIdeas(d).map(r => [r.target, r.rule, r.reason]), [['Agent 1', 'Newer.', ''], ['Agent 1', 'Rule 1.', 'No.'], ['Agent 1', 'Old one.', '']])
})
