// Tests for glossary.mjs: the shipped word list (public/glossary.json) merged
// with the words the dashboard learned (data/glossary.json). FACTORY_DATA_DIR
// points at a fresh temp folder BEFORE the import, so no test ever touches the
// real data/ folder.

import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'glossary-store-test-'))
const G = await import('../glossary.mjs')
after(() => fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true }))
beforeEach(() => fs.rmSync(G.GLOSSARY_FILE, { force: true }))

const stored = () => JSON.parse(fs.readFileSync(G.GLOSSARY_FILE, 'utf8'))

test('the learned file follows FACTORY_DATA_DIR', () => {
  assert.equal(G.GLOSSARY_FILE, path.join(process.env.FACTORY_DATA_DIR, 'glossary.json'))
})

test('readGlossary holds every shipped entry as built-in, keyed by its normalised word', () => {
  const g = G.readGlossary()
  assert.equal(g['worktree'].source, 'built-in')
  assert.equal(g['worktree'].term, 'worktree')
  assert.ok(g['fast forward'], 'fast-forward is keyed with a space')
  assert.equal(g['fast forward'].term, 'fast-forward')
})

test('saveTerm writes a learned entry and lookup finds it by any spelling', () => {
  const r = G.saveTerm({ term: 'Idempotency', short: 'Doing it twice has the same effect as once.', source: 'learned', flowId: 'dark-mode' })
  assert.equal(r.saved, true)
  assert.equal(r.entry.key, 'idempotency')
  const file = stored()
  assert.deepEqual(Object.keys(file), ['idempotency'])
  assert.equal(file.idempotency.term, 'Idempotency')
  assert.equal(file.idempotency.source, 'learned')
  assert.deepEqual(file.idempotency.seenIn, ['dark-mode'])
  assert.ok(file.idempotency.at)
  assert.equal(G.lookup('  idempotency. ').short, 'Doing it twice has the same effect as once.')
})

test('your own entry wins over a shipped one with the same key', () => {
  G.saveTerm({ term: 'worktree', short: 'My own words for it.', source: 'you' })
  assert.equal(G.readGlossary().worktree.short, 'My own words for it.')
  assert.equal(G.lookup('Worktree').source, 'you')
})

test('the user wording is never overwritten by an agent or by learning; an agent never by learning', () => {
  G.saveTerm({ term: 'race', short: 'Mine.', source: 'you' })
  assert.equal(G.saveTerm({ term: 'race', short: 'Agent.', source: 'agent' }).saved, false)
  assert.equal(G.saveTerm({ term: 'Race', short: 'Learned.', source: 'learned' }).saved, false)
  assert.equal(stored().race.short, 'Mine.')
  G.saveTerm({ term: 'cache', short: 'Agent words.', source: 'agent' })
  assert.equal(G.saveTerm({ term: 'cache', short: 'Learned.', source: 'learned' }).saved, false)
  assert.equal(G.saveTerm({ term: 'cache', short: 'Agent again.', source: 'agent' }).saved, true)
  assert.equal(G.saveTerm({ term: 'cache', short: 'Yours.', source: 'you' }).saved, true)
  assert.equal(stored().cache.short, 'Yours.')
})

test('saveTerm refuses a bad term, an empty or long explanation, and an unknown source', () => {
  for (const bad of [
    { term: 'x', short: 'ok', source: 'agent' },
    { term: 'y'.repeat(41), short: 'ok', source: 'agent' },
    { term: 'two\nlines', short: 'ok', source: 'agent' },
    { term: 'fine', short: '', source: 'agent' },
    { term: 'fine', short: 'z'.repeat(301), source: 'agent' },
    { term: 'fine', short: 'ok', more: 'm'.repeat(601), source: 'agent' },
    { term: 'fine', short: 'ok', source: 'built-in' },
    { term: 'fine', short: 'ok', source: 'agent', flowId: 'Not A Slug' },
  ]) assert.throws(() => G.saveTerm(bad), /./, JSON.stringify(bad).slice(0, 80))
  assert.equal(fs.existsSync(G.GLOSSARY_FILE), false)
})

