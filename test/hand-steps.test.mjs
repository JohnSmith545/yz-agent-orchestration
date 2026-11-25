// Tests for by-hand steps: the shape and its limits (hand-steps.mjs, validated by flows.mjs on every write), the
// user's tick that no agent can set or keep through a rewrite (keepHand, applyHandTick), and the commands agents
// run, `flow hand-step` and `flow hand-clear` (tools/hand-cli.mjs). FACTORY_DATA_DIR points at a fresh temp folder
// BEFORE the imports, so no test ever touches the real data/ folder.

import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hand-steps-test-'))
const F = await import('../flows.mjs')
const H = await import('../hand-steps.mjs')
const { runFlow, USAGE } = await import('../tools/flow-cli.mjs')
after(() => fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true }))

const { CONFIG } = await import('../config.mjs')
// these tests are about the steps alone: no Senior on the pipeline, whatever the live config.json says (Senior's hold on
// hand-clear is test/senior-hold-durable.test.mjs)
const run = (...argv) => runFlow(argv, { by: 'Agent 1', cwd: ROOT, config: { ...CONFIG, pipeline: { ...CONFIG.pipeline, senior: undefined } } })
const hand = id => F.readFlow(id).hand
beforeEach(() => {
  fs.rmSync(F.FLOWS_DIR, { recursive: true, force: true })
  assert.equal(run('new', 'ci', 'Set up the deploy pipeline', '--type', 'build').code, 0)
})

// ═══ hand-step ═══

test('hand-step adds steps h1, h2 in order with what to do, where, a value to copy, why and what to expect; nothing ticked', () => {
  assert.deepEqual(run('hand-step', 'ci', 'Add the deploy secret', '--expect', 'FIREBASE_TOKEN is listed', '--where', 'GitHub › Settings › Secrets and variables › Actions', '--copy', 'FIREBASE_TOKEN', '--why', 'The deploy job reads it'),
    { out: 'ci h1: by-hand step added', code: 0 })
  assert.equal(run('hand-step', 'ci', 'Run the workflow once', '--expect', 'A green tick on the run').code, 0)
  const h = hand('ci')
  assert.deepEqual(h.steps.map(s => [s.id, s.do, s.where, s.copy, s.why, s.expect, s.done]), [
    ['h1', 'Add the deploy secret', 'GitHub › Settings › Secrets and variables › Actions', 'FIREBASE_TOKEN', 'The deploy job reads it', 'FIREBASE_TOKEN is listed', null],
    ['h2', 'Run the workflow once', undefined, undefined, undefined, 'A green tick on the run', null],
  ])
  assert.ok(h.steps.every(s => typeof s.at === 'string'))
})

test('a value to copy may run over several lines and keeps its spacing; every other field is one line', () => {
  const yaml = 'on:\n  push:\n    branches: [main]'
  assert.equal(run('hand-step', 'ci', 'Paste the trigger', '--expect', 'The file saves', '--copy', yaml).code, 0)
  assert.equal(hand('ci').steps[0].copy, yaml)
  assert.deepEqual(run('hand-step', 'ci', 'Two\nlines', '--expect', 'x'), { out: 'the step must be one line', code: 1 })
  assert.deepEqual(run('hand-step', 'ci', 'Do it', '--expect', 'x', '--where', 'a\nb'), { out: '--where must be one line', code: 1 })
})

