// Tests for the story and glossary commands agents run: `flow say`,
// `flow say-clear` (tools/flow-cli.mjs) and `term` (tools/term-cli.mjs, behind
// tools/factory.mjs). FACTORY_DATA_DIR points at a fresh temp folder BEFORE
// the imports, so no test ever touches the real data/ folder.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'story-cli-test-'))
const F = await import('../flows.mjs')
const G = await import('../glossary.mjs')
const { runFlow, USAGE } = await import('../tools/flow-cli.mjs')
const { runTerm } = await import('../tools/term-cli.mjs')
after(() => fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true }))

const run = (...argv) => runFlow(argv, { by: 'Agent 1', cwd: ROOT })
const story = id => F.readFlow(id).output?.story
before(() => assert.equal(run('new', 'tale', 'A flow with a story', '--type', 'build').code, 0))

// ═══ flow say ═══

test('say adds a line as the --by agent with ids s1, s2, and a why when given', () => {
  assert.deepEqual(run('say', 'tale', 'Did [playwright] testing'), { out: 'tale s1: Agent 1: Did [playwright] testing', code: 0 })
  assert.equal(run('say', 'tale', 'Checked the code for [idempotency]', '--why', 'An attacker could send it twice').code, 0)
  const s = story('tale')
  assert.deepEqual(s.map(l => [l.id, l.who, l.did, l.why]), [
    ['s1', 'Agent 1', 'Did [playwright] testing', undefined],
    ['s2', 'Agent 1', 'Checked the code for [idempotency]', 'An attacker could send it twice'],
  ])
  assert.ok(s.every(l => typeof l.at === 'string'))
})

test('say takes another label with --who; a bad label is refused', () => {
  assert.equal(run('say', 'tale', 'Reviewed it', '--who', 'Agent 2').code, 0)
  assert.equal(story('tale').at(-1).who, 'Agent 2')
  const r = run('say', 'tale', 'X', '--who', 'A"B')
  assert.equal(r.code, 1)
  assert.match(r.out, /who must be a label/)
})

test('say needs a name: no --by and no --who is refused', () => {
  const r = runFlow(['say', 'tale', 'Anonymous'], { by: '', cwd: ROOT })
  assert.equal(r.code, 1)
  assert.match(r.out, /say who you are/)
  assert.equal(runFlow(['say', 'tale', 'Named', '--who', 'Agent 4'], { by: '', cwd: ROOT }).code, 0)
})

test('say refuses a line over 140 characters and a why over 160 with the plain message, and writes nothing', () => {
  const before = story('tale').length
  assert.deepEqual(run('say', 'tale', 'x'.repeat(212)), { out: 'say it shorter: at most 140 characters (this has 212)', code: 1 })
  assert.deepEqual(run('say', 'tale', 'ok', '--why', 'y'.repeat(170)), { out: '--why: say it shorter: at most 160 characters (this has 170)', code: 1 })
  assert.equal(run('say', 'tale', '   ').code, 1)
  assert.equal(story('tale').length, before)
})

test('say --id s2 --replace rewrites that line; --replace without --id, or an unknown id, is refused; a taken id without --replace too', () => {
  assert.deepEqual(run('say', 'tale', 'Checked [idempotency] again', '--id', 's2', '--replace'), { out: 'tale s2: Agent 1: Checked [idempotency] again', code: 0 })
  const s2 = story('tale').find(l => l.id === 's2')
  assert.equal(s2.did, 'Checked [idempotency] again')
  assert.equal(s2.why, undefined, 'a replaced line is rewritten whole')
  assert.match(run('say', 'tale', 'X', '--replace').out, /--replace needs --id/)
  assert.match(run('say', 'tale', 'X', '--id', 's9', '--replace').out, /has no story line s9/)
  assert.match(run('say', 'tale', 'X', '--id', 's1').out, /already has a story line s1/)
  assert.match(run('say', 'tale', 'X', '--id', 'n1').out, /--id must be s1, s2/)
})

