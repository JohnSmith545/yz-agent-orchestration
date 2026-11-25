// Tests for the Pipeline tokens block on the Agents page: public/token-view.js (the pure half: token counts as 12.4K,
// 3.1M, 1.2B with the exact number to hover, dollars to two places under $100 and whole above, the five tiles and
// their honest empty states, the collapsed line, the bars per day in tokens or dollars, the by agent and by model
// tables, the help, the building note) run in a vm with a bare window, and greps that wire it in: token-strip.js and
// tokens.css on the page, in npm run check, the block under Pipeline time on the Agents page, one window switch for
// all three blocks, colours only from the tokens, every localStorage access guarded.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const PUBLIC = path.join(ROOT, 'public')
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8')
const ctx = vm.createContext({ window: {} })
for (const f of ['shell.js', 'app.js', 'token-view.js']) vm.runInContext(read(f), ctx)
const V = ctx.window.TokenView
const plain = v => JSON.parse(JSON.stringify(v))

const DAYS = ['2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25']
/** /api/tokens' body for 7 days. */
const STATS = {
  window: { days: 7, from: '2026-11-18T16:00:00.000Z', to: '2026-11-25T06:30:00.000Z', dayCount: 7, bucket: 'day' },
  totals: { input: 12152, output: 5175344, cacheWrite: 23951826, cacheRead: 1669675910, all: 1698815232, responses: 5859 },
  cost: { usd: 582.08, unpriced: ['claude-haiku-5-5'], unpricedTokens: 125652, w1hAtWriteRate: false },
  perJob: { jobs: 13, tickets: 2, otherJobs: 11, tokens: 130678094.77, usd: 44.78 },
  cacheShare: 0.9856,
  spend: { usd: 29.12, turns: 179 },
  agents: [
    { label: 'Master <main>', sessions: 1, input: 9000, output: 5000000, cacheWrite: 20000000, cacheRead: 1650968323, all: 1675977323, responses: 5000, usd: 566.95, unpriced: true, share: 0.987, models: ['claude-haiku-5-5', 'claude-opus-5-5'], subs: { files: 12, input: 100, output: 2000, cacheWrite: 3000, cacheRead: 1465431471, all: 1465436571, usd: 479.68 } },
    { label: 'Stand up Creator', sessions: 1, input: 3152, output: 175344, cacheWrite: 3951826, cacheRead: 15812799, all: 19943121, responses: 859, usd: 10.31, unpriced: false, share: 0.012, models: ['claude-opus-5-5'], subs: { files: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, all: 0, usd: null } },
  ],
  models: [
    { model: 'claude-opus-5-5', input: 11330, output: 4800168, cacheWrite: 22413678, cacheWrite5m: 2000000, cacheWrite1h: 20413678, cacheRead: 1575457722, all: 1602682898, responses: 5000, usd: 529.3, price: { match: 'claude-opus-5-5', input: 4, output: 20, cacheWrite: 5, cacheWrite1h: 8, cacheRead: 0.2 } },
    { model: 'claude-opus-5-5-20261201', input: 1, output: 1, cacheWrite: 0, cacheRead: 0, all: 2, responses: 1, usd: 0.0001, price: { match: 'claude-opus-5-5', input: 4, output: 20, cacheWrite: 5, cacheWrite1h: 8, cacheRead: 0.2 } },
    { model: 'claude-haiku-5-5', input: 10, output: 3633, cacheWrite: 44027, cacheRead: 77982, all: 125652, responses: 8, usd: null, price: null },
  ],
  bars: DAYS.map((day, i) => ({ day, tokens: [0, 1e6, 3e8, 0, 0, 6e8, 2e8][i], usd: [0, 1, 100, 0, 0, 200, 70][i] })),
  skipped: 2, dupes: 30061, special: 0, files: 507,
  building: false, progress: 1,
  prices: { source: { url: 'https://platform.claude.com/docs/en/about-claude/pricing', read: '2026-11-25' }, errors: [], given: false },
  builtAt: '2026-11-25T06:30:00.000Z',
}
const EMPTY = {
  ...STATS,
  totals: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, all: 0, responses: 0 },
  cost: { usd: null, unpriced: [], unpricedTokens: 0, w1hAtWriteRate: false },
  perJob: null, cacheShare: null, spend: { usd: 0, turns: 0 }, agents: [], models: [],
  bars: DAYS.map(day => ({ day, tokens: 0, usd: null })), skipped: 0, dupes: 0, files: 0,
}