test('the limits are refused with a plain sentence: lengths, at most 20 steps, a missing --expect, empty flags, bad ids', () => {
  assert.deepEqual(run('hand-step', 'ci', 'x'.repeat(201), '--expect', 'y'), { out: 'the step: say it shorter: at most 200 characters (this has 201)', code: 1 })
  assert.deepEqual(run('hand-step', 'ci', 'Do', '--expect', 'y'.repeat(201)), { out: '--expect: say it shorter: at most 200 characters (this has 201)', code: 1 })
  assert.deepEqual(run('hand-step', 'ci', 'Do', '--expect', 'y', '--copy', 'z'.repeat(2001)), { out: '--copy: say it shorter: at most 2000 characters (this has 2001)', code: 1 })
  assert.deepEqual(run('hand-step', 'ci', 'Do', '--expect', 'y', '--why', 'w'.repeat(161)), { out: '--why: say it shorter: at most 160 characters (this has 161)', code: 1 })
  assert.match(run('hand-step', 'ci', 'Do').out, /needs --expect/)
  assert.match(run('hand-step', 'ci').out, /needs what to do/)
  assert.equal(run('hand-step', 'ci', 'Do', '--expect', 'y', '--where', '  ').out, '--where is empty: leave it out, or say it')
  assert.equal(run('hand-step', 'ci', 'Do', '--expect', 'y', '--id', 'H 1').out, '--id must match /^[a-z0-9-]+$/')
  assert.equal(run('hand-step', 'ci', 'Do', '--expect', 'y', '--replace').out, '--replace needs --id <the step to rewrite>')
  for (let i = 0; i < 20; i++) assert.equal(run('hand-step', 'ci', `Step ${i + 1}`, '--expect', 'ok').code, 0)
  assert.deepEqual(run('hand-step', 'ci', 'One more', '--expect', 'ok'), { out: 'ci already has 20 by-hand steps, the most a flow takes: say the rest in fewer steps', code: 1 })
  assert.equal(hand('ci').steps.length, 20)
  assert.match(run('hand-step', 'ci', 'Step 1 again', '--expect', 'ok', '--id', 'h1').out, /already has a by-hand step h1: add --replace/)
  assert.match(run('hand-step', 'ci', 'x', '--expect', 'ok', '--id', 'h99', '--replace').out, /has no by-hand step h99 to replace/)
})

test('without --by (or FACTORY_BY) the commands refuse, like the other Output commands', () => {
  assert.equal(runFlow(['hand-step', 'ci', 'Do', '--expect', 'y'], { cwd: ROOT }).code, 1)
  assert.equal(runFlow(['hand-clear', 'ci'], { cwd: ROOT }).code, 1)
})

// ═══ the user's tick ═══

test('applyHandTick is the only thing that ticks: { by: you, at }, and false clears it; an unknown step is a plain error', () => {
  run('hand-step', 'ci', 'Add the secret', '--expect', 'Listed')
  const f = F.readFlow('ci')
  H.applyHandTick(f, 'h1', true, '2026-11-24T10:00:00.000Z')
  assert.deepEqual(f.hand.steps[0].done, { by: 'you', at: '2026-11-24T10:00:00.000Z' })
  F.writeFlow(f)
  assert.deepEqual(H.handProgress(F.readFlow('ci')), { done: 1, total: 1 })
  H.applyHandTick(f, 'h1', false)
  assert.equal(f.hand.steps[0].done, null)
  assert.throws(() => H.applyHandTick(f, 'h9', true), /Flow ci has no by-hand step h9/)
  assert.throws(() => H.applyHandTick(f, 'h1', 'yes'), /done must be true or false/)
  assert.deepEqual(H.handProgress({}), { done: 0, total: 0 })
})

/** h1 ticked by the user, h2 not. */
function ticked() {
  run('hand-step', 'ci', 'Add the secret', '--expect', 'Listed', '--where', 'GitHub › Settings')
  run('hand-step', 'ci', 'Run it', '--expect', 'Green')
  const f = F.readFlow('ci')
  H.applyHandTick(f, 'h1', true, '2026-11-24T10:00:00.000Z')
  F.writeFlow(f)
}

test('a tick survives a reload and an agent rewrite of the flow (flow write), and an agent can never tick a step itself', () => {
  ticked()
  const file = path.join(process.env.FACTORY_DATA_DIR, 'ci.json')
  const mine = F.readFlow('ci')
  mine.hand.steps[1].done = { by: 'you', at: '2026-11-24T11:00:00.000Z' } // the agent forging a tick on h2
  mine.title = 'Set up the deploy pipeline, take two'
  fs.writeFileSync(file, JSON.stringify(mine))
  assert.equal(run('write', file).code, 0)
  const h = hand('ci')
  assert.deepEqual(h.steps[0].done, { by: 'you', at: '2026-11-24T10:00:00.000Z' }, 'the user tick is kept')
  assert.equal(h.steps[1].done, null, 'the forged tick is dropped')
  const noHand = F.readFlow('ci')
  delete noHand.hand
  fs.writeFileSync(file, JSON.stringify(noHand))
  assert.equal(run('write', file).code, 0)
  assert.deepEqual(hand('ci').steps[0].done, { by: 'you', at: '2026-11-24T10:00:00.000Z' }, 'a rewrite with no hand keeps the stored one whole')
})

