// Tests for the Pipeline time block on the Agents page: public/time-view.js (the pure half: durations and rates in
// the chosen unit, the five tiles, the collapsed line, the stage bar whose widths add to 100, the per day bars, the
// per agent table, the help) run in a vm with a bare window, and greps that wire it in: time-strip.js and time.css on
// the page, in npm run check, the block's container under the score on the Agents page, one window switch for both,
// colours only from the tokens, motion calmed, every localStorage access guarded.

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
for (const f of ['shell.js', 'app.js', 'time-view.js']) vm.runInContext(read(f), ctx)
const V = ctx.window.TimeView
const plain = v => JSON.parse(JSON.stringify(v))

const S = 1000
const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

/** /api/time's body for 7 days: 23 tickets and 4 other jobs from 25 flows. */
const STATS = {
  window: { days: 7, from: '2026-11-18T16:00:00.000Z', to: '2026-11-25T06:30:00.000Z', dayCount: 7, bucket: 'day', activeHours: 45, clockHours: 158.5 },
  finished: { tickets: 23, jobs: 4, flows: 25 },
  rates: { perDay: 27 / 7, perHour: 27 / 45, perClockHour: 27 / 158.5 },
  took: { median: 42 * MIN, mean: 3.5 * HOUR, fastest: 9 * MIN, slowest: 2.1 * DAY, flows: 25 },
  waiting: { median: 5 * MIN, mean: 20 * MIN, share: 0.08, flows: 23, undated: 2 },
  stages: [
    { key: 'producing', label: 'Producer', median: 30 * MIN, mean: 40 * MIN, flows: 25, undated: 0 },
    { key: 'qa', label: 'QA', median: 10 * MIN, mean: 12 * MIN, flows: 20, undated: 1 },
    { key: 'rework', label: 'Reworks', median: 20 * MIN, mean: 25 * MIN, flows: 6, undated: 0 },
    { key: 'human', label: 'Human task', median: null, mean: null, flows: 0, undated: 2 },
  ],
  bars: ['2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25'].map((day, i) => ({ day, count: [1, 0, 3, 0, 0, 6, 2][i] })),
  agents: [
    { label: 'Agent <1>', tickets: 20, jobs: 1, flows: 20, median: 40 * MIN, perDay: 3, sentBack: 4 },
    { label: 'Master', tickets: 3, jobs: 3, flows: 5, median: 2 * HOUR, perDay: 6 / 7, sentBack: 0 },
  ],
  left: { slipped: 1, dropped: 2, stopped: 0, stalled: 4 },
  fewer: false,
  builtAt: '2026-11-25T06:30:00.000Z',
}
const EMPTY = {
  window: { days: 7, from: '2026-11-18T16:00:00.000Z', to: '2026-11-25T06:30:00.000Z', dayCount: 7, bucket: 'day', activeHours: 3, clockHours: 158.5 },
  finished: { tickets: 0, jobs: 0, flows: 0 },
  rates: { perDay: null, perHour: null, perClockHour: null },
  took: null,
  waiting: null,
  stages: [],
  bars: STATS.bars.map(b => ({ ...b, count: 0 })),
  agents: [],
  left: { slipped: 0, dropped: 0, stopped: 0, stalled: 1 },
  fewer: true,
}

// ═══ units ═══

test('Auto picks the unit that fits, at every boundary', () => {
  const d = ms => V.duration(ms, 'auto')
  assert.equal(d(0), '0 s')
  assert.equal(d(400), 'under 1 s')
  assert.equal(d(4 * S), '4 s')
  assert.equal(d(59 * S), '59 s')
  assert.equal(d(59.6 * S), '1 min', 'rounds up into the next unit, never 60 s')
  assert.equal(d(60 * S), '1 min')
  assert.equal(d(42 * MIN), '42 min')
  assert.equal(d(59 * MIN), '59 min')
  assert.equal(d(59.6 * MIN), '1 h')
  assert.equal(d(60 * MIN), '1 h')
  assert.equal(d(3.5 * HOUR), '3.5 h')
  assert.equal(d(23.9 * HOUR), '23.9 h')
  assert.equal(d(23.96 * HOUR), '1 day')
  assert.equal(d(24 * HOUR), '1 day')
  assert.equal(d(2.1 * DAY), '2.1 days')
  assert.equal(d(null), '')
  assert.equal(d(-5), '')
})

