// Tests for the pipeline scorecard on the Agents page: public/score-view.js (the pure half: tiles, the collapsed
// line, the How it is counted HTML, what a remembered choice means) run in a vm with a bare window, and greps that
// wire it in: public/score-strip.js and score.css on the page, in npm run check, the strip's container on the
// Agents page, colours only from the tokens, motion calmed, every localStorage access guarded.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { MEANING as SERVER_MEANING } from '../score.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, '..', 'public')
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8')
const ctx = vm.createContext({ window: {} })
for (const f of ['shell.js', 'app.js', 'score-view.js']) vm.runInContext(read(f), ctx)
const V = ctx.window.ScoreView

/** A scorecard as /api/score sends it: 5 delivered, 0 slipped, 4 missed, 5 caught, 10 on their way. */
const SCORE = {
  window: { days: 30, from: '2026-10-25T12:00:00.000Z', stallDays: 7 },
  counts: { delivered: 5, slipped: 0, missed: 4, caught: 5 },
  lists: { slipped: [], missed: [{ id: 'armor-api', title: 'Armor <b>API</b>', why: 'stalled' }, { id: 'gone', title: 'Gone', why: 'dropped' }, { id: 'st', title: '', why: 'stopped' }] },
  precision: { value: 1, top: 5, bottom: 5 },
  recall: { value: 5 / 9, top: 5, bottom: 9 },
  accuracy: { value: 10 / 14, top: 10, bottom: 14 },
  f: { 1: { value: 0.714, beta: 1 }, 4: { value: 0.57, beta: 4 } },
  correctness: { value: 0.5, right: 2, judged: 4 },
  agents: [{ label: 'Master', handed: 12, firstTime: 2, sentBack: 5 }],
  inFlight: 10,
  builtAt: '2026-11-24T12:00:00.000Z',
}
const EMPTY = {
  window: { days: 7, from: '2026-11-17T12:00:00.000Z', stallDays: 7 },
  counts: { delivered: 0, slipped: 0, missed: 0, caught: 0 },
  lists: { slipped: [], missed: [] },
  precision: { value: null, top: 0, bottom: 0 },
  recall: { value: null, top: 0, bottom: 0 },
  accuracy: { value: null, top: 0, bottom: 0 },
  f: { 1: { value: null, beta: 1 }, 4: { value: null, beta: 4 } },
  correctness: { value: null, right: 0, judged: 0 },
  agents: [],
  inFlight: 1,
}

test('the plain meanings are the server ones, word for word (MUST CHANGE IN LOCKSTEP)', () => {
  assert.deepEqual({ ...V.MEANING }, { ...SERVER_MEANING })
})

test('five tiles in order, each the name, the percent, the fraction and the meaning', () => {
  const tiles = JSON.parse(JSON.stringify(V.tiles(SCORE, 1)))
  assert.deepEqual(tiles.map(t => t.key), ['precision', 'recall', 'f', 'accuracy', 'correctness'])
  assert.deepEqual(tiles.map(t => t.name), ['Precision', 'Recall', 'F-score', 'Accuracy', 'Correctness'])
  assert.deepEqual(tiles.map(t => t.number), ['100%', '56%', '71%', '71%', '50%'])
  assert.deepEqual(tiles.map(t => t.fraction), ['5 of 5', '5 of 9', '', '10 of 14', '2 of 4'])
  assert.equal(tiles[0].meaning, SERVER_MEANING.precision)
  assert.ok(tiles.every(t => t.empty === false))
})

test('the F-score tile follows the switch and says what the choice means', () => {
  const [one, four] = [V.tiles(SCORE, 1)[2], V.tiles(SCORE, 4)[2]]
  assert.equal(one.number, '71%')
  assert.equal(four.number, '57%')
  assert.match(one.meaning, /count the same/)
  assert.match(four.meaning, /far more/)
})

test('a score with no data says Not enough data yet, never 0%, NaN or a dash', () => {
  for (const t of V.tiles(EMPTY, 4)) {
    assert.equal(t.number, 'Not enough data yet', t.key)
    assert.equal(t.fraction, '', t.key)
    assert.equal(t.empty, true, t.key)
  }
  const line = V.line(EMPTY, 1)
  assert.match(line, /Not enough data yet/)
  assert.doesNotMatch(line + JSON.stringify(V.tiles(EMPTY, 1)), /0%|NaN|undefined|—|–/)
})

test('collapsed: one line with the five numbers, the chosen F-score named', () => {
  assert.equal(V.line(SCORE, 1), 'Precision 100% · Recall 56% · F1 71% · Accuracy 71% · Correctness 50%')
  assert.match(V.line(SCORE, 4), /F4 57%/)
  const some = { ...SCORE, precision: { value: null, top: 0, bottom: 0 }, f: { 1: { value: null }, 4: { value: null } } }
  assert.match(V.line(some, 1), /^Precision not enough data · Recall 56% · F1 not enough data/)
})

