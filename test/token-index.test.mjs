// Tests for token-index.mjs: the running index of what the transcripts spent, kept in data/token-index.json so a
// warm refresh reads only the bytes added since the last one. On temp folders shaped like Claude Code's own
// (<claudeDir>/projects/<folder>/<session>.jsonl and <session>/subagents/agent-<id>.jsonl): an append-only file is
// read once, a torn last line waits for its end, a file that shrank or was replaced is read again from the start, a
// file that is gone is dropped (and a copy of its responses elsewhere then counts), the saved index is picked up by a
// new process, only the project's folders count, and nothing is ever written in the transcripts' folders.

import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { listTranscripts, makeTokenIndex } from '../token-index.mjs'

let root
let claude
let project
let indexFile
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-index-test-'))
  claude = path.join(root, 'claude')
  project = path.join(claude, 'projects', 'c--Users-me-my-repo')
  fs.mkdirSync(project, { recursive: true })
  indexFile = path.join(root, 'data', 'token-index.json')
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const TODAY = '2026-11-25T10:00:00.000Z'
const line = (id, output = 10, more = {}) => JSON.stringify({
  type: 'assistant', timestamp: TODAY, requestId: `req_${id}`,
  message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 } }, ...more,
}) + '\n'
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
const outputs = snap => snap.files.reduce((t, f) => t + Object.values(f.days).reduce((u, m) => u + Object.values(m).reduce((v, vec) => v + vec[1], 0), 0), 0)
const index = () => makeTokenIndex({ claudeDirs: [claude], match: 'my-repo', file: indexFile })

test('an append-only file is read once: a second refresh reads only the added bytes', async () => {
  const f = path.join(project, 's1.jsonl')
  write(f, line('a') + line('b'))
  const ix = index()
  await ix.refresh()
  assert.equal(outputs(ix.snapshot()), 20)
  const first = ix.snapshot().lastRead
  assert.equal(first.bytes, fs.statSync(f).size)
  const added = line('c', 5)
  fs.appendFileSync(f, added)
  await ix.refresh()
  assert.equal(outputs(ix.snapshot()), 25)
  assert.equal(ix.snapshot().lastRead.bytes, Buffer.byteLength(added))
  await ix.refresh()
  assert.equal(ix.snapshot().lastRead.bytes, 0)
})

test('a torn last line is left for next time, then counted once whole', async () => {
  const f = path.join(project, 's1.jsonl')
  const whole = line('torn', 7)
  write(f, line('a') + whole.slice(0, 40))
  const ix = index()
  await ix.refresh()
  assert.equal(outputs(ix.snapshot()), 10)
  fs.appendFileSync(f, whole.slice(40))
  await ix.refresh()
  assert.equal(outputs(ix.snapshot()), 17)
})

test('a partial then a final record split across two refreshes counts the final usage once', async () => {
  const f = path.join(project, 's1.jsonl')
  write(f, line('m', 3))
  const ix = index()
  await ix.refresh()
  fs.appendFileSync(f, line('m', 300))
  await ix.refresh()
  assert.equal(outputs(ix.snapshot()), 300)
})

test('a file that shrank is read again from the start', async () => {
  const f = path.join(project, 's1.jsonl')
  write(f, line('a') + line('b') + line('c'))
  const ix = index()
  await ix.refresh()
  write(f, line('z', 4))
  await ix.refresh()
  assert.equal(outputs(ix.snapshot()), 4)
})

test('a file replaced by another one is read again from the start', async () => {
  const f = path.join(project, 's1.jsonl')
  write(f, line('a'))
  const ix = index()
  await ix.refresh()
  const other = path.join(root, 'elsewhere.jsonl')
  write(other, line('x', 1) + line('y', 2) + line('w', 3))
  fs.renameSync(other, f)
  await ix.refresh()
  assert.equal(outputs(ix.snapshot()), 6)
})

