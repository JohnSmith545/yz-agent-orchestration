// Tests for routing-outcomes.mjs: one line per finished flow (delivered, slipped through, stopped or dropped) built
// from stored records only, written ONCE, append-only; tokens and cost from the injected provider or marked missing;
// listOutcomes({ since }); and the Routing page's table, which says Too few to trust under 5 flows.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-outcomes-test-'))
const O = await import('../routing-outcomes.mjs')
after(() => fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true }))

const graph = { nodes: [
  { id: 'request', kind: 'request' }, { id: 'master', kind: 'agent', label: 'Master', role: 'coordinator' },
  { id: 'a2', kind: 'agent', label: 'Agent 2', role: 'producer' }, { id: 'qa', kind: 'agent', label: 'QA', role: 'qa' },
  { id: 'push', kind: 'push' }, { id: 'outcome', kind: 'outcome' },
], edges: [] }
const NOW = Date.parse('2026-11-25T12:00:00Z')
const routing = { type: 'wording', size: 'small', risk: null, suggested: { agent: null, model: 'claude-sonnet-5-5', effort: 'medium', rule: 1, why: 'x' }, used: { agent: 'Agent 2', model: 'claude-sonnet-5-5', effort: 'medium', at: '2026-11-25T09:00:00Z' }, followed: true }
const passed = (id, over = {}) => ({
  id, title: 'Fix a typo', agent: 'Agent 2', status: 'done', nodes: [], createdAt: '2026-11-25T09:00:00Z', updatedAt: '2026-11-25T10:00:00Z', routing,
  qa: { status: 'passed', attempt: 1, at: '2026-11-25T10:00:00Z', startedAt: '2026-11-25T09:40:00Z' }, ...over,
})
const tmpFile = name => path.join(process.env.FACTORY_DATA_DIR, name)

test('a delivered flow: the routing record, right first time, one QA attempt, its minutes; tokens marked missing', () => {
  const line = O.outcomeOf(passed('f1'), graph, { now: NOW })
  assert.deepEqual(line, {
    at: '2026-11-25T10:00:00.000Z', flow: 'f1', type: 'wording', size: 'small', risk: null, agent: 'Agent 2', model: 'claude-sonnet-5-5', effort: 'medium',
    followed: true, passedFirstTime: true, qaAttempts: 1, minutes: 60, delivered: true, end: 'delivered', missing: ['tokens', 'usd'],
  })
})

test('tokens and cost come from the provider when it knows them', () => {
  const line = O.outcomeOf(passed('f1'), graph, { now: NOW, flowTokens: id => (id === 'f1' ? { tokens: 12000, usd: 0.42 } : null) })
  assert.equal(line.tokens, 12000)
  assert.equal(line.usd, 0.42)
  assert.equal(line.missing, undefined)
  const broken = O.outcomeOf(passed('f1'), graph, { now: NOW, flowTokens: () => { throw new Error('x') } })
  assert.deepEqual(broken.missing, ['tokens', 'usd'])
})

test('a QA failure then a pass is not right first time; a flow stopped by QA is finished, not delivered', () => {
  const twice = passed('f2', { qa: { status: 'passed', attempt: 2, at: '2026-11-25T10:00:00Z', attempts: [{ status: 'failed', attempt: 1, at: '2026-11-25T09:30:00Z', rework: { to: 'Agent 2' } }] } })
  const l = O.outcomeOf(twice, graph, { now: NOW })
  assert.equal(l.passedFirstTime, false)
  assert.equal(l.qaAttempts, 2)
  const stopped = passed('f3', { status: 'open', qa: { status: 'qa-failed', attempt: 3, at: '2026-11-25T10:00:00Z' } })
  const s = O.outcomeOf(stopped, graph, { now: NOW })
  assert.equal(s.end, 'stopped')
  assert.equal(s.delivered, false)
  assert.equal(s.passedFirstTime, false)
})