test('under a minute is whole seconds in every unit, under a second says so', () => {
  for (const u of ['auto', 'min', 'h', 'day']) {
    assert.equal(V.duration(0, u), '0 s', u)
    assert.equal(V.duration(1, u), 'under 1 s', u)
    assert.equal(V.duration(999, u), 'under 1 s', u)
    assert.equal(V.duration(1000, u), '1 s', u)
    assert.equal(V.duration(4.4 * S, u), '4 s', u)
    assert.equal(V.duration(59 * S, u), '59 s', u)
    assert.equal(V.duration(59.4 * S, u), '59 s', u)
  }
  // the small times QA saw printed as unreadable decimals
  assert.equal(V.duration(0.000082 * HOUR, 'h'), 'under 1 s')
  assert.equal(V.duration(0.0000099 * DAY, 'day'), 'under 1 s')
  assert.equal(V.duration(0.005 * MIN, 'min'), 'under 1 s')
})

test('a fixed unit: at most 2 decimals, and the next smaller unit when it would round to 0', () => {
  assert.equal(V.duration(42 * MIN, 'min'), '42 min')
  assert.equal(V.duration(2.1 * DAY, 'min'), '3,024 min')
  assert.equal(V.duration(90 * S, 'min'), '1.5 min')
  assert.equal(V.duration(61 * S, 'min'), '1 min')
  assert.equal(V.duration(42 * MIN, 'h'), '0.7 h')
  assert.equal(V.duration(3.5 * HOUR, 'h'), '3.5 h')
  assert.equal(V.duration(60 * S, 'h'), '0.02 h')
  assert.equal(V.duration(42 * MIN, 'day'), '0.03 days')
  assert.equal(V.duration(15 * MIN, 'day'), '0.01 days')
  assert.equal(V.duration(5 * MIN, 'day'), '0.08 h', 'would read 0 days: falls to hours')
  assert.equal(V.duration(60 * S, 'day'), '0.02 h')
  assert.equal(V.duration(DAY, 'day'), '1 day')
  for (const u of ['min', 'h', 'day']) {
    for (const ms of [61 * S, 7 * MIN, 42 * MIN, 3.5 * HOUR, 2.1 * DAY]) assert.doesNotMatch(V.duration(ms, u), /\.\d{3}/,`${ms} in ${u}`)
  }
})

test('rates keep their own basis; the gap form is 1 every so many minutes', () => {
  assert.equal(V.rate(0.6 / HOUR, 'h'), '0.6 an hour')
  assert.equal(V.rate(3.3 / DAY, 'day'), '3.3 a day')
  assert.equal(V.rate(0, 'h'), null)
  assert.equal(V.rate(null, 'day'), null)
  assert.equal(V.gap(1 / (95 * MIN)), '1 every 95 min')
  assert.equal(V.gap(0), null)
})

test('a remembered unit: Minutes, Hours, Days or Auto, anything else Auto', () => {
  assert.deepEqual(plain(V.UNITS).map(u => u.label), ['Minutes', 'Hours', 'Days', 'Auto'])
  for (const u of ['min', 'h', 'day', 'auto']) assert.equal(V.unitOf(u), u)
  for (const u of [null, '', 'weeks', 'MIN']) assert.equal(V.unitOf(u), 'auto')
})

// ═══ tiles ═══

test('five tiles in order, each a number and one plain sentence', () => {
  const t = plain(V.tiles(STATS, 'auto'))
  assert.deepEqual(t.map(x => x.key), ['finished', 'perDay', 'perHour', 'took', 'waiting'])
  assert.deepEqual(t.map(x => x.name), ['Finished', 'Per day', 'Per hour', 'Time per job', 'Waiting on you'])
  assert.deepEqual(t.map(x => x.number), ['23 tickets', '3.9 a day', '0.6 an hour', '42 min', '5 min'])
  assert.equal(t[0].line, 'And 4 other jobs, from 25 flows.')
  assert.equal(t[1].line, 'Over the 7 days, today included.')
  assert.equal(t[2].line, 'Over 45 hours with work; 0.17 an hour round the clock.')
  assert.equal(t[3].line, 'Half the finished jobs took less. Mean 3.5 h, fastest 9 min, slowest 2.1 days.')
  assert.equal(t[4].line, 'Half waited less. Mean 20 min, 8% of their time. 2 flows with an undated question left out.')
  assert.ok(t.every(x => x.empty === false))
})