test('a remembered choice: 7, 30 or all days (30 for anything else), F1 or F4 (F1 for anything else)', () => {
  assert.equal(V.windowOf('7'), '7')
  assert.equal(V.windowOf('all'), 'all')
  for (const v of [null, '', '14', 'ALL', 'x']) assert.equal(V.windowOf(v), '30', String(v))
  assert.equal(V.betaOf('4'), 4)
  for (const v of [null, '', '2', '1']) assert.equal(V.betaOf(v), 1, String(v))
  assert.deepEqual([...V.WINDOWS].map(w => w.key), ['7', '30', 'all'])
})

test('How it is counted: the four boxes with their live counts and what each one holds', () => {
  const html = V.howHtml(SCORE)
  for (const [name, n] of [['Right, delivered', 5], ['Wrong, slipped through', 0], ['Wrong, missed', 4], ['Right, caught', 5]]) {
    assert.match(html, new RegExp(`<b class="psc-n">${n}</b> ${name}`), name)
  }
  assert.match(html, /<th scope="col">The work was good<\/th><th scope="col">The work was not good<\/th>/)
  assert.match(html, /<th scope="row">Went to the Output<\/th>/)
  assert.match(html, /<th scope="row">Held back<\/th>/)
  assert.match(html, /no update for 7 days/)
  assert.match(html, /the last 30 days/)
})

test('How it is counted: the missed flows link to each flow, titles escaped, each with its reason', () => {
  const html = V.howHtml(SCORE)
  assert.match(html, /<button type="button" class="link" data-score-flow="armor-api">Armor &lt;b&gt;API&lt;\/b&gt;<\/button>/)
  assert.doesNotMatch(html, /<b>API<\/b>/)
  assert.match(html, /No update for 7 days/)
  assert.match(html, /data-score-flow="gone">Gone<\/button> <span class="psc-why">Dropped<\/span>/)
  assert.match(html, /data-score-flow="st">st<\/button> <span class="psc-why">Stopped at QA<\/span>/, 'no title: the id')
  assert.match(html, /Slipped through<\/h4><p class="psc-none">None\.<\/p>/)
})

test('How it is counted: how many are still on their way, the sums, and the By agent table', () => {
  const html = V.howHtml(SCORE)
  assert.match(html, /10 flows are still on their way/)
  assert.match(V.howHtml(EMPTY), /1 flow is still on its way/)
  assert.match(html, /Precision: 5 ÷ \(5 \+ 0\)/)
  assert.match(html, /Recall: 5 ÷ \(5 \+ 4\)/)
  assert.match(html, /Accuracy: \(5 \+ 5\) ÷ 14/)
  assert.match(html, /<th scope="col">Handed to QA<\/th><th scope="col">Passed first time<\/th><th scope="col">Sent back<\/th>/)
  assert.match(html, /<th scope="row">Master<\/th><td class="num">12<\/td><td class="num">2<\/td><td class="num">5<\/td>/)
  assert.match(V.howHtml(EMPTY), /Nothing was handed to QA in this window\./)
  assert.match(V.howHtml({ ...SCORE, window: { days: null, from: null, stallDays: 7 } }), /all time/)
})

test('the copy has no em dash and no NaN anywhere', () => {
  for (const s of [V.howHtml(SCORE), V.howHtml(EMPTY), read('score-view.js'), read('score-strip.js')]) {
    assert.doesNotMatch(s, /—|NaN/)
  }
})

// ═══ wiring ═══

test('wired in: the scripts after app.js, the stylesheet, npm run check, and the strip at the top of the Agents page', () => {
  const html = read('index.html')
  const at = s => html.indexOf(`<script src="${s}"></script>`)
  assert.ok(at('score-view.js') > at('app.js') && at('score-strip.js') > at('score-view.js'), 'score-view.js, then score-strip.js')
  assert.match(html, /<link rel="stylesheet" href="score\.css">/)
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
  for (const f of ['score.mjs', 'score-routes.mjs', 'public/score-view.js', 'public/score-strip.js']) assert.match(pkg.checkList, new RegExp(`node --check ${f.replace('.', '\\.')}`), f)
  const page = read('agents-page.js')
  assert.match(page, /<div class="pl-main">\s*<div class="psc" id="plScore"><\/div>/)
  assert.match(page, /ScoreStrip/)
})

test('the strip: every localStorage access in try/catch, text set through esc or textContent', () => {
  const src = read('score-strip.js')
  const uses = src.split('localStorage').length - 1
  assert.ok(uses >= 2)
  const guarded = src.match(/try \{\s*(?:return )?window\.localStorage\.[a-zA-Z]+\(/g) || []
  assert.equal(guarded.length, uses, 'every access sits right inside a try')
  assert.match(src, /\.textContent = /, 'the tile numbers go in as text')
  assert.doesNotMatch(src, /innerHTML\s*=\s*`/, 'no template string goes straight into innerHTML')
})

test('score.css: colours only from the tokens, quiet tiles, motion calmed, and the class prefix is its own', () => {
  const css = read('score.css')
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i, 'no literal colours')
  assert.doesNotMatch(css, /var\(--(ok|bad|warn)\)/, 'no traffic-light colours')
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
  for (const f of fs.readdirSync(PUBLIC).filter(f => f.endsWith('.css') && f !== 'score.css')) assert.doesNotMatch(read(f), /\.psc\b|\.psc-/, f)
})
