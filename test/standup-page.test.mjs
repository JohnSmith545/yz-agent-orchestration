// Tests for the Standup creator's browser side, pure parts only, each file in a vm with a bare window:
//   generators.js       the tool switch: which tool an address opens (Prompt generator unless ?tool=standup)
//   standup-state.js    the two views (Daily, This week): today's stand-up after a reload, a new day empty, a run's
//                       facts, deltas and end, one archived stand-up shown read-only with its date, Back to today
//   standup-archive.js  the Date archive's words: days grouped by month, Daily and Week entries, the ticket box
//   standup-stream.js   POST /api/standup/generate read as NDJSON: the facts line, the deltas, the end
//   standup-page.js     the markup, as a string: the pills, the labels and accessible names
// and how it is wired: index.html, the check list, the stylesheet's reduced motion and narrow widths.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const read = f => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8')
const ctx = { window: {}, TextDecoder, TextEncoder }
for (const f of ['script-stream.js', 'generators.js', 'standup-state.js', 'standup-archive.js', 'standup-stream.js', 'standup-page.js']) vm.runInNewContext(read(f), ctx)
const { Generators: G, StandupState: S, StandupArchive: A, StandupStream: SS, StandupPage: P } = ctx.window
const plain = v => JSON.parse(JSON.stringify(v))
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

// ═══ the tool switch ═══

test('the page always opens on the Prompt generator, unless the address asks for the Standup creator', () => {
  assert.equal(G.toolOf({}), 'prompt')
  assert.equal(G.toolOf(undefined), 'prompt')
  assert.equal(G.toolOf({ tool: 'standup' }), 'standup')
  assert.equal(G.toolOf({ tool: 'STANDUP' }), 'prompt', 'only the exact word')
  assert.equal(G.toolOf({ tool: 'prompt' }), 'prompt')
  assert.equal(G.hashFor('standup'), '#/generators?tool=standup')
  assert.equal(G.hashFor('prompt'), '#/generators')
})

test('the switch is a radio group of two named pills, one checked, keyboard reachable by one tab stop', () => {
  const h = G.html('standup')
  assert.match(h, /role="radiogroup"/)
  assert.match(h, /aria-label="Tool"/)
  assert.deepEqual([...h.matchAll(/role="radio"/g)].length, 2)
  assert.match(h, /aria-checked="true"[^>]*tabindex="0"[^>]*>Standup creator</)
  assert.match(h, /aria-checked="false"[^>]*tabindex="-1"[^>]*>Prompt generator</)
  assert.ok(text(h).indexOf('Prompt generator') < text(h).indexOf('Standup creator'), 'Prompt generator first')
})

test('pickIndex: arrows and Home or End move round the pills, anything else is no move', () => {
  assert.equal(G.pickIndex('ArrowRight', 0, 2), 1)
  assert.equal(G.pickIndex('ArrowRight', 1, 2), 0, 'wraps')
  assert.equal(G.pickIndex('ArrowLeft', 0, 2), 1)
  assert.equal(G.pickIndex('ArrowDown', 0, 2), 1)
  assert.equal(G.pickIndex('Home', 1, 2), 0)
  assert.equal(G.pickIndex('End', 0, 2), 1)
  assert.equal(G.pickIndex('a', 0, 2), -1)
})

// ═══ the state ═══

const TODAY = { day: '2026-11-25', daily: 's-good', week: null }
const WINDOWS = {
  daily: { from: new Date(2026, 10, 24).toISOString(), to: new Date(2026, 10, 25, 9).toISOString(), label: 'Covers Tue 24 Nov to now', heading: 'Stand up, Tue 24 Nov' },
  week: { from: new Date(2026, 10, 19).toISOString(), to: new Date(2026, 10, 25, 9).toISOString(), label: 'Covers Thu 19 Nov to Wed 25 Nov', heading: 'This week — done:' },
}
const RUN = { id: 's-good', at: new Date(2026, 10, 25, 9, 14).toISOString(), day: '2026-11-25', mode: 'daily', output: 'Stand up, Tue 24 Nov\n- FLA-1: A thing — x', ok: true, error: null, cost: 0.06, window: WINDOWS.daily, read: { line: 'Read: 3 commits, 1 merged pull request, 4 tickets, ticket list from 13 Nov', left: '' } }
const todayEv = (over = {}) => ({ type: 'today', today: TODAY, runs: [RUN], windows: WINDOWS, ticketListAt: '2026-11-13T03:32:00.000Z', ...over })

