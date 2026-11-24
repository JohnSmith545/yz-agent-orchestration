// Tests for the Log's filters once the planner and Security are on the pipeline (public/pipeline-log.js): the Plans
// and Security chips show only when the graph has those agents, query their own log kinds, and say a plain empty
// line; with neither the chips are exactly as before. Also the stage word Security's review shows as.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = f => fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8')
const ctx = vm.createContext({ window: {} })
for (const f of ['shell.js', 'app.js', 'pipeline-tickets.js', 'pipeline-log.js']) vm.runInContext(read(f), ctx)
const L = ctx.window.PipelineLog
const T = ctx.window.PipelineTickets

test('the Plans and Security chips show only with those agents on the graph', () => {
  const none = L.chipsHtml('all')
  assert.equal(L.chipsHtml('all', { roles: ['coordinator', 'producer', 'qa'] }), none, 'without them: as before')
  assert.doesNotMatch(none, /data-log-chip="(planned|security)"/)
  const both = L.chipsHtml('security', { roles: ['coordinator', 'planner', 'qa', 'security'] })
  assert.match(both, /data-log-chip="rule" aria-pressed="false">Rules<\/button><button type="button" data-log-chip="planned" aria-pressed="false">Plans<\/button><button type="button" data-log-chip="security" aria-pressed="true">Security<\/button>/)
  assert.doesNotMatch(L.chipsHtml('all', { roles: ['security'] }), /Plans/)
})

test('their queries ask for their own kinds, and an empty list says so plainly', () => {
  assert.equal(L.filterOf('planned'), 'planned')
  assert.equal(L.filterOf('security'), 'security')
  assert.equal(L.queryOf('7', 'security'), '/api/log?days=7&kind=security')
  assert.equal(L.queryOf('all', 'planned'), '/api/log?days=all&kind=planned')
  const empty = { data: { events: [], total: 0 } }
  assert.match(L.listHtml(empty, { filter: 'security' }), /No Security verdicts in the last 30 days\./)
  assert.match(L.listHtml(empty, { filter: 'planned', win: '7' }), /No plans handed out in the last 7 days\./)
})

test('a flow Security is reviewing reads Being reviewed', () => {
  assert.equal(T.word({ stage: { node: 'security', status: 'reviewing' } }), 'Being reviewed')
})