test('each rate tile keeps its own meaning in every unit: the switch changes times only', () => {
  for (const u of ['auto', 'min', 'h', 'day']) {
    const t = plain(V.tiles(STATS, u))
    assert.equal(t[1].number, '3.9 a day', `Per day in ${u}`)
    assert.equal(t[2].number, '0.6 an hour', `Per hour in ${u}`)
    const gapDay = u === 'min' ? ' That is 1 every 373 min.' : ''
    const gapHour = u === 'min' ? ' That is 1 every 100 min.' : ''
    assert.equal(t[1].line, `Over the 7 days, today included.${gapDay}`, u)
    assert.equal(t[2].line, `Over 45 hours with work; 0.17 an hour round the clock.${gapHour}`, u)
    assert.match(V.line(STATS, u), / · 3\.9 a day · 0\.6 an hour · /, u)
    assert.match(V.agentsHtml(STATS, u), /<td class="num">0\.86 a day<\/td>/, u)
  }
  const days = plain(V.tiles(STATS, 'day'))
  assert.deepEqual(days.slice(3).map(x => x.number), ['0.03 days', '0.08 h'], 'the times do follow the switch (5 min would read 0 days)')
})

test('Finished: the flows only when they differ, other jobs only when there are tickets too', () => {
  const one = s => plain(V.tiles({ ...STATS, finished: s }, 'auto'))[0]
  assert.deepEqual([one({ tickets: 2, jobs: 11, flows: 13 }).number, one({ tickets: 2, jobs: 11, flows: 13 }).line], ['2 tickets', 'And 11 other jobs.'])
  assert.deepEqual([one({ tickets: 1, jobs: 0, flows: 1 }).number, one({ tickets: 1, jobs: 0, flows: 1 }).line], ['1 ticket', 'Tickets on flows that finished.'])
  assert.deepEqual([one({ tickets: 0, jobs: 3, flows: 3 }).number, one({ tickets: 0, jobs: 3, flows: 3 }).line], ['3 jobs', 'Finished flows with no ticket.'])
  assert.equal(one({ tickets: 4, jobs: 0, flows: 2 }).line, 'From 2 flows.')
})

test('fewer than 3 finished flows: the numbers, with too few to trust', () => {
  const t = plain(V.tiles({ ...STATS, finished: { tickets: 2, jobs: 0, flows: 2 }, fewer: true }, 'auto'))
  assert.ok(t.slice(1).every(x => x.line.startsWith('Too few to trust. ')), t.map(x => x.line).join('\n'))
  assert.equal(t[3].number, '42 min')
})

test('nothing finished: an honest empty state, never a zero', () => {
  const t = plain(V.tiles(EMPTY, 'auto'))
  assert.equal(t[0].number, 'Nothing finished yet')
  assert.equal(t[0].line, 'No ticket or other job finished in the last 7 days.')
  assert.ok(t.slice(1).every(x => x.number === 'Not enough data yet' && x.empty))
  assert.ok(t.every(x => !/\b0\b/.test(x.number)))
  assert.equal(V.line(EMPTY, 'auto'), 'Nothing finished in the last 7 days.')
})

test('All: the days since the first flow started', () => {
  const all = { ...STATS, window: { ...STATS.window, days: null, dayCount: 14, bucket: 'week' } }
  assert.equal(plain(V.tiles(all, 'auto'))[1].line, 'Over 14 days, since the first flow started.')
  const none = { ...EMPTY, window: { ...EMPTY.window, days: null } }
  assert.equal(V.line(none, 'auto'), 'Nothing finished yet.')
  assert.equal(plain(V.tiles(none, 'auto'))[0].line, 'No ticket or other job finished yet.')
})

test('waiting: nobody waited says so in words, not as half waited less than nothing', () => {
  const t = plain(V.tiles({ ...STATS, waiting: { median: 0, mean: 0, share: 0, flows: 12, undated: 1 } }, 'auto'))[4]
  assert.equal(t.number, '0 s')
  assert.equal(t.line, 'No question or by-hand step held these flows up. 1 flow with an undated question left out.')
})

test('waiting with no dated flow says so', () => {
  const t = plain(V.tiles({ ...STATS, waiting: null }, 'auto'))[4]
  assert.equal(t.number, 'Not enough data yet')
  assert.equal(t.line, 'No finished flow has its questions dated.')
})

test('the collapsed line', () => {
  assert.equal(V.line(STATS, 'auto'), '23 tickets and 4 other jobs · 3.9 a day · 0.6 an hour · 42 min a job · 5 min waiting on you')
})

// ═══ where the time goes ═══

test('the stage bar: only dated stages, widths adding to exactly 100, each labelled with its time', () => {
  const parts = plain(V.stageParts(STATS, 'auto'))
  assert.deepEqual(parts.map(p => p.key), ['producing', 'qa', 'rework'])
  assert.deepEqual(parts.map(p => p.text), ['Producer 30 min', 'QA 10 min', 'Reworks 20 min'])
  assert.equal(parts.reduce((t, p) => t + p.width, 0), 100)
  assert.deepEqual(parts.map(p => p.width), [50, 16.67, 33.33])
  const odd = plain(V.stageParts({ stages: [1, 1, 1].map((m, i) => ({ key: `k${i}`, label: `S${i}`, median: m * MIN, flows: 1 })) }, 'auto'))
  assert.equal(Math.round(odd.reduce((t, p) => t + p.width, 0) * 100) / 100, 100)
  assert.deepEqual(plain(V.stageParts(EMPTY, 'auto')), [])
})

