// Regression tests for QA B-1 (2026-11-25): an agent could lift Senior's hold by clearing or dropping the by-hand
// steps and then finish the flow with no review, and the scorecard counted it delivered. Now the hold is RECORDED on
// the flow (flow.senior status due) the moment a flow has by-hand steps while Senior is configured, every write keeps
// the stored record, and only Senior's pass or the user's release on the dashboard lifts it. Each refusal is one plain
// sentence and a non-zero exit; each case has its scorecard cell. FACTORY_DATA_DIR points at a fresh temp folder
// BEFORE the imports.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-hold-durable-test-'))
const F = await import('../flows.mjs')
const { runFlow } = await import('../tools/flow-cli.mjs')
const { applyHandTick } = await import('../hand-steps.mjs')
const { pipelineGraph, stageOf } = await import('../pipeline.mjs')
const { cellOf } = await import('../score.mjs')
const { seniorReleaseRoute } = await import('../human-routes.mjs')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-hold-durable-files-'))
after(() => {
  fs.rmSync(F.DATA_DIR, { recursive: true, force: true })
  fs.rmSync(TMP, { recursive: true, force: true })
})

const CONFIG = {
  repo: 'C:/watched/repo', coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', sen: 'Senior' },
  pipeline: { qa: 'QA', producers: null, protectedBranches: ['dev'], maxReworks: 2, senior: 'Senior' },
}
const G = pipelineGraph(CONFIG)
const DAY = 86_400_000
const as = by => (...argv) => runFlow(argv, { by, cwd: TMP, config: CONFIG })
const A1 = as('Agent 1')
const HELD = id => `Senior reviews the work done by hand before the flow is done: send Senior a message naming flow ${id}.`
const store = fn => F.withPipeline(CONFIG, fn)
const cell = f => cellOf(f, G, Date.now(), 7 * DAY).cell
let n = 0

function handFlow({ ticked = false, type = 'build' } = {}) {
  const id = `due-${++n}`
  assert.equal(A1('new', id, 'Set up the deploy secrets', '--type', type).code, 0)
  assert.equal(A1('hand-step', id, 'Add the deploy token', '--expect', 'It is listed').code, 0)
  if (ticked) {
    const flow = F.readFlow(id)
    applyHandTick(flow, 'h1', true)
    store(() => F.writeFlow(flow))
  }
  return id
}
const writeFile = (name, flow) => {
  const file = path.join(TMP, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(flow))
  return file
}

test('the first by-hand step records the hold on the flow (senior status due); without Senior nothing is recorded', () => {
  const id = handFlow()
  assert.deepEqual(Object.keys(F.readFlow(id).senior).sort(), ['at', 'status'])
  assert.equal(F.readFlow(id).senior.status, 'due')
  const plain = { ...CONFIG, pipeline: { ...CONFIG.pipeline, senior: undefined } }
  assert.equal(runFlow(['new', 'no-senior', 'X', '--type', 'ask'], { by: 'Agent 1', cwd: TMP, config: plain }).code, 0)
  assert.equal(runFlow(['hand-step', 'no-senior', 'Do it', '--expect', 'Done'], { by: 'Agent 1', cwd: TMP, config: plain }).code, 0)
  assert.equal(F.readFlow('no-senior').senior, undefined)
})

test('hand-clear before any tick keeps the hold: done is still refused, and the scorecard would count it slipped', () => {
  const id = handFlow()
  const r = A1('hand-clear', id)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /Senior still holds this flow/)
  assert.equal(F.readFlow(id).senior.status, 'due')
  const done = A1('set', id, '--status', 'done')
  assert.equal(done.code, 1)
  assert.equal(done.out, HELD(id))
  assert.equal(cell({ ...F.readFlow(id), status: 'done' }), 'slipped')
  assert.equal(stageOf(F.readFlow(id), G).node, 'human', 'held with no steps: it waits at Human task')
})

test('hand-clear after the user ticked a step is refused', () => {
  const id = handFlow({ ticked: true })
  const r = A1('hand-clear', id)
  assert.equal(r.code, 1)
  assert.match(r.out, /the user already ticked/)
  assert.equal(F.readFlow(id).hand.steps.length, 1)
})