test('say refuses a ninth line, pointing at replace and say-clear', () => {
  run('new', 'full', 'Full story', '--type', 'build')
  for (let i = 1; i <= 8; i++) assert.equal(run('say', 'full', `Line ${i}`).code, 0)
  const r = run('say', 'full', 'Line 9')
  assert.equal(r.code, 1)
  assert.match(r.out, /at most 8 lines/)
  assert.match(r.out, /say-clear/)
})

test('say-clear empties the story; say on a missing flow is refused', () => {
  assert.deepEqual(run('say-clear', 'full'), { out: 'full: story cleared', code: 0 })
  assert.deepEqual(story('full'), [])
  assert.match(run('say', 'nope', 'X').out, /No flow nope/)
  assert.match(runFlow(['say-clear', 'full'], { by: '', cwd: ROOT }).out, /say who you are/)
})

test('the usage lists say and say-clear and tells agents to mark words in square brackets', () => {
  assert.match(USAGE, /say <flow> "<what was done>" \[--why "<the reason>"\] \[--who "<label>"\] \[--id s2 --replace\]/)
  assert.match(USAGE, /say-clear <flow>/)
  assert.match(USAGE, /\[idempotency\]/)
})

test('show prints the story on stderr as Agent: did. Why? why, or says the page derives one', () => {
  const r = run('show', 'tale')
  assert.equal(r.code, 0)
  assert.match(r.err, /story: 4 lines/)
  assert.match(r.err, /\[s1\] Agent 1: Did \[playwright\] testing\n/)
  run('say', 'tale', 'Fixed it', '--why', 'Because it broke')
  assert.match(run('show', 'tale').err, /\[s5\] Agent 1: Fixed it\. Why\? Because it broke/)
  assert.match(run('show', 'full').err, /story: none yet \(the page shows one made from the steps; add yours with flow say\)/)
})

// ═══ term ═══

const term = (...argv) => runTerm(argv, { by: 'Agent 1' })

test('term saves an agent definition, with --more and --flow', () => {
  assert.deepEqual(term('Idempotency', 'Doing it twice has the same effect as doing it once.', '--more', 'So a retry is safe.', '--flow', 'tale'),
    { out: 'Saved idempotency: Doing it twice has the same effect as doing it once.', code: 0 })
  const e = G.lookup('idempotency')
  assert.equal(e.source, 'agent')
  assert.equal(e.more, 'So a retry is safe.')
  assert.deepEqual(e.seenIn, ['tale'])
})

test('term refuses an explanation over 300 characters, a more over 600, a missing explanation, a bad term or flow', () => {
  assert.deepEqual(term('cache', 'c'.repeat(301)), { out: 'say it shorter: at most 300 characters (this has 301)', code: 1 })
  assert.deepEqual(term('cache', 'ok', '--more', 'm'.repeat(601)), { out: '--more: say it shorter: at most 600 characters (this has 601)', code: 1 })
  assert.match(term('cache').out, /usage: term/)
  assert.match(term('x', 'Too short a word.').out, /2 to 40 characters/)
  assert.match(term('cache', 'ok', '--flow', 'Bad Flow').out, /flow/)
  assert.equal(G.lookup('cache'), null)
})

test('term never overwrites the user wording', () => {
  G.saveTerm({ term: 'race', short: 'My words.', source: 'you' })
  const r = term('race', 'Agent words.')
  assert.equal(r.code, 1)
  assert.match(r.out, /the user wrote their own explanation of race/)
  assert.equal(G.lookup('race').short, 'My words.')
})

test('tools/factory.mjs runs term and lists it in its usage', () => {
  const env = { ...process.env, FACTORY_DATA_DIR: process.env.FACTORY_DATA_DIR }
  const r = spawnSync(process.execPath, ['tools/factory.mjs', 'term', 'shard', 'One slice of a big table.'], { cwd: ROOT, env, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /Saved shard/)
  const u = spawnSync(process.execPath, ['tools/factory.mjs'], { cwd: ROOT, env, encoding: 'utf8' })
  assert.match(u.stdout, /term "<word>" "<plain explanation/)
})