test('the stage html: a bar and a table with the same numbers, the undated named, escaped', () => {
  const h = V.stagesHtml(STATS, 'auto')
  assert.match(h, /<table/)
  assert.match(h, /<th scope="row">Producer<\/th><td class="num">30 min<\/td><td class="num">40 min<\/td><td class="num">25<\/td>/)
  assert.match(h, /style="width:50%"/)
  assert.match(h, /Human task/, 'a stage nobody could date is named under the table')
  assert.match(V.stagesHtml(EMPTY, 'auto'), /Nothing finished in this period/)
})

// ═══ the per day bars ═══

test('the per day bars: a height for each, the day and count to read, a text list beside them', () => {
  const b = plain(V.barModel(STATS))
  assert.equal(b.length, 7)
  assert.deepEqual(b.map(x => x.height), [16.67, 0, 50, 0, 0, 100, 33.33])
  assert.equal(b[0].label, 'Thu 19 Nov')
  assert.equal(b[0].says, 'Thu 19 Nov: 1 finished')
  const h = V.chartHtml(STATS)
  assert.match(h, /As a list/)
  assert.match(h, /<li>Tue 24 Nov: 6<\/li>/)
  assert.equal((h.match(/tabindex="0"/g) || []).length, 1, 'one tab stop; the arrow keys move along the bars')
  const week = plain(V.barModel({ ...STATS, window: { ...STATS.window, bucket: 'week' }, bars: [{ day: '2026-11-16', count: 2 }] }))
  assert.equal(week[0].label, 'Week of 16 Nov')
  assert.match(V.chartHtml(EMPTY), /Nothing finished in this period/)
})

// ═══ by agent and the help ═══

test('the per agent table: tickets, other jobs, time per ticket, per day, sent back, escaped', () => {
  const h = V.agentsHtml(STATS, 'auto')
  assert.match(h, /Agent &lt;1&gt;/)
  assert.doesNotMatch(h, /Agent <1>/)
  assert.match(h, /<th scope="row">Master<\/th><td class="num">3<\/td><td class="num">3<\/td><td class="num">2 h<\/td><td class="num">0.86 a day<\/td><td class="num">0<\/td>/)
  assert.match(h, /<th scope="col">Time per job<\/th>/)
  assert.doesNotMatch(h, /Time per ticket/)
  assert.match(V.agentsHtml(EMPTY, 'auto'), /No agent finished work/)
})

test('How it is counted names the rules, the live counts and what the flow files cannot date', () => {
  const h = V.howHtml(STATS)
  for (const words of ['delivered', 'local', 'midnight', '45 hours', 'Median', 'cannot be dated', 'planner', '1 slipped through', '2 dropped', '4 stalled']) assert.match(h, new RegExp(words), words)
  assert.match(h, /Time per job/)
  assert.doesNotMatch(h, /Time per ticket/)
  assert.match(h, /changes the times only/)
  assert.doesNotMatch(h, /—/, 'no em dashes in the copy')
})

// ═══ wiring ═══

test('the block is on the page, in npm run check, under the score, and driven by the score window', () => {
  const html = read('index.html')
  for (const f of ['time-view.js', 'time-strip.js']) assert.match(html, new RegExp(`<script src="${f}"></script>`))
  assert.match(html, /<link rel="stylesheet" href="time.css">/)
  const check = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.check
  for (const f of ['public/time-view.js', 'public/time-strip.js']) assert.ok(check.includes(`node --check ${f}`), f)
  const page = read('agents-page.js')
  assert.ok(page.indexOf('id="plScore"') < page.indexOf('id="plTime"'), 'directly under the score')
  const strip = read('time-strip.js')
  assert.match(strip, /score-window/)
  assert.match(strip, /ScoreStrip\??\.windowNow/)
})

test('time.css uses only the colour tokens, calms its motion, and every storage access is guarded', () => {
  const css = read('time.css')
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|rgb\(/i)
  assert.match(css, /prefers-reduced-motion/)
  const strip = read('time-strip.js')
  for (const m of strip.matchAll(/localStorage\.(get|set)Item/g)) {
    const before = strip.slice(Math.max(0, m.index - 80), m.index)
    assert.match(before, /try \{/, 'every localStorage access sits in a try')
  }
})