test('flow write with the steps emptied, or with no hand key at all, keeps the hold and is refused done', () => {
  for (const hand of [{ steps: [] }, undefined]) {
    const id = handFlow({ ticked: true })
    const flow = { ...F.readFlow(id), status: 'done', hand }
    if (hand === undefined) delete flow.hand
    delete flow.senior
    const r = A1('write', writeFile(id, flow))
    assert.equal(r.code, 1, JSON.stringify(hand))
    assert.equal(r.out, HELD(id))
    assert.equal(F.readFlow(id).status, 'open')
    assert.equal(F.readFlow(id).senior.status, 'due')
    assert.equal(cell({ ...F.readFlow(id), status: 'done', hand }), 'slipped')
  }
})

test('a rewrite that keeps the flow open but drops the steps and the record keeps the record', () => {
  const id = handFlow()
  const flow = { ...F.readFlow(id), hand: { steps: [] } }
  delete flow.senior
  assert.equal(A1('write', writeFile(`${id}-open`, flow)).code, 0)
  assert.equal(F.readFlow(id).senior.status, 'due')
  assert.equal(A1('set', id, '--status', 'done').code, 1)
})

test('a brand-new flow written straight to done with steps is refused and not written; its cell would be slipped', () => {
  const fresh = { id: 'straight-done', title: 'Turn on branch protection', agent: 'Agent 1', status: 'done', tickets: [], nodes: [], route: { type: 'ask' }, hand: { steps: [{ id: 'h1', do: 'Turn it on', expect: 'The rule shows', done: null }] } }
  const r = A1('write', writeFile('straight-done', fresh))
  assert.equal(r.code, 1)
  assert.equal(r.out, HELD('straight-done'))
  assert.equal(F.readFlow('straight-done'), null)
  assert.equal(cell({ ...fresh, senior: { status: 'due', at: new Date().toISOString() }, updatedAt: new Date().toISOString() }), 'slipped')
})

test('Senior pass lifts the hold: done, and delivered', () => {
  const id = handFlow({ ticked: true })
  assert.equal(as('Senior')('senior', id, 'pass', 'Checked the token is in dev only.').code, 0)
  assert.equal(F.readFlow(id).status, 'done')
  assert.equal(cell(F.readFlow(id)), 'delivered')
})

test('the user releases a held flow on the dashboard only: it is done, counted as slipped through (nobody reviewed it)', () => {
  const id = handFlow()
  assert.equal(A1('hand-clear', id).code, 0)
  const r = store(() => seniorReleaseRoute(id, {}))
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const f = F.readFlow(id)
  assert.equal(f.status, 'done')
  assert.equal(f.senior.status, 'released')
  assert.equal(f.senior.by, 'you')
  assert.equal(cell(f), 'slipped')
  assert.equal(stageOf(f, G).node, 'outcome')
  assert.equal(store(() => seniorReleaseRoute('no-such-flow', {})).status, 404)
  // the agent CLI cannot write the release: a rewrite keeps the stored record
  const other = handFlow()
  const forged = { ...F.readFlow(other), status: 'done', senior: { status: 'released', by: 'you', at: new Date().toISOString() } }
  assert.equal(A1('write', writeFile(`${other}-forged`, forged)).code, 1)
  assert.equal(F.readFlow(other).senior.status, 'due')
})

test('a release of a flow Senior does not hold is refused', () => {
  assert.equal(A1('new', 'free', 'Why is the build slow?', '--type', 'ask').code, 0)
  const r = store(() => seniorReleaseRoute('free', {}))
  assert.equal(r.status, 400)
  assert.match(r.body.error, /Senior does not hold/)
})

test('a flow done before Senior existed (done, steps, no record) gets no record on a later write and stays delivered', () => {
  const id = handFlow()
  const old = { ...F.readFlow(id), status: 'done' }
  delete old.senior
  fs.writeFileSync(path.join(F.FLOWS_DIR, `${id}.json`), JSON.stringify(old)) // as an old file on disk
  store(() => F.writeFlow({ ...F.readFlow(id), title: 'Renamed' }))
  assert.equal(F.readFlow(id).senior, undefined)
  assert.equal(cell(F.readFlow(id)), 'delivered')
})
