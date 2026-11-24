// Tests for POST /api/script/generate (script-routes.mjs): the Origin rule, the text
// check, the NDJSON stream of deltas and its one final line, one run at a time (409),
// and a browser that goes away cancelling the run. A real http server on port 0
// calls the route with a STUB generate: no Claude turn ever runs.

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'

const { makeScriptRoute } = await import('../script-routes.mjs')

/** The stub generation: records each call; the test drives its deltas and its end. */
let runs = []
function stubGenerate(text, { onDelta }) {
  let finish
  const run = { text, onDelta, cancelled: 0, done: new Promise(r => (finish = r)) }
  run.end = out => finish(out)
  run.cancel = () => {
    run.cancelled++
    finish({ error: 'Stopped.', cancelled: true })
  }
  runs.push(run)
  return { done: run.done, cancel: run.cancel }
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
  route = makeScriptRoute({ generate: stubGenerate, port })
  base = `http://127.0.0.1:${port}`
})
after(() => server.close())
beforeEach(() => (runs = []))

const post = (body, headers = {}) => fetch(`${base}/api/script/generate`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })
const lines = text => text.split('\n').filter(Boolean).map(l => JSON.parse(l))
const until = async cond => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise(r => setTimeout(r, 5))
  assert.ok(cond(), 'timed out waiting')
}

test('a good run streams each delta as one NDJSON line, then ONE done line with ok, stopReason and cost', async () => {
  const pending = post({ text: 'my rough idea' })
  await until(() => runs.length === 1)
  assert.equal(runs[0].text, 'my rough idea')
  runs[0].onDelta('```\nSitu')
  runs[0].onDelta('ation: x')
  runs[0].end({ ok: true, stopReason: 'end_turn', cost: 0.18 })
  const res = await pending
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /^application\/x-ndjson/)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.deepEqual(lines(await res.text()), [
    { type: 'delta', text: '```\nSitu' },
    { type: 'delta', text: 'ation: x' },
    { type: 'done', ok: true, stopReason: 'end_turn', cost: 0.18 },
  ])
})

test('a failed run ends with ONE error line carrying the plain message (and the cost when there was one)', async () => {
  const pending = post({ text: 'idea' })
  await until(() => runs.length === 1)
  runs[0].onDelta('partial')
  runs[0].end({ error: 'No reply for 2 minutes, so the run was stopped. Try again.', cost: 0.05 })
  const out = lines(await (await pending).text())
  assert.deepEqual(out.at(-1), { type: 'error', error: 'No reply for 2 minutes, so the run was stopped. Try again.', cost: 0.05 })
  assert.equal(out.filter(l => l.type === 'error' || l.type === 'done').length, 1)
})

test('a POST from another site is refused before any run', async () => {
  const res = await post({ text: 'idea' }, { origin: 'http://evil.example' })
  assert.equal(res.status, 403)
  assert.match((await res.json()).error, /Cross-origin/)
  assert.equal(runs.length, 0)
})

test('the page\'s own Origin is accepted, on 127.0.0.1 and localhost', async () => {
  for (const origin of [`http://127.0.0.1:${port}`, `http://localhost:${port}`]) {
    const pending = post({ text: 'idea' }, { origin })
    await until(() => runs.length === 1)
    runs[0].end({ ok: true, stopReason: 'end_turn', cost: 0.1 })
    assert.equal((await pending).status, 200)
    runs = []
  }
})

test('text is required, 1 to 8000 characters; a bad body is a 400 with a plain reason and no run', async () => {
  for (const body of [{}, { text: '' }, { text: '   ' }, { text: 42 }, { text: 'x'.repeat(8001) }]) {
    const res = await post(body)
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 40))
    assert.ok((await res.json()).error.length > 5)
  }
  const bad = await post('{not json')
  assert.equal(bad.status, 400)
  assert.equal(runs.length, 0)
  const longest = post({ text: 'x'.repeat(8000) })
  await until(() => runs.length === 1)
  runs[0].end({ ok: true, stopReason: 'end_turn', cost: 0.1 })
  assert.equal((await longest).status, 200)
})

test('one at a time: a second request while one runs is a 409 with a plain message; after it ends a new one runs', async () => {
  const first = post({ text: 'one' })
  await until(() => runs.length === 1)
  const second = await post({ text: 'two' })
  assert.equal(second.status, 409)
  assert.match((await second.json()).error, /already/i)
  assert.equal(runs.length, 1)
  runs[0].end({ ok: true, stopReason: 'end_turn', cost: 0.1 })
  await (await first).text()
  const third = post({ text: 'three' })
  await until(() => runs.length === 2)
  runs[1].end({ ok: true, stopReason: 'end_turn', cost: 0.1 })
  assert.equal((await third).status, 200)
})

test('a browser that goes away cancels the run, and the next request is free to run', async () => {
  await new Promise((resolve, reject) => {
    const req = request(`${base}/api/script/generate`, { method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      res.once('data', () => {
        req.destroy()
        resolve()
      })
    })
    req.on('error', () => {})
    req.end(JSON.stringify({ text: 'idea' }))
    until(() => runs.length === 1).then(() => runs[0].onDelta('first words'), reject)
  })
  await until(() => runs[0].cancelled === 1)
  const next = post({ text: 'again' })
  await until(() => runs.length === 2)
  runs[1].end({ ok: true, stopReason: 'end_turn', cost: 0.1 })
  assert.equal((await next).status, 200)
})

test('a generate that throws ends the stream with an error line and frees the slot', async () => {
  let route
  const s = createServer(async (req, res) => {
    if (!(await route(req, res, new URL(req.url, 'http://localhost')))) res.writeHead(404).end()
  })
  await new Promise(r => s.listen(0, '127.0.0.1', r))
  let calls = 0
  route = makeScriptRoute({ generate: () => { calls++; throw new Error('boom') }, port: s.address().port })
  const url = `http://127.0.0.1:${s.address().port}/api/script/generate`
  const send = () => fetch(url, { method: 'POST', body: JSON.stringify({ text: 'idea' }) })
  const out = lines(await (await send()).text())
  assert.equal(out.at(-1).type, 'error')
  assert.equal((await send()).status, 200, 'not stuck busy')
  assert.equal(calls, 2)
  s.close()
})

test('other paths and a GET are not answered by this route', async () => {
  assert.equal((await fetch(`${base}/api/script/generate`)).status, 404)
  assert.equal((await fetch(`${base}/api/script/other`, { method: 'POST' })).status, 404)
})
