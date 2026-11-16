// Tests for subagent-routes.mjs: GET /api/subagents?days=1..7 and GET /api/subagents/report,
// on a real http server (port 0) over the synthetic fixtures in test/fixtures/subagents,
// with a stub gh, a stub worktree list and a fixed clock. The fixtures are copied to a
// temp folder first, because the window reads file times and the test sets them.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { makeSubagentRoutes, countsOf } = await import('../subagent-routes.mjs')
const { makePrStates } = await import('../subagent-prs.mjs')
const { useTicketPrefixes } = await import('../transcripts.mjs')
useTicketPrefixes(['ABC', 'XYZ'])

// Local noon, so "today" holds everything touched in the two hours before it.
const NOW = new Date(2026, 10, 12, 12, 0).getTime()
const MIN = 60_000
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-routes-test-'))
const CLAUDE = path.join(TMP, 'claude')
fs.cpSync(path.join(HERE, 'fixtures', 'subagents', 'claude'), CLAUDE, { recursive: true })
const subFile = (session, id) => path.join(CLAUDE, 'projects', 'C--path-to-your-repo', session, 'subagents', `agent-${id}.jsonl`)
function touch(session, id, minutesAgo) {
  const t = new Date(NOW - minutesAgo * MIN)
  fs.utimesSync(subFile(session, id), t, t)
}
const TOUCHED = { b1: 60, w1: 2, s1: 20, f1: 30, t1: 45, t2: 50, mid1: 1, bad1: 5, l1: 2 * 24 * 60, old1: 10 * 24 * 60 }
for (const [id, m] of Object.entries(TOUCHED)) touch('sess-live', id, m)
touch('sess-ended', 'e1', 120)

const ghCalls = []
let ghAnswer = () => ({ ok: true, out: JSON.stringify({ state: 'MERGED', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }) })
const gh = async args => {
  ghCalls.push(args)
  return ghAnswer(args)
}
let trees = async () => [{ path: 'C:/path/to/your-repo', branch: 'dev' }, { path: 'C:/path/to/your-repo/.claude/worktrees/label-print', branch: 'fix/xyz-5-label-print' }]
const make = (over = {}) => makeSubagentRoutes({
  claudeDirs: [CLAUDE],
  match: 'your-repo',
  listWorktrees: () => trees(),
  prStates: makePrStates({ gh, now: () => NOW }),
  sessions: async () => new Map([['sess-live', { label: 'Coordinator' }]]),
  now: () => NOW,
  ...over,
})

let route = make()
let server
let base
before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    try {
      if (!(await route(req, res, url))) res.writeHead(404).end('not handled')
    } catch (e) {
      res.writeHead(500).end(String(e?.stack || e))
    }
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => {
  server.close()
  fs.rmSync(TMP, { recursive: true, force: true })
})
const get = async p => {
  const r = await fetch(base + p)
  const text = await r.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {}
  return { status: r.status, body, text, headers: r.headers }
}
const ids = body => body.subagents.map(h => h.id)

// ═══ GET /api/subagents ═══

test('with no days it lists today, newest first, never cached by the browser', async () => {
  route = make()
  const r = await get('/api/subagents')
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('cache-control'), 'no-store')
  assert.match(r.headers.get('content-type'), /application\/json/)
  assert.equal(r.body.days, 1)
  assert.equal(r.body.at, new Date(NOW).toISOString())
  assert.equal(r.body.since, new Date(2026, 10, 12).toISOString())
  assert.deepEqual(ids(r.body), ['mid1', 'w1', 's1', 'f1', 't1', 't2', 'b1', 'e1'])
})

test('days widens the window up to 7: 3 brings in the day before yesterday, and nothing brings in ten days ago', async () => {
  route = make()
  assert.ok(ids((await get('/api/subagents?days=3')).body).includes('l1'))
  const week = (await get('/api/subagents?days=7')).body
  assert.equal(week.days, 7)
  assert.ok(ids(week).includes('l1'))
  assert.ok(!ids(week).includes('old1'))
})

test('a days value that is not 1 to 7 reads as the nearest allowed one', async () => {
  route = make()
  for (const [q, want] of [['99', 7], ['8', 7], ['0', 1], ['-3', 1], ['abc', 1], ['', 1], ['2.5', 1], ['2', 2]]) {
    assert.equal((await get(`/api/subagents?days=${q}`)).body.days, want, q)
  }
})

