// Tests for Senior (tools/senior-cli.mjs, flow-senior.mjs): only the configured Senior label records a review; it
// reviews a no-code flow once the user ticked every by-hand step, or one an agent sent on purpose (senior-ask); a pass
// finishes the flow; a failure goes back to the Human task box with the steps it names (or every step) unticked and
// its text kept for the checklist; failures share pipeline.maxReworks; a flow with a QA record is never Senior's; a
// rewrite of the flow keeps Senior's record. FACTORY_DATA_DIR points at a fresh temp folder BEFORE the imports.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-cli-test-'))
const F = await import('../flows.mjs')
const { runFlow } = await import('../tools/flow-cli.mjs')
const { applyHandTick } = await import('../hand-steps.mjs')
const { pipelineGraph, stageOf } = await import('../pipeline.mjs')
const S = await import('../flow-senior.mjs')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-cli-files-'))
after(() => {
  fs.rmSync(F.DATA_DIR, { recursive: true, force: true })
  fs.rmSync(TMP, { recursive: true, force: true })
})

const CONFIG = {
  repo: 'C:/watched/repo',
  coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', 'Agent 2': 'Agent 2', sen: 'Senior' },
  pipeline: { qa: 'QA', producers: null, protectedBranches: ['dev'], maxReworks: 2, senior: 'Senior' },
}
const WITHOUT = { ...CONFIG, pipeline: { ...CONFIG.pipeline, senior: undefined } }
const G = pipelineGraph(CONFIG)
const as = (by, config = CONFIG) => (...argv) => runFlow(argv, { by, cwd: TMP, config })
const A1 = as('Agent 1')
const SEN = as('Senior')
const read = id => F.readFlow(id)
let n = 0

/** A new ask flow of Agent 1 with by-hand steps h1 and h2, `ticked` of them ticked by the user. */
function handFlow(ticked = []) {
  const id = `hand-${++n}`
  assert.equal(A1('new', id, 'Set up the deploy secrets', '--type', 'ask').code, 0)
  assert.equal(A1('hand-step', id, 'Add the deploy token', '--expect', 'It is listed').code, 0)
  assert.equal(A1('hand-step', id, 'Turn on branch protection', '--expect', 'The rule shows').code, 0)
  tick(id, ticked)
  return id
}
function tick(id, steps) {
  const flow = read(id)
  for (const s of steps) applyHandTick(flow, s, true)
  F.writeFlow(flow)
}

test('only Senior records a review: no Senior on the pipeline, no name, or another name is refused, and nothing is written', () => {
  const id = handFlow(['h1', 'h2'])
  assert.match(as('Senior', WITHOUT)('senior-start', id).out, /no Senior agent \(config pipeline\.senior\)/)
  assert.equal(runFlow(['senior-start', id], { cwd: TMP, config: CONFIG }).code, 1)
  for (const cmd of [['senior-start', id], ['senior', id, 'pass', 'Checked']]) {
    const r = A1(...cmd)
    assert.equal(r.code, 1)
    assert.match(r.out, /Only Senior records a review: --by must be "Senior"/)
  }
  assert.equal(read(id).senior, undefined)
})

test('senior-start waits for every by-hand step to be ticked, and says how many are', () => {
  const id = handFlow(['h1'])
  const r = SEN('senior-start', id)
  assert.equal(r.code, 1)
  assert.match(r.out, /ticked 1 of 2 by-hand steps/)
  assert.equal(stageOf(read(id), G).node, 'human')
  tick(id, ['h2'])
  assert.equal(stageOf(read(id), G).node, 'senior', 'every step ticked: it waits at Senior')
  const ok = SEN('senior-start', id)
  assert.equal(ok.code, 0, ok.out)
  assert.equal(read(id).senior.status, 'reviewing')
  assert.deepEqual(stageOf(read(id), G).status, 'reviewing')
})

test('nothing to review: no steps and no senior-ask; a dropped flow; a flow on the QA path', () => {
  assert.equal(A1('new', 'plain', 'Why is it slow?', '--type', 'ask').code, 0)
  assert.match(SEN('senior-start', 'plain').out, /no by-hand steps and no one sent it to Senior/)
  const dropped = handFlow(['h1', 'h2'])
  F.writeFlow({ ...read(dropped), status: 'dropped' })
  assert.match(SEN('senior-start', dropped).out, /is dropped/)
  const tested = handFlow(['h1', 'h2'])
  F.writeFlow({ ...read(tested), qa: { status: 'testing', attempt: 1, by: 'QA', at: '2026-11-25T10:00:00Z' } })
  assert.match(SEN('senior-start', tested).out, /went to QA/)
  assert.match(A1('senior-ask', tested, 'Look at it').out, /went to QA/)
})

