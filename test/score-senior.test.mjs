// Tests for the scorecard (score.mjs) and the log (score-log.mjs) once Senior is on the pipeline: work done by hand
// that Senior gates is delivered only at Senior's pass, stopped by Senior is missed, finished with a Senior record but
// no pass slipped through, and each Senior failure is a catch; flows finished before Senior existed (or with no by-hand
// work) are judged as before; the log shows Senior's start and each verdict as kind `senior`; and summing the log's
// cells still gives exactly the scorecard's counts. Pure.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_PIPELINE, pipelineGraph } from '../pipeline.mjs'
import { cellOf, scoreOf, seniorApplies } from '../score.mjs'
import { orchestrationLog } from '../score-log.mjs'

const BASE = {
  coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', Senior: 'Senior' },
  pipeline: { ...DEFAULT_PIPELINE, senior: 'Senior' },
}
const G = pipelineGraph(BASE)
const PLAIN = pipelineGraph({ ...BASE, pipeline: { ...DEFAULT_PIPELINE } })
const DAY = 86_400_000
const NOW = Date.parse('2026-11-25T12:00:00Z')
const ago = ms => new Date(NOW - ms).toISOString()
const step = (id, done = true) => ({ id, do: `do ${id}`, expect: 'ok', at: ago(DAY), done: done ? { by: 'you', at: ago(DAY) } : null })
const hand = { hand: { steps: [step('h1'), step('h2')] } }
const flow = (id, more = {}) => ({ id, title: `Flow ${id}`, agent: 'Agent 1', status: 'open', createdAt: ago(2 * DAY), updatedAt: ago(3_600_000), nodes: [], ...more })
const senior = (status, more = {}) => ({ senior: { status, by: 'Senior', startedAt: ago(7000), at: ago(6000), summary: 'Checked', ...more } })
const failedBefore = { history: [{ status: 'failed', by: 'Senior', startedAt: ago(9500), at: ago(9000), summary: 'Wrong project', redo: ['h1'] }] }
const cell = (f, g = G) => cellOf(f, g, NOW, 7 * DAY)
const score = (flows, g = G) => scoreOf(flows, g, { now: NOW, days: 30 })

test('seniorApplies: a Senior record, or by-hand steps on a flow still on its way; never a QA flow, never without Senior', () => {
  assert.equal(seniorApplies(flow('a', { ...hand, ...senior('passed') }), G), true)
  assert.equal(seniorApplies(flow('b', hand), G), true, 'by-hand steps, still open')
  assert.equal(seniorApplies(flow('c', { status: 'done', ...hand }), G), false, 'finished with no Senior record: judged as before')
  assert.equal(seniorApplies(flow('d', { status: 'done' }), G), false, 'no by-hand work at all')
  assert.equal(seniorApplies(flow('e', { ...hand, qa: { status: 'testing', attempt: 1 } }), G), false, 'code is QA work')
  assert.equal(seniorApplies(flow('f', { ...hand, ...senior('passed') }), PLAIN), false)
})

test('cellOf: delivered at Senior pass; stopped by Senior is missed; finished with a record and no pass slipped through; on its way otherwise', () => {
  assert.deepEqual(cell(flow('a', { status: 'done', ...hand, ...senior('passed') })), { cell: 'delivered', why: null, kind: 'senior', time: NOW - 6000 })
  assert.deepEqual(cell(flow('b', { status: 'blocked', ...hand, ...senior('senior-failed') })), { cell: 'missed', why: 'stopped', kind: 'stopped', time: NOW - 6000 })
  assert.deepEqual(cell(flow('c', { status: 'done', updatedAt: ago(500), ...hand, ...senior('reviewing') })), { cell: 'slipped', why: null, kind: 'done', time: NOW - 500 })
  assert.equal(cell(flow('d', hand)).cell, null, 'waiting at Human task: on its way')
  assert.equal(cell(flow('e', { ...hand, ...senior('failed') })).cell, null, 'sent back to Human task: on its way')
})

test('cellOf: flows finished before Senior existed, and answers with no by-hand work, are delivered as before', () => {
  assert.deepEqual(cell(flow('old', { status: 'done', updatedAt: ago(500), ...hand })), { cell: 'delivered', why: null, kind: 'done', time: NOW - 500 })
  assert.deepEqual(cell(flow('ask', { status: 'done', updatedAt: ago(500) })), { cell: 'delivered', why: null, kind: 'done', time: NOW - 500 })
  assert.deepEqual(cell(flow('plain', { status: 'done', updatedAt: ago(500), ...hand, ...senior('passed') }), PLAIN), { cell: 'delivered', why: null, kind: 'done', time: NOW - 500 }, 'no Senior on the graph')
})

test('scoreOf: each Senior failure is one catch against the flow agent; correctness counts it as a failure', () => {
  const twice = flow('twice', { status: 'done', ...hand, ...senior('passed', failedBefore) })
  const clean = flow('clean', { status: 'done', ...hand, ...senior('passed') })
  const s = score([twice, clean])
  assert.deepEqual(s.counts, { delivered: 2, slipped: 0, missed: 0, caught: 1 })
  assert.deepEqual(s.correctness, { value: 0.5, right: 1, judged: 2 })
  const a1 = s.agents.find(a => a.label === 'Agent 1')
  assert.equal(a1.sentBack, 1)
  assert.equal(a1.firstTime, 1)
  const stopped = score([flow('stop', { status: 'blocked', ...hand, ...senior('senior-failed', failedBefore) })])
  assert.deepEqual(stopped.counts, { delivered: 0, slipped: 0, missed: 1, caught: 2 })
  assert.deepEqual(stopped.correctness, { value: 0, right: 0, judged: 1 })
  assert.equal(score([twice], PLAIN).counts.caught, 0, 'without Senior on the graph its data is not counted')
})