test('after a reload each view shows today s stand-up of its kind; the other is empty and says what Generate does', () => {
  let s = S.reduce(S.initial(), todayEv())
  const d = plain(S.view(s))
  assert.equal(d.mode, 'daily')
  assert.equal(d.output, RUN.output)
  assert.equal(d.canCopy, true)
  assert.equal(d.read, RUN.read.line)
  assert.equal(d.made, 'Daily · Made Wed 25 Nov 09:14 · Covers Tue 24 Nov')
  assert.equal(d.covers, 'Covers Tue 24 Nov to now')
  assert.equal(d.button, 'Generate again')
  s = S.reduce(s, { type: 'mode', mode: 'week' })
  const w = plain(S.view(s))
  assert.equal(w.output, '')
  assert.equal(w.canCopy, false)
  assert.equal(w.made, 'This week · not written yet today')
  assert.equal(w.covers, 'Covers Thu 19 Nov to Wed 25 Nov')
  assert.equal(w.button, 'Generate')
  assert.match(w.empty, /Generate/)
})

test('a new day empties both views until Generate is pressed', () => {
  let s = S.reduce(S.initial(), todayEv())
  s = S.reduce(s, todayEv({ today: { day: '2026-11-26', daily: null, week: null }, runs: [] }))
  assert.equal(S.view(s).output, '')
  assert.equal(S.view(s).made, 'Daily · not written yet today')
})

test('a run: start empties the view, the facts line fills Read, deltas stream in, the end names the run; late events of an old run are dropped', () => {
  let s = S.reduce(S.initial(), todayEv())
  s = S.reduce(s, { type: 'start', mode: 'daily', at: new Date(2026, 10, 25, 10, 2).toISOString() })
  const run = s.run
  assert.equal(S.view(s).output, '')
  assert.equal(S.view(s).busy, true)
  assert.equal(S.view(s).progress, 'Reading your work…')
  s = S.reduce(s, { type: 'facts', run, read: 'Read: 2 commits', left: 'Left out: Flows (it could not be read).', window: WINDOWS.daily })
  assert.equal(S.view(s).read, 'Read: 2 commits')
  assert.equal(S.view(s).left, 'Left out: Flows (it could not be read).')
  assert.equal(S.view(s).progress, 'Writing…')
  s = S.reduce(s, { type: 'delta', run, text: 'Stand up, ' })
  s = S.reduce(s, { type: 'delta', run, text: 'Tue 24 Nov' })
  assert.equal(S.view(s).output, 'Stand up, Tue 24 Nov')
  assert.equal(S.reduce(s, { type: 'delta', run: run - 1, text: 'late' }), s, 'an old run s event changes nothing')
  s = S.reduce(s, { type: 'end', run, ok: true, runId: 's-new', cost: 0.07 })
  const v = S.view(s)
  assert.equal(v.busy, false)
  assert.equal(v.progress, '')
  assert.equal(v.made, 'Daily · Made Wed 25 Nov 10:02 · Covers Tue 24 Nov')
  assert.equal(s.views.daily.runId, 's-new')
})

test('while one stand-up is written the other view cannot start one; a failed run shows its error and Retry', () => {
  let s = S.reduce(S.initial(), todayEv())
  s = S.reduce(s, { type: 'start', mode: 'daily', at: RUN.at })
  s = S.reduce(s, { type: 'mode', mode: 'week' })
  assert.equal(S.view(s).canGenerate, false)
  assert.match(S.view(s).hint, /being written/)
  s = S.reduce(s, { type: 'mode', mode: 'daily' })
  s = S.reduce(s, { type: 'end', run: s.run, ok: false, error: 'No reply for 2 minutes, so the run was stopped. Try again.' })
  const v = S.view(s)
  assert.equal(v.error, 'No reply for 2 minutes, so the run was stopped. Try again.')
  assert.equal(v.canRetry, true)
  assert.equal(v.canGenerate, true)
})