test('seenIn gains each flow once and keeps the 20 most recent', () => {
  for (let i = 1; i <= 23; i++) G.saveTerm({ term: 'shard', short: `Take ${i}.`, source: 'agent', flowId: `f${i}` })
  G.saveTerm({ term: 'shard', short: 'Again.', source: 'agent', flowId: 'f23' })
  const seen = stored().shard.seenIn
  assert.equal(seen.length, 20)
  assert.equal(seen[0], 'f4')
  assert.equal(seen.at(-1), 'f23')
})

test('markSeen adds a flow to entries already stored and leaves built-in ones alone', () => {
  G.saveTerm({ term: 'replay', short: 'Sending it again.', source: 'learned', flowId: 'a' })
  G.markSeen(['replay', 'worktree', 'unknown word'], 'b')
  const file = stored()
  assert.deepEqual(file.replay.seenIn, ['a', 'b'])
  assert.equal(file.worktree, undefined)
})

test('removeTerm removes a stored entry, falls back to the built-in one, and refuses a built-in or unknown key', () => {
  G.saveTerm({ term: 'worktree', short: 'Mine.', source: 'you' })
  G.saveTerm({ term: 'replay', short: 'Again.', source: 'agent' })
  assert.deepEqual(G.removeTerm('Worktree'), { removed: 'worktree', fallback: G.readGlossary().worktree })
  assert.equal(G.lookup('worktree').source, 'built-in')
  assert.equal(G.removeTerm('replay').removed, 'replay')
  assert.equal(G.lookup('replay'), null)
  assert.throws(() => G.removeTerm('worktree'), /built-in/)
  assert.throws(() => G.removeTerm('never seen'), /no saved entry/)
})

test('related gives the nearest entries by shared words, never the word itself, at most n', () => {
  G.saveTerm({ term: 'idempotency key', short: 'A unique id sent with a request so a repeat is ignored.', source: 'agent' })
  G.saveTerm({ term: 'retry', short: 'Sending a request again after it failed.', source: 'agent' })
  G.saveTerm({ term: 'sql injection', short: 'Text that changes a database query.', source: 'agent' })
  const near = G.related('idempotency', 5)
  assert.equal(near[0].key, 'idempotency key')
  assert.ok(!near.some(e => e.key === 'idempotency'))
  assert.ok(near.length <= 5)
  for (const e of near) assert.deepEqual(Object.keys(e).sort(), ['key', 'short', 'term'])
  assert.deepEqual(G.related('request repeat', 1).map(e => e.key), ['idempotency key'])
  assert.deepEqual(G.related('zzzz qqqq'), [])
})

test('learnedToday counts the learned entries saved on the local day', () => {
  G.saveTerm({ term: 'alpha', short: 'A.', source: 'learned' })
  G.saveTerm({ term: 'beta', short: 'B.', source: 'agent' })
  const file = stored()
  file.gamma = { term: 'gamma', short: 'G.', source: 'learned', at: '2020-01-01T10:00:00Z', seenIn: [] }
  fs.writeFileSync(G.GLOSSARY_FILE, JSON.stringify(file))
  assert.equal(G.learnedToday(), 1)
})

test('a broken learned file reads as empty and the shipped list still answers', () => {
  fs.mkdirSync(path.dirname(G.GLOSSARY_FILE), { recursive: true })
  fs.writeFileSync(G.GLOSSARY_FILE, '{ not json')
  assert.equal(G.lookup('worktree').source, 'built-in')
  assert.equal(G.lookup('zzz'), null)
})

test('entriesList gives every merged entry with key, term, short, more, source, at and seenIn, sorted by key', () => {
  G.saveTerm({ term: 'replay', short: 'Again.', more: 'Once more.', source: 'agent', flowId: 'x' })
  const list = G.entriesList()
  assert.deepEqual(list.map(e => e.key), [...list.map(e => e.key)].sort())
  const replay = list.find(e => e.key === 'replay')
  assert.deepEqual({ ...replay, at: typeof replay.at }, { key: 'replay', term: 'replay', short: 'Again.', more: 'Once more.', source: 'agent', at: 'string', seenIn: ['x'] })
  const wt = list.find(e => e.key === 'worktree')
  assert.equal(wt.source, 'built-in')
  assert.equal(wt.at, null)
  assert.deepEqual(wt.seenIn, [])
})
