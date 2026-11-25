// Tests for the Learn page's routes (learn-routes.mjs) on a real http server on port 0, every reader a STUB:
//   GET  /api/learn                         the page's state: settings, the reminder, the runs, the verdicts
//   POST /api/learn/run                     ONE Learn run at a time (409), started in the background (202)
//   POST /api/learn/weekly                  the weekly run on page open: only when learn.weekly and 7 days have passed
//   POST /api/learn/runs/<id>/<n>           Accept (through the rules path, marked as Learn), Edit then accept, Reject
//   POST /api/learn/retro/<flow>            Write the retrospective
//   POST /api/learn/changes/<id>            Keep, Wait, Revert (through the rules path, marked revert)
// Every POST needs the page's own Origin, present. No model runs; config.json is never written.

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-routes-test-'))
process.env.FACTORY_DATA_DIR = TMP
const { makeLearnRoute, learnTurn } = await import('../learn-routes.mjs')
const { LEARN_DEFAULTS } = await import('../learn-settings.mjs')
const { listRuns, rejectedIdeas } = await import('../learn-runs.mjs')
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const CONFIG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json')
const configBefore = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : null
const NOW = new Date('2026-11-25T12:00:00.000Z')
const ANSWER = JSON.stringify({ proposals: [
  { target: 'Agent 1', action: 'add', rule: 'Test every limit before QA.', flows: ['agent-rules'], evidence: 'agent-rules failed once.', effect: 'Fewer failures.', check: 'QA failures go down.' },
  { target: 'Agent 1', action: 'change', old: 'Write the failing test first.', rule: 'Write the failing test first, then watch it fail.', flows: ['agent-rules'], evidence: 'e', effect: 'f', check: 'c' },
  { target: 'settings', action: 'change', rule: 'Set outputs.max to 5.', flows: ['agent-rules'], evidence: 'e', effect: 'f', check: 'c' },
] })

let state
function reset() {
  state = {
    settings: { ...LEARN_DEFAULTS }, gens: [], answer: ANSWER, hold: null, puts: [], rules: { 'Agent 1': ['Write the failing test first.'] },
    decided: [], retroCalls: [], dir: fs.mkdtempSync(path.join(TMP, 'runs-')),
  }
}
reset()

function generate(text, opts) {
  state.gens.push({ text, opts })
  const done = (async () => {
    if (state.hold) await state.hold
    opts.onDelta(state.answer)
    return { ok: true, cost: 0.42 }
  })()
  return { done, cancel: () => {} }
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
  base = `http://127.0.0.1:${port}`
  route = makeLearnRoute({
    port, generate, now: () => NOW, dir: () => state.dir, settings: () => state.settings,
    pack: () => ({ window: { from: '2026-11-18T12:00:00.000Z', to: NOW.toISOString(), days: 7, widened: false }, text: 'PACK TEXT', read: 'Read: 1 finished flow', left: '', flowIds: new Set(['agent-rules']) }),
    labels: () => ['Master', 'Agent 1', 'QA'],
    rulesNow: () => state.rules,
    putRules: (label, body, headers, opts) => {
      state.puts.push({ label, body, origin: headers.origin, opts })
      state.rules[label] = body.rules ?? state.rules[label]
      return { status: 200, body: { ok: true } }
    },
    retros: { write: async (id, source) => (state.retroCalls.push([id, source]), { status: 200, body: { ok: true, retro: { right: 'r' } } }), busy: () => false },
    verdicts: {
      view: () => ({ due: [], changes: [] }),
      decide: (id, what, { revert }) => {
        state.decided.push([id, what])
        return what === 'revert' ? revert({ id, label: 'Agent 1', added: ['Test every limit before QA.'], removed: [], spec: null }) : { status: 200, body: { ok: true } }
      },
    },
  })
})
after(() => server.close())
beforeEach(reset)

