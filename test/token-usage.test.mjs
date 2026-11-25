// Tests for token-usage.mjs, the pure half of Pipeline tokens: one transcript record read as one API response (or
// skipped), the de-duplication rule proved on a real trimmed example (two records of one streamed response with the
// same usage; a partial record then its final one with more output), the four token kinds, local days, the price
// table (defaults, the user's own, exact and prefix matches, none), the estimate, and the whole block's numbers:
// the period edges at local midnight, subagents under the session that started them, renamed and unnamed sessions,
// the per job average on Pipeline time's own count, the cache share and the dashboard's own runs beside it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_PRICES, I, O, W5, W1, R, N, costOf, localDay, newTally, priceFor, priceTable, responseOf, tallyRecord, tokenStats,
} from '../token-usage.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REAL = fs.readFileSync(path.join(HERE, 'fixtures', 'tokens-real-trimmed.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
// the same reply in a forked session (0 / 0 / 0 / 0) and in its own session (2 / 1,989 / 1,125 / 246,176), trimmed
const [FORK_COPY, OWN_COPY] = fs.readFileSync(path.join(HERE, 'fixtures', 'tokens-real-fork-copy.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))

const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime()
const asst = (id, { t = at(2026, 11, 25), model = 'claude-opus-5-5', input = 1, output = 10, w5 = 0, w1 = 0, read = 0, side = false, extra = {} } = {}) => ({
  type: 'assistant', isSidechain: side, timestamp: new Date(t).toISOString(), requestId: `req_${id}`,
  message: { id, model, usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: w5 + w1, cache_read_input_tokens: read, cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 }, ...extra } },
})

// ═══ one record ═══

test('an assistant record with usage is one response with the four kinds, cache writes split by lifetime', () => {
  const r = responseOf(REAL[1])
  assert.equal(r.kind, 'usage')
  assert.equal(r.id, 'msg_011CgAzov9sFnFpbv26CjZoZ')
  assert.equal(r.model, 'claude-opus-5-5')
  assert.equal(r.at, Date.parse('2026-10-19T04:53:19.923Z'))
  // new input 2, output 342, cache writes 0 for 5 minutes and 35,374 for an hour, cache reads 29,974
  assert.deepEqual(r.vec, [2, 342, 0, 35374, 29974, 1])
})

test('cache writes with no split count as 5 minute writes, and a split that does not add up gives the rest to them', () => {
  const plain = responseOf({ ...asst('a'), message: { id: 'a', model: 'm', usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 50, cache_read_input_tokens: 7 } } })
  assert.deepEqual(plain.vec, [1, 2, 50, 0, 7, 1])
  const odd = responseOf(asst('b', { w5: 10, w1: 20, extra: { cache_creation_input_tokens: 40 } }))
  assert.deepEqual(odd.vec, [1, 10, 20, 20, 0, 1])
})

test('a record with no usage, or no time, is skipped; a synthetic reply and any other record are not responses', () => {
  assert.equal(responseOf({ type: 'assistant', timestamp: '2026-11-25T10:00:00Z', message: { id: 'x', model: 'claude-opus-5-5' } }).kind, 'skip')
  assert.equal(responseOf({ type: 'assistant', message: { id: 'x', model: 'm', usage: { input_tokens: 1, output_tokens: 1 } } }).kind, 'skip')
  assert.equal(responseOf({ type: 'assistant', timestamp: '2026-11-25T10:00:00Z', message: { id: 'x', usage: { input_tokens: 'many', output_tokens: 1 } } }).kind, 'skip')
  assert.equal(responseOf({ ...asst('s'), message: { ...asst('s').message, model: '<synthetic>' } }), null)
  assert.equal(responseOf({ type: 'user', message: { usage: {} } }), null)
  assert.equal(responseOf(null), null)
  assert.equal(responseOf('text'), null)
})

test('a record with no message id falls back to its request id; with neither it is skipped', () => {
  const r = asst('m1')
  delete r.message.id
  assert.equal(responseOf(r).id, 'req_m1')
  delete r.requestId
  assert.equal(responseOf(r).kind, 'skip')
})

test('the day is the local day of the record', () => {
  assert.equal(localDay(at(2026, 11, 25, 0, 0)), '2026-11-25')
  assert.equal(localDay(at(2026, 11, 24, 23, 59)), '2026-11-24')
})

