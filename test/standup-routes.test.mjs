// Tests for the Standup creator's routes (standup-routes.mjs) and their archive (standup-archive.mjs, its own tests in standup-archive.test.mjs):
//   POST /api/standup/generate { mode }   the Origin rule, the mode check, one run at a time (409), and the NDJSON
//                                         order: ONE facts line, the deltas, ONE done or error line with the run id
//   GET  /api/standup/log                 today's runs, today's stand-up of each mode, and the two windows
//   GET  /api/standup/days, /day/<day>, /ticket/<id>   the Date archive and the ticket log, ids and days checked first
// A real http server on port 0 calls the route with a STUB generate and STUB facts: no Claude turn and no git ever
// runs. FACTORY_DATA_DIR points at a temp folder BEFORE the import, so the log never touches data/.

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'standup-routes-test-'))
process.env.FACTORY_DATA_DIR = TMP
const { makeStandupRoute, standupTurn } = await import('../standup-routes.mjs')
const A = await import('../standup-archive.mjs')
const { systemPrompt } = await import('../standup-prompt.mjs')
const { factsText } = await import('../standup-text.mjs')
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const NOW = new Date(2026, 10, 25, 10, 12) // Wednesday
const DIR = path.join(TMP, 'standup')
const LINK = id => `https://x/${id}`

let runs = []
function stubGenerate(text, opts) {
  let finish
  const run = { text, opts, cancelled: 0, done: new Promise(r => (finish = r)) }
  run.end = out => finish(out)
  run.cancel = () => {
    run.cancelled++
    finish({ error: 'Stopped.', cancelled: true })
  }
  runs.push(run)
  return { done: run.done, cancel: run.cancel }
}

/** Facts as standup-facts.mjs makes them, for whatever window the route asks for. */
let gathered = []
async function stubFacts(window) {
  gathered.push(window)
  return {
    mode: window.mode, window, author: 'Yz31LL', name: 'Yz31LL', project: 'flinki-v2', base: 'origin/dev',
    commits: [{ sha: 'c1', at: window.to, branch: 'fix/fla-1', subject: 'fix: a thing', ids: ['FLA-1'] }], merges: [], unmerged: [],
    tickets: [{ id: 'FLA-1', title: 'A thing', state: 'Started', mine: true, known: true, link: 'https://x/FLA-1', line: 'FLA-1: A thing — https://x/FLA-1' }],
    next: [], flows: [], waiting: [], ticketListAt: new Date(2026, 10, 12, 9).toISOString(), skipped: [{ title: 'Flows', why: 'The flows could not be read.' }], builtAt: window.to,
  }
}

let server
let base
let port
before(async () => {
  let route
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (!(await route(req, res, url))) res.writeHead(404).end('not found')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  port = server.address().port
  route = makeStandupRoute({ port, generate: stubGenerate, facts: stubFacts, log: e => A.appendRun(e, DIR), dir: DIR, now: () => NOW, ticketListAt: () => '2026-11-12T09:00:00.000Z', prefixes: () => ['FLA'], linkOf: LINK })
  base = `http://127.0.0.1:${port}`
})
after(() => server.close())
beforeEach(async () => {
  await new Promise(r => setTimeout(r, 30)) // a run the last test ended writes its log entry just after its response
  runs = []
  gathered = []
  fs.rmSync(DIR, { recursive: true, force: true })
})

const post = (body, headers = {}) => fetch(`${base}/api/standup/generate`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })
const lines = text => text.split('\n').filter(Boolean).map(l => JSON.parse(l))
const until = async cond => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise(r => setTimeout(r, 5))
  assert.ok(cond(), 'timed out waiting')
}
const logged = async n => {
  await until(() => A.readDay('2026-11-25', DIR).length === n)
  return A.readDay('2026-11-25', DIR)
}

// ═══ POST /api/standup/generate ═══

test('a daily run: ONE facts line, the deltas, then ONE done line with the run id; the model gets the facts text', async () => {
  const pending = post({ mode: 'daily' })
  await until(() => runs.length === 1)
  runs[0].opts.onDelta('Stand up, Tue 24 Nov\n')
  runs[0].opts.onDelta('- FLA-1: A thing — https://x/FLA-1')
  runs[0].end({ ok: true, stopReason: 'end_turn', cost: 0.06 })
  const res = await pending
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /^application\/x-ndjson/)
  const got = lines(await res.text())
  assert.deepEqual(got.map(l => l.type), ['facts', 'delta', 'delta', 'done'])
  const facts = got[0]
  assert.equal(facts.mode, 'daily')
  assert.equal(facts.window.label, 'Covers Tue 24 Nov to now')
  assert.equal(facts.window.heading, 'Stand up, Tue 24 Nov')
  assert.equal(facts.read, 'Read: 1 commit, 0 merged pull requests, 1 ticket, ticket list from 12 Nov')
  assert.equal(facts.left, 'Left out: Flows (it could not be read).')
  assert.deepEqual(facts.counts, { commits: 1, merges: 0, unmerged: 0, tickets: 1, flows: 0, waiting: 0 })
  assert.match(got.at(-1).run, /^s-[a-z0-9]+$/)
  assert.equal(got.at(-1).cost, 0.06)
  assert.equal(runs[0].text, factsText(await stubFacts(gathered[0]), NOW))
  assert.equal(gathered[0].from, new Date(2026, 10, 24).toISOString(), 'the daily window, from the injected clock')
})

