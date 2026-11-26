// Tests for phone-orchestration.mjs: the orchestration on the phone, READ ONLY, built from the desktop's own functions
// (pipeline-routes.mjs pipelineGet, pipeline.mjs stageOf, flow-route.mjs withRoute) and trimmed to what the phone
// shows: the boxes in route order with each agent's state and the flows standing there, the alerts in two lines,
// the open pull requests, and one flow's sheet. FACTORY_DATA_DIR points at a temp folder BEFORE the imports.

import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-orch-test-'))
const F = await import('../flows.mjs')
const O = await import('../phone-orchestration.mjs')

const DAY = 86_400_000
const ago = d => new Date(Date.now() - d * DAY).toISOString()
const PIPE = { qa: 'QA', producers: null, protectedBranches: ['dev', 'main'], maxReworks: 3 }
const PLAIN = { coordinator: 'Coordinator', coordinatorLabel: 'Master', codingAgents: { 'Agent 1': 'Agent 1', 'Agent 2': 'Agent 2', 'Agent 3': 'Agent 3' }, pipeline: PIPE }
const FULL = { ...PLAIN, codingAgents: { ...PLAIN.codingAgents, p: 'Planner', s: 'Security', o: 'Senior' }, pipeline: { ...PIPE, planner: 'Planner', security: 'Security', senior: 'Senior' } }

function put(id, more = {}) {
  const flow = {
    id, title: `Flow ${id}`, agent: 'Agent 1', tickets: [], status: 'open', why: '', createdAt: ago(2), updatedAt: ago(0.1),
    nodes: [{ id: 'n1', type: 'step', title: 'Look into it', status: 'doing', evidence: [], verified: null }], ...more,
  }
  fs.writeFileSync(path.join(F.FLOWS_DIR, `${id}.json`), JSON.stringify(flow, null, 1))
}
const make = (o = {}) => O.makeOrchestration({ config: PLAIN, getStatus: async () => ({ agents: [] }), alerts: async () => ({ status: 200, body: { enabled: true, alerts: [] } }), ...o })
const box = (body, label) => body.boxes.find(b => b.label === label)

beforeEach(() => {
  fs.rmSync(F.FLOWS_DIR, { recursive: true, force: true })
  fs.mkdirSync(F.FLOWS_DIR, { recursive: true })
})

// ═══ the boxes ═══

test('the boxes in route order, only those the config draws: without Planner, Security and Senior', async () => {
  const { status, body } = await make().orchestration()
  assert.equal(status, 200)
  assert.deepEqual(body.boxes.map(b => b.label), ['Request', 'Master', 'Agent 1', 'Agent 2', 'Agent 3', 'QA', 'Human task', 'Push', 'Output'])
})

test('the boxes in route order with Planner, Security and Senior', async () => {
  const { body } = await make({ config: FULL }).orchestration()
  assert.deepEqual(body.boxes.map(b => b.label), ['Request', 'Master', 'Planner', 'Agent 1', 'Agent 2', 'Agent 3', 'QA', 'Security', 'Human task', 'Senior', 'Push', 'Output'])
})

test('each agent box says busy, idle or no session; the fixed steps say nothing; other sessions are listed apart', async () => {
  const agents = [{ label: 'Agent 1', state: 'active', status: 'busy' }, { label: 'QA', state: 'idle', status: 'idle' }, { label: 'Helper', state: 'idle' }, { label: '3f2a9c1e-7b4d-4e21-9a0b-6c5d4e3f2a1b', state: 'idle' }]
  const { body } = await make({ getStatus: async () => ({ agents }) }).orchestration()
  assert.equal(body.agentsKnown, true)
  assert.equal(box(body, 'Agent 1').state, 'busy')
  assert.equal(box(body, 'QA').state, 'idle')
  assert.equal(box(body, 'Agent 2').state, 'none')
  assert.equal(box(body, 'Master').state, 'none')
  for (const step of ['Request', 'Human task', 'Push', 'Output']) assert.equal(box(body, step).state, null, step)
  assert.deepEqual(body.others, [{ label: 'Helper', state: 'idle' }, { label: 'Unnamed session', state: 'idle' }])
})

