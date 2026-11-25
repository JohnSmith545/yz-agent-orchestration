// Tests for standup-archive.mjs: the Standup creator's dated archive. One file per local day under data/standup/
// (<YYYY-MM-DD>.json, every run made that day, newest first, at most 20), written atomically, plus index.json
// (day -> its runs in brief and the ticket ids they mention), rebuilt from the day files when it is missing, broken
// or out of step. Every path is built only after the day or ticket id is checked. A temp folder stands in for data/.

import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'standup-archive-test-'))
process.env.FACTORY_DATA_DIR = TMP
const A = await import('../standup-archive.mjs')
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const DIR = path.join(TMP, 'standup')
beforeEach(() => fs.rmSync(DIR, { recursive: true, force: true }))

const LINK = id => `https://app.switchboardpm.ai/stories/${id}`
const DAILY_OUT = [
  'Stand up, Tue 24 Nov',
  `- FLA-886: Deleted accounts also delete uploads — ${LINK('FLA-886')}`,
  '  - Deleting an account now also deletes the athlete s photos.',
  '  - Merged to dev in PR #1174.',
  '',
  'Blockers',
  `- FLA-870: needs a production database admin to grant access — ${LINK('FLA-870')}`,
  '',
  "What's next",
  `- FLA-868: finish the tests — ${LINK('FLA-868')}`,
].join('\n')

let n = 0
const entry = (over = {}) => ({
  id: `s-${(n++).toString(36).padStart(6, '0')}`, at: new Date(2026, 10, 25, 9, n % 60).toISOString(), day: '2026-11-25', mode: 'daily', ms: 1000,
  output: DAILY_OUT, ok: true, error: null, cancelled: false, cost: 0.05,
  window: { from: 'a', to: 'b', label: 'Covers Tue 24 Nov to now', heading: 'Stand up, Tue 24 Nov' }, read: { line: 'Read: x', left: '' },
  tickets: [{ id: 'FLA-886', title: 'Deleted accounts also delete uploads', link: LINK('FLA-886') }], ...over,
})

// ═══ checks before any path ═══

test('isDay: a real calendar day as YYYY-MM-DD, nothing else', () => {
  assert.equal(A.isDay('2026-11-25'), true)
  assert.equal(A.isDay('2028-02-29'), true, 'a leap day')
  for (const bad of ['2026-02-30', '2026-13-01', '2026-1-5', '../2026-11-25', '2026-11-25.json', '', null, 20261125]) assert.equal(A.isDay(bad), false, String(bad))
})

test('ticketId: an id such as FLA-886, upper-cased; anything else is empty', () => {
  assert.equal(A.ticketId('fla-886'), 'FLA-886')
  assert.equal(A.ticketId(' FLIN-12 '), 'FLIN-12')
  for (const bad of ['FLA', '886', 'FLA-886/..', '../FLA-1', 'FLA-1-2', '', null]) assert.equal(A.ticketId(bad), '', String(bad))
})

// ═══ one file per day ═══

test('appendRun writes the run into its own day s file, newest first, and nothing else is rewritten', () => {
  const a = A.appendRun(entry({ day: '2026-11-24' }))
  const b = A.appendRun(entry())
  const c = A.appendRun(entry({ mode: 'week', output: 'Name: Yz31LL' }))
  assert.deepEqual(fs.readdirSync(DIR).sort(), ['2026-11-24.json', '2026-11-25.json', 'index.json'])
  assert.deepEqual(A.readDay('2026-11-25').map(r => r.id), [c.id, b.id])
  assert.deepEqual(A.readDay('2026-11-24').map(r => r.id), [a.id])
  assert.ok(!fs.readdirSync(DIR).some(f => f.includes('.tmp')), 'written atomically, no temp file left')
})

test('a day keeps at most 20 runs; there is no cap on the number of days', () => {
  for (let i = 0; i < 23; i++) A.appendRun(entry())
  assert.equal(A.readDay('2026-11-25').length, A.ARCHIVE_LIMITS.perDay)
  assert.equal(A.ARCHIVE_LIMITS.perDay, 20)
  for (let d = 1; d <= 70; d++) A.appendRun(entry({ day: `2026-09-${String((d % 30) + 1).padStart(2, '0')}` }))
  assert.equal(A.listDays().length, 31, 'every day is kept')
})

test('one output is capped; a run of the wrong shape is refused', () => {
  const e = A.appendRun(entry({ output: 'x'.repeat(50_000) }))
  assert.equal(e.output.length, 40_000)
  assert.throws(() => A.appendRun({ id: 'nope' }))
  assert.throws(() => A.appendRun(entry({ day: '../x' })))
})

test('readDay: an unknown, missing or broken day is no runs; a bad day string never reaches the disk', () => {
  assert.deepEqual(A.readDay('2026-11-01'), [])
  assert.deepEqual(A.readDay('../../etc'), [])
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(path.join(DIR, '2026-11-02.json'), '{nope')
  assert.deepEqual(A.readDay('2026-11-02'), [])
})

// ═══ the index ═══

