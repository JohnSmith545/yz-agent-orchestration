// Regression tests for QA round two (2026-11-25) around Senior, the agent CLI side:
//   B-F2  hand-step and senior-ask on a done or dropped flow are refused: the work would wait on no one
//   B-F3  a flow Senior (or QA, or Security) stopped is moved on by the user only: the agent CLI may not set it done or
//         open, by flow set or flow write (the dashboard may: test/senior-origin.test.mjs)
// FACTORY_DATA_DIR points at a fresh temp folder BEFORE the imports.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-round2-test-'))
const F = await import('../flows.mjs')
const { runFlow } = await import('../tools/flow-cli.mjs')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-round2-files-'))

const SENIOR = {
  repo: 'C:/watched/repo', coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', sen: 'Senior' },
  pipeline: { qa: 'QA', producers: null, protectedBranches: ['dev'], maxReworks: 2, senior: 'Senior' },
}
const A1 = (...argv) => runFlow(argv, { by: 'Agent 1', cwd: TMP, config: SENIOR })
let n = 0
const fresh = (type = 'ask') => {
  const id = `r2-${++n}`
  assert.equal(A1('new', id, 'Rotate the keys', '--type', type).code, 0)
  return id
}
const store = fn => F.withPipeline(SENIOR, fn)

after(() => {
  fs.rmSync(F.DATA_DIR, { recursive: true, force: true })
  fs.rmSync(TMP, { recursive: true, force: true })
})

// ═══ B-F2 ═══

test('hand-step and senior-ask on a done or dropped flow are refused with one plain sentence, and change nothing', () => {
  for (const status of ['done', 'dropped']) {
    const id = fresh()
    assert.equal(A1('set', id, '--status', status).code, 0)
    const h = A1('hand-step', id, 'Rotate the key', '--expect', 'A new key')
    assert.equal(h.code, 1, status)
    assert.equal(h.out, `${id} is ${status}: start a new flow for this work, or ask the user to reopen this one.`)
    const s = A1('senior-ask', id, 'Check the rotated key')
    assert.equal(s.code, 1)
    assert.equal(s.out, `${id} is ${status}: start a new flow for this work, or ask the user to reopen this one.`)
    const f = F.readFlow(id)
    assert.equal(f.hand, undefined)
    assert.equal(f.senior, undefined)
    assert.equal(f.status, status)
  }
})

// ═══ B-F3 ═══

const stopped = {
  senior: f => ({ ...f, status: 'blocked', hand: { steps: [{ id: 'h1', do: 'x', expect: 'y', done: null }] }, senior: { status: 'senior-failed', by: 'Senior', at: '2026-11-25T10:00:00Z', summary: 'no' } }),
  qa: f => ({ ...f, status: 'blocked', qa: { status: 'qa-failed', attempt: 3, by: 'QA', at: '2026-11-25T10:00:00Z' } }),
  security: f => ({ ...f, status: 'blocked', qa: { status: 'passed', attempt: 1, by: 'QA', at: '2026-11-25T10:00:00Z', commit: 'abc1234', security: { status: 'security-failed', by: 'Security', at: '2026-11-25T11:00:00Z', commit: 'abc1234' } } }),
}
const WHO = { senior: 'Senior', qa: 'QA', security: 'Security' }

for (const [kind, make] of Object.entries(stopped)) {
  test(`a flow ${WHO[kind]} stopped: the agent CLI may not set it done or open, by flow set or flow write`, () => {
    const id = fresh('build')
    store(() => F.writeFlow(make(F.readFlow(id))))
    const said = `${id} was stopped by ${WHO[kind]}: only the user moves it on, on the dashboard.`
    for (const to of ['done', 'open']) {
      const r = A1('set', id, '--status', to)
      assert.equal(r.code, 1, `${kind} ${to}`)
      assert.equal(r.out, said)
      const file = path.join(TMP, `${id}-${to}.json`)
      fs.writeFileSync(file, JSON.stringify({ ...F.readFlow(id), status: to }))
      const w = A1('write', file)
      assert.equal(w.code, 1)
      assert.equal(w.out, said)
      assert.equal(F.readFlow(id).status, 'blocked')
    }
    assert.equal(A1('set', id, '--title', 'Renamed').code, 0, 'anything but the status is still the agent')
    assert.equal(A1('set', id, '--status', 'dropped').code, 0, 'dropping is not moving it on')
  })
}
