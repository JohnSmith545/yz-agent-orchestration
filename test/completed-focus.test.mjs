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
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'completed-focus-test-'))
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

// ═══ 3. focus after Mark all completed ═══

test('after a press, focus goes to a stable place in the same part of the page', () => {
  const C = browser()
  const at = scopes => ({ closest: sel => (scopes.some(s => sel.split(', ').includes(s)) ? { scope: scopes[0] } : null) })
  assert.equal(C.focusAfter(at(['.pl-panel']))[1], '[data-mode="outputs"]', 'the heading of the list: never redrawn')
  assert.equal(C.focusAfter(at(['#drawer']))[1], '#fcInput')
  assert.equal(C.focusAfter(at(['.fl-open']))[1], '.fl-readonly a, .fl-tabs [aria-selected="true"]')
  assert.equal(C.focusAfter(at([])), null)
})
