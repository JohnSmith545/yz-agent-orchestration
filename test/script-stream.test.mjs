// Tests for public/script-stream.js: the page's side of POST /api/script/generate. It
// reads the NDJSON body as it arrives (a line may be split across chunks), hands each
// delta on, and resolves the final line, or a calm error for a refused request, a
// network failure or a stream that ends without its final line. Stub fetch, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ctx = { window: {}, TextDecoder, TextEncoder }
vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', 'script-stream.js'), 'utf8'), ctx)
const SS = ctx.window.ScriptStream
const plain = v => JSON.parse(JSON.stringify(v))

/** A fetch Response whose body arrives in the given string chunks. */
function response(chunks, { ok = true, status = 200, json = {} } = {}) {
  const enc = new TextEncoder()
  const queue = chunks.map(c => enc.encode(c))
  return {
    ok, status,
    json: async () => json,
    body: { getReader: () => ({ read: async () => (queue.length ? { done: false, value: queue.shift() } : { done: true, value: undefined }) }) },
  }
}
const line = o => JSON.stringify(o) + '\n'

test('splitLines: whole lines out, the unfinished tail kept for the next chunk', () => {
  assert.deepEqual(plain(SS.splitLines('a\nb\nc')), { lines: ['a', 'b'], rest: 'c' })
  assert.deepEqual(plain(SS.splitLines('a\n')), { lines: ['a'], rest: '' })
  assert.deepEqual(plain(SS.splitLines('')), { lines: [], rest: '' })
  assert.deepEqual(plain(SS.splitLines('\n\nx\n')), { lines: ['x'], rest: '' }, 'blank lines are dropped')
})

test('it POSTs the text as JSON to the route, streams each delta in order, and resolves the done line', async () => {
  const sent = []
  const body = line({ type: 'delta', text: 'Hel' }) + line({ type: 'delta', text: 'lo' }) + line({ type: 'done', ok: true, stopReason: 'end_turn', cost: 0.2 })
  const fetch = async (url, opts) => (sent.push({ url, opts }), response([body.slice(0, 15), body.slice(15, 40), body.slice(40)]))
  const got = []
  const out = await SS.generate('my idea', { onDelta: t => got.push(t), fetch })
  assert.equal(sent[0].url, '/api/script/generate')
  assert.equal(sent[0].opts.method, 'POST')
  assert.equal(sent[0].opts.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(sent[0].opts.body), { text: 'my idea' })
  assert.deepEqual(got, ['Hel', 'lo'])
  assert.deepEqual(plain(out), { type: 'done', ok: true, stopReason: 'end_turn', cost: 0.2 })
})

test('an error line resolves as the error, with its message', async () => {
  const fetch = async () => response([line({ type: 'delta', text: 'x' }) + line({ type: 'error', error: 'The model chose not to write this one.' })])
  const out = await SS.generate('idea', { onDelta: () => {}, fetch })
  assert.deepEqual(plain(out), { type: 'error', error: 'The model chose not to write this one.' })
})

test('a refused request (409, 400, 403) resolves as an error with the server message', async () => {
  const fetch = async () => response([], { ok: false, status: 409, json: { error: 'A prompt is already being written.' } })
  assert.deepEqual(plain(await SS.generate('idea', { onDelta: () => {}, fetch })), { type: 'error', error: 'A prompt is already being written.' })
  const bare = async () => ({ ok: false, status: 500, json: async () => { throw new Error('not json') } })
  assert.match((await SS.generate('idea', { onDelta: () => {}, fetch: bare })).error, /500/)
})

test('a network failure, or a stream cut before its last line, is a calm error', async () => {
  const down = async () => { throw new TypeError('Failed to fetch') }
  assert.match((await SS.generate('idea', { onDelta: () => {}, fetch: down })).error, /reach the dashboard/)
  const cut = async () => response([line({ type: 'delta', text: 'x' })])
  assert.match((await SS.generate('idea', { onDelta: () => {}, fetch: cut })).error, /closed before/)
})

test('a final line with no newline after it still counts', async () => {
  const fetch = async () => response([JSON.stringify({ type: 'done', ok: true, stopReason: 'end_turn', cost: 0.1 })])
  assert.equal((await SS.generate('idea', { onDelta: () => {}, fetch })).type, 'done')
})

test('a garbled line is skipped, not fatal', async () => {
  const fetch = async () => response(['{oops\n' + line({ type: 'delta', text: 'ok' }) + line({ type: 'done', ok: true, stopReason: 'end_turn', cost: 0 })])
  const got = []
  assert.equal((await SS.generate('idea', { onDelta: t => got.push(t), fetch })).type, 'done')
  assert.deepEqual(got, ['ok'])
})

test('a context line before the first delta goes to onContext, not onDelta', async () => {
  const ctxLine = { type: 'context', used: [{ title: 'Brand voice', chars: 120 }], skipped: [{ title: 'Old notes', why: 'too long' }] }
  const fetch = async () => response([line(ctxLine) + line({ type: 'delta', text: 'Hi' }) + line({ type: 'done', ok: true, stopReason: 'end_turn', cost: 0 })])
  const seen = []
  const got = []
  const out = await SS.generate('idea', { onDelta: t => got.push(t), onContext: c => seen.push(plain(c)), fetch })
  assert.equal(out.type, 'done')
  assert.deepEqual(got, ['Hi'])
  assert.deepEqual(seen, [{ used: [{ title: 'Brand voice', chars: 120 }], skipped: [{ title: 'Old notes', why: 'too long' }] }])
})

test('a context line with no onContext, or with missing lists, is harmless', async () => {
  const fetch = async () => response([line({ type: 'context' }) + line({ type: 'done', ok: true, stopReason: 'end_turn', cost: 0 })])
  assert.equal((await SS.generate('idea', { onDelta: () => {}, fetch })).type, 'done')
  const seen = []
  await SS.generate('idea', { onDelta: () => {}, onContext: c => seen.push(plain(c)), fetch })
  assert.deepEqual(seen, [{ used: [], skipped: [] }])
})

test('the abort signal reaches fetch, so Restart can stop the run', async () => {
  let got = null
  const signal = { aborted: false }
  const fetch = async (_u, opts) => ((got = opts.signal), response([line({ type: 'done', ok: true, stopReason: 'end_turn', cost: 0 })]))
  await SS.generate('idea', { onDelta: () => {}, fetch, signal })
  assert.equal(got, signal)
})
