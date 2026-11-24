// Tests for the run log in POST /api/script/generate (script-routes.mjs): with a log injected, every run that
// started is recorded once when it ends (good, failed and stopped alike) with the user's OWN text, the streamed
// output and the context as titles and sizes; the done or error line names the run; a log that cannot be written
// never fails the run's own answer. Stub generate and a recording log: no Claude turn, no data/ folder.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'

const { makeScriptRoute } = await import('../script-routes.mjs')

let runs = []
function stubGenerate(text, { onDelta }) {
  const run = { text, onDelta, cancelled: 0 }
  run.done = new Promise(r => (run.end = r))
  run.cancel = () => {
    run.cancelled++
    run.end({ error: 'Stopped.', cancelled: true })
  }
  runs.push(run)
  return { done: run.done, cancel: run.cancel }
}

const servers = []
async function serve(opts) {
  let route
  const s = createServer(async (req, res) => {
    if (!(await route(req, res, new URL(req.url, 'http://localhost')))) res.writeHead(404).end()
  })
  await new Promise(r => s.listen(0, '127.0.0.1', r))
  route = makeScriptRoute({ generate: stubGenerate, port: s.address().port, ...opts })
  servers.push(s)
  return `http://127.0.0.1:${s.address().port}/api/script/generate`
}
after(() => servers.forEach(s => s.close()))

const lines = text => text.split('\n').filter(Boolean).map(l => JSON.parse(l))
const until = async cond => {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise(r => setTimeout(r, 5))
  assert.ok(cond(), 'timed out waiting')
}
const post = (url, text) => fetch(url, { method: 'POST', body: JSON.stringify({ text }) })

test('a good run is logged once with the user text (not the composed input), the output, the cost and the context sizes', async () => {
  const logged = []
  const url = await serve({
    log: e => logged.push(e),
    gather: async () => ({ parts: [{ title: 'Product', text: 'SECRET FACT' }], skipped: [{ title: 'Live session: Agent 2', why: 'Agent 2 is not running now.' }] }),
  })
  runs = []
  const pending = post(url, 'my idea')
  await until(() => runs.length === 1)
  assert.match(runs[0].text, /<task>\nmy idea\n<\/task>/)
  runs[0].onDelta('Situation: ')
  runs[0].onDelta('a team.')
  runs[0].end({ ok: true, stopReason: 'end_turn', cost: 0.031 })
  const out = lines(await (await pending).text())
  await until(() => logged.length === 1)
  const e = logged[0]
  assert.match(e.id, /^r-[a-z0-9]+$/)
  assert.deepEqual(out.at(-1), { type: 'done', ok: true, stopReason: 'end_turn', cost: 0.031, run: e.id })
  assert.equal(e.text, 'my idea')
  assert.equal(e.output, 'Situation: a team.')
  assert.equal(e.ok, true)
  assert.equal(e.error, null)
  assert.equal(e.cancelled, false)
  assert.equal(e.cost, 0.031)
  assert.ok(e.ms >= 0 && !Number.isNaN(Date.parse(e.at)))
  assert.deepEqual(e.context, { used: [{ title: 'Product', chars: 11 }], skipped: [{ title: 'Live session: Agent 2', why: 'Agent 2 is not running now.' }] })
  assert.ok(!JSON.stringify(e).includes('SECRET FACT'))
})

test('a failed run is logged with its plain message, and the error line names the run', async () => {
  const logged = []
  const url = await serve({ log: e => logged.push(e) })
  runs = []
  const pending = post(url, 'idea')
  await until(() => runs.length === 1)
  runs[0].onDelta('partial')
  runs[0].end({ error: 'The model run stopped before it finished. Try again in a moment.', cost: 0.01 })
  const out = lines(await (await pending).text())
  await until(() => logged.length === 1)
  assert.deepEqual(out.at(-1), { type: 'error', error: 'The model run stopped before it finished. Try again in a moment.', cost: 0.01, run: logged[0].id })
  assert.equal(logged[0].ok, false)
  assert.equal(logged[0].output, 'partial')
  assert.match(logged[0].error, /stopped before/)
  assert.deepEqual(logged[0].context, { used: [], skipped: [] })
})

test('a run stopped because the browser left is logged as cancelled, with what had arrived', async () => {
  const logged = []
  const url = await serve({ log: e => logged.push(e) })
  runs = []
  await new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST' }, res => {
      res.once('data', () => {
        req.destroy()
        resolve()
      })
    })
    req.on('error', () => {})
    req.end(JSON.stringify({ text: 'idea' }))
    until(() => runs.length === 1).then(() => runs[0].onDelta('first words'), reject)
  })
  await until(() => logged.length === 1)
  assert.equal(logged[0].cancelled, true)
  assert.equal(logged[0].ok, false)
  assert.equal(logged[0].output, 'first words')
})

test('a log that throws never fails or holds up the answer, and the next run still goes', async () => {
  let calls = 0
  const url = await serve({ log: () => { calls++; throw new Error('disk full') } })
  for (let i = 0; i < 2; i++) {
    runs = []
    const pending = post(url, 'idea')
    await until(() => runs.length === 1)
    runs[0].onDelta('x')
    runs[0].end({ ok: true, stopReason: 'end_turn', cost: 0.02 })
    const res = await pending
    assert.equal(res.status, 200)
    assert.equal(lines(await res.text()).at(-1).type, 'done')
  }
  await until(() => calls === 2)
})

test('the logged output stops at 40,000 characters however long the stream', async () => {
  const logged = []
  const url = await serve({ log: e => logged.push(e) })
  runs = []
  const pending = post(url, 'idea')
  await until(() => runs.length === 1)
  for (let i = 0; i < 50; i++) runs[0].onDelta('y'.repeat(1_000))
  runs[0].end({ ok: true, stopReason: 'end_turn', cost: 0.05 })
  await (await pending).text()
  await until(() => logged.length === 1)
  assert.equal(logged[0].output.length, 40_000)
})

test('with no log injected (the tests elsewhere), nothing is recorded and the end lines are as before', async () => {
  const url = await serve({})
  runs = []
  const pending = post(url, 'idea')
  await until(() => runs.length === 1)
  runs[0].end({ ok: true, stopReason: 'end_turn', cost: 0.02 })
  assert.deepEqual(lines(await (await pending).text()).at(-1), { type: 'done', ok: true, stopReason: 'end_turn', cost: 0.02 })
})
