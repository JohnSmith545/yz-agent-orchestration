// Tests for public/predict-group.js: how alerts are grouped, counted and put in words, ONE file for the desktop Alerts
// line (predict-view.js, in the browser) and the phone's Agents tab (phone-orchestration.mjs, on the server, which
// imports the same file). QA (2026-11-26): the phone said 10 alerts where the desktop said 3 for the same data,
// because the desktop groups an agent's Taking long alerts and the phone did not. Now both use groupAlerts and
// lineOf, and these tests check that they give the same count and the same first lines.

import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'predict-group-test-'))
const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = f => fs.readFileSync(path.join(HERE, '..', f), 'utf8')
const F = await import('../flows.mjs')
const O = await import('../phone-orchestration.mjs')

/** The desktop as the page loads it: predict-group.js, then predict-view.js. */
const ctx = vm.createContext({ window: {} })
vm.runInContext(read('public/predict-group.js'), ctx)
vm.runInContext(read('public/predict-view.js'), ctx)
const G = ctx.window.PredictGroup
const V = ctx.window.PredictView
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

const stuck = (n, agent, more = {}) => ({ kind: 'stuck', key: `stuck:${agent}:${n}`, agent, flow: `f-${agent}-${n}`.toLowerCase().replace(/\s/g, '-'), text: `Flow ${n} has stood at ${agent} for 3 hours, about 4 times its usual.`, ...more })
// QA's case: Master holds 8 flows longer than usual, one other flow far past its time, one session re-reading
const ALERTS = [
  ...Array.from({ length: 8 }, (_, i) => stuck(i + 1, 'Master')),
  stuck(9, 'Agent 2'),
  { kind: 'context', key: 'ctx:s1', agent: 'Agent 3', text: 'Agent 3 re-reads a large history on every turn.' },
]
const PIPE = { qa: 'QA', producers: null, protectedBranches: ['dev', 'main'], maxReworks: 3 }
const CONFIG = { coordinator: 'Coordinator', coordinatorLabel: 'Master', codingAgents: { 'Agent 1': 'Agent 1' }, pipeline: PIPE }
const phone = alerts => O.makeOrchestration({ config: CONFIG, getStatus: async () => ({ agents: [] }), alerts: async () => ({ status: 200, body: { enabled: true, alerts } }) })

beforeEach(() => {
  fs.rmSync(F.FLOWS_DIR, { recursive: true, force: true })
  fs.mkdirSync(F.FLOWS_DIR, { recursive: true })
})

test('the desktop line and the phone give the same count for a grouped case: 3 alerts, not 10', async () => {
  const desk = text(V.lineHtml({ enabled: true, alerts: ALERTS }))
  assert.match(desk, /^3 alerts /)
  const { body } = await phone(ALERTS).orchestration()
  assert.equal(body.alerts.count, 3)
  assert.equal(body.alerts.count, G.groupAlerts(ALERTS).length)
})

test('and the same first lines, in the same order, as the rows under the desktop line', async () => {
  const { body } = await phone(ALERTS).orchestration()
  assert.deepEqual(body.alerts.lines, ['Master holds 8 flows longer than usual for their step.', ALERTS[8].text])
  const rows = text(V.listHtml({ enabled: true, alerts: ALERTS }))
  for (const line of body.alerts.lines) assert.ok(rows.includes(line), line)
  assert.ok(rows.indexOf(body.alerts.lines[0]) < rows.indexOf(body.alerts.lines[1]), 'same order')
  assert.equal(body.alerts.kinds, G.kindsText(G.groupAlerts(ALERTS)), 'the kinds in words, as the desktop line has them')
})

test('under three of one agent nothing groups, and Waiting on you is never grouped: the same on both', async () => {
  const few = [stuck(1, 'Master'), stuck(2, 'Master'), stuck(3, 'QA', { onYou: true }), stuck(4, 'QA', { onYou: true }), stuck(5, 'QA', { onYou: true })]
  const { body } = await phone(few).orchestration()
  assert.equal(body.alerts.count, 5)
  assert.match(text(V.lineHtml({ enabled: true, alerts: few })), /^5 alerts /)
})

test('one file: the server imports public/predict-group.js itself, and the page loads it before predict-view.js', () => {
  assert.match(read('phone-orchestration.mjs'), /import '\.\/public\/predict-group\.js'/)
  assert.match(read('public/predict-view.js'), /window\.PredictGroup/)
  assert.doesNotMatch(read('public/predict-view.js'), /function groupAlerts/, 'no second copy on the page')
  const html = read('public/index.html')
  assert.ok(html.indexOf('<script src="predict-group.js"></script>') > 0)
  assert.ok(html.indexOf('<script src="predict-group.js"></script>') < html.indexOf('<script src="predict-view.js"></script>'))
  assert.match(read('package.json'), /node --check public\/predict-group\.js/)
})