test('a cold status build does not hold the tab: the states are unknown and the rest comes at once', async () => {
  const started = Date.now()
  const { body } = await make({ getStatus: () => new Promise(() => {}), agentsWaitMs: 50 }).orchestration()
  assert.ok(Date.now() - started < 2000)
  assert.equal(body.agentsKnown, false)
  assert.equal(box(body, 'Agent 1').state, null)
  const broken = await make({ getStatus: async () => { throw new Error('git broke') } }).orchestration()
  assert.equal(broken.body.agentsKnown, false)
})

// ═══ the chips ═══

test('the flows standing at each box are its chips: archived and completed ones are not; a long title is cut', async () => {
  put('build', { title: 'Login page' })
  put('asking', { agent: 'Agent 2', status: 'blocked', nodes: [{ id: 'a1', type: 'ask', title: 'Ship it?', why: '', kind: 'yesno', yes: '', no: '', answer: null, at: ago(0.1) }] })
  put('long', { title: 'x'.repeat(200) })
  put('away', { archivedAt: ago(0.05) })
  put('signed', { status: 'done', completedAt: ago(0.05), archivedAt: ago(0.05), completedBy: 'you' })
  const { body } = await make().orchestration()
  const a1 = box(body, 'Agent 1').flows
  assert.deepEqual(a1.map(f => f.id).sort(), ['build', 'long'])
  assert.equal(a1.find(f => f.id === 'build').word, 'Working')
  assert.ok(a1.find(f => f.id === 'long').title.length <= O.CHIP_TITLE_MAX + 1)
  assert.ok(a1.find(f => f.id === 'long').title.endsWith('…'))
  assert.deepEqual(box(body, 'Agent 2').flows.map(f => [f.id, f.word]), [['asking', 'Blocked']])
  assert.equal(JSON.stringify(body).includes('away'), false)
  assert.equal(JSON.stringify(body).includes('signed'), false)
})

test('at most CHIPS_MAX chips per box, and how many more', async () => {
  for (let i = 0; i < O.CHIPS_MAX + 3; i++) put(`f${i}`)
  const { body } = await make().orchestration()
  assert.equal(box(body, 'Agent 1').flows.length, O.CHIPS_MAX)
  assert.equal(box(body, 'Agent 1').more, 3)
})

// ═══ alerts and pull requests ═══

test('the alerts: the count and the first two in one line each; none when off or when they cannot be read', async () => {
  const alerts = [{ text: 'Login page has stood at QA for 3 hours, about 4 times its usual.' }, { text: 'Agent 2 used tokens fast in the last hour.' }, { text: 'Third.' }]
  const { body } = await make({ alerts: async () => ({ status: 200, body: { enabled: true, alerts } }) }).orchestration()
  assert.deepEqual(body.alerts, { count: 3, lines: [alerts[0].text, alerts[1].text] })
  assert.equal((await make({ alerts: async () => ({ status: 200, body: { enabled: false, alerts: [] } }) }).orchestration()).body.alerts, null)
  assert.equal((await make({ alerts: async () => { throw new Error('x') } }).orchestration()).body.alerts, null)
  const long = await make({ alerts: async () => ({ status: 200, body: { enabled: true, alerts: [{ text: 'y'.repeat(500) }] } }) }).orchestration()
  assert.ok(long.body.alerts.lines[0].length <= O.ALERT_LINE_MAX + 1)
})

test('the open pull requests: only open ones, only github.com addresses, titles only', async () => {
  put('open-pr', { status: 'done', output: { pr: { url: 'https://github.com/o/r/pull/12', number: 12, state: 'open' }, merge: { title: 'Add the login page', head: 'feat/login', base: 'dev', body: 'The login page.' } } })
  put('merged-pr', { status: 'done', output: { pr: { url: 'https://github.com/o/r/pull/11', number: 11, state: 'merged' } } })
  put('odd-pr', { status: 'done', output: { pr: { url: 'javascript:alert(1)//github.com/o/r/pull/1', number: 1, state: 'open' } } })
  put('elsewhere', { status: 'done', output: { pr: { url: 'https://gitlab.example/o/r/pull/3', number: 3, state: 'open' } } })
  const { body } = await make().orchestration()
  assert.deepEqual(body.prs, [{ title: 'Add the login page', url: 'https://github.com/o/r/pull/12', number: 12 }])
})