test('the run is the clean turn with the stand-up prompt, medium effort, its own session name and the standup spend kind', async () => {
  const pending = post({ mode: 'week' })
  await until(() => runs.length === 1)
  assert.deepEqual(runs[0].opts.turn, standupTurn('week'))
  assert.deepEqual({ ...standupTurn('week'), messages: undefined }, { system: systemPrompt('week'), effort: 'medium', name: 'STANDUP', kind: 'standup', messages: undefined })
  assert.match(standupTurn('daily').messages.refusal, /stand-up/)
  runs[0].end({ ok: true, cost: 0.05 })
  await (await pending).text()
})

test('each run that started is logged with its mode, day, output, window and Read line', async () => {
  const pending = post({ mode: 'daily' })
  await until(() => runs.length === 1)
  runs[0].opts.onDelta('Stand up, Tue 24 Nov')
  runs[0].end({ ok: true, cost: 0.06 })
  const end = lines(await (await pending).text()).at(-1)
  const [e] = await logged(1)
  assert.equal(e.id, end.run)
  assert.equal(e.mode, 'daily')
  assert.equal(e.day, '2026-11-25', 'the local day it was made on')
  assert.equal(e.output, 'Stand up, Tue 24 Nov')
  assert.equal(e.ok, true)
  assert.equal(e.cost, 0.06)
  assert.equal(e.window.heading, 'Stand up, Tue 24 Nov')
  assert.equal(e.read.line, 'Read: 1 commit, 0 merged pull requests, 1 ticket, ticket list from 12 Nov')
})

test('a failed run ends with ONE error line and is logged as failed', async () => {
  const pending = post({ mode: 'daily' })
  await until(() => runs.length === 1)
  runs[0].end({ error: 'The model run stopped before it finished.', cost: 0.01 })
  const got = lines(await (await pending).text())
  assert.deepEqual(got.map(l => l.type), ['facts', 'error'])
  assert.equal(got[1].cost, 0.01)
  const [e] = await logged(1)
  assert.equal(e.ok, false)
  assert.match(e.error, /stopped/)
})

test('a mode that is not daily or week, a bad body and a non-POST are refused in plain words', async () => {
  for (const body of [{ mode: 'month' }, {}, { mode: 7 }]) {
    const res = await post(body)
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /Daily or This week/)
  }
  const bad = await post('{nope')
  assert.equal(bad.status, 400)
  const get = await fetch(`${base}/api/standup/generate`)
  assert.equal(get.status, 405)
  assert.equal(runs.length, 0)
})

test('another site s Origin is refused before anything runs; the page s own is fine', async () => {
  const res = await post({ mode: 'daily' }, { origin: 'https://evil.example' })
  assert.equal(res.status, 403)
  assert.equal(gathered.length, 0)
  const own = post({ mode: 'daily' }, { origin: `http://127.0.0.1:${port}` })
  await until(() => runs.length === 1)
  runs[0].end({ ok: true })
  assert.equal((await own).status, 200)
})

test('one stand-up at a time: a second POST while one runs is 409, and the next after it ends is fine', async () => {
  const first = post({ mode: 'daily' })
  await until(() => runs.length === 1)
  const second = await post({ mode: 'week' })
  assert.equal(second.status, 409)
  assert.match((await second.json()).error, /already being written/)
  runs[0].end({ ok: true })
  await (await first).text()
  const third = post({ mode: 'week' })
  await until(() => runs.length === 2)
  runs[1].end({ ok: true })
  assert.equal((await third).status, 200)
})

