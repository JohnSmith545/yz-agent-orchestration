// Tests for terms.mjs: the technical words an agent marks in square brackets
// ([idempotency]) so the dashboard can explain them. Pure functions, no data.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { findTerms, normalise, termsOfFlow } from '../terms.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const fixture = name => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', name + '.json'), 'utf8'))

// ═══ findTerms ═══

test('findTerms returns the marked words in order, trimmed', () => {
  assert.deepEqual(findTerms('Checked the code for [idempotency], then [ SQL injection ].'), ['idempotency', 'SQL injection'])
})

test('findTerms gives each word once, the first spelling kept', () => {
  assert.deepEqual(findTerms('[Token] then [tokens] then [token]'), ['Token'])
})

test('findTerms skips a markdown link and an image', () => {
  assert.deepEqual(findTerms('See [the guide](https://example.com) and ![a shot](x.png) for [caching]'), ['caching'])
})

test('findTerms skips checkboxes and anything under 2 or over 40 characters', () => {
  assert.deepEqual(findTerms('- [ ] todo\n- [x] done\n- [X] done\n[a] [' + 'y'.repeat(41) + '] [ok]'), ['ok'])
  assert.deepEqual(findTerms('[' + 'z'.repeat(40) + ']'), ['z'.repeat(40)])
})

test('findTerms skips the kind prefixes of the diagram language', () => {
  assert.deepEqual(findTerms('[actor] User -> [store] Reports; [decision] Ok? -> [box] Job; [Actor] x; [rate limit]'), ['rate limit'])
})

test('findTerms never spans a line break, and empty or odd input is no terms', () => {
  assert.deepEqual(findTerms('[half\nterm] and [whole]'), ['whole'])
  for (const v of [undefined, null, '', 42, {}, '[]', '[  ]', 'no marks at all']) assert.deepEqual(findTerms(v), [], String(v))
})

test('findTerms ignores a nested bracket and a reference link', () => {
  assert.deepEqual(findTerms('[[wiki]] and [ref][1] and [cache key]'), ['wiki', 'cache key'])
})

// ═══ normalise ═══

test('normalise lower-cases and collapses spaces and hyphens into one space', () => {
  assert.equal(normalise('  Fast-Forward  '), 'fast forward')
  assert.equal(normalise('merge   base'), 'merge base')
  assert.equal(normalise('SQL -- injection'), 'sql injection')
})

test('normalise strips a plural s only from a stem of 4 or more that does not end in ss', () => {
  assert.equal(normalise('tokens'), 'token')
  assert.equal(normalise('Pull Requests'), 'pull request')
  assert.equal(normalise('runs'), 'runs', 'stem run is under 4')
  assert.equal(normalise('pass'), 'pass')
  assert.equal(normalise('access'), 'access')
  assert.equal(normalise('idempotency'), 'idempotency')
})

test('normalise keeps words ending in us or is (status, analysis), which are not plurals', () => {
  assert.equal(normalise('status'), 'status')
  assert.equal(normalise('analysis'), 'analysis')
})

test('normalise drops edge punctuation and quotes, and gives empty for nothing', () => {
  assert.equal(normalise('"Worktree".'), 'worktree')
  assert.equal(normalise('(idempotency)'), 'idempotency')
  assert.equal(normalise(''), '')
  assert.equal(normalise(undefined), '')
})

// ═══ termsOfFlow ═══

test('termsOfFlow finds the marked words in the story, summary, test steps, nodes and asks, with where each was seen', () => {
  const flow = {
    id: 'x', title: 'T', agent: 'Agent 1', status: 'open',
    output: {
      story: [{ id: 's1', who: 'Agent 1', did: 'Checked for [idempotency]', why: 'An [attacker] could replay it' }],
      summary: 'Now every write is [idempotent]. Second sentence with [idempotency] again.',
      testing: [{ id: 't1', do: 'Send the request twice with one [idempotency key]', expect: 'One row, no [race]' }],
    },
    nodes: [
      { id: 'n1', type: 'step', title: 'Add a [unique index]', why: 'Stops a [race]' },
      { id: 'n2', type: 'ask', title: 'Turn on [rate limiting]?', yes: 'Use the [token bucket]', no: 'Leave it' },
      { id: 'n3', type: 'note', title: 'Nothing marked here' },
    ],
  }
  const terms = termsOfFlow(flow)
  assert.deepEqual(terms.map(t => t.term), ['idempotency', 'attacker', 'idempotent', 'idempotency key', 'race', 'unique index', 'rate limiting', 'token bucket'])
  const idem = terms.find(t => t.key === 'idempotency')
  assert.deepEqual(idem.where.map(w => w.field), ['story s1 did', 'summary'])
  assert.equal(idem.where[1].sentence, 'Second sentence with [idempotency] again.', 'the sentence it was in, not the whole field')
  assert.deepEqual(terms.find(t => t.key === 'race').where.map(w => w.field), ['testing t1 expect', 'node n1 why'])
  assert.deepEqual(terms.find(t => t.key === 'token bucket').where.map(w => w.field), ['node n2 yes'])
})

test('termsOfFlow on the no-visual fixture finds the word marked in a node title; a flow with nothing marked has none', () => {
  const terms = termsOfFlow(fixture('no-visual'))
  assert.deepEqual(terms.map(t => t.key), ['service account'])
  assert.deepEqual(termsOfFlow({ id: 'y', nodes: [] }), [])
  assert.deepEqual(termsOfFlow(null), [])
})

test('termsOfFlow on the dark-mode fixture finds the story words and the test-step word', () => {
  const keys = termsOfFlow(fixture('dark-mode')).map(t => t.key)
  assert.ok(keys.includes('theme token'), keys.join(', '))
  assert.ok(keys.includes('local storage'), keys.join(', '))
  assert.ok(keys.includes('prefers color scheme'), keys.join(', '))
})

test('termsOfFlow caps a seen-in sentence at 300 characters', () => {
  const long = 'word '.repeat(100) + '[cache]' + ' more'.repeat(40)
  const [t] = termsOfFlow({ id: 'z', output: { summary: long }, nodes: [] })
  assert.ok(t.where[0].sentence.length <= 300)
  assert.match(t.where[0].sentence, /\[cache\]/)
})