// ═══ the de-duplication rule, on the real example ═══

test('REAL: two records of one streamed response with the same usage count once', () => {
  const owners = new Map()
  const t = newTally()
  for (const rec of REAL.slice(0, 3)) tallyRecord(t, rec, { self: 'main.jsonl', owners })
  const day = localDay(Date.parse('2026-10-19T04:53:19.923Z'))
  assert.deepEqual(t.days[day]['claude-opus-5-5'], [2, 342, 0, 35374, 29974, 1])
  assert.deepEqual(Object.keys(t.counted), ['msg_011CgAzov9sFnFpbv26CjZoZ'])
  assert.equal(t.title, 'indepenent') // the custom-title record names the session
})

test('REAL: a partial record then the final one of the same response counts the final usage once', () => {
  const owners = new Map()
  const t = newTally()
  for (const rec of REAL.slice(3)) tallyRecord(t, rec, { self: 'sub.jsonl', owners })
  const day = localDay(Date.parse('2026-10-14T03:09:19.361Z'))
  assert.deepEqual(t.days[day]['claude-opus-5-5'], [2, 300, 30456, 0, 24394, 1])
})

test('the same response in another file counts once, for the file that read it first, and the other notes the overlap', () => {
  const owners = new Map()
  const a = newTally()
  const b = newTally()
  tallyRecord(a, asst('m1', { output: 5 }), { self: 'a', owners })
  tallyRecord(b, asst('m1', { output: 5 }), { self: 'b', owners })
  tallyRecord(b, asst('m2', { output: 7 }), { self: 'b', owners })
  assert.equal(a.days['2026-11-25']['claude-opus-5-5'][O], 5)
  assert.equal(b.days['2026-11-25']['claude-opus-5-5'][O], 7)
  assert.equal(b.dupes, 1)
  assert.deepEqual(b.dupOf, ['a'])
})

test('a final record far from its partial one is counted once, with its final usage', () => {
  const owners = new Map()
  const t = newTally()
  tallyRecord(t, asst('first', { output: 3 }), { self: 'f', owners })
  for (let i = 0; i < 200; i++) tallyRecord(t, asst(`m${i}`), { self: 'f', owners })
  tallyRecord(t, asst('first', { output: 300 }), { self: 'f', owners })
  assert.equal(t.days['2026-11-25']['claude-opus-5-5'][N], 201)
  assert.equal(t.days['2026-11-25']['claude-opus-5-5'][O], 200 * 10 + 300)
})

test('REAL: a forked copy with zero usage read first gives the reply up to the larger copy, under that file', () => {
  const owners = new Map()
  const tallies = { fork: newTally(), own: newTally() }
  const ctx = self => ({ self, owners, tallyOf: p => tallies[p] })
  tallyRecord(tallies.fork, FORK_COPY, ctx('fork'))
  tallyRecord(tallies.own, OWN_COPY, ctx('own'))
  const day = localDay(Date.parse(OWN_COPY.timestamp))
  assert.deepEqual(tallies.own.days[day]['claude-opus-5-5'], [2, 1989, 0, 1125, 246176, 1])
  assert.deepEqual(tallies.fork.days[day]['claude-opus-5-5'], [0, 0, 0, 0, 0, 0])
  assert.equal(owners.get('msg_011CgxMfyPUdHNTn64mizgP9'), 'own')
  assert.deepEqual(Object.keys(tallies.fork.counted), [])
  assert.equal(tallies.fork.dupes, 1)
  assert.deepEqual(tallies.fork.dupOf, ['own'])
  assert.equal(tallies.own.dupes, 0)
})

test('REAL: the larger copy read first keeps the reply; the zero copy after it is a dupe', () => {
  const owners = new Map()
  const tallies = { fork: newTally(), own: newTally() }
  const ctx = self => ({ self, owners, tallyOf: p => tallies[p] })
  tallyRecord(tallies.own, OWN_COPY, ctx('own'))
  tallyRecord(tallies.fork, FORK_COPY, ctx('fork'))
  const day = localDay(Date.parse(OWN_COPY.timestamp))
  assert.deepEqual(tallies.own.days[day]['claude-opus-5-5'], [2, 1989, 0, 1125, 246176, 1])
  assert.equal(tallies.fork.days[day], undefined)
  assert.equal(tallies.fork.dupes, 1)
  assert.deepEqual(tallies.fork.dupOf, ['own'])
})