test('a step the agent rewrote to ask something else loses its tick; one that only changed its why keeps it', () => {
  ticked()
  assert.equal(run('hand-step', 'ci', 'Add the secret', '--expect', 'Listed', '--where', 'GitHub › Settings', '--why', 'Now with a reason', '--id', 'h1', '--replace').out, 'ci h1: by-hand step replaced')
  assert.ok(hand('ci').steps[0].done, 'same ask: still ticked')
  assert.equal(run('hand-step', 'ci', 'Add the secret', '--expect', 'Listed', '--where', 'GitLab › Settings', '--id', 'h1', '--replace').out,
    'ci h1: by-hand step replaced (it changed, so the user tick on it was cleared)')
  assert.equal(hand('ci').steps[0].done, null)
})

test('the request fields are the server: a rewrite never sets or clears them', () => {
  const f = F.readFlow('ci')
  f.hand = { steps: [], requestedAt: '2026-11-24T09:00:00.000Z', requestSentAt: null, requestError: null }
  F.writeFlow(f)
  const incoming = { ...F.readFlow('ci'), hand: { steps: [], requestedAt: '2030-01-01T00:00:00.000Z', requestError: 'forged' } }
  const merged = F.mergeKeepingAnswers(incoming, F.readFlow('ci'))
  assert.equal(merged.hand.requestedAt, '2026-11-24T09:00:00.000Z')
  assert.equal('requestError' in merged.hand, false)
})

test('hand-clear empties the steps; show prints them with who ticked what, and the open request', () => {
  ticked()
  const shown = run('show', 'ci')
  assert.match(shown.err, /by-hand steps: 1 of 2 done by the user/)
  assert.match(shown.err, /1\. \[h1\] \(done\) Add the secret -> Listed \(at GitHub › Settings\)/)
  assert.match(shown.err, /2\. \[h2\] Run it -> Green/)
  assert.deepEqual(run('hand-clear', 'ci'), { out: 'ci: by-hand steps cleared', code: 0 })
  assert.deepEqual(hand('ci').steps, [])
  const f = F.readFlow('ci')
  f.hand.requestedAt = '2026-11-24T09:00:00.000Z'
  F.writeFlow(f)
  assert.match(run('show', 'ci').err, /the user asked for by-hand steps at 2026-11-24T09:00:00.000Z: record them with hand-step, then stop/)
})

// ═══ validation (flows.mjs validateFlow) ═══

test('validateFlow checks hand: steps a list, ids unique slugs, do and expect present, done only the user shape', () => {
  const base = { id: 'x', title: 'X', agent: 'Agent 1', status: 'open', nodes: [] }
  assert.deepEqual(F.validateFlow({ ...base, hand: { steps: [] } }), [])
  assert.deepEqual(F.validateFlow({ ...base, hand: [] }), ['hand must be a JSON object'])
  assert.deepEqual(F.validateFlow({ ...base, hand: { steps: 'no' } }), ['hand.steps must be a list'])
  assert.deepEqual(F.validateFlow({ ...base, hand: { steps: [{ id: 'h1', do: 'Do', expect: 'See' }, { id: 'h1', do: 'Do', expect: 'See' }] } }), ['duplicate hand step id h1'])
  assert.deepEqual(F.validateFlow({ ...base, hand: { steps: [{ id: 'h1' }] } }), ['hand step h1: do must say what to do', 'hand step h1: expect must say what the user should see when it worked'])
  assert.deepEqual(F.validateFlow({ ...base, hand: { steps: [{ id: 'h1', do: 'Do', expect: 'See', done: { by: 'Agent 1', at: 'now' } }] } }), ['hand step h1: done must be null or { by: "you", at }'])
  assert.match(F.validateFlow({ ...base, hand: { steps: Array.from({ length: 21 }, (_, i) => ({ id: `h${i}`, do: 'a', expect: 'b' })) } })[0], /hand has 21 steps, at most 20/)
})

test('the usage text and the agent brief tell agents to record the steps and stop, never to do that work', () => {
  assert.match(USAGE, /hand-step <flow> "<do this>" --expect "<you should see>" \[--where "<path or click path>"\] \[--copy "<value to paste>"\]/)
  assert.match(USAGE, /hand-clear <flow>/)
  assert.match(USAGE, /record the steps, then STOP;\s+never do that work yourself/)
  const brief = fs.readFileSync(path.join(ROOT, 'docs', 'agent-brief.md'), 'utf8')
  assert.match(brief, /flow hand-step/)
  assert.match(brief, /You never run[\s>]*that work yourself/)
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  for (const f of ['hand-steps.mjs', 'tools/hand-cli.mjs']) assert.ok(pkg.scripts.check.includes(`node --check ${f}`), f)
})