// ═══ the flow sheet ═══

test('the sheet refuses a bad id before any lookup, and a missing, deleted, archived or completed flow', async () => {
  put('away', { archivedAt: ago(0.05) })
  put('signed', { status: 'done', completedAt: ago(0.05), archivedAt: ago(0.05), completedBy: 'you' })
  const o = make()
  for (const id of ['../config', 'A', '', 'a/b', 'x'.repeat(81), 42, null, undefined, ['build']]) {
    const r = await o.flow({ id })
    assert.equal(r.status, 400, JSON.stringify(id))
    assert.equal(typeof r.body.error, 'string')
  }
  assert.equal((await o.flow(null)).status, 400)
  assert.equal((await o.flow({ id: 'nope' })).status, 404)
  for (const id of ['away', 'signed']) {
    const r = await o.flow({ id })
    assert.equal(r.status, 404, id)
    assert.match(r.body.error, /archive/)
  }
})

test('the sheet: title, tickets, where it stands, its route line, story, last QA verdict, open questions, pull request', async () => {
  put('build', {
    title: 'Login page', tickets: ['FLA-12'], status: 'blocked',
    nodes: [{ id: 'a1', type: 'ask', title: 'Ship it?', why: 'QA passed.', kind: 'yesno', yes: 'it goes', no: 'it waits', answer: null, at: ago(0.1) },
      { id: 'a2', type: 'ask', title: 'Old one?', why: '', kind: 'yesno', yes: '', no: '', answer: 'yes', at: ago(0.2) }],
    qa: { status: 'failed', attempt: 2, at: ago(0.05), by: 'QA', summary: 'The button does nothing.', rework: { to: 'Agent 1' } },
    output: { story: [{ id: 's1', who: 'Agent 1', did: 'Built the page.', why: 'You asked.' }], pr: { url: 'https://github.com/o/r/pull/12', number: 12, state: 'open' } },
  })
  const { status, body } = await make().flow({ id: 'build' })
  assert.equal(status, 200)
  assert.equal(body.title, 'Login page')
  assert.deepEqual(body.tickets, ['FLA-12'])
  assert.match(body.where, /Sent back at Agent 1/)
  assert.ok(body.route.length >= 4)
  assert.deepEqual(body.route.map(s => s.label).slice(0, 2), ['Request', 'Master'])
  assert.ok(body.route.every(s => ['done', 'current', 'upcoming', 'skipped'].includes(s.state)))
  assert.deepEqual(body.story, [{ who: 'Agent 1', did: 'Built the page.', why: 'You asked.' }])
  assert.deepEqual(body.qa, { word: 'Failed', attempt: 2, at: body.qa.at, summary: 'The button does nothing.' })
  assert.deepEqual(body.asks.map(a => [a.flowId, a.nodeId, a.question, a.kind]), [['build', 'a1', 'Ship it?', 'yesno']])
  assert.deepEqual(body.pr, { url: 'https://github.com/o/r/pull/12', number: 12, state: 'open' })
})

test('a finished or dropped flow shows no open question (the answer action would refuse it)', async () => {
  const ask = { id: 'a1', type: 'ask', title: 'Ship it?', why: '', kind: 'yesno', yes: '', no: '', answer: null, at: ago(0.1) }
  put('done1', { status: 'done', nodes: [ask] })
  put('drop1', { status: 'dropped', nodes: [ask] })
  for (const id of ['done1', 'drop1']) assert.deepEqual((await make().flow({ id })).body.asks, [], id)
  assert.equal((await make().flow({ id: 'drop1' })).body.where, 'Dropped')
})