test('an archived stand-up is shown read-only with its date, and Back to today brings today s back', () => {
  let s = S.reduce(S.initial(), todayEv())
  const old = { ...RUN, id: 's-old', mode: 'week', day: '2026-11-18', at: new Date(2026, 10, 18, 17, 40).toISOString(), output: 'Name: Yz31LL', window: { from: new Date(2026, 10, 12).toISOString(), to: new Date(2026, 10, 18, 17, 40).toISOString() } }
  s = S.reduce(s, { type: 'show', run: old })
  const v = S.view(s)
  assert.equal(v.mode, 'week', 'the pill follows the stand-up shown')
  assert.equal(v.output, 'Name: Yz31LL')
  assert.equal(v.archived, true)
  assert.equal(v.made, 'This week · Made Wed 18 Nov 17:40 · Covers Thu 12 Nov to Wed 18 Nov')
  assert.equal(v.canCopy, true)
  s = S.reduce(s, { type: 'back' })
  assert.equal(S.view(s).archived, false)
  assert.equal(S.view(s).output, '', 'no week stand-up today')
  s = S.reduce(s, { type: 'show', run: { ...RUN, id: 's-x', mode: 'daily' } })
  s = S.reduce(s, { type: 'start', mode: 'daily', at: RUN.at })
  assert.equal(S.reduce(s, { type: 'show', run: { ...old, mode: 'daily' } }), s, 'refused into the view whose stand-up is being written')
  assert.equal(S.view(S.reduce(s, { type: 'show', run: old })).mode, 'week', 'the other view may still show one: the run goes on')
})

test('a reload of today does not replace a stand-up being shown from the archive', () => {
  let s = S.reduce(S.initial(), todayEv())
  s = S.reduce(s, { type: 'show', run: { ...RUN, id: 's-old', at: new Date(2026, 10, 20, 9).toISOString(), day: '2026-11-20', output: 'Stand up, Thu 19 Nov' } })
  s = S.reduce(s, todayEv())
  assert.equal(S.view(s).output, 'Stand up, Thu 19 Nov')
})

// ═══ the Date archive ═══

const DAYS = [
  { day: '2026-12-01', runs: [{ id: 's-4', mode: 'daily', ok: true, first: '- FLA-9: Nine — x' }], tickets: ['FLA-9'] },
  { day: '2026-11-25', runs: [{ id: 's-3', mode: 'week', ok: true, first: 'FLA-7: Seven — x' }, { id: 's-2', mode: 'daily', ok: false, first: 'Stopped.' }, { id: 's-1', mode: 'daily', ok: true, first: '- FLA-1: One — x' }], tickets: ['FLA-1', 'FLA-7'] },
]

test('months: days newest first under their month, each entry Daily or Week with its first line', () => {
  const m = plain(A.months(DAYS))
  assert.deepEqual(m.map(x => x.label), ['December 2026', 'November 2026'])
  assert.equal(m[1].days[0].label, 'Wed 25 Nov')
  assert.deepEqual(m[1].days[0].entries.map(e => [e.kind, e.first, e.failed]), [['Week', 'FLA-7: Seven — x', false], ['Daily', 'Stopped.', true], ['Daily', 'FLA-1: One — x', false]])
  const linked = plain(A.months([{ day: '2026-11-25', runs: [{ id: 's-1', mode: 'daily', ok: true, first: '- FLA-1: One — https://app.switchboardpm.ai/stories/FLA-1' }] }]))
  assert.equal(linked[0].days[0].entries[0].first, 'FLA-1: One', 'a list line drops the bullet and the link: the stand-up itself keeps them')
})

test('the archive s other words: the day name, the summary, a day with nothing, the ticket box', () => {
  assert.equal(A.dayName('2026-11-25'), 'Wed 25 Nov 2026')
  assert.equal(A.dayName('nope'), '')
  assert.equal(A.summary(DAYS), 'Date archive · 2 days')
  assert.equal(A.summary([DAYS[0]]), 'Date archive · 1 day')
  assert.equal(A.nothing('2026-11-26'), 'Nothing was saved on Thu 26 Nov 2026.')
  assert.equal(A.ticketQuery(' fla-886 '), 'FLA-886')
  assert.equal(A.ticketQuery('886'), '')
  assert.equal(A.ticketNone('FLA-886'), 'No stand-up mentions FLA-886 yet.')
  assert.equal(A.dayQuery('2026-11-25'), '2026-11-25')
  assert.equal(A.dayQuery('2026-02-30'), '')
})

// ═══ the stream ═══

function response(chunks, { ok = true, status = 200, json = {} } = {}) {
  const enc = new TextEncoder()
  const queue = chunks.map(c => enc.encode(c))
  return { ok, status, json: async () => json, body: { getReader: () => ({ read: async () => (queue.length ? { done: false, value: queue.shift() } : { done: true, value: undefined }) }) } }
}
const line = o => JSON.stringify(o) + '\n'