test('facts that cannot be gathered at all end with an error line and no run', async () => {
  const route = makeStandupRoute({ port, generate: stubGenerate, facts: async () => { throw new Error('boom') }, now: () => NOW })
  const s = createServer(async (req, res) => { if (!(await route(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end() })
  await new Promise(r => s.listen(0, '127.0.0.1', r))
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/api/standup/generate`, { method: 'POST', body: JSON.stringify({ mode: 'daily' }) })
    const got = lines(await res.text())
    assert.deepEqual(got.map(l => l.type), ['error'])
    assert.match(got[0].error, /could not be read/)
    assert.equal(runs.length, 0)
  } finally {
    s.close()
  }
})

test('a browser that goes away cancels the run', async () => {
  const ctl = new AbortController()
  const pending = fetch(`${base}/api/standup/generate`, { method: 'POST', body: JSON.stringify({ mode: 'daily' }), signal: ctl.signal }).then(r => r.text()).catch(() => null)
  await until(() => runs.length === 1)
  ctl.abort()
  await pending
  await until(() => runs[0].cancelled === 1)
})

// ═══ the ticket log ═══

test('a saved stand-up records the tickets it mentions: the facts ones it names, and any other id in its text', async () => {
  const pending = post({ mode: 'daily' })
  await until(() => runs.length === 1)
  runs[0].opts.onDelta('Stand up, Tue 24 Nov\n- FLA-1: A thing — https://x/FLA-1\n\nBlockers\n- FLA-77: needs a review — https://x/FLA-77')
  runs[0].end({ ok: true, cost: 0.06 })
  await (await pending).text()
  const [e] = await logged(1)
  assert.deepEqual(e.tickets, [{ id: 'FLA-1', title: 'A thing', link: 'https://x/FLA-1' }, { id: 'FLA-77', title: '', link: LINK('FLA-77') }])
})

// ═══ GET /api/standup/log: today ═══

const entry = (over = {}) => ({
  id: `s-${Math.random().toString(36).slice(2, 10)}`, at: NOW.toISOString(), day: '2026-11-25', mode: 'daily', ms: 1000, output: 'Stand up, Tue 24 Nov\n- FLA-1: A thing — https://x/FLA-1', ok: true,
  error: null, cancelled: false, cost: 0.05, window: { from: 'a', to: 'b', label: 'Covers', heading: 'Stand up' }, read: { line: 'Read: x', left: '' },
  tickets: [{ id: 'FLA-1', title: 'A thing', link: 'https://x/FLA-1' }], ...over,
})
const getJson = async p => {
  const res = await fetch(`${base}${p}`)
  return { status: res.status, body: await res.json() }
}

test('GET log: today s runs newest first, today s newest good run of each mode, the two windows and the ticket list date', async () => {
  A.appendRun(entry({ day: '2026-11-24', mode: 'daily' }), DIR)
  const failed = A.appendRun(entry({ ok: false, error: 'x' }), DIR)
  const good = A.appendRun(entry(), DIR)
  const week = A.appendRun(entry({ mode: 'week', output: 'Name: Yz31LL' }), DIR)
  const later = A.appendRun(entry({ ok: false, error: 'stopped', cancelled: true }), DIR)
  const { body: j } = await getJson('/api/standup/log')
  assert.deepEqual(j.runs.map(r => r.id), [later.id, week.id, good.id, failed.id], 'today only: yesterday is in the archive')
  assert.deepEqual(j.today, { day: '2026-11-25', daily: good.id, week: week.id })
  assert.equal(j.windows.daily.label, 'Covers Tue 24 Nov to now')
  assert.equal(j.windows.week.label, 'Covers Thu 19 Nov to Wed 25 Nov')
  assert.equal(j.ticketListAt, '2026-11-12T09:00:00.000Z')
  assert.deepEqual(j.limits, { perDay: 20, outputMax: 40000, ticketsMax: 100 })
})

test('GET log on a new day: nothing is today s, so both views start empty', async () => {
  A.appendRun(entry({ day: '2026-11-24' }), DIR)
  const { body: j } = await getJson('/api/standup/log')
  assert.deepEqual(j.today, { day: '2026-11-25', daily: null, week: null })
  assert.deepEqual(j.runs, [])
})

// ═══ the Date archive and the ticket log ═══

test('GET days: every day newest first with its runs in brief; GET day: one day in full', async () => {
  A.appendRun(entry({ day: '2026-10-31' }), DIR)
  const today = A.appendRun(entry(), DIR)
  const { body } = await getJson('/api/standup/days')
  assert.deepEqual(body.days.map(d => d.day), ['2026-11-25', '2026-10-31'])
  assert.equal(body.days[0].runs[0].first, '- FLA-1: A thing — https://x/FLA-1')
  const one = await getJson('/api/standup/day/2026-11-25')
  assert.equal(one.status, 200)
  assert.deepEqual(one.body.runs.map(r => r.id), [today.id])
  assert.equal(one.body.runs[0].output, entry().output)
  assert.deepEqual((await getJson('/api/standup/day/2026-11-01')).body, { day: '2026-11-01', runs: [] }, 'a day with nothing')
})

test('GET day and ticket refuse a bad day or id before any path is built', async () => {
  for (const p of ['/api/standup/day/2026-02-30', '/api/standup/day/..%2F..%2Fx', '/api/standup/day/%E0%A4%A', '/api/standup/ticket/not-a-ticket', '/api/standup/ticket/..%2Findex']) {
    const r = await getJson(p)
    assert.equal(r.status, 400, p)
    assert.match(r.body.error, /looks like/)
  }
  const post = await fetch(`${base}/api/standup/days`, { method: 'POST' })
  assert.equal(post.status, 405)
})

test('GET ticket: every day the ticket appeared, newest first, with its title, link and lines', async () => {
  A.appendRun(entry({ day: '2026-11-20' }), DIR)
  A.appendRun(entry({ day: '2026-11-24' }), DIR)
  const { status, body } = await getJson('/api/standup/ticket/fla-1')
  assert.equal(status, 200)
  assert.equal(body.id, 'FLA-1')
  assert.equal(body.title, 'A thing')
  assert.equal(body.link, 'https://x/FLA-1')
  assert.deepEqual(body.days.map(d => d.day), ['2026-11-24', '2026-11-20'])
  assert.deepEqual(body.days[0].entries[0].lines, ['- FLA-1: A thing — https://x/FLA-1'])
})
