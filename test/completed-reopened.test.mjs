// Tests for the QA findings on Completed: the Sign-off block leaves once the flow is completed (the Output tab redraws
// on completedAt and archivedAt), a new question that reopens a completed flow is a sign-off entry of its own (by the
// agent, never the user) with its own Log line, focus stays in the list after Mark all completed, the Output list
// leaves room above the toast stack, the confirm question uses its width, one overdue wording, and an Uncomplete
// raises no is-done or added-proof toast (the pulse carries the put-away flows, so the notifier knows them).
// FACTORY_DATA_DIR points at a fresh temp folder BEFORE the imports.

import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, '..', 'public')
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8')
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'completed-reopened-test-'))
const F = await import('../flows.mjs')
const { CONFIG } = await import('../config.mjs')
const { pipelineGraph } = await import('../pipeline.mjs')
const { orchestrationLog } = await import('../score-log.mjs')
const { pulse } = await import('../orchestration.mjs')
const { applyComplete, validateSignoff } = await import('../completed.mjs')
after(() => fs.rmSync(F.DATA_DIR, { recursive: true, force: true }))
beforeEach(() => fs.rmSync(F.FLOWS_DIR, { recursive: true, force: true }))

const AT = '2026-11-20T09:00:00.000Z'
const talk = [{ id: 'n1', type: 'step', title: 'Look into it', status: 'done', evidence: [{ kind: 'note', ref: 'Fine.' }], verified: null }]
const base = (id, more = {}) => ({ id, title: `Flow ${id}`, agent: 'Agent 3', tickets: [], status: 'done', why: '', createdAt: AT, updatedAt: AT, nodes: structuredClone(talk), ...more })
const browser = () => {
  const ctx = vm.createContext({ window: {} })
  vm.runInContext(read('completed-view.js'), ctx)
  return ctx.window.CompletedView
}

// ═══ 2. a new question that reopens a completed flow ═══

test('a new question that reopens a completed flow adds a reopened entry by the agent, never by you', () => {
  const f = base('ship')
  applyComplete(f, true, Date.parse(AT))
  F.writeFlow(f, { stamp: false })
  const g = F.readFlow('ship')
  F.addNode(g, { type: 'ask', title: 'Ship it now?', why: 'The build is green.' })
  F.writeFlow(g)
  const h = F.readFlow('ship')
  assert.equal(h.completedAt, undefined)
  assert.deepEqual(h.signoff.map(e => [e.did, e.by]), [['completed', undefined], ['reopened', 'Agent 3']])
  assert.ok(Date.parse(h.signoff[1].at) > Date.parse(AT))
  const k = F.readFlow('ship')
  k.title = 'Retitled'
  F.writeFlow(k)
  assert.equal(F.readFlow('ship').signoff.length, 2, 'only a write that reopens it adds one')
})

test('a new question on an archived flow never completed adds no sign-off entry', () => {
  F.writeFlow(base('away', { archivedAt: AT }))
  const g = F.readFlow('away')
  F.addNode(g, { type: 'ask', title: 'Ship it now?', why: 'The build is green.' })
  F.writeFlow(g)
  assert.equal(F.readFlow('away').signoff, undefined)
})

test('a reopened entry validates with its agent label, and is its own Log line', () => {
  const isTime = v => !Number.isNaN(Date.parse(v))
  assert.deepEqual(validateSignoff([{ at: AT, did: 'reopened', by: 'Agent 3' }], isTime), [])
  assert.deepEqual(validateSignoff([{ at: AT, did: 'reopened', by: 'You' }], isTime), ['signoff #1 by must be the agent label, never You'])
  assert.deepEqual(validateSignoff([{ at: AT, did: 'completed', by: 'Agent 3' }], isTime), ['signoff #1 by is only for reopened'])
  const signoff = [{ at: '2026-11-20T09:00:00.000Z', did: 'completed' }, { at: '2026-11-20T10:00:00.000Z', did: 'reopened', by: 'Agent 3' }]
  const log = orchestrationLog([base('ship', { signoff })], pipelineGraph(CONFIG), { now: Date.parse('2026-11-21T00:00:00.000Z'), days: 30, extra: [] })
  const e = log.find(x => x.kind === 'reopened')
  assert.deepEqual(e, { at: '2026-11-20T10:00:00.000Z', kind: 'reopened', flow: { id: 'ship', title: 'Flow ship' }, agent: 'Agent 3', text: 'A question from Agent 3 reopened this.', cell: null })
})
