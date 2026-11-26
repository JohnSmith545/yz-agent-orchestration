// Tests for routing-routes.mjs: the Routing page's data, the rule save through the config-write path (page Origin
// only, every problem in plain lines, every other byte of config.json kept), a flow's task type correction, ticket
// intake for the Tickets page with corrections, and the model sort refused while it is off. Files are temp ones.

import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-routes-test-'))
const F = await import('../flows.mjs')
const { makeRoutingRoute } = await import('../routing-routes.mjs')
const { makeRoutingReader, writeRoutingRules } = await import('../routing-config.mjs')
const { STATE_FILE } = await import('../factory-state.mjs')
const { DEFAULT_RULES } = await import('../routing-rules.mjs')
after(() => fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true }))

const PORT = 4999
const ORIGIN = `http://127.0.0.1:${PORT}`
const CONFIG = {
  repo: 'C:/r', coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 2': 'Agent 2' }, pipeline: { qa: 'QA', producers: null, protectedBranches: ['dev'], maxReworks: 2 },
}
let configFile
let route
const TICKETS = [
  { id: 'FLA-1', title: 'Fix a typo on the sign-up page', state: 'Unstarted', labels: [], type: 'bug' },
  { id: 'FLA-2', title: 'Cloud Hosting: Billing account linked', state: 'Unstarted', labels: [], type: 'chore' },
  { id: 'FLA-3', title: 'Comments do not load on the activity feed', state: 'Unstarted', labels: [], type: 'bug' },
  { id: 'FLA-4', title: 'Comments not loading on activity feed', state: 'Unstarted', labels: [], type: 'bug' },
  { id: 'FLA-5', title: 'Things', state: 'Unstarted', labels: [], type: 'chore' },
]

beforeEach(() => {
  configFile = path.join(process.env.FACTORY_DATA_DIR, `config-${Math.random().toString(36).slice(2)}.json`)
  fs.writeFileSync(configFile, '{\n  "repo": "C:/r",\n  "port": 4999\n}\n')
  fs.rmSync(STATE_FILE, { force: true })
  fs.rmSync(F.FLOWS_DIR, { recursive: true, force: true })
  route = makeRoutingRoute({ port: PORT, config: CONFIG, configFile, reader: makeRoutingReader(configFile, { warn: () => {} }), tickets: () => TICKETS, outcomesFile: path.join(process.env.FACTORY_DATA_DIR, 'out.jsonl') })
})

/** One request through the route: { status, body }. */
async function call(method, url, body, origin = ORIGIN) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
  Object.assign(req, { method, headers: origin ? { origin } : {} })
  let status = 0
  let text = ''
  const res = { writeHead: s => (status = s), end: t => (text = t) }
  const handled = await route(req, res, new URL(url, ORIGIN))
  return handled ? { status, body: JSON.parse(text) } : null
}

test('GET /api/routing: the default rules, the lists the page needs, the table and the 100 target', async () => {
  const r = await call('GET', '/api/routing')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.rules, JSON.parse(JSON.stringify(DEFAULT_RULES)))
  assert.equal(r.body.custom, false)
  assert.equal(r.body.intakeModel, null)
  assert.ok(r.body.types.includes('wording'))
  assert.deepEqual(r.body.table, { rows: [], recorded: 0, target: 100 })
  assert.ok(r.body.agents.some(a => a.label === 'Agent 2'))
  assert.equal(await call('GET', '/api/other'), null, 'not ours: left to the next route')
})

test('PUT /api/routing/rules writes config.json routing.rules through config-write, keeping the rest', async () => {
  const rules = [{ when: { type: 'docs' }, agent: 'Agent 2', model: 'claude-sonnet-5-5', effort: 'low', why: 'docs are easy' }]
  const r = await call('PUT', '/api/routing/rules', { rules })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.rules, rules)
  assert.equal(r.body.custom, true)
  const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  assert.deepEqual(saved, { repo: 'C:/r', port: 4999, routing: { rules } })
  assert.match(fs.readFileSync(configFile, 'utf8'), /^\{\n  "repo": "C:\/r",\n  "port": 4999,/)
  // a second save replaces the rules in place
  await call('PUT', '/api/routing/rules', { rules: [{ when: {}, effort: 'high', why: 'always think hard' }] })
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).routing.rules.length, 1)
})

test('PUT /api/routing/rules: a bad rule is 400 with every problem, and nothing is written', async () => {
  const before = fs.readFileSync(configFile, 'utf8')
  const r = await call('PUT', '/api/routing/rules', { rules: [{ when: { type: 'poems' }, why: '' }] })
  assert.equal(r.status, 400)
  assert.ok(r.body.problems.length >= 2)
  assert.equal(fs.readFileSync(configFile, 'utf8'), before)
})