test('a missing file is dropped, and a copy of its responses in another file then counts there', async () => {
  const a = path.join(project, 's1.jsonl')
  const b = path.join(claude, 'projects', 'C--Users-me-my-repo--claude-worktrees-x', 's1.jsonl') // the same session moved
  write(a, line('m1') + line('m2'))
  const ix = index()
  await ix.refresh()
  write(b, line('m1') + line('m2') + line('m3', 1))
  fs.utimesSync(b, new Date(), new Date(Date.now() + 5000))
  await ix.refresh()
  assert.equal(outputs(ix.snapshot()), 21) // m1 and m2 once, m3
  assert.equal(ix.snapshot().files.find(x => x.path === b).dupes, 2)
  fs.rmSync(a)
  await ix.refresh()
  const snap = ix.snapshot()
  assert.equal(snap.files.length, 1)
  assert.equal(outputs(snap), 21) // the copy now counts them
  assert.equal(snap.files[0].dupes, 0)
})

test('subagents carry the session that started them; other projects and other files are not read', async () => {
  write(path.join(project, 's1.jsonl'), JSON.stringify({ type: 'custom-title', customTitle: 'Master' }) + '\n' + line('a'))
  write(path.join(project, 's1', 'subagents', 'agent-x1.jsonl'), line('b', 5, { isSidechain: true }))
  write(path.join(project, 's1', 'subagents', 'agent-x1.meta.json'), '{}')
  write(path.join(project, 's1', 'tool-results', 'big.jsonl'), line('nope', 1000))
  write(path.join(claude, 'projects', 'c--Users-me-other', 's9.jsonl'), line('other', 1000))
  const listed = await listTranscripts({ claudeDirs: [claude], match: 'my-repo' })
  assert.deepEqual(listed.map(f => [path.basename(f.path), f.sessionId, f.sub]).sort(), [['agent-x1.jsonl', 's1', true], ['s1.jsonl', 's1', false]])
  const ix = index()
  await ix.refresh()
  const snap = ix.snapshot()
  assert.equal(outputs(snap), 15)
  assert.equal(snap.files.find(f => !f.sub).title, 'Master')
})

test('the saved index is picked up by a new process, which reads nothing that did not change', async () => {
  const f = path.join(project, 's1.jsonl')
  write(f, line('a') + line('b'))
  await index().refresh()
  assert.ok(fs.existsSync(indexFile))
  const again = index()
  await again.refresh()
  assert.equal(again.snapshot().lastRead.bytes, 0)
  assert.equal(outputs(again.snapshot()), 20)
  // and its de-duplication ids came back with it: a copy of a counted response is not counted again
  write(path.join(project, 's2.jsonl'), line('a'))
  await again.refresh()
  assert.equal(outputs(again.snapshot()), 20)
})

test('a saved index of another format or time zone is ignored and rebuilt', async () => {
  write(path.join(project, 's1.jsonl'), line('a'))
  write(indexFile, JSON.stringify({ version: 0, files: { bogus: {} } }))
  const ix = index()
  await ix.refresh()
  assert.equal(outputs(ix.snapshot()), 10)
  write(indexFile, '{ not json')
  const broken = index()
  await broken.refresh()
  assert.equal(outputs(broken.snapshot()), 10)
})

test('while the first build runs the snapshot says building, with a progress figure; refreshes never overlap', async () => {
  write(path.join(project, 's1.jsonl'), line('a').repeat(1) + line('b'))
  const ix = index()
  assert.equal(ix.snapshot().building, true)
  assert.equal(ix.snapshot().progress, 0)
  const one = ix.refresh()
  const two = ix.refresh()
  assert.equal(one, two)
  await one
  assert.equal(ix.snapshot().building, false)
  assert.equal(ix.snapshot().progress, 1)
  assert.ok(ix.snapshot().builtAt)
})

test('no transcripts at all: an empty, finished index', async () => {
  const ix = makeTokenIndex({ claudeDirs: [path.join(root, 'nothing-here')], match: 'my-repo', file: indexFile })
  await ix.refresh()
  assert.deepEqual(ix.snapshot().files, [])
  assert.equal(ix.snapshot().building, false)
})

test('nothing is written in the transcripts folders', async () => {
  write(path.join(project, 's1.jsonl'), line('a'))
  const before = fs.readdirSync(claude, { recursive: true }).sort()
  const ix = index()
  await ix.refresh()
  await ix.refresh()
  assert.deepEqual(fs.readdirSync(claude, { recursive: true }).sort(), before)
  assert.throws(() => makeTokenIndex({ claudeDirs: [claude], match: 'my-repo', file: path.join(claude, 'token-index.json') }), /transcripts/)
})
