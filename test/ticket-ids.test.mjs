// Ticket ids (ticket-ids.mjs). Two modes:
//   known prefixes (config.ticketPrefixes, or the ones the ticket sources use):
//     only those prefixes count, in any case, in text and in branch names;
//   none known: a generic shape, with guards against words that only look like ids.
// ABC, XYZ and OPS are made-up trackers.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { compareTickets, idsInBranch, idsInText, knownPrefixes, mayHoldTicketId } from '../ticket-ids.mjs'

const P = ['ABC', 'XYZ']

// ═══ known prefixes ═══

test('known prefixes: text ids in any case, upper-cased, each once in order', () => {
  assert.deepEqual(idsInText('fix: ABC-120 and xyz-10, then abc-120 again', P), ['ABC-120', 'XYZ-10'])
  assert.deepEqual(idsInText('cd .claude/worktrees/abc-120-x && npm test', P), ['ABC-120'])
})

test('known prefixes: other id-like words are not tickets', () => {
  assert.deepEqual(idsInText('OPS-7, AES-256, HTTP-2, STEP-2 and ABC-1', P), ['ABC-1'])
})

test('known prefixes: a third prefix works once it is listed', () => {
  assert.deepEqual(idsInText('ops-7 done', ['OPS']), ['OPS-7'])
  assert.deepEqual(idsInBranch('feat/ops-7-x', ['OPS']), ['OPS-7'])
})

test('known prefixes: branch runs expand, anywhere in the name', () => {
  assert.deepEqual(idsInBranch('abc-120-122-login', P), ['ABC-120', 'ABC-122'])
  assert.deepEqual(idsInBranch('fix/xyz-10-11-12-login', P), ['XYZ-10', 'XYZ-11', 'XYZ-12'])
  assert.deepEqual(idsInBranch('feat/gone-ABC-9004', P), ['ABC-9004'])
  assert.deepEqual(idsInBranch('feat/step-2-abc-12', P), ['ABC-12'])
})

test('known prefixes: branches without one of them carry no ids', () => {
  for (const b of ['backup/feat-email-wip-2026-07-17', 'fix/step-2', 'release-2026-11', 'renovate/node-20', 'worktree-agent-4821', 'followup', ''])
    assert.deepEqual(idsInBranch(b, P), [], b)
})

// ═══ no prefixes known: the generic shape ═══

test('generic: an upper-case prefix of letters, a dash, a number', () => {
  assert.deepEqual(idsInText('fix: ABC-120 and XYZ-10, then ABC-120 again'), ['ABC-120', 'XYZ-10'])
  assert.deepEqual(idsInText('ops: OPS-7 done'), ['OPS-7'])
})

test('generic: lower case, single letters, digits in the prefix and leading zeros are not ids', () => {
  assert.deepEqual(idsInText('claude-opus-5-5 on node-20, step-3 of 4'), [])
  assert.deepEqual(idsInText('plan A-1 and B-2, priority P0-1, record ADR-014'), [])
  assert.deepEqual(idsInText(undefined), [])
})

test('generic: standards, protocols and model names are not ids', () => {
  assert.deepEqual(idsInText('UTF-8, SHA-256, ISO-8601, AES-256, HTTP-2, RFC-7231, CVE-2024, GPT-4 next to ABC-1'), ['ABC-1'])
})

test('generic: a branch id only at the start of a path segment', () => {
  assert.deepEqual(idsInBranch('abc-120-122-login'), ['ABC-120', 'ABC-122'])
  assert.deepEqual(idsInBranch('fix/xyz-10-11-12-login'), ['XYZ-10', 'XYZ-11', 'XYZ-12'])
  assert.deepEqual(idsInBranch('feat/ops-7'), ['OPS-7'])
  assert.deepEqual(idsInBranch('feat/login-page-2'), [])
  assert.deepEqual(idsInBranch('worktree-agent-4821'), [])
  assert.deepEqual(idsInBranch('backup/feat-email-wip-2026-07-17'), [])
})

test('generic: dates, versions, runtimes and step words are not branch ids', () => {
  for (const b of ['wip-2026-07-17', 'release-2026-11', 'v2-0', 'renovate/node-20', 'utf-8', 'fix/step-2', 'feat/v2-login', 'followup', '', null])
    assert.deepEqual(idsInBranch(b), [], String(b))
})

test('mayHoldTicketId: a cheap pre-check before a transcript line is parsed', () => {
  assert.equal(mayHoldTicketId('{"input":"git commit -m fix: OPS-7"}'), true)
  assert.equal(mayHoldTicketId('{"input":"npm test"}'), false)
  assert.equal(mayHoldTicketId('{"input":"cd worktrees/abc-12-x"}', P), true)
  assert.equal(mayHoldTicketId('{"input":"OPS-7"}', P), false)
})

// ═══ which prefixes are known ═══

test('knownPrefixes: the configured list wins, upper-cased, in its order', () => {
  assert.deepEqual(knownPrefixes({ configured: ['xyz', 'ABC'], collections: [{ filter: { prefix: 'OPS' } }], sourceIds: ['OPS-1'] }), ['XYZ', 'ABC'])
  assert.deepEqual(knownPrefixes({ configured: [], collections: [{ filter: { prefix: 'OPS' } }] }), [], 'an empty list asks for the generic shape')
})

test('knownPrefixes: without a list, the collection filters then the source ids, each once', () => {
  const collections = [{ filter: { prefix: 'XYZ' } }, { id: 'no-filter' }, { filter: { prefix: 'ABC' } }]
  assert.deepEqual(knownPrefixes({ collections, sourceIds: ['OPS-2', 'ABC-1', 'OPS-1', 'not an id'] }), ['XYZ', 'ABC', 'OPS'])
  assert.deepEqual(knownPrefixes({}), [])
})

// ═══ ticket order ═══

test('compareTickets: by the prefix order given, then alphabetical, newest number first', () => {
  const ids = ['ABC-1', 'OPS-5', 'XYZ-2', 'ABC-12', 'DEF-3', 'XYZ-10']
  const sorted = ids.map(id => ({ id })).sort((a, b) => compareTickets(a, b, ['XYZ', 'ABC'])).map(t => t.id)
  assert.deepEqual(sorted, ['XYZ-10', 'XYZ-2', 'ABC-12', 'ABC-1', 'DEF-3', 'OPS-5'])
  const plain = ids.map(id => ({ id })).sort((a, b) => compareTickets(a, b, [])).map(t => t.id)
  assert.deepEqual(plain, ['ABC-12', 'ABC-1', 'DEF-3', 'OPS-5', 'XYZ-10', 'XYZ-2'])
})
