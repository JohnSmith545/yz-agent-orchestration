// Tests for the planner's commands (tools/plan-cli.mjs, behind `node tools/factory.mjs flow plan-start | plan`) and
// its record (flow-plan.mjs): only the configured planner may run them; plan-start puts the flow on the planner;
// plan copies the plan into the evidence folder, hands the flow to a producer (its agent from then on) and plans a
// build's route again through the planner; a producer's rewrite can never change the record. FACTORY_DATA_DIR
// points at a fresh temp folder BEFORE the imports.

import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-cli-test-'))
const F = await import('../flows.mjs')
const { runFlow } = await import('../tools/flow-cli.mjs')
const { validatePlan, keepPlan } = await import('../flow-plan.mjs')
const { pipelineGraph, stageOf } = await import('../pipeline.mjs')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-cli-files-'))
after(() => {
  fs.rmSync(F.DATA_DIR, { recursive: true, force: true })
  fs.rmSync(TMP, { recursive: true, force: true })
})

const CONFIG = {
  repo: 'C:/watched/repo',
  coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', 'Agent 2': 'Agent 2', Planner: 'Planner' },
  pipeline: { qa: 'QA', producers: null, protectedBranches: ['dev'], maxReworks: 2, planner: 'Planner' },
}
const NO_PLANNER = { ...CONFIG, pipeline: { ...CONFIG.pipeline, planner: undefined } }
const ID = 'plan-me'
const run = (by, ...argv) => runFlow(argv, { by, cwd: TMP, config: CONFIG })
const read = () => F.readFlow(ID)

beforeEach(() => {
  fs.rmSync(F.FLOWS_DIR, { recursive: true, force: true })
  fs.rmSync(F.EVIDENCE_DIR, { recursive: true, force: true })
  assert.equal(runFlow(['new', ID, 'Add the login page', '--type', 'build'], { by: 'Master', cwd: TMP, config: CONFIG }).code, 0)
  fs.writeFileSync(path.join(TMP, 'plan.md'), '# Plan\n1. Write the failing test.\n')
  fs.writeFileSync(path.join(TMP, 'plan.html'), '<p>no</p>')
})

test('only the planner records a plan, and only when the pipeline has one', () => {
  const r = run('Agent 1', 'plan-start', ID)
  assert.equal(r.code, 1)
  assert.match(r.out, /Only the planner records a plan: --by must be "Planner"/)
  assert.match(run(undefined, 'plan-start', ID).out, /--by/)
  const none = runFlow(['plan-start', ID], { by: 'Planner', cwd: TMP, config: NO_PLANNER })
  assert.equal(none.code, 1)
  assert.match(none.out, /no planner/)
  assert.equal(read().plan, undefined)
})

test('plan-start puts the flow on the planner, and the stage says so', () => {
  const r = run('Planner', 'plan-start', ID)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /Planner is planning it/)
  const flow = read()
  assert.equal(flow.plan.status, 'planning')
  assert.equal(flow.plan.by, 'Planner')
  assert.equal(flow.agent, 'Master', 'still the coordinator flow until it is handed out')
  assert.deepEqual(stageOf(flow, pipelineGraph(CONFIG)), { node: 'planner', status: 'working', path: ['request', 'master', 'planner'], reworks: 0 })
})

test('plan hands the task to a producer: the plan is copied, the flow is that producer, the build route goes through the planner', () => {
  run('Planner', 'plan-start', ID)
  const r = run('Planner', 'plan', ID, '--file', 'plan.md', '--to', 'Agent 1')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /handed to Agent 1 with the plan/)
  assert.match(r.out, /send Agent 1 a message naming flow plan-me/)
  const flow = read()
  assert.equal(flow.agent, 'Agent 1')
  assert.deepEqual({ status: flow.plan.status, to: flow.plan.to, file: flow.plan.file }, { status: 'handed', to: 'Agent 1', file: `${ID}/plan-1.md` })
  assert.equal(fs.readFileSync(path.join(F.EVIDENCE_DIR, ID, 'plan-1.md'), 'utf8'), '# Plan\n1. Write the failing test.\n')
  assert.deepEqual(flow.route.steps, ['request', 'master', 'planner', 'agent-1', 'qa', 'push', 'outcome'])
  assert.equal(flow.route.history.length, 1, 'the coordinator route stays in the history')
  assert.deepEqual(stageOf(flow, pipelineGraph(CONFIG)).path, ['request', 'master', 'planner', 'agent-1'])
})