test('listDays: newest first, each day s runs in brief with the line that says what it is about', () => {
  A.appendRun(entry({ day: '2026-11-24' }))
  A.appendRun(entry({ mode: 'week', output: 'Name: Yz31LL\nProject: Flinki\nThis week — done:\nDone Nov 19–25:\nFLA-700: Confirm the list — x' }))
  A.appendRun(entry({ ok: false, error: 'Stopped.', output: '', cancelled: true }))
  const days = A.listDays()
  assert.deepEqual(days.map(d => d.day), ['2026-11-25', '2026-11-24'])
  const [failed, week] = days[0].runs
  assert.equal(week.mode, 'week')
  assert.equal(week.first, 'FLA-700: Confirm the list — x', 'past the header lines, to the first ticket')
  assert.equal(failed.ok, false)
  assert.equal(failed.first, 'Stopped.')
  assert.equal(days[1].runs[0].first, `- FLA-886: Deleted accounts also delete uploads — ${LINK('FLA-886')}`)
  assert.ok(days[0].tickets.includes('FLA-886'))
})

test('the index is rebuilt from the day files when it is missing, broken or out of step', () => {
  A.appendRun(entry({ day: '2026-11-24' }))
  A.appendRun(entry())
  fs.rmSync(path.join(DIR, 'index.json'))
  assert.deepEqual(A.listDays().map(d => d.day), ['2026-11-25', '2026-11-24'])
  fs.writeFileSync(path.join(DIR, 'index.json'), 'not json')
  assert.equal(A.listDays().length, 2)
  fs.copyFileSync(path.join(DIR, '2026-11-24.json'), path.join(DIR, '2026-11-20.json')) // a day file the index has not heard of
  assert.deepEqual(A.listDays().map(d => d.day), ['2026-11-25', '2026-11-24', '2026-11-20'])
  assert.ok(JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8')).days['2026-11-20'], 'and written back')
})

// ═══ tickets ═══

test('ticketsMentioned: the facts tickets the output names, then any other id in it, each with a link', () => {
  const facts = [
    { id: 'FLA-886', title: 'Deleted accounts also delete uploads', link: LINK('FLA-886') },
    { id: 'FLA-999', title: 'In the facts but not in the stand-up', link: LINK('FLA-999') },
  ]
  const got = A.ticketsMentioned(DAILY_OUT, facts, ['FLIN', 'FLA'], LINK)
  assert.deepEqual(got.map(t => t.id), ['FLA-886', 'FLA-870', 'FLA-868'])
  assert.deepEqual(got[0], facts[0])
  assert.deepEqual(got[1], { id: 'FLA-870', title: '', link: LINK('FLA-870') })
  assert.deepEqual(A.ticketsMentioned('', facts, ['FLA'], LINK), [])
})

test('linesAbout: the lines that name a ticket, with the bullets under each', () => {
  assert.deepEqual(A.linesAbout(DAILY_OUT, 'FLA-886'), [
    `- FLA-886: Deleted accounts also delete uploads — ${LINK('FLA-886')}`,
    '  - Deleting an account now also deletes the athlete s photos.',
    '  - Merged to dev in PR #1174.',
  ])
  assert.deepEqual(A.linesAbout(DAILY_OUT, 'FLA-88'), [], 'FLA-88 is not FLA-886')
})

test('ticketHistory: every day a ticket appeared, newest first, with its title, link and lines', () => {
  A.appendRun(entry({ day: '2026-11-20' }))
  A.appendRun(entry({ day: '2026-11-21', output: 'Stand up, Thu 20 Nov\n- Nothing merged.', tickets: [] }))
  A.appendRun(entry({ day: '2026-11-24' }))
  const h = A.ticketHistory('fla-886')
  assert.equal(h.id, 'FLA-886')
  assert.equal(h.title, 'Deleted accounts also delete uploads')
  assert.equal(h.link, LINK('FLA-886'))
  assert.deepEqual(h.days.map(d => d.day), ['2026-11-24', '2026-11-20'])
  assert.equal(h.days[0].entries[0].mode, 'daily')
  assert.equal(h.days[0].entries[0].lines.length, 3)
  assert.deepEqual(A.ticketHistory('FLA-1').days, [])
  assert.equal(A.ticketHistory('../x'), null, 'a bad id is refused before any read')
})

test('todayRuns picks the newest GOOD run of each mode of one day', () => {
  const runs = [entry({ id: 's-3', ok: false }), entry({ id: 's-2' }), entry({ id: 's-1' }), entry({ id: 's-0', mode: 'week', ok: false })]
  assert.deepEqual(A.todayRuns(runs), { daily: 's-2', week: null })
})

// ═══ QA A-3, 2026-11-25: the list must say when each was made and what it covers, not only after opening ═══

test('listDays: each run in brief carries the window it covers, and an older index without it is rebuilt', () => {
  const e = A.appendRun(entry({ window: { from: '2026-11-23T16:00:00.000Z', to: '2026-11-25T02:28:00.000Z', label: 'x', heading: 'y' } }))
  assert.deepEqual(A.listDays()[0].runs[0].window, { from: '2026-11-23T16:00:00.000Z', to: '2026-11-25T02:28:00.000Z' })
  assert.equal(A.listDays()[0].runs[0].at, e.at)
  const file = path.join(DIR, 'index.json')
  const old = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const r of old.days['2026-11-25'].runs) delete r.window
  fs.writeFileSync(file, JSON.stringify(old))
  assert.ok(A.listDays()[0].runs[0].window, 'rebuilt from the day file')
})