test('the log: Senior starts and verdicts as kind senior, in plain sentences, the pass carrying the delivered cell', () => {
  const ev = orchestrationLog([flow('gated', { status: 'done', ...hand, ...senior('passed', failedBefore) })], G, { now: NOW, days: 30 })
  const mine = ev.filter(e => e.kind === 'senior').map(e => [e.agent, e.text, e.cell])
  assert.deepEqual(mine, [
    ['Senior', 'Senior passed the work done by hand.', 'delivered'],
    ['Senior', 'Senior started reviewing the work done by hand.', null],
    ['Senior', 'Senior failed this and sent it back to Human task.', 'caught'],
    ['Senior', 'Senior started reviewing the work done by hand.', null],
  ])
  const going = orchestrationLog([flow('going', { ...hand, ...senior('reviewing') })], G, { now: NOW, days: 30 })
  assert.deepEqual(going.filter(e => e.kind === 'senior').map(e => e.text), ['Senior started reviewing the work done by hand.'], 'a review going on shows its start')
  assert.ok(!orchestrationLog([flow('x', { status: 'done', ...hand, ...senior('passed') })], PLAIN, { now: NOW, days: 30 }).some(e => e.kind === 'senior'))
})

test('the log: a stop by Senior is said by Senior; a finish before Senior passed it slipped through, said plainly', () => {
  const ev = orchestrationLog([
    flow('stop', { status: 'blocked', ...hand, ...senior('senior-failed') }),
    flow('slip', { status: 'done', updatedAt: ago(500), ...hand, ...senior('reviewing') }),
  ], G, { now: NOW, days: 30 })
  const stop = ev.find(e => e.kind === 'stopped')
  assert.deepEqual([stop.agent, stop.text, stop.cell], ['Senior', 'Senior stopped this, so it will not reach the Output.', 'missed'])
  const slip = ev.find(e => e.flow.id === 'slip' && e.cell === 'slipped')
  assert.deepEqual([slip.kind, slip.text], ['done', 'This finished by hand before Senior passed it.'])
})

test('summing the log cells gives the scorecard counts, with Senior on the pipeline', () => {
  const flows = [
    flow('a', { status: 'done', ...hand, ...senior('passed') }),
    flow('b', { status: 'done', ...hand, ...senior('passed', failedBefore) }),
    flow('c', { status: 'blocked', ...hand, ...senior('senior-failed', failedBefore) }),
    flow('d', { ...hand, ...senior('failed') }),
    flow('e', { status: 'done', updatedAt: ago(500), ...hand, ...senior('reviewing') }),
    flow('f', { status: 'done', updatedAt: ago(DAY), ...hand }),
    flow('g', { status: 'done', updatedAt: ago(DAY) }),
    flow('h', { updatedAt: ago(10 * DAY), ...hand }),
  ]
  for (const days of [7, 30, null]) {
    const s = scoreOf(flows, G, { now: NOW, days })
    const ev = orchestrationLog(flows, G, { now: NOW, days })
    const sum = { delivered: 0, slipped: 0, missed: 0, caught: 0 }
    for (const e of ev) if (e.cell) sum[e.cell]++
    assert.deepEqual(sum, s.counts, `days ${days}`)
  }
})

test('GET /api/log takes kind=senior only on a pipeline with Senior; the Log offers a Senior chip only then', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const vm = await import('node:vm')
  process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'score-senior-test-'))
  const { logGet } = await import('../score-routes.mjs')
  const opts = config => ({ config, now: NOW, extra: [] })
  assert.equal(logGet({ kind: 'senior' }, opts(BASE)).status, 200)
  assert.equal(logGet({ kind: 'senior' }, opts({ ...BASE, pipeline: { ...DEFAULT_PIPELINE } })).status, 400)
  assert.match(logGet({ kind: 'nope' }, opts(BASE)).body.error, /rule or senior\.$/)
  fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true })
  const ctx = vm.createContext({ window: {} })
  const pub = f => fs.readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8')
  for (const f of ['shell.js', 'app.js', 'pipeline-log.js']) vm.runInContext(pub(f), ctx)
  const L = ctx.window.PipelineLog
  assert.doesNotMatch(L.chipsHtml('all', { roles: ['qa'] }), /data-log-chip="senior"/)
  assert.match(L.chipsHtml('senior', { roles: ['qa', 'senior'] }), /data-log-chip="senior" aria-pressed="true">Senior<\/button>/)
  assert.equal(L.queryOf('7', 'senior'), '/api/log?days=7&kind=senior')
  assert.match(L.listHtml({ data: { events: [], total: 0 } }, { filter: 'senior' }), /No Senior reviews in the last 30 days\./)
})

test('the scorecard help says how work done by hand is counted, in one plain sentence', async () => {
  const fs = await import('node:fs')
  const text = fs.readFileSync(new URL('../public/score-view.js', import.meta.url), 'utf8')
  assert.match(text, /With Senior on the pipeline, work done by hand counts as delivered only once Senior passed it; work finished before Senior joined is judged as before\./)
})