test('a pass finishes the flow at the Output; a second verdict is refused', () => {
  const id = handFlow(['h1', 'h2'])
  assert.equal(SEN('senior-start', id).code, 0)
  const r = SEN('senior', id, 'pass', 'The token is in the right project, scoped to deploys only, and CI is green.')
  assert.equal(r.code, 0, r.out)
  const f = read(id)
  assert.equal(f.status, 'done')
  assert.equal(f.senior.status, 'passed')
  assert.equal(f.senior.summary, 'The token is in the right project, scoped to deploys only, and CI is green.')
  assert.deepEqual(stageOf(f, G), { node: 'outcome', status: 'passed', path: ['request', 'master', 'agent-1', 'human', 'senior', 'outcome'], reworks: 0 })
  assert.match(SEN('senior', id, 'fail', 'Again').out, /already passed/)
})

test('a failure goes back to Human task: the named steps are unticked, the text kept; ticked again it waits at Senior', () => {
  const id = handFlow(['h1', 'h2'])
  const r = SEN('senior', id, 'fail', 'The token was added to prod, not dev. Remove it there and add it to dev.', '--steps', 'h1')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /goes back to Human task and step h1 waits to be done again/)
  let f = read(id)
  assert.equal(f.status, 'open')
  assert.deepEqual(f.senior.redo, ['h1'])
  assert.equal(f.hand.steps.find(s => s.id === 'h1').done, null)
  assert.ok(f.hand.steps.find(s => s.id === 'h2').done, 'a step Senior did not name keeps its tick')
  assert.deepEqual(S.pendingRedo(f), { summary: 'The token was added to prod, not dev. Remove it there and add it to dev.', redo: ['h1'], by: 'Senior', at: f.senior.at })
  assert.deepEqual(stageOf(f, G), { node: 'human', status: 'rework', path: ['request', 'master', 'agent-1', 'human', 'senior', 'human'], reworks: 1 })
  tick(id, ['h1'])
  f = read(id)
  assert.equal(stageOf(f, G).node, 'senior')
  assert.equal(SEN('senior-start', id).code, 0)
  f = read(id)
  assert.equal(f.senior.status, 'reviewing')
  assert.equal(f.senior.history.length, 1, 'the failure moved into history')
  assert.equal(f.senior.history[0].summary, 'The token was added to prod, not dev. Remove it there and add it to dev.')
})

test('a failure that names no step unticks them all; a step that does not exist is refused', () => {
  const id = handFlow(['h1', 'h2'])
  assert.match(SEN('senior', id, 'fail', 'Redo', '--steps', 'h9').out, /has no by-hand step h9: its steps are h1, h2/)
  assert.match(SEN('senior', id, 'pass', 'Fine', '--steps', 'h1').out, /leave it out of a pass/)
  assert.equal(SEN('senior', id, 'fail', 'Nothing shows the rule was saved: add a screenshot of the branch settings.').code, 0)
  assert.deepEqual(read(id).hand.steps.map(s => s.done), [null, null])
  assert.deepEqual(read(id).senior.redo, ['h1', 'h2'])
})

test('a verdict needs pass or fail and words; too long is refused', () => {
  const id = handFlow(['h1', 'h2'])
  assert.match(SEN('senior', id, 'maybe', 'x').out, /pass\|fail/)
  assert.match(SEN('senior', id, 'pass').out, /say what you checked/)
  assert.match(SEN('senior', id, 'fail', '  ').out, /say what to redo/)
  assert.match(SEN('senior', id, 'pass', 'x'.repeat(1001)).out, /at most 1000 characters/)
  assert.equal(read(id).senior, undefined)
})

test('failures share pipeline.maxReworks: past it the flow is stopped at Senior and blocked', () => {
  const id = handFlow(['h1', 'h2'])
  for (let k = 0; k < 2; k++) {
    assert.equal(SEN('senior', id, 'fail', `Round ${k + 1}`).code, 0)
    tick(id, ['h1', 'h2'])
  }
  const r = SEN('senior', id, 'fail', 'Round 3')
  assert.match(r.out, /already went back 2 times/)
  const f = read(id)
  assert.equal(f.senior.status, 'senior-failed')
  assert.equal(f.status, 'blocked')
  assert.equal(f.senior.history.length, 2)
  assert.equal(stageOf(f, G).node, 'senior')
  assert.equal(stageOf(f, G).status, 'failed')
  assert.match(SEN('senior-start', id).out, /stopped/)
})