test('the stream POSTs the mode, hands on the facts line and each delta, and resolves the end line', async () => {
  const sent = []
  const body = line({ type: 'facts', mode: 'daily', read: 'Read: 1 commit', left: '', window: WINDOWS.daily }) + line({ type: 'delta', text: 'Stand' }) + line({ type: 'delta', text: ' up' }) + line({ type: 'done', ok: true, cost: 0.06, run: 's-1' })
  const fetch = async (url, opts) => (sent.push({ url, opts }), response([body.slice(0, 30), body.slice(30)]))
  const facts = []
  const got = []
  const out = await SS.generate('daily', { onFacts: f => facts.push(f), onDelta: t => got.push(t), fetch })
  assert.equal(sent[0].url, '/api/standup/generate')
  assert.deepEqual(JSON.parse(sent[0].opts.body), { mode: 'daily' })
  assert.equal(facts[0].read, 'Read: 1 commit')
  assert.deepEqual(got, ['Stand', ' up'])
  assert.deepEqual(plain(out), { type: 'done', ok: true, cost: 0.06, run: 's-1' })
})

test('the stream never rejects: a refusal, a network failure and a cut stream are calm errors', async () => {
  assert.deepEqual(plain(await SS.generate('week', { fetch: async () => response([], { ok: false, status: 409, json: { error: 'A stand-up is already being written.' } }) })), { type: 'error', error: 'A stand-up is already being written.' })
  assert.match((await SS.generate('week', { fetch: async () => { throw new Error('down') } })).error, /Could not reach/)
  assert.match((await SS.generate('week', { fetch: async () => response([line({ type: 'delta', text: 'x' })]) })).error, /closed before/)
})

// ═══ the markup ═══

