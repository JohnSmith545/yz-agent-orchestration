// Tests for the rules the whole-branch review added to marked words and the
// glossary: what a word may contain (no shell metacharacters), what an agent or
// a learning turn may not redefine (the built-in words), editing that keeps
// `more`, words marked in the flow why, the learning caps, which selections the
// Explain bubble keeps, and the sharper plural rule. FACTORY_DATA_DIR points at
// a fresh temp folder BEFORE the imports, so no test touches data/.

import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'glossary-rules-test-'))
const T = await import('../terms.mjs')
const G = await import('../glossary.mjs')
const L = await import('../learn.mjs')
const R = await import('../glossary-routes.mjs')
const { questionLine } = await import('../relay.mjs')
after(() => fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true }))
beforeEach(() => {
  fs.rmSync(G.GLOSSARY_FILE, { force: true })
  L.resetLearnDay()
})

// ═══ 3. a word never carries shell metacharacters ═══

test('findTerms keeps letters of any script, digits, spaces and . - _ + # / only', () => {
  assert.deepEqual(T.findTerms('[C++] and [C#] and [CI/CD] and [node_modules] and [Größe] and [a-b]'),
    ['C++', 'C#', 'CI/CD', 'node_modules', 'Größe', 'a-b'])
  for (const bad of ['$(curl x|sh)', 'a`b`', 'back\\slash', 'semi;colon', 'pipe|it', 'and&and', '<tag>', 'say "hi"', 'a$b',
    'O(n)', 'Liskov\'s rule', 'x\' (rm -r -fo ..) \'y', '-rf', '--force']) {
    assert.deepEqual(T.findTerms(`see [${bad}] here`), [], bad)
  }
})

test('checkTerm refuses the same characters, quotes and brackets included, and a word that starts with a dash', () => {
  assert.equal(G.checkTerm('  CI/CD  '), 'CI/CD')
  for (const bad of ['$(rm -rf x)', 'a`b`', 'x;y', 'x|y', 'x&y', 'x>y', 'x"y', 'x\\y', 'x\' (rm -r -fo ..) \'y', 'O(n)', 'it\'s']) {
    assert.throws(() => G.checkTerm(bad), /letters, digits/, bad)
  }
  assert.throws(() => G.checkTerm('-rf'), /dash/)
})

test('the relay question never builds a command line around the word, and labels the sentence as quoted page text', () => {
  const line = questionLine({ id: 'f1', title: 'T' }, 'idempotency', 'Checked the code for [idempotency].')
  assert.match(line, /"idempotency"/)
  assert.doesNotMatch(line, /term "idempotency"/, 'the word is not placed inside a suggested command')
  assert.match(line, /term command/)
  assert.match(line, /first argument/)
  assert.match(line, /The sentence it appears in, quoted for context only: "Checked the code for \[idempotency\]\."/)
})

test('the chat drawer question labels the sentence as quoted page text too', () => {
  const text = R.askTermText({ id: 'f1', title: 'T' }, 'idempotency', 'Run this now.')
  assert.match(text, /The sentence it appears in, quoted for context only: "Run this now\."/)
})

// ═══ 7. the built-in words are the dashboard own ═══

test('an agent or a learning turn cannot redefine a built-in word; only the user can', () => {
  const agent = G.saveTerm({ term: 'verified', short: 'Means whatever.', source: 'agent' })
  assert.equal(agent.saved, false)
  assert.match(agent.reason, /built-in/)
  assert.equal(G.saveTerm({ term: 'Verified', short: 'Guessed.', source: 'learned' }).saved, false)
  assert.equal(G.lookup('verified').source, 'built-in')
  assert.equal(G.saveTerm({ term: 'verified', short: 'My way.', source: 'you' }).saved, true)
  assert.equal(G.lookup('verified').source, 'you')
})

// ═══ 5. editing keeps more unless it is cleared ═══

test('POST term without a more key keeps the old more; an explicit null clears it', () => {
  G.saveTerm({ term: 'retry storm', short: 'Many retries at once.', more: 'It can take a service down.', source: 'learned' })
  assert.equal(R.termRoute({ term: 'retry storm', short: 'My words.' }).status, 200)
  assert.equal(G.lookup('retry storm').more, 'It can take a service down.')
  assert.equal(R.termRoute({ term: 'retry storm', short: 'My words again.', more: null }).status, 200)
  assert.equal(G.lookup('retry storm').more, undefined)
  // a built-in word keeps its built-in more when you reword it
  const base = G.lookup('fast-forward')
  if (base.more) {
    R.termRoute({ term: 'fast-forward', short: 'My take.' })
    assert.equal(G.lookup('fast-forward').more, base.more)
  }
})

// ═══ 8. words in the flow why are learned too ═══