test('plan refuses a missing or HTML file, and a --to that is not a producer, each in one line; nothing changes', () => {
  for (const [args, re] of [
    [['--to', 'Agent 1'], /--file <plan\.md>/],
    [['--file', 'plan.html', '--to', 'Agent 1'], /never HTML/],
    [['--file', 'nope.md', '--to', 'Agent 1'], /existing \.md or \.txt/],
    [['--file', 'plan.md'], /--to "<producer>"/],
    [['--file', 'plan.md', '--to', 'Master'], /Master is not a producer/],
    [['--file', 'plan.md', '--to', 'Planner'], /Planner is not a producer/],
  ]) {
    const r = run('Planner', 'plan', ID, ...args)
    assert.equal(r.code, 1, args.join(' '))
    assert.match(r.out, re)
  }
  assert.equal(read().plan, undefined)
  assert.equal(read().agent, 'Master')
})

test('a second hand-out keeps the first in the history, numbered files apart', () => {
  run('Planner', 'plan', ID, '--file', 'plan.md', '--to', 'Agent 1')
  run('Planner', 'plan-start', ID)
  assert.equal(read().plan.history.length, 1)
  const r = run('Planner', 'plan', ID, '--file', 'plan.md', '--to', 'Agent 2')
  assert.equal(r.code, 0, r.out)
  const flow = read()
  assert.equal(flow.plan.file, `${ID}/plan-2.md`)
  assert.deepEqual(flow.plan.history.map(h => h.to), ['Agent 1'])
  assert.equal(flow.agent, 'Agent 2')
})

test('a dropped flow is refused; the plan block is the planners alone: a rewrite keeps the stored one', () => {
  run('Planner', 'plan', ID, '--file', 'plan.md', '--to', 'Agent 1')
  const stored = read()
  const forged = { ...stored, plan: { ...stored.plan, to: 'Agent 2' } }
  assert.deepEqual(keepPlan(forged, stored).plan, stored.plan)
  assert.equal(keepPlan({ id: ID, plan: { status: 'handed' } }, { id: ID }).plan, undefined)
  F.writeFlow({ ...read(), status: 'dropped' })
  assert.match(run('Planner', 'plan-start', ID).out, /dropped/)
})

test('validatePlan: the shape, in plain lines', () => {
  const at = '2026-11-24T10:00:00.000Z'
  assert.deepEqual(validatePlan({ status: 'planning', by: 'Planner', startedAt: at, at }, ID), [])
  assert.deepEqual(validatePlan({ status: 'handed', by: 'Planner', startedAt: at, at, to: 'Agent 1', file: `${ID}/plan-1.md` }, ID), [])
  assert.deepEqual(validatePlan([], ID), ['plan must be a JSON object'])
  const bad = validatePlan({ status: 'done', by: 'x"y', startedAt: '1', at, to: 'Agent 1' }, ID).join('\n')
  assert.match(bad, /plan status must be one of planning, handed/)
  assert.match(bad, /plan by must be/)
  assert.match(bad, /plan startedAt must be a time/)
  assert.match(bad, /plan to is set only once/)
  assert.match(validatePlan({ status: 'handed', by: 'Planner', startedAt: at, at, to: 'Agent 1', file: `${ID}/plan.html` }, ID).join('\n'), /never HTML/)
})

test('flow show says where the plan is', () => {
  run('Planner', 'plan', ID, '--file', 'plan.md', '--to', 'Agent 1')
  const shown = runFlow(['show', ID], { by: 'Agent 1', cwd: TMP, config: CONFIG })
  assert.match(shown.err, /plan: handed to Agent 1 by Planner at .*plan-me\/plan-1\.md/)
})
