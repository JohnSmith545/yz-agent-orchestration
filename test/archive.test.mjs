// Tests for Archive in flows.mjs: a flow's optional `archivedAt` is the USER'S field, like a tick.
// An archived flow is left out of listFlows unless asked for, an agent can neither set nor clear it
// through `flow write`, and a NEW open ask brings the flow back so archiving never hides a question.
// FACTORY_DATA_DIR points at a fresh temp folder BEFORE the import.

import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'))
const F = await import('../flows.mjs')
after(() => fs.rmSync(F.DATA_DIR, { recursive: true, force: true }))

const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'dark-mode.json'), 'utf8'))
const AT = '2026-11-14T09:00:00.000Z'
/** The fixture as flow `id`, its refs moved to that evidence folder. */
function fx(id, edit = () => {}) {
  const f = structuredClone(FIXTURE)
  f.id = id
  for (const r of f.output.result) r.ref = r.ref.replace('dark-mode/', `${id}/`)
  for (const t of f.output.testing) t.shot = t.shot.replace('dark-mode/', `${id}/`)
  edit(f)
  return f
}
const openAsks = f => f.nodes.filter(n => n.type === 'ask' && n.answer == null).length

beforeEach(() => fs.rmSync(F.FLOWS_DIR, { recursive: true, force: true }))

test('an archived flow is left out of listFlows, and is the only one with { archived: true }', () => {
  F.writeFlow(fx('kept'))
  F.writeFlow(fx('put-away', f => { f.archivedAt = AT }))
  assert.deepEqual(F.listFlows().flows.map(f => f.id), ['kept'])
  assert.deepEqual(F.listFlows({ archived: true }).flows.map(f => f.id), ['put-away'])
  assert.deepEqual(F.listFlows({ archived: true, agent: 'Agent 9' }).flows, [], 'the other filters still apply')
  assert.equal(F.readFlow('put-away').archivedAt, AT, 'still readable by id')
})

test('listFlows counts the archived flows into a tally when given one, whatever the filter, and keeps its shape', () => {
  F.writeFlow(fx('kept'))
  F.writeFlow(fx('a1', f => { f.archivedAt = AT }))
  F.writeFlow(fx('a2', f => { f.archivedAt = AT; f.agent = 'Agent 1' }))
  const tally = {}
  const r = F.listFlows({ agent: 'Agent 3' }, tally)
  assert.deepEqual(Object.keys(r), ['flows', 'invalid'])
  assert.deepEqual(tally, { archived: 2 })
})

test('flow write: the stored archivedAt is kept, and one the agent sends is ignored', () => {
  const stored = fx('dark', f => { f.archivedAt = AT })
  const incoming = fx('dark')
  delete incoming.archivedAt
  assert.equal(F.mergeKeepingAnswers(incoming, stored).archivedAt, AT, 'an agent cannot unarchive by leaving it out')
  const sneaky = fx('dark', f => { f.archivedAt = '2026-11-15T00:00:00.000Z' })
  assert.equal(F.mergeKeepingAnswers(sneaky, stored).archivedAt, AT, 'nor change it')
  const fresh = fx('dark', f => { f.archivedAt = AT })
  assert.equal('archivedAt' in F.mergeKeepingAnswers(fresh, fx('dark')), false, 'nor archive a flow the user did not')
  assert.equal('archivedAt' in F.mergeKeepingAnswers(fx('new-one', f => { f.archivedAt = AT }), null), false)
})

test('a NEW open ask brings an archived flow back; a write without one leaves it archived', () => {
  const f = fx('dark', g => { g.archivedAt = AT })
  assert.equal(openAsks(f), 1, 'the fixture has one open ask')
  F.writeFlow(f)
  const same = F.readFlow('dark')
  same.title = 'Retitled'
  F.writeFlow(same)
  assert.equal(F.readFlow('dark').archivedAt, AT, 'archiving a flow that already asks something holds')
  const more = F.readFlow('dark')
  F.addNode(more, { type: 'ask', title: 'Ship it now?', why: 'The build is green.' })
  F.writeFlow(more)
  assert.equal('archivedAt' in F.readFlow('dark'), false, 'a further ask unarchives it')
})

test('answering an ask on an archived flow keeps it archived', () => {
  const f = fx('dark', g => { g.archivedAt = AT })
  F.writeFlow(f)
  const g = F.readFlow('dark')
  F.applyAnswer(g, g.nodes.find(n => n.type === 'ask').id, 'yes')
  F.writeFlow(g)
  assert.equal(F.readFlow('dark').archivedAt, AT)
})

test('a REWORDED ask (same id, new title, its answer reset by the merge) brings an archived flow back', () => {
  F.writeFlow(fx('dark', g => { g.archivedAt = AT }))
  const stored = F.readFlow('dark')
  const incoming = structuredClone(stored)
  incoming.nodes.find(n => n.id === 'n3').title = 'Ship dark mode to stage now?'
  F.writeFlow(F.mergeKeepingAnswers(incoming, stored))
  assert.equal(openAsks(F.readFlow('dark')), 1, 'the same number of open asks')
  assert.equal('archivedAt' in F.readFlow('dark'), false, 'but a question the user has not seen')
})

test('a REPLACED ask (n3 swapped for q2) brings an archived flow back', () => {
  F.writeFlow(fx('dark', g => { g.archivedAt = AT }))
  const f = F.readFlow('dark')
  const at = f.nodes.findIndex(n => n.id === 'n3')
  f.nodes[at] = { ...f.nodes[at], id: 'q2', title: 'Ship it to stage first?' }
  for (const n of f.nodes) n.after = (n.after || []).map(a => (a === 'n3' ? 'q2' : a))
  F.writeFlow(f)
  assert.equal(openAsks(F.readFlow('dark')), 1)
  assert.equal('archivedAt' in F.readFlow('dark'), false)
})

test('an ask the user REOPENS (its answer set back to none) keeps the flow archived: the user did that', () => {
  F.writeFlow(fx('dark', g => { g.archivedAt = AT }))
  const g = F.readFlow('dark')
  F.applyAnswer(g, 'n3', 'yes')
  F.writeFlow(g)
  const h = F.readFlow('dark')
  F.applyAnswer(h, 'n3', null)
  F.writeFlow(h)
  assert.equal(F.readFlow('dark').archivedAt, AT)
})

test('validation: archivedAt is a real ISO time or absent', () => {
  assert.deepEqual(F.validateFlow(fx('dark', f => { f.archivedAt = AT })), [])
  assert.deepEqual(F.validateFlow(fx('dark', f => { f.archivedAt = '2026-11-14T09:00:00Z' })), [])
  assert.deepEqual(F.validateFlow(fx('dark', f => { f.archivedAt = '2026-11-14T09:00:00+01:00' })), [])
  for (const bad of ['', 'soon', 5, null, {}, '1', '2026', 'Nov 14 2026', '2026-13-40T99:00:00Z']) {
    assert.deepEqual(F.validateFlow(fx('dark', f => { f.archivedAt = bad })), ['archivedAt must be a time'], String(bad))
  }
})

test('{ archived: "any" } lists every live flow, archived or not: for callers that look a flow up, not show a board', () => {
  F.writeFlow(fx('seen'))
  F.writeFlow(fx('put-away', f => (f.archivedAt = AT)))
  assert.deepEqual(F.listFlows({ archived: 'any' }).flows.map(f => f.id).sort(), ['put-away', 'seen'])
  assert.deepEqual(F.listFlows().flows.map(f => f.id), ['seen'], 'the default still leaves the archived one out')
})