test('the Standup creator s markup: the mode pills, the box, Generate, Copy, the archive tools, all named', () => {
  const h = P.markup()
  assert.match(h, /role="radiogroup" aria-label="Which stand-up"/)
  assert.ok(text(h).includes('Daily') && text(h).includes('This week'))
  assert.match(h, /id="suOut"[^>]*role="region"[^>]*aria-label="Your stand-up"/)
  assert.match(h, /id="suGo"[^>]*>Generate</)
  assert.match(h, /id="suCopy"[^>]*>Copy</)
  assert.match(h, /<input type="date" id="suDay"/)
  assert.match(h, /<label for="suDay"/)
  assert.match(h, /<label for="suTicket"/)
  assert.match(h, /id="suArchiveHead"[^>]*>Date archive</)
  assert.doesNotMatch(h, /style="/, 'no inline styles: standup.css holds the look')
})

// ═══ the wiring ═══

test('index.html loads the stylesheet and the scripts after the prompt generator s, and the check list has every file', () => {
  const index = read('index.html')
  assert.ok(index.includes('<link rel="stylesheet" href="standup.css">'))
  const at = s => index.indexOf(`<script src="${s}"></script>`)
  const order = ['script-stream.js', 'standup-state.js', 'standup-archive.js', 'standup-stream.js', 'standup-archive-view.js', 'standup-page.js', 'generators.js', 'script-page.js']
  for (const s of order) assert.ok(at(s) > 0, s)
  for (let i = 1; i < order.length; i++) assert.ok(at(order[i - 1]) < at(order[i]), `${order[i - 1]} before ${order[i]}`)
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  for (const f of ['public/generators.js', 'public/standup-state.js', 'public/standup-archive.js', 'public/standup-stream.js', 'public/standup-archive-view.js', 'public/standup-page.js']) assert.ok(pkg.scripts.check.includes(`node --check ${f}`), f)
})

test('standup.css: the pills show which is checked, the archive never widens a phone, and reduced motion calms it', () => {
  const css = read('standup.css')
  assert.match(css, /\[aria-checked="true"\]/)
  assert.match(css, /prefers-reduced-motion: reduce/)
  assert.match(css, /@media \(max-width: 560px\)/)
  assert.match(css, /overflow-wrap: anywhere/)
  assert.doesNotMatch(css, /#[0-9a-f]{3,6}\b/i, 'colours come from the tokens, so dark mode follows')
})

// ═══ QA A-2, 2026-11-25: a refused or failed Generate showed a Made time for a stand-up that did not exist ═══

test('regression: a Generate refused before any text (409, no server) never shows a Made time', () => {
  let s = S.reduce(S.initial(), todayEv({ today: { day: '2026-11-25', daily: null, week: null }, runs: [] }))
  s = S.reduce(s, { type: 'start', mode: 'daily', at: new Date(2026, 10, 25, 10, 28).toISOString() })
  assert.equal(S.view(s).made, 'Daily · not written yet today', 'nothing is made until text arrives')
  s = S.reduce(s, { type: 'end', run: s.run, ok: false, error: 'A stand-up is already being written. Wait for it to finish, then try again.' })
  const v = S.view(s)
  assert.equal(v.made, 'Daily · not written yet today')
  assert.equal(v.output, '')
  assert.match(v.error, /already being written/)
})

test('regression: a failed Generate over today s stand-up brings that stand-up and its own Made time back, with the error', () => {
  let s = S.reduce(S.initial(), todayEv())
  s = S.reduce(s, { type: 'start', mode: 'daily', at: new Date(2026, 10, 25, 10, 28).toISOString() })
  s = S.reduce(s, { type: 'end', run: s.run, ok: false, error: 'Could not reach the dashboard.' })
  const v = S.view(s)
  assert.equal(v.output, RUN.output)
  assert.equal(v.made, 'Daily · Made Wed 25 Nov 09:14 · Covers Tue 24 Nov')
  assert.equal(v.error, 'Could not reach the dashboard.')
  assert.equal(v.canRetry, true)
})

test('a run that failed after some text keeps that text and its own time, marked by the error', () => {
  let s = S.reduce(S.initial(), todayEv())
  s = S.reduce(s, { type: 'start', mode: 'daily', at: new Date(2026, 10, 25, 10, 28).toISOString() })
  s = S.reduce(s, { type: 'delta', run: s.run, text: 'Stand up, Tue' })
  s = S.reduce(s, { type: 'end', run: s.run, ok: false, error: 'Stopped.' })
  assert.equal(S.view(s).output, 'Stand up, Tue')
  assert.match(S.view(s).made, /Made Wed 25 Nov 10:28/)
})

test('regression (QA A-3): each archive entry says its kind, the time it was made and the dates it covers', () => {
  const at = new Date(2026, 10, 25, 10, 28).toISOString()
  const m = plain(A.months([{ day: '2026-11-25', runs: [
    { id: 's-2', mode: 'week', ok: true, first: 'x', at, window: { from: new Date(2026, 10, 19).toISOString(), to: at } },
    { id: 's-1', mode: 'daily', ok: true, first: 'y', at, window: { from: new Date(2026, 10, 24).toISOString(), to: at } },
    { id: 's-0', mode: 'daily', ok: true, first: 'z' },
  ] }]))
  assert.deepEqual(m[0].days[0].entries.map(e => e.meta), ['Week · 10:28 · covers Thu 19 Nov to Wed 25 Nov', 'Daily · 10:28 · covers Tue 24 Nov', 'Daily'])
})

// ═══ QA A-8, 2026-11-25: a page left open past midnight did not reset until it was opened again ═══

test('msToMidnight: the time to just after the next local midnight, from the clock given', () => {
  assert.equal(S.msToMidnight(new Date(2026, 10, 25, 23, 59, 30)), 31_000, 'a second past midnight, so the server s day has turned')
  assert.equal(S.msToMidnight(new Date(2026, 10, 30, 12, 0, 0)), 12 * 3_600_000 + 1_000, 'across a month end')
  assert.equal(S.msToMidnight(new Date(2026, 11, 31, 23, 0, 0)), 3_600_000 + 1_000, 'across a year end')
})

test('the page asks for today again when the tab comes back, when Generate is pressed and just after midnight', () => {
  const src = read('standup-page.js')
  assert.match(src, /addEventListener\('visibilitychange'[^\n]*visible[^\n]*refresh\(\)/)
  assert.match(src, /async function onGenerate\(\) \{[\s\S]*?await refresh\(\)[\s\S]*?dispatch\(\{ type: 'start'/)
  assert.match(src, /setTimeout\(atMidnight, S\(\)\.msToMidnight\(new Date\(\)\)\)/)
})

test('a reload on a new day empties a stand-up shown from a live run as well', () => {
  let s = S.reduce(S.initial(), todayEv({ today: { day: '2026-11-25', daily: null, week: null }, runs: [] }))
  s = S.reduce(s, { type: 'start', mode: 'daily', at: RUN.at })
  s = S.reduce(s, { type: 'delta', run: s.run, text: 'Stand up, Tue 24 Nov' })
  s = S.reduce(s, { type: 'end', run: s.run, ok: true, runId: 's-x' })
  s = S.reduce(s, todayEv({ today: { day: '2026-11-26', daily: null, week: null }, runs: [] }))
  assert.equal(S.view(s).output, '')
  assert.equal(S.view(s).made, 'Daily · not written yet today')
})

test('a refresh while another page or tool shows never writes over that page s status chip', () => {
  assert.match(read('standup-page.js'), /if \(home && !home\.closest\('\[hidden\]'\)\) status\(\)/)
})
