// Tests for Completed in the orchestration log (score-log.mjs and GET /api/log, score-routes.mjs): completing adds ONE
// `completed` event by You at completedAt (uncompleting one `uncompleted`), with no score cell, and changes no other
// event. The default view leaves a completed flow out; the Completed filter (completed=1) shows it; a cell or kind
// filter (the scorecard's See these in the log) keeps it, so the log still adds up to the score. FACTORY_DATA_DIR
// points at a fresh temp folder BEFORE the imports.

import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'completed-log-test-'))
const F = await import('../flows.mjs')
const { CONFIG } = await import('../config.mjs')
const { pipelineGraph } = await import('../pipeline.mjs')
const { orchestrationLog, SIGN_OFF_KINDS } = await import('../score-log.mjs')
const { logGet } = await import('../score-routes.mjs')
after(() => fs.rmSync(F.DATA_DIR, { recursive: true, force: true }))
beforeEach(() => {
  fs.rmSync(F.FLOWS_DIR, { recursive: true, force: true })
  fs.mkdirSync(F.FLOWS_DIR, { recursive: true })
})

const G = pipelineGraph(CONFIG)
const DAY = 86_400_000
const NOW = Date.now()
const at = ms => new Date(NOW - ms).toISOString()
const talk = [{ id: 'n1', type: 'step', title: 'Look into it', status: 'done', evidence: [{ kind: 'note', ref: 'Fine.' }], verified: null }]
const flow = (id, more = {}) => ({ id, title: `Flow ${id}`, agent: 'Agent 1', tickets: [], status: 'done', why: '', createdAt: at(3 * DAY), updatedAt: at(2 * DAY), nodes: talk, ...more })
const SIGNED = { completedAt: at(DAY), completedBy: 'you', archivedAt: at(DAY) }
const put = f => fs.writeFileSync(path.join(F.FLOWS_DIR, `${f.id}.json`), JSON.stringify(f))
const opts = { now: NOW, days: 30, extra: [] }

test('completing adds one completed event by You at completedAt, with no cell, and changes no other event', () => {
  const plain = orchestrationLog([flow('a')], G, opts)
  const signed = orchestrationLog([flow('a', SIGNED)], G, opts)
  const extra = signed.filter(e => e.kind === 'completed')
  assert.equal(extra.length, 1)
  assert.deepEqual(extra[0], { at: SIGNED.completedAt, kind: 'completed', flow: { id: 'a', title: 'Flow a' }, agent: 'You', text: 'You marked this completed.', cell: null })
  assert.deepEqual(signed.filter(e => e.kind !== 'completed'), plain)
  assert.deepEqual(SIGN_OFF_KINDS, ['completed', 'uncompleted'])
})

test('uncompleting adds one uncompleted event by You at uncompletedAt', () => {
  const log = orchestrationLog([flow('a', { uncompletedAt: at(1000) })], G, opts)
  const e = log.find(x => x.kind === 'uncompleted')
  assert.deepEqual(e, { at: at(1000), kind: 'uncompleted', flow: { id: 'a', title: 'Flow a' }, agent: 'You', text: 'You took the completed mark off.', cell: null })
  assert.equal(log[0].kind, 'uncompleted', 'newest first')
})

test('GET /api/log: the default view leaves a completed flow out; completed=1 shows only those (and uncompleted events)', () => {
  put(flow('live'))
  put(flow('signed', SIGNED))
  put(flow('back', { uncompletedAt: at(1000) }))
  const all = logGet({}, { now: NOW, extra: [] }).body
  assert.ok(all.events.length)
  assert.ok(all.events.every(e => e.flow?.id !== 'signed'), 'no event of a completed flow')
  assert.ok(all.events.some(e => e.kind === 'uncompleted'), 'a flow put back is live again: its event shows')
  const done = logGet({ completed: '1' }, { now: NOW, extra: [] }).body
  assert.deepEqual([...new Set(done.events.map(e => e.flow.id))].sort(), ['back', 'signed'])
  assert.ok(done.events.filter(e => e.flow.id === 'back').every(e => e.kind === 'uncompleted'), 'of a live flow, only the uncompleted event')
  assert.ok(done.events.some(e => e.kind === 'completed'))
  assert.equal(done.total, done.events.length)
})

test('GET /api/log: a cell or kind filter keeps completed flows, so the log still adds up to the scorecard', () => {
  put(flow('live'))
  put(flow('signed', SIGNED))
  const delivered = logGet({ cell: 'delivered' }, { now: NOW, extra: [] }).body
  assert.deepEqual(delivered.events.map(e => e.flow.id).sort(), ['live', 'signed'])
  const kinds = logGet({ kind: 'completed' }, { now: NOW, extra: [] }).body
  assert.deepEqual(kinds.events.map(e => e.flow.id), ['signed'])
})

test('GET /api/log: completed must be 1 when given', () => {
  const r = logGet({ completed: 'yes' }, { now: NOW, extra: [] })
  assert.equal(r.status, 400)
  assert.equal(r.body.error, 'completed must be 1 when given.')
})

// ═══ the Log's Completed chip (public/pipeline-log.js, in a vm) ═══

test('the Log has a Completed chip, last, that asks for completed=1; its empty line says Nothing completed', async () => {
  const vm = await import('node:vm')
  const { fileURLToPath } = await import('node:url')
  const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
  const ctx = vm.createContext({ window: { UI: { esc: s => String(s ?? '') } } })
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'pipeline-log.js'), 'utf8'), ctx)
  const L = ctx.window.PipelineLog
  assert.equal(L.filterOf('completed'), 'completed')
  assert.equal(L.queryOf('7', 'completed'), '/api/log?days=7&completed=1')
  const chips = L.chipsHtml('completed', { roles: ['planner'] })
  assert.match(chips, /data-log-chip="completed" aria-pressed="true">Completed<\/button><\/div>$/, 'the last chip, pressed')
  assert.match(L.chipsHtml('all'), /data-log-chip="completed" aria-pressed="false">Completed</, 'on every pipeline')
  assert.match(L.listHtml({ data: { events: [], total: 0 } }, { win: '30', filter: 'completed' }), /Nothing completed in the last 30 days\./)
})