test('the counts say how many work, are stuck, finished, stopped and failed, and how many are builders', async () => {
  route = make()
  const { counts } = (await get('/api/subagents')).body
  assert.deepEqual(counts, { working: 2, stuck: 1, done: 4, stopped: 0, failed: 1, builders: 5, lookups: 3 })
  assert.equal(countsOf([{ state: 'stopped', builder: true }, { state: 'stopped', builder: false }, { state: 'failed', builder: true }]).stopped, 2)
})

test('each subagent says which session it belongs to: its label when that session is live, and that it has ended when not', async () => {
  route = make()
  const { subagents } = (await get('/api/subagents')).body
  assert.deepEqual(subagents.find(h => h.id === 'b1').parent, { label: 'Coordinator', live: true })
  assert.deepEqual(subagents.find(h => h.id === 'e1').parent, { label: '', live: false })
})

test('git says which branch a worktree is on for a builder that has not committed yet', async () => {
  route = make()
  const w = (await get('/api/subagents')).body.subagents.find(h => h.id === 'w1')
  assert.equal(w.worktree, 'label-print')
  assert.equal(w.branch, 'fix/xyz-5-label-print')
})

test('a worktree list that fails does not stop the list', async () => {
  route = make({ listWorktrees: async () => { throw new Error('git is locked') } })
  const r = await get('/api/subagents')
  assert.equal(r.status, 200)
  assert.equal(r.body.subagents.find(h => h.id === 'w1').branch, '')
})

test('a pull request carries its state and checks from gh, read only', async () => {
  ghCalls.length = 0
  route = make()
  const b = (await get('/api/subagents')).body.subagents.find(h => h.id === 'b1')
  assert.deepEqual(b.prs, [{ repo: 'acme/your-repo', number: 12, url: 'https://github.com/acme/your-repo/pull/12', state: 'merged', checks: 'passing', draft: false, at: new Date(NOW).toISOString() }])
  assert.ok(ghCalls.length >= 1)
  for (const c of ghCalls) assert.deepEqual(c.slice(0, 2), ['pr', 'view'], 'only gh pr view')
})

test('when gh fails the link stays and the state is left out', async () => {
  ghAnswer = () => ({ ok: false, out: '', err: 'not signed in' })
  route = make()
  const b = (await get('/api/subagents')).body.subagents.find(h => h.id === 'b1')
  assert.deepEqual(b.prs, [{ repo: 'acme/your-repo', number: 12, url: 'https://github.com/acme/your-repo/pull/12' }])
})

test('a slow gh does not hold the list back: the states arrive with a later request', async () => {
  ghAnswer = () => new Promise(r => setTimeout(() => r({ ok: true, out: JSON.stringify({ state: 'OPEN', statusCheckRollup: [] }) }), 600))
  route = make({ prBudgetMs: 20 })
  const started = Date.now()
  const first = (await get('/api/subagents')).body.subagents.find(h => h.id === 'b1')
  assert.ok(Date.now() - started < 500, 'answered before gh did')
  assert.equal(first.prs[0].state, undefined)
  await new Promise(r => setTimeout(r, 700))
  const second = (await get('/api/subagents?refresh=1')).body.subagents.find(h => h.id === 'b1')
  assert.equal(second.prs[0].state, 'open')
})

test('the list is small: no subagent carries its full report', async () => {
  route = make()
  const { subagents } = (await get('/api/subagents')).body
  for (const h of subagents) assert.equal('report' in h, false, h.id)
  assert.equal(subagents.find(h => h.id === 'b1').hasReport, true)
})

test('a burst of requests for the same window is one read of the files', async () => {
  let listed = 0
  route = make({ listWorktrees: async () => { listed++; return [] } })
  await Promise.all([get('/api/subagents'), get('/api/subagents'), get('/api/subagents')])
  await get('/api/subagents')
  assert.equal(listed, 1)
  await get('/api/subagents?refresh=1')
  assert.equal(listed, 2, 'refresh reads again')
})

// ═══ GET /api/subagents/report ═══