test('token counts: whole below 1,000, then K, M and B with at most one decimal, rolling up at the edge', () => {
  assert.equal(V.count(0), '0')
  assert.equal(V.count(999), '999')
  assert.equal(V.count(1000), '1K')
  assert.equal(V.count(12_400), '12.4K')
  assert.equal(V.count(123_456), '123K')
  assert.equal(V.count(999_950), '1M')
  assert.equal(V.count(3_140_000), '3.1M')
  assert.equal(V.count(41_249_999), '41.2M')
  assert.equal(V.count(1e9), '1B')
  assert.equal(V.count(1_234_567_890), '1.2B')
  assert.equal(V.count(null), '')
  assert.equal(V.exact(1_698_815_232), '1,698,815,232')
})

test('dollars: two places under $100, whole dollars from $100, a trace says under a cent', () => {
  assert.equal(V.usd(4.662), '$4.66')
  assert.equal(V.usd(99.994), '$99.99')
  assert.equal(V.usd(99.996), '$100')
  assert.equal(V.usd(212.4), '$212')
  assert.equal(V.usd(3077.36), '$3,077')
  assert.equal(V.usd(0), '$0.00')
  assert.equal(V.usd(0.0001), 'under $0.01')
  assert.equal(V.usd(null), '')
})

test('five tiles in order, each a number, its exact figure to hover and one plain line', () => {
  const t = plain(V.tiles(STATS))
  assert.deepEqual(t.map(x => x.key), ['tokens', 'cost', 'perJob', 'cache', 'spend'])
  assert.deepEqual(t.map(x => x.name), ['Tokens used', 'Estimated cost', 'Per finished job', 'Cache share', 'The dashboard\'s own runs'])
  assert.equal(t[0].number, '1.7B')
  assert.equal(t[0].title, '1,698,815,232 tokens')
  assert.match(t[0].line, /^New input 12.2K, output 5.2M, cache writes 24M, cache reads 1.7B\.$/)
  assert.equal(t[1].number, 'about $582')
  assert.equal(t[1].side, 'estimate')
  assert.match(t[1].line, /what these tokens would cost at API prices/i)
  assert.match(t[1].line, /1 model with no price set: claude-haiku-5-5/)
  assert.equal(t[2].number, '131M')
  assert.equal(t[2].side, 'average')
  assert.match(t[2].line, /About \$44\.78 a job/)
  assert.match(t[2].line, /13 jobs: 2 tickets and 11 other jobs/)
  assert.equal(t[3].number, '98.6%')
  assert.match(t[3].line, /a tenth/)
  assert.equal(t[4].number, '$29.12')
  assert.match(t[4].line, /179 runs/)
  assert.match(t[4].line, /exact/i)
  assert.ok(t.every(x => !x.empty))
})

test('no model with a price: the cost tile says so and shows no dollar figure; per job keeps its tokens', () => {
  const s = { ...STATS, cost: { usd: null, unpriced: ['claude-haiku-5-5', 'claude-x'], unpricedTokens: 5, w1hAtWriteRate: false }, perJob: { ...STATS.perJob, usd: null } }
  const t = plain(V.tiles(s))
  assert.equal(t[1].number, 'No prices set')
  assert.equal(t[1].empty, true)
  assert.doesNotMatch(t[1].number + t[1].line, /\$/)
  assert.doesNotMatch(t[2].line, /\$/)
  assert.doesNotMatch(V.line(s), /about \$/)
})

test('three or more unpriced models are counted, not listed one by one', () => {
  const t = plain(V.tiles({ ...STATS, cost: { ...STATS.cost, unpriced: ['a', 'b', 'c'] } }))
  assert.match(t[1].line, /3 models with no price set\b/)
  assert.doesNotMatch(t[1].line, /a, b/)
})

