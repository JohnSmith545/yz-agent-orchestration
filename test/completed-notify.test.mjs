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
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'completed-notify-test-'))
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

// ═══ 7. an Uncomplete raises no is-done or added-proof toast ═══

test('the pulse carries the put-away flows apart, and the notifier keeps them in its baseline without alerting', async () => {
  F.writeFlow(base('live', { status: 'open' }))
  F.writeFlow(base('signed', { completedAt: AT, completedBy: 'you', archivedAt: AT }))
  const p = await pulse({ getStatus: async () => ({}), chatStatus: () => ({}) })
  assert.deepEqual(p.flows.map(f => f.id), ['live'])
  assert.deepEqual(p.away.map(f => [f.id, f.status, f.evidence]), [['signed', 'done', 1]])
  const window = {}
  vm.runInNewContext(read('notify.js'), { window })
  const { alerts } = window.NotifyRules
  const plain = v => JSON.parse(JSON.stringify(v))
  const first = alerts(null, { waiting: [], flows: p.flows, away: p.away })
  assert.equal(first.alerts.length, 0)
  // Uncomplete: the flow comes back to the live list, done, with its proof: nothing new happened
  const back = alerts(first.flows, { waiting: [], flows: [...p.flows, ...p.away], away: [] })
  assert.deepEqual(plain(back.alerts.map(a => a.type)), [])
  // a put-away flow never alerts, even when it changes while away
  const changed = alerts(first.flows, { waiting: [], flows: p.flows, away: [{ ...p.away[0], evidence: 5 }] })
  assert.deepEqual(plain(changed.alerts.map(a => a.type)), [])
  // without the away lines (the old pulse) the same return was a false is done and added proof
  const before = alerts(alerts(null, { waiting: [], flows: p.flows }).flows, { waiting: [], flows: [...p.flows, ...p.away] })
  assert.deepEqual(plain(before.alerts.map(a => a.type)).sort(), ['done', 'proof'])
})