test('the report route gives one finished subagent its final report in full', async () => {
  route = make()
  const r = await get('/api/subagents/report?session=sess-live&sub=b1')
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('cache-control'), 'no-store')
  assert.ok(r.body.report.startsWith('ABC-101 is ready for review'))
  assert.ok(r.body.report.endsWith('2. Click the moon.'))
})

test('a subagent from an ended session has its report too', async () => {
  route = make()
  assert.equal((await get('/api/subagents/report?session=sess-ended&sub=e1')).body.report, 'The footer link is fixed. No pull request yet.')
})

test('a subagent that has not handed back answers an empty report', async () => {
  route = make()
  const r = await get('/api/subagents/report?session=sess-live&sub=w1')
  assert.equal(r.status, 200)
  assert.equal(r.body.report, '')
})

test('no such subagent, a missing id, or an id that is a path, is a plain 404 that names no file', async () => {
  route = make()
  for (const q of ['session=sess-live&sub=nope', 'session=sess-live', 'sub=b1', '', 'session=..&sub=b1', 'session=sess-live&sub=..%2F..%2Fx']) {
    const r = await get(`/api/subagents/report?${q}`)
    assert.equal(r.status, 404, q)
    assert.deepEqual(r.body, { error: 'No such subagent.' })
  }
})

// ═══ the edges ═══

test('only GET is answered', async () => {
  route = make()
  for (const p of ['/api/subagents', '/api/subagents/report?session=sess-live&sub=b1']) {
    const r = await fetch(base + p, { method: 'POST' })
    assert.equal(r.status, 405, p)
  }
})

test('any other path is left to the rest of the server', async () => {
  route = make()
  for (const p of ['/api/subagent', '/api/subagents/other', '/api/subagentsx', '/api/status']) assert.equal((await get(p)).text, 'not handled', p)
})

test('a failure while listing is a safe message, never a stack or a path', async () => {
  route = make({ claudeDirs: null })
  const r = await get('/api/subagents?refresh=1')
  assert.equal(r.status, 500)
  assert.deepEqual(r.body, { error: 'Could not read the subagents. Try again.' })
})

// ═══ the flow of a subagent, and the story a builder owes ═══

const DARK_FLOW = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'dark-mode.json'), 'utf8')) // tells ABC-101 with a story and a picture
const subagentOf = async (id, over) => {
  route = make(over)
  return (await get('/api/subagents')).body.subagents.find(h => h.id === id)
}

test('a builder whose ticket a flow tells links to that flow and owes nothing', async () => {
  const b = await subagentOf('b1', { flows: () => [DARK_FLOW] })
  assert.deepEqual(b.flow, { id: 'dark-mode', title: DARK_FLOW.title, story: true, visual: true })
  assert.equal(b.noStory, '')
})

test('a builder with no flow is marked; a lookup never is', async () => {
  const t = await subagentOf('t1', { flows: () => [DARK_FLOW] })
  assert.equal(t.flow, null)
  assert.equal(t.noStory, 'No flow recorded')
  const lookup = await subagentOf('s1', { flows: () => [DARK_FLOW] })
  assert.equal(lookup.flow, null)
  assert.equal(lookup.noStory, '')
})

test('a builder that is still working is not marked yet; a stuck or failed one is', async () => {
  const flows = () => [DARK_FLOW]
  const working = await subagentOf('w1', { flows })
  assert.equal(working.state, 'working')
  assert.equal(working.builder, true)
  assert.equal(working.noStory, '')
  assert.equal((await subagentOf('f1', { flows })).noStory, 'No flow recorded')
})

test('a flow with no story is linked and marked', async () => {
  const bare = { ...structuredClone(DARK_FLOW), output: { diagram: DARK_FLOW.output.diagram } }
  const b = await subagentOf('b1', { flows: () => [bare] })
  assert.equal(b.flow.id, 'dark-mode')
  assert.equal(b.noStory, 'Its flow has no story')
})

test('with no flow source, or one that fails, the list still answers and every builder reads as having no flow', async () => {
  for (const flows of [undefined, () => { throw new Error('flows unreadable') }]) {
    const b = await subagentOf('b1', { flows })
    assert.equal(b.flow, null)
    assert.equal(b.noStory, 'No flow recorded')
  }
})