test('nothing in the period: honest empty tiles, never a zero that reads as a result', () => {
  const t = plain(V.tiles(EMPTY))
  assert.equal(t[0].number, 'None in the last 7 days') // older windows may have tokens: never says yet
  assert.equal(plain(V.tiles({ ...EMPTY, window: { ...EMPTY.window, days: 30 } }))[0].number, 'None in the last 30 days')
  assert.equal(plain(V.tiles({ ...EMPTY, window: { ...EMPTY.window, days: null, bucket: 'week' } }))[0].number, 'No tokens yet')
  assert.ok(t.slice(0, 4).every(x => x.empty))
  assert.ok(t.slice(0, 4).every(x => !/\b0\b/.test(x.number)))
  assert.match(t[0].line, /in the last 7 days/)
  // the spend tile keeps a true zero: the dashboard ran nothing
  assert.equal(t[4].number, '$0.00')
  assert.equal(V.line(EMPTY), 'No tokens in the last 7 days.')
})

test('tokens but nothing finished: per job says why there is nothing to divide by', () => {
  const t = plain(V.tiles({ ...STATS, perJob: null }))
  assert.equal(t[2].number, 'Nothing finished yet')
  assert.match(t[2].line, /nothing to divide by/)
})

test('while the first build runs, a note says how far it got and that the numbers are partial', () => {
  assert.equal(V.note(STATS), '')
  assert.equal(V.note({ ...STATS, building: true, progress: 0.424 }), 'Reading the transcripts for the first time: 42% done. The numbers so far are partial.')
  assert.ok(plain(V.tiles({ ...EMPTY, building: true, progress: 0 })).slice(0, 4).every(t => t.line === 'Still reading the transcripts.'))
  for (const f of ['chartHtml', 'modelsHtml', 'agentsHtml']) assert.match(V[f]({ ...EMPTY, building: true }, 'tokens'), /Still reading the transcripts/, f)
})

test('the collapsed line', () => {
  assert.equal(V.line(STATS), '1.7B tokens · about $582 at API prices · 131M a job · 98.6% from the cache · $29.12 own runs')
})

test('the bars: tokens or dollars, a height for each, the day and value to read, a list beside them', () => {
  const b = plain(V.barModel(STATS, 'tokens'))
  assert.deepEqual(b.map(x => x.height), [0, 0.17, 50, 0, 0, 100, 33.33])
  assert.equal(b[1].says, 'Fri 20 Nov: 1M tokens')
  const d = plain(V.barModel(STATS, 'usd'))
  assert.deepEqual(d.map(x => x.height), [0, 0.5, 50, 0, 0, 100, 35])
  assert.equal(d[5].says, 'Tue 24 Nov: about $200')
  assert.equal(d[0].says, 'Thu 19 Nov: $0') // an empty day is no estimate: not about $0.00
  assert.match(V.chartHtml(STATS, 'usd'), /<li>Thu 19 Nov: \$0<\/li>/)
  const html = V.chartHtml(STATS, 'tokens')
  assert.match(html, /class="ptm-chart"/)
  assert.match(html, /aria-label="Tokens per day; use the arrow keys to move along the bars"/)
  assert.match(html, /<li>Wed 25 Nov: 200M tokens<\/li>/)
  assert.match(V.chartHtml({ ...STATS, window: { ...STATS.window, bucket: 'week' } }, 'usd'), /Estimated dollars per week/)
  // dollars asked for with no price: tokens instead
  assert.deepEqual(plain(V.barModel({ ...STATS, cost: { ...STATS.cost, usd: null } }, 'usd')).map(x => x.height), b.map(x => x.height))
  assert.match(V.chartHtml(EMPTY, 'tokens'), /No tokens in this period/)
  assert.equal(V.measureOf('usd'), 'usd')
  assert.equal(V.measureOf('nonsense'), 'tokens')
})