test('every write needs the page Origin, never a missing one', async () => {
  assert.equal((await call('PUT', '/api/routing/rules', { rules: [] }, null)).status, 403)
  assert.equal((await call('PUT', '/api/routing/rules', { rules: [] }, 'http://evil.example')).status, 403)
  assert.equal((await call('POST', '/api/routing/tickets/FLA-1', { kind: 'code' }, null)).status, 403)
})

test('writeRoutingRules adds a routing block when there is none, else replaces the rules in place', () => {
  const f = path.join(process.env.FACTORY_DATA_DIR, 'w.json')
  fs.writeFileSync(f, '{\n  "repo": "x",\n  "routing": { "intakeModel": "claude-haiku-5-5" }\n}\n')
  writeRoutingRules(f, [{ when: {}, effort: 'low', why: 'w' }])
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')).routing, { intakeModel: 'claude-haiku-5-5', rules: [{ when: {}, effort: 'low', why: 'w' }] })
})

test('POST /api/routing/flows/<id>: the user corrects a flow task type; bad ids and types are refused', async () => {
  F.createFlow({ id: 'typo', title: 'Fix a typo', agent: 'Agent 2', route: { type: 'ask', steps: ['request', 'master', 'outcome'], at: '2026-11-25T10:00:00Z', by: 'Agent 2' } })
  const r = await call('POST', '/api/routing/flows/typo', { type: 'docs' })
  assert.equal(r.status, 200)
  assert.equal(F.readFlow('typo').routing.type, 'docs')
  assert.equal(F.readFlow('typo').routing.typeBy, 'you')
  assert.equal((await call('POST', '/api/routing/flows/Bad..', { type: 'docs' })).status, 400)
  assert.equal((await call('POST', '/api/routing/flows/none', { type: 'docs' })).status, 404)
  assert.equal((await call('POST', '/api/routing/flows/typo', { type: 'poems' })).status, 400)
  const listed = await call('GET', '/api/routing')
  assert.equal(listed.body.flows[0].id, 'typo')
})

test('GET /api/routing/tickets: kind, task type, suggestion and duplicate per ticket, with counts', async () => {
  const r = await call('GET', '/api/routing/tickets')
  assert.equal(r.status, 200)
  const t = r.body.tickets
  assert.equal(t['FLA-1'].kind, 'code')
  assert.equal(t['FLA-1'].type, 'wording')
  assert.match(t['FLA-1'].suggestion, /^Suggested: Sonnet 5\.5, medium effort/)
  assert.equal(t['FLA-2'].kind, 'needs-a-person')
  assert.equal(t['FLA-4'].duplicate.of, 'FLA-3')
  assert.equal(t['FLA-5'].confidence, 'unsure')
  assert.equal(r.body.counts.unsure >= 1, true)
  assert.deepEqual(r.body.model, { on: false, model: null, running: false, unsure: r.body.model.unsure })
})

test('POST /api/routing/tickets/<ID>: corrections win and not-a-duplicate is remembered', async () => {
  assert.equal((await call('POST', '/api/routing/tickets/FLA-1', { kind: 'no-code' })).body.ticket.by, 'you')
  await call('POST', '/api/routing/tickets/FLA-1', { type: 'docs' })
  await call('POST', '/api/routing/tickets/FLA-4', { notDuplicateOf: 'FLA-3' })
  const t = (await call('GET', '/api/routing/tickets')).body.tickets
  assert.equal(t['FLA-1'].kind, 'no-code')
  assert.equal(t['FLA-1'].type, 'docs')
  assert.equal(t['FLA-1'].typeBy, 'you')
  assert.equal(t['FLA-4'].duplicate, undefined)
  assert.equal((await call('POST', '/api/routing/tickets/fla-1', { kind: 'code' })).status, 400)
  assert.equal((await call('POST', '/api/routing/tickets/FLA-1', {})).status, 400)
  assert.equal((await call('POST', '/api/routing/tickets/FLA-1', { kind: 'maybe' })).status, 400)
})

test('the model sort is refused while it is off, and runs the unsure tickets once it is on', async () => {
  const off = await call('POST', '/api/routing/intake/run')
  assert.equal(off.status, 400)
  assert.match(off.body.error, /routing\.intakeModel/)
  const asked = []
  fs.writeFileSync(configFile, JSON.stringify({ repo: 'C:/r', routing: { intakeModel: 'claude-haiku-5-5' } }))
  route = makeRoutingRoute({ port: PORT, config: CONFIG, configFile, reader: makeRoutingReader(configFile, { warn: () => {} }), tickets: () => TICKETS,
    runner: { running: () => false, run: async (list, model) => (asked.push({ ids: list.map(t => t.id), model }), { ok: true, sorted: 1, asked: list.length, cost: 0.001 }) } })
  const on = await call('POST', '/api/routing/intake/run')
  assert.equal(on.status, 200)
  assert.deepEqual(asked, [{ ids: ['FLA-5'], model: 'claude-haiku-5-5' }])
})