test('senior-ask sends a no-code flow with no steps to Senior; Senior may not ask itself; reviewing refuses a new ask', () => {
  assert.equal(A1('new', 'ci-console', 'Turn on the CI cache in the console', '--type', 'ask').code, 0)
  assert.match(A1('senior-ask', 'ci-console').out, /needs what to review/)
  assert.match(SEN('senior-ask', 'ci-console', 'x').out, /does not ask itself/)
  assert.match(as('Agent 1', WITHOUT)('senior-ask', 'ci-console', 'x').out, /no Senior agent/)
  const r = A1('senior-ask', 'ci-console', 'I turned on the build cache in the CI settings page of the dev project.')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /Send Senior a message naming flow ci-console/)
  let f = read('ci-console')
  assert.equal(f.senior.status, 'asked')
  assert.equal(f.senior.ask.by, 'Agent 1')
  assert.deepEqual(stageOf(f, G), { node: 'senior', status: 'waiting', path: ['request', 'master', 'agent-1', 'senior'], reworks: 0 })
  assert.equal(SEN('senior-start', 'ci-console').code, 0)
  assert.match(A1('senior-ask', 'ci-console', 'again').out, /reviewing it now/)
  assert.equal(SEN('senior', 'ci-console', 'fail', 'The cache was turned on in stage too.').code, 0)
  f = read('ci-console')
  assert.equal(stageOf(f, G).node, 'human', 'no steps to tick again: it waits at Human task')
  assert.match(SEN('senior-start', 'ci-console').out, /sends it again with senior-ask/)
  assert.equal(A1('senior-ask', 'ci-console', 'Turned it off in stage again.').code, 0)
  f = read('ci-console')
  assert.equal(f.senior.status, 'asked')
  assert.equal(f.senior.history.length, 1)
})

test('senior-ask on a finished flow opens it again until Senior passes it', () => {
  assert.equal(A1('new', 'done-ask', 'A finished change', '--type', 'ask').code, 0)
  F.writeFlow({ ...read('done-ask'), status: 'done' })
  assert.equal(A1('senior-ask', 'done-ask', 'Check the DNS record I changed').code, 0)
  assert.equal(read('done-ask').status, 'open')
})

test('a rewrite of the flow keeps the stored Senior record: an agent can neither drop a failure nor forge a pass', () => {
  const id = handFlow(['h1', 'h2'])
  assert.equal(SEN('senior', id, 'fail', 'Wrong project').code, 0)
  const forged = { ...read(id), senior: { status: 'passed', by: 'Senior', at: '2026-11-25T10:00:00Z' } }
  const merged = F.mergeKeepingAnswers(forged, read(id))
  assert.equal(merged.senior.status, 'failed')
  const dropped = { ...read(id) }
  delete dropped.senior
  assert.equal(F.mergeKeepingAnswers(dropped, read(id)).senior.status, 'failed')
})

test('validateSenior: a good record passes; every bad part is one plain line', () => {
  assert.deepEqual(S.validateSenior({ status: 'failed', by: 'Senior', at: '2026-11-25T10:00:00Z', summary: 'x', redo: ['h1'], history: [{ status: 'failed', by: 'Senior', at: '2026-11-25T09:00:00Z', summary: 'y' }] }), [])
  const bad = S.validateSenior({ status: 'maybe', by: 'x"y', at: 'soon', summary: 'x'.repeat(1001), redo: ['H 1'], ask: { text: '', by: '', at: 'x' }, history: [{ status: 'passed' }] })
  for (const re of [/status must be one of/, /by must be a label/, /at must be a time/, /summary must be text of at most 1000/, /redo must be a list/, /ask text/, /ask by/, /ask at/, /history #1 must be a failed verdict/]) assert.ok(bad.some(p => re.test(p)), String(re))
  assert.deepEqual(S.validateSenior(null), ['senior must be a JSON object'])
  assert.match(F.validateFlow({ ...read(handFlow()), senior: { status: 'nope' } }).join('\n'), /senior status/)
})

test('flow show says where Senior is, and the help lists the commands', () => {
  const id = handFlow(['h1', 'h2'])
  assert.equal(SEN('senior', id, 'fail', 'Wrong project', '--steps', 'h2').code, 0)
  const r = A1('show', id)
  assert.match(r.err || '', /senior: failed \(Senior\), sent back 1 time/)
  assert.match(r.err || '', /redo: Wrong project \(steps h2\)/)
  const help = runFlow(['nope']).out
  for (const s of ['senior-ask <flow>', 'senior-start <flow>', 'senior <flow> pass|fail']) assert.ok(help.includes(s), s)
})