const OWN = () => ({ origin: `http://127.0.0.1:${port}` })
const post = (p, body = {}, headers = OWN()) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const get = async () => (await fetch(`${base}/api/learn`)).json()
const until = async cond => {
  for (let i = 0; i < 200 && !(await cond()); i++) await new Promise(r => setTimeout(r, 5))
  assert.ok(await cond(), 'timed out waiting')
}
async function oneRun() {
  assert.equal((await post('/api/learn/run')).status, 202)
  await until(() => listRuns(state.dir).length === 1)
  return listRuns(state.dir)[0]
}

test('the turn: Opus at high effort by default, its own prompt, session name and spend kind', () => {
  const t = learnTurn('claude-opus-5-5')
  assert.deepEqual([t.model, t.effort, t.name, t.kind], ['claude-opus-5-5', 'high', 'LEARN', 'learn'])
})

test('every POST needs the page own Origin, present: none and another site are refused, nothing runs', async () => {
  assert.equal((await post('/api/learn/run', {}, {})).status, 403)
  assert.equal((await post('/api/learn/run', {}, { origin: 'http://evil.example' })).status, 403)
  assert.equal((await post('/api/learn/retro/agent-rules', {}, {})).status, 403)
  assert.equal(state.gens.length, 0)
  assert.equal((await fetch(`${base}/api/learn/run`)).status, 405)
})

test('Run Learn: 202 at once, the pack on stdin, the run kept with its proposals, cost and pack summary', async () => {
  const run = await oneRun()
  assert.equal(state.gens[0].text, 'PACK TEXT')
  assert.equal(state.gens[0].opts.turn.kind, 'learn')
  assert.equal(run.ok, true)
  assert.equal(run.cost, 0.42)
  assert.equal(run.read, 'Read: 1 finished flow')
  assert.deepEqual(run.proposals.map(p => p.target), ['Agent 1', 'Agent 1', 'settings'])
  const g = await get()
  assert.equal(g.running, null)
  assert.equal(g.runs[0].id, run.id)
  assert.equal(g.lastRunAt, run.at)
  assert.equal(g.remind, null)
})

test('one run at a time: a second press while it runs is a 409 with a plain sentence', async () => {
  let release
  state.hold = new Promise(r => (release = r))
  assert.equal((await post('/api/learn/run')).status, 202)
  const second = await post('/api/learn/run')
  assert.equal(second.status, 409)
  assert.match((await second.json()).error, /already running/)
  assert.ok((await get()).running)
  release()
  await until(() => listRuns(state.dir).length === 1)
})

test('switched off: Run Learn and the retrospective are refused, the page still loads', async () => {
  state.settings.enabled = false
  assert.equal((await post('/api/learn/run')).status, 403)
  assert.equal((await post('/api/learn/retro/agent-rules')).status, 403)
  assert.equal((await get()).settings.enabled, false)
})

test('the reminder: never run, or the last good run is 7 days old or more', async () => {
  assert.match((await get()).remind, /has not run yet/)
})

test('Accept: the rule is added through the rules path, marked as Learn and linked to its proposal', async () => {
  const run = await oneRun()
  const r = await post(`/api/learn/runs/${run.id}/1`, { do: 'accept' })
  assert.equal(r.status, 200)
  assert.deepEqual(state.puts[0].body, { rules: ['Write the failing test first.', 'Test every limit before QA.'] })
  assert.equal(state.puts[0].opts.by, 'learn')
  assert.deepEqual(state.puts[0].opts.link, { run: run.id, n: 1 })
  assert.equal(state.puts[0].origin, OWN().origin) // the page's own headers go on to the rules path
  const p = listRuns(state.dir)[0].proposals[0]
  assert.equal(p.state, 'accepted')
  assert.equal((await post(`/api/learn/runs/${run.id}/1`, { do: 'accept' })).status, 409) // decided already
})