test('a copy of the same size in another file never moves the reply', () => {
  const owners = new Map()
  const tallies = { a: newTally(), b: newTally() }
  const ctx = self => ({ self, owners, tallyOf: p => tallies[p] })
  tallyRecord(tallies.a, asst('m', { output: 5 }), ctx('a'))
  tallyRecord(tallies.b, asst('m', { output: 5 }), ctx('b'))
  assert.equal(owners.get('m'), 'a')
  assert.equal(tallies.b.dupes, 1)
})

test('skipped records are counted; responses on fast mode or US only inference are counted as special', () => {
  const owners = new Map()
  const t = newTally()
  tallyRecord(t, { type: 'assistant', timestamp: '2026-11-25T10:00:00Z', message: { id: 'x', model: 'm' } }, { self: 'f', owners })
  tallyRecord(t, asst('f1', { extra: { speed: 'fast' } }), { self: 'f', owners })
  tallyRecord(t, asst('f2', { extra: { inference_geo: 'us' } }), { self: 'f', owners })
  tallyRecord(t, asst('f3', { extra: { speed: 'standard', inference_geo: 'global' } }), { self: 'f', owners })
  assert.equal(t.skipped, 1)
  assert.equal(t.special, 2)
})

// ═══ prices ═══

test('the default prices: the models seen in the transcripts, from the public page, each with the five rates', () => {
  for (const id of ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-fable-5-1']) {
    const p = DEFAULT_PRICES[id]
    assert.ok(p, id)
    for (const k of ['input', 'output', 'cacheWrite', 'cacheWrite1h', 'cacheRead']) assert.equal(typeof p[k], 'number', `${id} ${k}`)
  }
  assert.deepEqual({ ...DEFAULT_PRICES['claude-opus-5-5'] }, { input: 4, output: 20, cacheWrite: 5, cacheWrite1h: 8, cacheRead: 0.2 })
  // Haiku 5.5's price depends on how long the prompt is, which one rate per kind cannot say: no default
  assert.equal(DEFAULT_PRICES['claude-haiku-5-5'], undefined)
})

test('the user prices add to the defaults, replace one, null takes one away, and a bad entry is named and priced as none', () => {
  const t = priceTable({ prices: {
    'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
    'claude-opus-5-5': { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 },
    'claude-fable-5-1': null,
    'claude-bad': { input: 'cheap', output: 1, cacheWrite: 1, cacheRead: 1 },
    'claude-negative': { input: -1, output: 1, cacheWrite: 1, cacheRead: 1 },
  } })
  assert.deepEqual(t.prices['claude-haiku-5-5'], { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 })
  assert.deepEqual(t.prices['claude-opus-5-5'], { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 })
  assert.equal(t.prices['claude-fable-5-1'], null) // kept as no price, so no shorter id prices it instead
  assert.equal(t.prices['claude-bad'], null)
  assert.deepEqual(t.errors, ['claude-bad', 'claude-negative'])
  assert.ok(t.prices['claude-sonnet-5-5'])
  // no tokens block at all, or a broken one: the defaults
  assert.deepEqual(Object.keys(priceTable(undefined).prices).sort(), Object.keys(DEFAULT_PRICES).sort())
  assert.deepEqual(Object.keys(priceTable({ prices: 'none' }).prices).sort(), Object.keys(DEFAULT_PRICES).sort())
})

test('null means no price for that id and every id under it with no price of its own, never a shorter prefix', () => {
  const { prices } = priceTable({ prices: { 'claude-opus-5-5': null, 'claude-opus-5-5-fast': { input: 8, output: 40, cacheWrite: 10, cacheRead: 0.4 } } })
  assert.equal(priceFor('claude-opus-5-5', prices), null) // not Opus 5 rates
  assert.equal(priceFor('claude-opus-5-5-20261201', prices), null)
  assert.equal(priceFor('claude-opus-5-5-fast', prices).match, 'claude-opus-5-5-fast') // its own price stands
  assert.equal(priceFor('claude-opus-5', prices).match, 'claude-opus-5')
  // and so in the block: tokens, no dollars, named as unpriced
  const s = tokenStats({ files: [{ path: 'm', sessionId: 's', sub: false, mtimeMs: 1, title: 'Master', days: { '2026-11-25': { 'claude-opus-5-5': [1, 1, 0, 0, 0, 1] } } }], now: new Date(2026, 10, 25, 12).getTime(), days: 7, prices })
  assert.equal(s.models[0].price, null)
  assert.deepEqual(s.cost.unpriced, ['claude-opus-5-5'])
})

