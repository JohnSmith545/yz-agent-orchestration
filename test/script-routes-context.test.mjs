// Tests for context in POST /api/script/generate (script-routes.mjs): the injected gatherer's parts are
// composed with the user's text (script-compose.mjs) and the composed text is what generate() gets; ONE
// `context` line goes out before the first delta when anything was used or skipped; none when nothing was; a
// gatherer that throws never stops the run. The stub generate means no Claude turn ever runs.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const { makeScriptRoute } = await import('../script-routes.mjs')
const { composeInput } = await import('../script-compose.mjs')

let runs = []
function stubGenerate(text, { onDelta }) {
  const run = { text, onDelta }
  run.done = new Promise(r => (run.end = r))
  runs.push(run)
  return { done: run.done, cancel: () => run.end({ error: 'Stopped.', cancelled: true }) }
}

let gathered = { parts: [], skipped: [] }
let gatherCalls = 0
const servers = []
async function serve(gather) {
  let route
  const s = createServer(async (req, res) => {
    if (!(await route(req, res, new URL(req.url, 'http://localhost')))) res.writeHead(404).end()
  })
  await new Promise(r => s.listen(0, '127.0.0.1', r))
  route = makeScriptRoute({ generate: stubGenerate, port: s.address().port, gather })
  servers.push(s)
  return `http://127.0.0.1:${s.address().port}/api/script/generate`
}
let url
before(async () => {
  url = await serve(async () => {
    gatherCalls++
    return gathered
  })
})
after(() => servers.forEach(s => s.close()))

const lines = text => text.split('\n').filter(Boolean).map(l => JSON.parse(l))
const until = async cond => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise(r => setTimeout(r, 5))
  assert.ok(cond(), 'timed out waiting')
}
async function generate(target, text) {
  runs = []
  const pending = fetch(target, { method: 'POST', body: JSON.stringify({ text }) })
  await until(() => runs.length === 1)
  runs[0].onDelta('Situation: x')
  runs[0].end({ ok: true, stopReason: 'end_turn', cost: 0.03 })
  return { run: runs[0], out: lines(await (await pending).text()) }
}

test('with context: generate gets the composed text, and ONE context line comes before the first delta', async () => {
  gathered = {
    parts: [{ title: 'Product', text: 'Lumen is a reading app.' }, { title: 'Live session: Master', text: 'User: hi', keep: 'end' }],
    skipped: [{ title: 'Live session: Agent 2', why: 'Agent 2 is not running now.' }],
  }
  const { run, out } = await generate(url, 'Write a launch email.')
  assert.equal(run.text, composeInput('Write a launch email.', gathered.parts).input)
  assert.deepEqual(out[0], {
    type: 'context',
    used: [{ title: 'Product', chars: 23 }, { title: 'Live session: Master', chars: 8 }],
    skipped: [{ title: 'Live session: Agent 2', why: 'Agent 2 is not running now.' }],
  })
  assert.equal(out[1].type, 'delta')
  assert.equal(out.at(-1).type, 'done')
  assert.equal(out.filter(l => l.type === 'context').length, 1)
})

test('cuts and drops made by the composer are in skipped too', async () => {
  gathered = { parts: [{ title: 'Empty', text: ' ' }, { title: 'Real', text: 'fact' }], skipped: [] }
  const { out } = await generate(url, 'idea')
  assert.deepEqual(out[0].skipped, [{ title: 'Empty', why: 'It was empty.' }])
})

test('no context at all: the text goes unchanged and there is no context line', async () => {
  gathered = { parts: [], skipped: [] }
  const { run, out } = await generate(url, 'just the idea')
  assert.equal(run.text, 'just the idea')
  assert.deepEqual(out.map(l => l.type), ['delta', 'done'])
})

test('the gatherer runs after the checks: a bad body or a 409 never reads the context', async () => {
  gathered = { parts: [], skipped: [] }
  const before = gatherCalls
  assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify({ text: '' }) })).status, 400)
  assert.equal(gatherCalls, before)
})

test('a gatherer that throws: the run still goes, with the plain text and a skipped line saying why', async () => {
  const target = await serve(async () => {
    throw new Error('disk gone')
  })
  const { run, out } = await generate(target, 'idea')
  assert.equal(run.text, 'idea')
  assert.deepEqual(out[0], { type: 'context', used: [], skipped: [{ title: 'Context', why: 'It could not be read, so none was sent.' }] })
})

test('the user text keeps its own 8,000 limit, whatever the context adds', async () => {
  gathered = { parts: [{ title: 'Big', text: 'x'.repeat(50_000) }], skipped: [] }
  const { run } = await generate(url, 'y'.repeat(8_000))
  assert.ok(run.text.length > 50_000)
  assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify({ text: 'y'.repeat(8_001) }) })).status, 400)
})
