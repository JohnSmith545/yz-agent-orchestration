// Tests for what Predict and warn added to the token index (token-usage.mjs, token-index.mjs): per file per HOUR totals
// (the hour a reply's own timestamp falls in, as an epoch hour, so no time zone moves it), the last replies of each file
// (for the context cost warning), both kept right when a larger copy of a reply replaces a partial one in the same file
// or takes it over from another file, the snapshot that hands them on, the session label helper, and the index format
// version that makes an older saved index rebuild once.

import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { INDEX_VERSION, makeTokenIndex } from '../token-index.mjs'
import { RECENT_MAX, hourOf, newTally, sessionLabels, tallyRecord } from '../token-usage.mjs'

const HOUR = 3_600_000
const BASE = Date.parse('2026-11-25T10:00:00.000Z')
const asst = (id, { t = BASE, output = 10, read = 100, model = 'claude-opus-5-5' } = {}) => ({
  type: 'assistant', timestamp: new Date(t).toISOString(), requestId: `req_${id}`,
  message: { id, model, usage: { input_tokens: 1, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: read } },
})

test('the hour of a reply is its epoch hour, the same in every time zone', () => {
  assert.equal(hourOf(BASE), String(BASE / HOUR))
  assert.equal(hourOf(BASE + HOUR - 1), String(BASE / HOUR))
  assert.equal(hourOf(BASE + HOUR), String(BASE / HOUR + 1))
})

test('each reply is added to its hour too, per model', () => {
  const t = newTally()
  const owners = new Map()
  tallyRecord(t, asst('a', { t: BASE + 60_000 }), { self: 'f', owners })
  tallyRecord(t, asst('b', { t: BASE + 2 * 60_000, output: 5 }), { self: 'f', owners })
  tallyRecord(t, asst('c', { t: BASE + HOUR + 1, model: 'claude-sonnet-5-5' }), { self: 'f', owners })
  assert.deepEqual(t.hours[hourOf(BASE)]['claude-opus-5-5'], [2, 15, 0, 0, 200, 2])
  assert.deepEqual(t.hours[hourOf(BASE + HOUR)]['claude-sonnet-5-5'], [1, 10, 0, 0, 100, 1])
})

test('a final record that replaces a partial one in the same file moves its hour total too', () => {
  const t = newTally()
  const owners = new Map()
  tallyRecord(t, asst('m', { output: 3 }), { self: 'f', owners })
  tallyRecord(t, asst('m', { output: 300 }), { self: 'f', owners })
  assert.deepEqual(t.hours[hourOf(BASE)]['claude-opus-5-5'], [1, 300, 0, 0, 100, 1])
  assert.equal(t.recent.length, 1)
  assert.deepEqual(t.recent[0].vec, [1, 300, 0, 0, 100, 1])
})

test('a larger copy in another file takes the hour over: the first file gives its share back', () => {
  const owners = new Map()
  const a = newTally()
  const b = newTally()
  const tallies = { a, b }
  const tallyOf = f => tallies[f]
  tallyRecord(a, asst('x', { output: 0, read: 0 }), { self: 'a', owners, tallyOf })
  tallyRecord(b, asst('x', { output: 50, read: 500 }), { self: 'b', owners, tallyOf })
  assert.deepEqual(a.hours[hourOf(BASE)]['claude-opus-5-5'], [0, 0, 0, 0, 0, 0])
  assert.deepEqual(b.hours[hourOf(BASE)]['claude-opus-5-5'], [1, 50, 0, 0, 500, 1])
  assert.equal(a.recent.length, 0)
  assert.equal(b.recent.length, 1)
})

test('a file keeps only its newest replies, newest last, each with its time, model and counts', () => {
  const t = newTally()
  const owners = new Map()
  for (let i = 0; i < RECENT_MAX + 5; i++) tallyRecord(t, asst(`r${i}`, { t: BASE + i * 1000, read: i }), { self: 'f', owners })
  // one older reply read late (a file is read in order, but a copy may carry an older time): it does not push a newer one out
  tallyRecord(t, asst('old', { t: BASE - HOUR }), { self: 'f', owners })
  assert.equal(t.recent.length, RECENT_MAX)
  assert.equal(t.recent.at(-1).id, `r${RECENT_MAX + 4}`)
  assert.equal(t.recent[0].id, 'r5')
  assert.ok(!t.recent.some(r => r.id === 'old'))
  assert.equal(t.recent.at(-1).at, BASE + (RECENT_MAX + 4) * 1000)
  assert.equal(t.recent.at(-1).model, 'claude-opus-5-5')
})

test('the session label helper names a file the way Pipeline tokens does, Unnamed sessions with no name', () => {
  const files = [
    { sessionId: 's1', sub: false, title: 'Builder', mtimeMs: 1 },
    { sessionId: 's2', sub: false, title: null, mtimeMs: 1 },
    { sessionId: 's3', sub: true, title: 'ignored', mtimeMs: 1 },
  ]
  const labelOf = n => ({ master: 'Master' })[n] ?? n
  const label = sessionLabels(files, new Map([['s2', 'master']]), labelOf)
  assert.equal(label('s1'), 'Builder')
  assert.equal(label('s2'), 'Master')
  assert.equal(label('s3'), 'Unnamed sessions')
})

// ═══ the index ═══

let root
let project
let indexFile
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'predict-hours-test-'))
  project = path.join(root, 'claude', 'projects', 'c--Users-me-my-repo')
  fs.mkdirSync(project, { recursive: true })
  indexFile = path.join(root, 'data', 'token-index.json')
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const index = () => makeTokenIndex({ claudeDirs: [path.join(root, 'claude')], match: 'my-repo', file: indexFile })

test('the snapshot hands on each file its hours and its recent replies, and they survive a restart', async () => {
  fs.writeFileSync(path.join(project, 's1.jsonl'), JSON.stringify(asst('a')) + '\n' + JSON.stringify(asst('b', { t: BASE + HOUR })) + '\n')
  const ix = index()
  await ix.refresh()
  const f = ix.snapshot().files[0]
  assert.deepEqual(Object.keys(f.hours).sort(), [hourOf(BASE), hourOf(BASE + HOUR)])
  assert.deepEqual(f.recent.map(r => r.id), ['a', 'b'])
  const again = index()
  await again.refresh()
  assert.deepEqual(again.snapshot().files[0].recent.map(r => r.id), ['a', 'b'])
})

test('the index format is version 3, and a saved version 2 index (no hours) is read again from the start once', async () => {
  assert.equal(INDEX_VERSION, 3)
  fs.writeFileSync(path.join(project, 's1.jsonl'), JSON.stringify(asst('a')) + '\n')
  const file = path.join(project, 's1.jsonl')
  const st = fs.statSync(file)
  fs.mkdirSync(path.dirname(indexFile), { recursive: true })
  const tally = { days: {}, counted: {}, title: null, skipped: 0, dupes: 0, special: 0, dupOf: [] }
  const old = { version: 2, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local', files: { [file]: { sessionId: 's1', sub: false, size: st.size, mtimeMs: st.mtimeMs, ident: 'x', offset: st.size, tally } } }
  fs.writeFileSync(indexFile, JSON.stringify(old))
  const ix = index()
  await ix.refresh()
  assert.equal(ix.snapshot().lastRead.bytes, st.size)
  assert.ok(ix.snapshot().files[0].hours[hourOf(BASE)])
  assert.equal(JSON.parse(fs.readFileSync(indexFile, 'utf8')).version, 3)
})