test('dropped is finished; slipped through is finished but not delivered; on its way or stalled is no line', () => {
  assert.equal(O.outcomeOf(passed('d', { status: 'dropped', qa: undefined }), graph, { now: NOW }).end, 'dropped')
  const slipped = O.outcomeOf({ ...passed('s'), qa: undefined, output: { changes: [{ kind: 'commit', ref: 'abcdef1' }] } }, graph, { now: NOW })
  assert.equal(slipped.end, 'slipped')
  assert.equal(slipped.delivered, false)
  assert.equal(slipped.passedFirstTime, null, 'no QA: right first time cannot be told')
  assert.equal(O.outcomeOf(passed('o', { status: 'open', qa: { status: 'testing', at: '2026-11-25T11:50:00Z' } }), graph, { now: NOW }), null)
  assert.equal(O.outcomeOf(passed('st', { status: 'open', qa: undefined, updatedAt: '2026-11-01T10:00:00Z' }), graph, { now: NOW }), null)
})

test('a flow with no routing record still gets a line: its type from the title, the model not known', () => {
  const { routing: _r, ...bare } = passed('old')
  const line = O.outcomeOf(bare, graph, { now: NOW })
  assert.equal(line.type, 'wording')
  assert.equal(line.agent, 'Agent 2')
  assert.equal(line.model, null)
  assert.equal(line.followed, null)
  assert.equal(line.minutes, 60)
  assert.equal(O.outcomeOf({ ...bare, createdAt: undefined }, graph, { now: NOW }).minutes, null, 'no start: no minutes, never a guess')
})

test('recordOutcomes writes each finished flow ONCE, append-only, and lists them back', () => {
  const file = tmpFile('once.jsonl')
  const flows = [passed('a'), passed('b', { status: 'open', qa: { status: 'testing', at: '2026-11-25T11:50:00Z' } })]
  assert.equal(O.recordOutcomes({ flows, graph, now: NOW, file }), 1)
  assert.equal(O.recordOutcomes({ flows, graph, now: NOW, file }), 0, 'again: nothing new')
  flows[1] = passed('b')
  assert.equal(O.recordOutcomes({ flows, graph, now: NOW, file }), 1)
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  assert.deepEqual(O.readOutcomes(file).map(l => l.flow), ['a', 'b'])
})

test('readOutcomes skips a torn or hand-made line; listOutcomes filters by since', () => {
  const file = tmpFile('torn.jsonl')
  fs.writeFileSync(file, [JSON.stringify({ at: '2026-11-20T10:00:00.000Z', flow: 'x', type: 'docs' }), '{torn', JSON.stringify({ flow: 'no-time' }), JSON.stringify({ at: '2026-11-24T10:00:00.000Z', flow: 'y', type: 'docs' })].join('\n') + '\n')
  assert.deepEqual(O.readOutcomes(file).map(l => l.flow), ['x', 'y'])
  assert.deepEqual(O.listOutcomes({ since: '2026-11-22T00:00:00Z' }, file).map(l => l.flow), ['y'])
  assert.deepEqual(O.listOutcomes({}, file).map(l => l.flow), ['x', 'y'])
  assert.deepEqual(O.listOutcomes({ since: 'not a time' }, file).map(l => l.flow), ['x', 'y'])
  assert.deepEqual(O.listOutcomes({}, tmpFile('none.jsonl')), [])
})

test('the table: per task type and model, flows, right first time, median time and cost; Too few to trust under 5', () => {
  const mk = (flow, over) => ({ at: '2026-11-25T10:00:00.000Z', flow, type: 'wording', model: 'claude-sonnet-5-5', passedFirstTime: true, minutes: 30, usd: 0.2, ...over })
  const lines = [
    mk('1'), mk('2', { minutes: 50, usd: 0.4 }), mk('3', { passedFirstTime: false, minutes: 10 }), mk('4', { usd: undefined }), mk('5', { passedFirstTime: null }),
    mk('6', { type: 'feature', model: 'claude-opus-5-5', minutes: 120 }),
    mk('7', { type: null, model: null }),
  ]
  const t = O.outcomeTable(lines)
  assert.equal(t.recorded, 7)
  assert.equal(t.target, 100)
  const w = t.rows.find(r => r.type === 'wording')
  assert.deepEqual(w, { type: 'wording', model: 'claude-sonnet-5-5', flows: 5, right: 3, judged: 4, firstTime: 0.75, medianMinutes: 30, medianUsd: 0.2, costOf: 4, fewer: false })
  const f = t.rows.find(r => r.type === 'feature')
  assert.equal(f.fewer, true)
  const unknown = t.rows.find(r => r.type === null)
  assert.equal(unknown.model, null)
  assert.equal(t.rows[0].type, 'wording', 'most flows first')
  assert.deepEqual(O.outcomeTable([]), { rows: [], recorded: 0, target: 100 })
})