test('by agent: one row per label with the subagents part under it, exact numbers to hover, escaped', () => {
  const html = V.agentsHtml(STATS)
  assert.match(html, /<th scope="row">Master &lt;main&gt;<\/th>/)
  assert.match(html, /of which subagents \(12\)/)
  assert.match(html, /title="1,675,977,323"/)
  assert.match(html, /\$567/)
  assert.match(html, /98\.7%/)
  assert.match(html, /<span class="ptk-nw">claude-haiku-5-5<\/span>, <span class="ptk-nw">claude-opus-5-5<\/span>/)
  assert.match(V.agentsHtml({ ...STATS, agents: [{ ...STATS.agents[1], share: 0.0001 }] }), />under 0\.1%</) // a sliver is not 0%
  assert.match(html, /tokens has no price set/)
  assert.equal((html.match(/of which subagents/g) || []).length, 1) // none for a session with no subagents
  assert.match(V.agentsHtml(EMPTY), /No session of this project used tokens in this period/)
})

test('by model: the price used, a prefix match named, and no price set said plainly', () => {
  const html = V.modelsHtml(STATS)
  assert.match(html, /\$4 in · \$20 out · \$5 5 min write · \$8 1 hour write · \$0\.20 read/)
  // a column for each write lifetime, each with its exact count to hover
  assert.match(html, /<th scope="col">Writes, 5 min<\/th><th scope="col">Writes, 1 hour<\/th>/)
  assert.match(html, /title="2,000,000">2M<\/td><td class="num" title="20,413,678">20.4M<\/td>/)
  // a price with no 1 hour rate says the 5 minute one prices both
  const one = { ...STATS.models[0], price: { ...STATS.models[0].price, cacheWrite1h: undefined } }
  assert.match(V.modelsHtml({ ...STATS, models: [one] }), /\$5 write \(5 min and 1 hour\)/)
  assert.match(html, /as claude-opus-5-5/)
  assert.match(html, /no price set/)
  assert.match(V.modelsHtml(EMPTY), /No tokens in this period/)
})

test('How it is counted names the rules, the source of the prices, the subscription and what is not counted', () => {
  const html = V.howHtml(STATS)
  for (const re of [/once/, /message id/, /2 records/, /30,061/, /local/, /subagent/i, /subscription/, /platform\.claude\.com/, /2026-11-25/, /config\.json/, /not counted/i, /dashboard&#39;s own runs/, /web search/i]) assert.match(html, re)
  assert.match(V.howHtml({ ...STATS, prices: { ...STATS.prices, errors: ['claude-x'] } }), /claude-x/)
  assert.match(V.howHtml({ ...STATS, special: 3 }), /3 replies in this period used fast mode or US only inference/)
})

test('the block is on the page, in npm run check, under Pipeline time, and driven by the score window', () => {
  const html = read('index.html')
  assert.match(html, /<link rel="stylesheet" href="tokens.css">/)
  assert.ok(html.indexOf('src="token-view.js"') > html.indexOf('src="time-strip.js"'))
  assert.ok(html.indexOf('src="token-strip.js"') > html.indexOf('src="token-view.js"'))
  const check = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.check
  for (const f of ['public/token-view.js', 'public/token-strip.js']) assert.ok(check.includes(`node --check ${f}`), f)
  const page = read('agents-page.js')
  assert.ok(page.indexOf('id="plTokens"') > page.indexOf('id="plTime"'))
  assert.match(page, /TokenStrip\?\.create/)
  assert.match(page, /tokens\?\.refresh\(\)/)
  const strip = read('token-strip.js')
  assert.match(strip, /ScoreStrip\?\.windowNow/)
  assert.match(strip, /'score-window'/)
  assert.match(strip, /\/api\/tokens\?days=/)
})

test('tokens.css uses only the colour tokens and every storage access is guarded', () => {
  const css = read('tokens.css')
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i)
  const strip = read('token-strip.js')
  const uses = strip.match(/localStorage\.(get|set)Item/g) || []
  assert.ok(uses.length >= 1)
  assert.equal((strip.match(/try \{\s*(return )?window\.localStorage/g) || []).length, uses.length)
})