test('a model takes its exact price, else the longest prefix, else none', () => {
  const prices = { 'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 }, 'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 }, claude: { input: 9, output: 9, cacheWrite: 9, cacheRead: 9 } }
  assert.equal(priceFor('claude-opus-5', prices).match, 'claude-opus-5')
  assert.equal(priceFor('claude-opus-5-5', prices).match, 'claude-opus-5-5')
  assert.equal(priceFor('claude-opus-5-5-20261101', prices).match, 'claude-opus-5-5')
  assert.equal(priceFor('claude-haiku-5-5', prices).match, 'claude')
  assert.equal(priceFor('gpt-9', prices), null)
  assert.equal(priceFor('', prices), null)
})

test('the estimate: each kind at its rate per million, 1 hour writes at their own rate or the 5 minute one', () => {
  const p = { input: 4, output: 20, cacheWrite: 5, cacheWrite1h: 8, cacheRead: 0.2 }
  const vec = [1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 9]
  assert.equal(costOf(vec, p), 4 + 20 + 5 + 8 + 0.2)
  assert.equal(costOf(vec, { ...p, cacheWrite1h: undefined }), 4 + 20 + 5 + 5 + 0.2)
  assert.equal(costOf([2, 342, 0, 35374, 29974, 1], p), (2 * 4 + 342 * 20 + 35374 * 8 + 29974 * 0.2) / 1e6)
})

// ═══ the whole block ═══

const NOW = at(2026, 11, 25, 10, 30)
const vec = (input, output, w5 = 0, w1 = 0, read = 0, n = 1) => [input, output, w5, w1, read, n]
const OPUS = 'claude-opus-5-5'
const HAIKU = 'claude-haiku-5-5'
const PRICES = priceTable(undefined).prices
const labelOf = name => ({ 'flinki-v2-a9': 'Agent 3', Master: 'Master', indepenent: 'Independent agent' })[name] ?? name
const file = (p, sessionId, days, more = {}) => ({ path: p, sessionId, sub: false, mtimeMs: 1, title: null, days, skipped: 0, dupes: 0, special: 0, ...more })
const stats = (files, more = {}) => tokenStats({ files, now: NOW, days: 7, prices: PRICES, names: new Map(), labelOf, finished: null, spend: null, ...more })

test('the period is whole local days: 7 days starts at local midnight six days before today', () => {
  const files = [file('m', 's1', {
    '2026-11-18': { [OPUS]: vec(100, 0) }, // the day before the period
    '2026-11-19': { [OPUS]: vec(10, 0) }, // its first day
    '2026-11-25': { [OPUS]: vec(1, 0) }, // today
  }, { title: 'Master' })]
  const s = stats(files)
  assert.equal(s.window.from, new Date(at(2026, 11, 19, 0, 0)).toISOString())
  assert.equal(s.totals.input, 11)
  assert.equal(s.bars.length, 7)
  assert.deepEqual(s.bars.map(b => b.tokens), [10, 0, 0, 0, 0, 0, 1])
  // All: from the first day with tokens, per week
  const all = stats(files, { days: null })
  assert.equal(all.totals.input, 111)
  assert.equal(all.window.bucket, 'week')
  assert.equal(all.window.from, new Date(at(2026, 11, 18, 0, 0)).toISOString())
})

test('totals: the four kinds, all tokens, responses; cache share is reads over all input', () => {
  const s = stats([file('m', 's1', { '2026-11-25': { [OPUS]: vec(10, 20, 30, 40, 900, 3) } }, { title: 'Master' })])
  assert.deepEqual({ ...s.totals }, { input: 10, output: 20, cacheWrite: 70, cacheRead: 900, all: 1000, responses: 3 })
  assert.equal(s.cacheShare, 900 / (10 + 70 + 900))
})

