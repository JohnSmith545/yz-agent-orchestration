// Tests for the evidence pack the weekly Learn run reads (learn-pack.mjs) and the retrospectives it reads instead of
// raw logs (learn-records.mjs listRetros, the contract other features may call). The window rule (since the last run,
// 7 days without one, at least 14 when fewer than 5 flows finished), the sections, the caps, a failed source left out
// and named, the optional lessons and signals, and the rejected ideas carried to the next pack. Pure: every reader is
// a stub.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_PIPELINE, pipelineGraph } from '../pipeline.mjs'
import { PACK_MAX, buildPack } from '../learn-pack.mjs'
import { listRetros } from '../learn-records.mjs'

const DAY = 86_400_000
const H = 3_600_000
const NOW = new Date(2026, 10, 25, 12, 0).getTime()
const iso = t => new Date(t).toISOString()
const GRAPH = pipelineGraph({ coordinator: 'Master', coordinatorLabel: 'Master', codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1' }, pipeline: { ...DEFAULT_PIPELINE }, factory: { chat: { name: 'Independent' } } })

function flow(id, done, { fails = 0, retro = null, agent = 'Agent 1' } = {}) {
  const start = done - 2 * H
  const attempts = Array.from({ length: fails }, (_, i) => ({ status: 'failed', attempt: i + 1, by: 'QA', startedAt: iso(start + (i + 1) * 60_000), at: iso(start + (i + 1) * 60_000 + 1000), summary: `Fail ${i + 1} on ${id}: the limit was not checked.`, report: `${id}/qa-${i + 1}-report.md`, rework: { to: agent } }))
  return {
    id, title: `Title ${id}`, agent, status: 'done', nodes: [], createdAt: iso(start), updatedAt: iso(done),
    qa: { status: 'passed', attempt: fails + 1, by: 'QA', startedAt: iso(done - 1000), at: iso(done), summary: 'ok', attempts },
    ...(retro ? { retro: { at: iso(done + 1000), right: `R ${id}`, wrong: `W ${id}`, next: `N ${id}`, cost: 0.01, source: 'completed' } } : {}),
  }
}

const RULES = { agents: { 'Agent 1': { spec: 'Builds the web.', rules: [{ id: 'r1', text: 'Write the failing test first.' }] } } }
const base = (over = {}) => ({
  now: NOW, lastRunAt: null, graph: GRAPH, flows: () => FLOWS, rules: () => RULES, tokens: () => ({ usd: 12 }),
  verdicts: () => [], rejected: () => [], readReport: () => '# QA\nThe 301st character was cut.', ...over,
})
const FLOWS = [flow('a', NOW - 1 * DAY, { retro: true }), flow('b', NOW - 2 * DAY, { fails: 1, retro: true }), flow('c', NOW - 3 * DAY), flow('d', NOW - 4 * DAY), flow('e', NOW - 5 * DAY), flow('old', NOW - 20 * DAY, { fails: 2 })]

test('the window: the last 7 days without a run, since the last run with one', () => {
  const p = buildPack(base())
  assert.equal(p.window.from, iso(NOW - 7 * DAY))
  assert.equal(p.window.widened, false)
  const since = buildPack(base({ lastRunAt: iso(NOW - 6 * DAY), flows: () => [...FLOWS, flow('f', NOW - 2 * H)] }))
  assert.equal(since.window.from, iso(NOW - 6 * DAY))
})

test('fewer than 5 finished: the window goes back at least 14 days, and says so', () => {
  const p = buildPack(base({ lastRunAt: iso(NOW - 2 * DAY) })) // a and b only in 2 days
  assert.equal(p.window.from, iso(NOW - 14 * DAY))
  assert.equal(p.window.widened, true)
  assert.match(p.text, /widened to 14 days because fewer than 5 flows finished/)
})

test('the sections: score, numbers, retrospectives, failure texts with their reports, reworks per agent, rules, verdicts', () => {
  const p = buildPack(base({ verdicts: () => [{ label: 'Agent 1', at: iso(NOW - 3 * DAY), added: ['Old idea.'], removed: [], dueAt: iso(NOW + 11 * DAY), state: 'waiting' }] }))
  for (const head of ['PIPELINE NUMBERS', 'FLOWS IN THE WINDOW', 'RETROSPECTIVES', 'FAILURE TEXTS', 'REWORKS PER AGENT', 'CURRENT RULES', 'OPEN VERDICTS ON EARLIER RULE CHANGES']) assert.match(p.text, new RegExp(head))
  assert.match(p.text, /- b \(Title b\): Right: R b \| Wrong: W b \| Next: N b/)
  assert.match(p.text, /Fail 1 on b: the limit was not checked\./)
  assert.match(p.text, /301st character/)
  assert.match(p.text, /Agent 1: 1\. Write the failing test first\./)
  assert.match(p.text, /Agent 1 got: Old idea\./)
  assert.deepEqual([...p.flowIds].sort(), ['a', 'b', 'c', 'd', 'e'])
  assert.doesNotMatch(p.text, /Title old/) // outside the window
  assert.match(p.read, /^Read: 5 finished flows, 2 retrospectives, 1 failure text, 1 open verdict/)
  assert.equal(p.left, '')
})

test('a rejected idea goes into the next pack with its reason, so the same idea is not proposed again', () => {
  const p = buildPack(base({ rejected: () => [{ target: 'Agent 1', rule: 'Ask before every commit.', reason: 'Too slow.' }] }))
  assert.match(p.text, /REJECTED BEFORE \(do not propose these again\)\n- Agent 1: Ask before every commit\. Reason: Too slow\./)
})

test('a source that fails is left out and named; the rest of the pack is still built', () => {
  const p = buildPack(base({ tokens: () => { throw new Error('no index') }, rules: () => { throw new Error('bad file') } }))
  assert.equal(p.left, 'Left out: the token cost, the current rules (they could not be read).')
  assert.match(p.text, /RETROSPECTIVES/)
  assert.doesNotMatch(p.text, /CURRENT RULES/)
})

test('no lessons or signals provider: no such section; with them, their lines', () => {
  assert.doesNotMatch(buildPack(base()).text, /LESSONS|ALERTS/)
  const p = buildPack(base({ lessons: ({ since }) => [{ id: 'l1', text: 'Check limits.', area: 'QA', count: 3, since }], signals: () => [{ kind: 'stuck', text: 'Agent 2 stalled twice.' }] }))
  assert.match(p.text, /LESSONS LEARNED\n- \[QA\] Check limits\. \(seen 3 times\)/)
  assert.match(p.text, /ALERTS AND ESTIMATES\n- stuck: Agent 2 stalled twice\./)
})

test('the pack is capped, the cut said at its end; one long failure text cannot crowd out the rules', () => {
  const many = Array.from({ length: 200 }, (_, i) => flow(`f${i}`, NOW - (i % 6) * DAY - H, { fails: 3, retro: true }))
  const p = buildPack(base({ flows: () => many, readReport: () => 'x'.repeat(9000) }))
  assert.ok(p.text.length <= PACK_MAX, `${p.text.length}`)
  assert.match(p.text, /Cut here/)
  assert.match(p.text, /CURRENT RULES/)
})

test('listRetros: every retrospective written since a time, newest first, archived flows too', () => {
  const flows = [flow('a', NOW - 1 * DAY, { retro: true }), flow('b', NOW - 9 * DAY, { retro: true }), flow('c', NOW - DAY), { ...flow('d', NOW - 2 * DAY, { retro: true }), archivedAt: iso(NOW) }]
  const list = listRetros({ since: NOW - 7 * DAY, readFlows: () => flows })
  assert.deepEqual(list.map(r => r.flowId), ['a', 'd'])
  assert.deepEqual(Object.keys(list[0]).sort(), ['agent', 'at', 'flowId', 'next', 'right', 'source', 'title', 'wrong'])
  assert.equal(listRetros({ readFlows: () => flows }).length, 3) // no since: all
  assert.deepEqual(listRetros({ since: 'not a time', readFlows: () => flows }).length, 3)
  assert.deepEqual(listRetros({ readFlows: () => { throw new Error('x') } }), [])
})
