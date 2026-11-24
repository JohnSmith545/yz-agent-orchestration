// Tests for the SCRIPT run log store (script-log.mjs): the newest 50 runs in data/script-log.json, newest first,
// each entry normalised (the output capped at 40,000, the context as titles and sizes only, never its text), a
// missing or broken file reading as empty, and removing one run or all. FACTORY_DATA_DIR points at a fresh temp
// folder BEFORE the import.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'script-log-test-'))
const L = await import('../script-log.mjs')
after(() => fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true }))

let n = 0
const fresh = () => path.join(process.env.FACTORY_DATA_DIR, `log-${++n}.json`)
const run = (o = {}) => ({
  id: L.newRunId(), at: '2026-11-24T10:00:00.000Z', ms: 4200, text: 'my idea', output: 'Situation: x', ok: true,
  error: null, cancelled: false, cost: 0.03, context: { used: [{ title: 'Product', chars: 23 }], skipped: [] }, ...o,
})

test('the file lives in the data dir; the limits are 50 runs and 40,000 characters of output', () => {
  assert.equal(L.LOG_FILE, path.join(process.env.FACTORY_DATA_DIR, 'script-log.json'))
  assert.deepEqual({ ...L.LOG_LIMITS }, { runsMax: 50, outputMax: 40_000 })
})

test('a missing file, a file that is not JSON, and one of the wrong shape all read as no runs', () => {
  assert.deepEqual(L.readLog(fresh()), [])
  const broken = fresh()
  fs.writeFileSync(broken, '{nope')
  assert.deepEqual(L.readLog(broken), [])
  const wrong = fresh()
  fs.writeFileSync(wrong, JSON.stringify({ runs: 'many' }))
  assert.deepEqual(L.readLog(wrong), [])
})

test('a run is added newest first, and only the newest 50 are kept', () => {
  const file = fresh()
  for (let i = 0; i < 53; i++) L.appendRun(run({ id: `r-${i}`, text: `idea ${i}` }), file)
  const runs = L.readLog(file)
  assert.equal(runs.length, 50)
  assert.equal(runs[0].id, 'r-52')
  assert.equal(runs.at(-1).id, 'r-3')
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(f => f.endsWith('.tmp')), [])
})

test('an entry keeps the agreed shape: the output capped, the context as titles and sizes only', () => {
  const file = fresh()
  L.appendRun(run({
    output: 'x'.repeat(45_000),
    cost: undefined,
    context: { used: [{ title: 'Secret note', chars: 9, text: 'TOP SECRET' }], skipped: [{ title: 'Live session: Agent 2', why: 'Agent 2 is not running now.', text: 'leak' }] },
    extra: 'dropped',
  }), file)
  const [e] = L.readLog(file)
  assert.deepEqual(Object.keys(e).sort(), ['at', 'cancelled', 'context', 'cost', 'error', 'id', 'ms', 'ok', 'output', 'text'])
  assert.equal(e.output.length, 40_000)
  assert.equal(e.cost, null)
  assert.deepEqual(e.context, { used: [{ title: 'Secret note', chars: 9 }], skipped: [{ title: 'Live session: Agent 2', why: 'Agent 2 is not running now.' }] })
  assert.ok(!fs.readFileSync(file, 'utf8').includes('TOP SECRET'))
})

test('a failed and a cancelled run are kept with their plain message', () => {
  const file = fresh()
  L.appendRun(run({ ok: false, error: 'No reply for 2 minutes, so the run was stopped. Try again.', cost: 0.01 }), file)
  L.appendRun(run({ ok: false, error: 'Stopped.', cancelled: true, cost: null, output: 'part' }), file)
  const [cancelled, failed] = L.readLog(file)
  assert.equal(cancelled.cancelled, true)
  assert.equal(cancelled.output, 'part')
  assert.equal(failed.ok, false)
  assert.match(failed.error, /2 minutes/)
})

test('a bad entry in a hand-edited file is left out, the good ones still read', () => {
  const file = fresh()
  L.appendRun(run({ id: 'r-good' }), file)
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  raw.runs.push({ id: 42 })
  fs.writeFileSync(file, JSON.stringify(raw))
  assert.deepEqual(L.readLog(file).map(r => r.id), ['r-good'])
})

test('one run is removed by id (404 for an unknown one); clear removes them all', () => {
  const file = fresh()
  L.appendRun(run({ id: 'r-a' }), file)
  L.appendRun(run({ id: 'r-b' }), file)
  assert.deepEqual(L.removeRun('r-a', file), { ok: true })
  assert.deepEqual(L.readLog(file).map(r => r.id), ['r-b'])
  assert.equal(L.removeRun('r-a', file).status, 404)
  assert.deepEqual(L.clearLog(file), { ok: true, removed: 1 })
  assert.deepEqual(L.readLog(file), [])
})

test('run ids are unique and safe in a URL', () => {
  const ids = new Set(Array.from({ length: 200 }, () => L.newRunId()))
  assert.equal(ids.size, 200)
  for (const id of ids) assert.match(id, /^r-[a-z0-9]+$/)
})