test('subagents count under the session that started them, with their own part, and the rows sort by cost then tokens', () => {
  const files = [
    file('a/s1.jsonl', 's1', { '2026-11-25': { [OPUS]: vec(1_000_000, 0) } }, { title: 'Master' }),
    file('a/s1/subagents/agent-x.jsonl', 's1', { '2026-11-25': { [OPUS]: vec(0, 1_000_000) } }, { sub: true }),
    file('a/s2.jsonl', 's2', { '2026-11-25': { [OPUS]: vec(3_000_000, 0) } }, { title: 'flinki-v2-a9' }),
    file('a/s3.jsonl', 's3', { '2026-11-25': { [HAIKU]: vec(9_000_000, 0) } }, { title: 'Mentor' }),
  ]
  const s = stats(files)
  assert.deepEqual(s.agents.map(a => a.label), ['Master', 'Agent 3', 'Mentor'])
  const master = s.agents[0]
  assert.equal(master.all, 2_000_000)
  assert.equal(master.usd, 4 + 20)
  assert.equal(master.subs.all, 1_000_000)
  assert.equal(master.subs.usd, 20)
  assert.equal(master.subs.files, 1)
  assert.deepEqual(master.models, [OPUS])
  assert.equal(s.agents[2].usd, null) // Haiku has no price: tokens only
  assert.equal(s.agents[2].unpriced, true)
  assert.equal(master.share, 2 / 14)
})

test('a renamed session keeps one row under its latest name, two names mapped to one label share a row, and a mapped live name wins', () => {
  const files = [
    file('x/s1.jsonl', 's1', { '2026-11-25': { [OPUS]: vec(5, 0) } }, { title: 'Mentor', mtimeMs: 9 }),
    file('y/s1.jsonl', 's1', { '2026-11-24': { [OPUS]: vec(7, 0) } }, { title: 'Advisor', mtimeMs: 2 }), // the same session in another account folder, named earlier
    file('x/s2.jsonl', 's2', { '2026-11-25': { [OPUS]: vec(1, 0) } }, { title: 'Agent 3' }),
    file('x/s3.jsonl', 's3', { '2026-11-25': { [OPUS]: vec(2, 0) } }, { title: 'whatever it was called' }),
  ]
  const s = stats(files, { names: new Map([['s3', 'flinki-v2-a9']]) })
  assert.deepEqual(s.agents.map(a => [a.label, a.all, a.sessions]).sort(), [['Agent 3', 3, 2], ['Mentor', 12, 1]])
})

test('a live name the config does not map gives way to the name the user gave the session; with no title it stands', () => {
  const files = [
    file('x/s4.jsonl', 's4', { '2026-11-25': { [OPUS]: vec(4, 0) } }, { title: 'QA' }), // registry: a derived name
    file('x/s5.jsonl', 's5', { '2026-11-25': { [OPUS]: vec(5, 0) } }),
  ]
  const s = stats(files, { names: new Map([['s4', 'flinki-v2-9b'], ['s5', 'flinki-v2-c1']]) })
  assert.deepEqual(s.agents.map(a => [a.label, a.all]).sort(), [['QA', 4], ['flinki-v2-c1', 5]])
})

test('a session with no name anywhere is counted under Unnamed sessions; a subagent whose session file is gone still counts', () => {
  const files = [
    file('x/s1.jsonl', 's1', { '2026-11-25': { [OPUS]: vec(5, 0) } }),
    file('x/s9/subagents/agent-q.jsonl', 's9', { '2026-11-25': { [OPUS]: vec(4, 0) } }, { sub: true }),
  ]
  const s = stats(files)
  assert.deepEqual(s.agents.map(a => [a.label, a.all, a.sessions, a.subs.all]), [['Unnamed sessions', 9, 2, 4]])
})

test('by model: tokens, the estimate and the price used, the unpriced ones named', () => {
  const files = [file('m', 's1', { '2026-11-25': { [OPUS]: vec(1_000_000, 0), [HAIKU]: vec(5, 5), 'claude-opus-5-5-20261201': vec(1_000_000, 0) } }, { title: 'Master' })]
  const s = stats(files)
  const byId = Object.fromEntries(s.models.map(m => [m.model, m]))
  assert.equal(byId[OPUS].usd, 4)
  assert.equal(byId[OPUS].price.match, OPUS)
  assert.equal(byId['claude-opus-5-5-20261201'].price.match, OPUS)
  assert.equal(byId[HAIKU].usd, null)
  assert.equal(byId[HAIKU].price, null)
  assert.deepEqual(s.cost.unpriced, [HAIKU])
  assert.equal(s.cost.usd, 8)
  assert.equal(s.cost.unpricedTokens, 10)
})

