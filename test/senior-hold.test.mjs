// Regression tests for the Senior gate on finishing a flow: while Senior holds a flow (Senior is configured, the flow
// has by-hand steps or a senior-ask, no QA record, and no Senior pass), NO path may mark it done: the agent CLI
// (`flow set --status done`, `flow write` with status done, new or not), the dashboard's status route and anything
// else, since the rule lives in the store (flows.mjs writeFlow, flow-senior.mjs seniorHolds). Each refusal is the same
// one plain sentence and a non-zero exit. Senior's own pass stays the way through, and a flow Senior does not hold is
// free to finish. FACTORY_DATA_DIR points at a fresh temp folder BEFORE the imports.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-hold-test-'))
const F = await import('../flows.mjs')
const { runFlow } = await import('../tools/flow-cli.mjs')
const { applyHandTick } = await import('../hand-steps.mjs')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-hold-files-'))
after(() => {
  fs.rmSync(F.DATA_DIR, { recursive: true, force: true })
  fs.rmSync(TMP, { recursive: true, force: true })
})

const CONFIG = {
  repo: 'C:/watched/repo', coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', sen: 'Senior' },
  pipeline: { qa: 'QA', producers: null, protectedBranches: ['dev'], maxReworks: 2, senior: 'Senior' },
}
const WITHOUT = { ...CONFIG, pipeline: { ...CONFIG.pipeline, senior: undefined } }
const as = (by, config = CONFIG) => (...argv) => runFlow(argv, { by, cwd: TMP, config })
const A1 = as('Agent 1')
const SEN = as('Senior')
const HELD = id => `Senior reviews the work done by hand before the flow is done: send Senior a message naming flow ${id}.`
let n = 0

/** A new ask flow with one by-hand step, ticked by the user when `ticked`. */
function handFlow(ticked = true) {
  const id = `held-${++n}`
  assert.equal(A1('new', id, 'Rotate the deploy key', '--type', 'ask').code, 0)
  assert.equal(A1('hand-step', id, 'Rotate the key', '--expect', 'A new key is listed').code, 0)
  if (ticked) {
    const flow = F.readFlow(id)
    applyHandTick(flow, 'h1', true)
    F.writeFlow(flow)
  }
  return id
}

test('flow set --status done is refused while Senior holds the flow, with the one sentence and a non-zero exit', () => {
  for (const ticked of [false, true]) {
    const id = handFlow(ticked)
    const r = A1('set', id, '--status', 'done')
    assert.equal(r.code, 1)
    assert.equal(r.out, HELD(id))
    assert.equal(F.readFlow(id).status, 'open', 'nothing was written')
  }
})

test('flow write with status done is refused while Senior holds it, for a stored flow and for a new one', () => {
  const id = handFlow()
  const file = path.join(TMP, `${id}.json`)
  fs.writeFileSync(file, JSON.stringify({ ...F.readFlow(id), status: 'done' }))
  const r = A1('write', file)
  assert.equal(r.code, 1)
  assert.equal(r.out, HELD(id))
  assert.equal(F.readFlow(id).status, 'open')
  const fresh = { id: 'held-new', title: 'Turn on branch protection', agent: 'Agent 1', status: 'done', tickets: [], nodes: [], route: { type: 'ask' }, hand: { steps: [{ id: 'h1', do: 'Turn it on', expect: 'The rule shows', done: { by: 'you', at: '2026-11-25T10:00:00Z' } }] } }
  const newFile = path.join(TMP, 'held-new.json')
  fs.writeFileSync(newFile, JSON.stringify(fresh))
  const w = A1('write', newFile)
  assert.equal(w.code, 1)
  assert.equal(w.out, HELD('held-new'))
  assert.equal(F.readFlow('held-new'), null)
})

test('a flow sent with senior-ask and no steps is held too, with its own sentence: it has no work done by hand (QA B-9)', () => {
  assert.equal(A1('new', 'asked', 'Turn on the CI cache in the console', '--type', 'ask').code, 0)
  assert.equal(A1('senior-ask', 'asked', 'I turned on the CI cache in the dev project settings.').code, 0)
  const r = A1('set', 'asked', '--status', 'done')
  assert.equal(r.code, 1)
  assert.equal(r.out, 'Senior reviews the change sent with senior-ask before the flow is done: send Senior a message naming flow asked.')
})

test('the store is the one place: any writer (the dashboard status route included) gets the same refusal', () => {
  const id = handFlow()
  const flow = { ...F.readFlow(id), status: 'done' }
  assert.throws(() => F.withPipeline(CONFIG, () => F.writeFlow(flow)), { message: HELD(id) })
  assert.equal(F.readFlow(id).status, 'open')
  // the route has no rule of its own: it writes through writeFlow like everything else
  assert.doesNotMatch(fs.readFileSync(new URL('../factory-routes.mjs', import.meta.url), 'utf8'), /seniorHolds/)
})

test('steps, say and result never finish a flow, so they cannot go round Senior', () => {
  const id = handFlow()
  assert.equal(A1('step', id, 'Rotate it', '--status', 'done').code, 0)
  assert.equal(A1('say', id, 'Rotated the deploy key').code, 0)
  assert.equal(F.readFlow(id).status, 'open')
})

test('Senior pass is the way through: the flow is done, and setting done again is fine', () => {
  const id = handFlow()
  const r = SEN('senior', id, 'pass', 'The key is rotated in dev only, and CI is green.')
  assert.equal(r.code, 0, r.out)
  assert.equal(F.readFlow(id).status, 'done')
  assert.equal(A1('set', id, '--status', 'done').code, 0)
})

test('a flow Senior does not hold is free to finish: no steps and no senior-ask, no Senior configured, or stopped by Senior', () => {
  assert.equal(A1('new', 'answer', 'Why is the build slow?', '--type', 'ask').code, 0)
  assert.equal(A1('set', 'answer', '--status', 'done').code, 0)
  assert.equal(F.readFlow('answer').status, 'done')
  const id = handFlow()
  assert.equal(as('Agent 1', WITHOUT)('set', id, '--status', 'done').code, 0, 'no Senior on the pipeline')
  const stopped = handFlow()
  F.withPipeline(CONFIG, () => F.writeFlow({ ...F.readFlow(stopped), status: 'blocked', senior: { status: 'senior-failed', by: 'Senior', at: '2026-11-25T10:00:00Z', summary: 'x' } }))
  assert.equal(A1('set', stopped, '--status', 'done').code, 0, 'stopped by Senior: the user decides')
})

test('a flow that is done already may be written again (an old flow finished before Senior existed)', () => {
  const id = handFlow()
  F.withPipeline(WITHOUT, () => F.writeFlow({ ...F.readFlow(id), status: 'done' }))
  assert.equal(A1('set', id, '--title', 'Rotate the deploy key, renamed').code, 0, 'only the move to done is checked')
})