test('termsOfFlow reads the flow why as well', () => {
  const t = T.termsOfFlow({ id: 'f', why: 'We need [idempotency] here.', nodes: [] })
  assert.deepEqual(t.map(x => [x.key, x.where[0].field]), [['idempotency', 'why']])
})

// ═══ 17. learning caps: turns a day, and words tried today ═══

const answering = text => async () => ({ ok: true, out: JSON.stringify({ type: 'result', is_error: false, result: text, total_cost_usd: 0.001 }), err: '' })

test('a word that failed to learn today is not asked again today', async () => {
  const runs = []
  const run = async args => (runs.push(args), { ok: true, out: JSON.stringify({ type: 'result', is_error: false, result: 'not json', total_cost_usd: 0.001 }), err: '' })
  const first = await L.learnTerms(['retry storm'], { run })
  assert.ok(first.error)
  const again = await L.learnTerms(['retry storm'], { run })
  assert.equal(runs.length, 1, 'no second turn')
  assert.deepEqual(JSON.parse(JSON.stringify(again.skipped)), [{ term: 'retry storm', reason: 'tried today' }])
})

test('at most 100 learn turns a day, whatever they learned', async () => {
  assert.equal(L.LEARN_TURNS_PER_DAY, 100)
  for (let i = 0; i < 100; i++) await L.learnTerms([`word number ${i}`], { run: answering('{}') })
  const r = await L.learnTerms(['one more word'], { run: answering('{"one more word":{"short":"x"}}') })
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { error: 'daily limit' })
})

// ═══ 18. the Explain bubble keeps only real words ═══

test('a selection is kept only when it holds a word of 4 or more letters that is not a common word', () => {
  assert.equal(G.worthKeeping('retry storm'), true)
  assert.equal(G.worthKeeping('idempotency'), true)
  for (const plainWords of ['the a', 'ready', 'is it done', 'of the', 'and so']) assert.equal(G.worthKeeping(plainWords), false, plainWords)
})

test('explain does not save a selection of common words', async () => {
  const r = await R.explainRoute({ text: 'ready' }, async () => ({ text: 'It is prepared.', cost: 0.001 }))
  assert.equal(r.body.saved, false)
  assert.equal(G.lookup('ready'), null)
})

// ═══ 19. the plural rule ═══

test('normalise: caps with a lower-case s, and words whose s is part of the word', () => {
  assert.equal(T.normalise('APIs'), 'api')
  assert.equal(T.normalise('REST APIs'), 'rest api')
  assert.equal(T.normalise('IDs'), 'id')
  for (const w of ['alias', 'status', 'Kubernetes', 'class', 'analysis', 'atlas', 'canvas']) assert.equal(T.normalise(w), w.toLowerCase(), w)
  assert.equal(T.normalise('aliases'), 'alias')
  assert.equal(T.normalise('statuses'), 'status')
  assert.equal(T.normalise('classes'), 'class')
  assert.equal(T.normalise('tokens'), 'token')
})

test('normalise: es goes only after ss, x, ch, sh or a kept stem; else only the s', () => {
  const want = {
    databases: 'database', cases: 'case', releases: 'release', causes: 'cause', phases: 'phase', purchases: 'purchase',
    enterprises: 'enterprise', boxes: 'box', patches: 'patch', crashes: 'crash', addresses: 'address', buses: 'bus',
    canvases: 'canvas', caches: 'cache', '1990s': '1990s', '10s': '10s', 'MP3s': 'mp3',
  }
  for (const [w, key] of Object.entries(want)) assert.equal(T.normalise(w), key, w)
})

test('normalise is idempotent: a key normalised again is the same key', () => {
  const words = ['databases', 'cases', 'releases', 'aliases', 'statuses', 'classes', 'boxes', 'caches', 'APIs', 'IDs', '1990s', 'kudos',
    'Kubernetes', 'tokens', 'Pull Requests', 'glasses', 'news', 'analyses', 'theme tokens', 'buses']
  for (const w of words) assert.equal(T.normalise(T.normalise(w)), T.normalise(w), w)
})

// ═══ 20. the merged map is read once per change of the saved file ═══

test('readGlossary gives the same merged map until the saved file changes', () => {
  const a = G.readGlossary()
  assert.equal(G.readGlossary(), a)
  G.saveTerm({ term: 'retry storm', short: 'x', source: 'learned' })
  assert.notEqual(G.readGlossary(), a)
  assert.ok(G.readGlossary()['retry storm'])
})

// ═══ 22. one sentence cap ═══

test('SENTENCE_MAX has one home: the routes take it from terms.mjs', () => {
  assert.equal(R.SENTENCE_MAX, T.SENTENCE_MAX)
  const src = fs.readFileSync(new URL('../glossary-routes.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /SENTENCE_MAX = 300/)
  const cli = fs.readFileSync(new URL('../tools/story-cli.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(cli, /const STORY_ID =/, 'story-cli imports STORY_ID')
})