test('by model: the two cache write lifetimes apart, so tokens times the listed rates gives the cost shown', () => {
  const s = stats([file('m', 's1', { '2026-11-25': { [OPUS]: vec(10, 20, 300, 4000, 50000) } }, { title: 'Master' })])
  const m = s.models[0]
  assert.equal(m.cacheWrite5m, 300)
  assert.equal(m.cacheWrite1h, 4000)
  assert.equal(m.cacheWrite, 4300)
  const p = m.price
  assert.equal(m.usd, (m.input * p.input + m.output * p.output + m.cacheWrite5m * p.cacheWrite + m.cacheWrite1h * p.cacheWrite1h + m.cacheRead * p.cacheRead) / 1e6)
})

test('no model with a price: no dollar figure anywhere', () => {
  const s = stats([file('m', 's1', { '2026-11-25': { [HAIKU]: vec(5, 5) } }, { title: 'Master' })])
  assert.equal(s.cost.usd, null)
  assert.ok(s.bars.every(b => b.usd === null))
  assert.equal(s.perJob, null)
})

test('per finished job divides by Pipeline time own count, tickets and other jobs', () => {
  const files = [file('m', 's1', { '2026-11-25': { [OPUS]: vec(1_000_000, 0) } }, { title: 'Master' })]
  const s = stats(files, { finished: { tickets: 3, jobs: 1, flows: 4 } })
  assert.deepEqual({ ...s.perJob }, { jobs: 4, tickets: 3, otherJobs: 1, tokens: 250_000, usd: 1 })
  assert.equal(stats(files, { finished: { tickets: 0, jobs: 0, flows: 0 } }).perJob, null)
})

test('the dashboard own runs ride along untouched, never added to the estimate', () => {
  const files = [file('m', 's1', { '2026-11-25': { [OPUS]: vec(1_000_000, 0) } }, { title: 'Master' })]
  const s = stats(files, { spend: { usd: 3.5, turns: 7 } })
  assert.deepEqual({ ...s.spend }, { usd: 3.5, turns: 7 })
  assert.equal(s.cost.usd, 4)
})

test('no transcripts at all: zeros only where they are true, no rows, no cache share, an honest empty block', () => {
  const s = stats([])
  assert.equal(s.totals.all, 0)
  assert.equal(s.cacheShare, null)
  assert.deepEqual(s.agents, [])
  assert.deepEqual(s.models, [])
  assert.equal(s.cost.usd, null)
  assert.equal(stats([], { days: null }).bars.length, 0)
})

test('skipped, overlapping and special responses are summed for the help', () => {
  const s = stats([file('m', 's1', {}, { skipped: 2, dupes: 5, special: 1 }), file('n', 's2', {}, { skipped: 1 })])
  assert.deepEqual({ skipped: s.skipped, dupes: s.dupes, special: s.special, files: s.files }, { skipped: 3, dupes: 5, special: 1, files: 2 })
})

test('vector slots are the documented order', () => {
  assert.deepEqual([I, O, W5, W1, R, N], [0, 1, 2, 3, 4, 5])
})

test('config.example.json carries the default prices as the block a user keeps current, every entry valid', () => {
  const example = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'config.example.json'), 'utf8'))
  const t = priceTable(example.tokens)
  assert.deepEqual(t.errors, [])
  assert.deepEqual(Object.keys(example.tokens.prices).sort(), Object.keys(DEFAULT_PRICES).sort())
  for (const [id, p] of Object.entries(example.tokens.prices)) assert.deepEqual(p, { ...DEFAULT_PRICES[id] }, id)
})

test('config.example.json says what null means, beside the prices', () => {
  const example = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'config.example.json'), 'utf8'))
  assert.match(example.tokens.note, /null means no price for that id and every id under it with no price of its own/)
  assert.match(example.tokens.note, /keeping them current is yours/)
})