test('Edit then accept: the edited text replaces the rule it changes, word for word', async () => {
  const run = await oneRun()
  const r = await post(`/api/learn/runs/${run.id}/2`, { do: 'accept', text: '  Write the failing test first and watch it fail.  ' })
  assert.equal(r.status, 200)
  assert.deepEqual(state.puts[0].body, { rules: ['Write the failing test first and watch it fail.'] })
  assert.equal(listRuns(state.dir)[0].proposals[1].text, 'Write the failing test first and watch it fail.')
  assert.equal((await post(`/api/learn/runs/${run.id}/1`, { do: 'accept', text: 'x'.repeat(301) })).status, 400)
})

test('a change to a rule edited since is refused, not guessed', async () => {
  const run = await oneRun()
  state.rules['Agent 1'] = ['Something else now.']
  const r = await post(`/api/learn/runs/${run.id}/2`, { do: 'accept' })
  assert.equal(r.status, 409)
  assert.match((await r.json()).error, /no longer has the rule/)
  assert.equal(state.puts.length, 0)
})

test('a settings proposal is accepted as text for the user to apply by hand: nothing is written', async () => {
  const run = await oneRun()
  const r = await post(`/api/learn/runs/${run.id}/3`, { do: 'accept' })
  assert.equal(r.status, 200)
  assert.match((await r.json()).note, /by hand/)
  assert.equal(state.puts.length, 0)
  assert.equal(configBefore === null ? null : fs.readFileSync(CONFIG_FILE, 'utf8'), configBefore)
})

test('Reject keeps the reason, and the idea is carried to the next pack', async () => {
  const run = await oneRun()
  assert.equal((await post(`/api/learn/runs/${run.id}/1`, { do: 'reject', reason: 'We test limits already.' })).status, 200)
  assert.deepEqual(rejectedIdeas(state.dir).map(r => [r.rule, r.reason]), [['Test every limit before QA.', 'We test limits already.']])
  assert.equal((await post(`/api/learn/runs/${run.id}/2`, { do: 'reject', reason: 'r'.repeat(301) })).status, 400)
  assert.equal((await post(`/api/learn/runs/${run.id}/9`, { do: 'reject' })).status, 404)
  assert.equal((await post('/api/learn/runs/not-a-run/1', { do: 'reject' })).status, 404)
})

test('the retrospective button runs the retro writer for that flow; a bad id is refused before any read', async () => {
  assert.equal((await post('/api/learn/retro/agent-rules')).status, 200)
  assert.deepEqual(state.retroCalls, [['agent-rules', 'button']])
  assert.equal((await post('/api/learn/retro/..%2Fx')).status, 400)
})

test('Revert goes through the rules path marked revert, with the exact text taken off', async () => {
  state.rules['Agent 1'] = ['Write the failing test first.', 'Test every limit before QA.']
  const r = await post('/api/learn/changes/v1', { do: 'revert' })
  assert.equal(r.status, 200)
  assert.deepEqual(state.puts[0].body, { rules: ['Write the failing test first.'] })
  assert.equal(state.puts[0].opts.by, 'revert')
  assert.equal((await post('/api/learn/changes/v1', { do: 'keep' })).status, 200)
  assert.deepEqual(state.decided, [['v1', 'revert'], ['v1', 'keep']])
})

test('weekly: off by default; on, it starts a run on page open only when the last run is 7 days old or more', async () => {
  let r = await (await post('/api/learn/weekly')).json()
  assert.equal(r.started, false)
  state.settings.weekly = true
  r = await (await post('/api/learn/weekly')).json()
  assert.equal(r.started, true)
  await until(() => listRuns(state.dir).length === 1)
  r = await (await post('/api/learn/weekly')).json()
  assert.equal(r.started, false) // ran today: not again for 7 days
  assert.equal(state.gens.length, 1)
})

test('nothing here writes config.json', () => {
  assert.equal(configBefore === null ? null : fs.readFileSync(CONFIG_FILE, 'utf8'), configBefore)
})
