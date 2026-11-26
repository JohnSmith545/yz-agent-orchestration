// Tests for public/predict-view.js, the pure half of Predict and warn on the page, run in a vm with a bare window:
// the words (in lockstep with predict-words.mjs), the Alerts line over the diagram and its rows (dismiss, copy the
// handover request, open the flow), Home's count, the Cost block of a flow's Output tab (tokens, the estimate, estimate
// against actual), a ticket's estimate, the accuracy table (too few to trust under 5), the placed line of Pipeline
// tokens; everything a flow or agent wrote escaped. And greps that wire it in.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { durationText, tokensText, usdText } from '../predict-words.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8')
const ctx = vm.createContext({ window: {} })
vm.runInContext(read('public/predict-view.js'), ctx)
const V = ctx.window.PredictView

const MIN = 60_000
const HOUR = 3_600_000

test('the words are the server s words: durations, tokens and dollars in lockstep', () => {
  for (const ms of [10_000, 59_999, 60_000, 45 * MIN, 2 * HOUR, 3 * HOUR + 20 * MIN, 47 * HOUR, 60 * HOUR]) assert.equal(V.duration(ms), durationText(ms), ms)
  for (const n of [0, 850, 12_400, 611_200, 12_400_000, 1_200_000_000, 2_457_800_000]) assert.equal(V.tokens(n), tokensText(n), n)
  for (const n of [0.04, 4.1, 99.5, 120.4, 1568.33]) assert.equal(V.usd(n), usdText(n), n)
  assert.equal(V.usd(1568.33), '$1,568')
})

const ALERTS = {
  enabled: true, hidden: 1, building: false,
  counts: { shown: 3, hidden: 1, onYou: 1, stuck: 2, spike: 0, context: 1, daily: 0 },
  alerts: [
    { key: 'stuck:a:qa', kind: 'stuck', text: 'Fix <login> has been with QA for 2 h, 6 times the usual 20 min for that step.', flow: 'a', agent: 'QA', measure: 1 },
    { key: 'stuck:b:ask', kind: 'stuck', onYou: true, text: 'B has waited on you for 30 h: a question is open.', flow: 'b', measure: 1, returned: true },
    { key: 'context:s1', kind: 'context', text: 'Master re-reads about 611K tokens of its own history every turn.', agent: 'Master', session: 's1', handover: 'Please write a short handover note.', measure: 1 },
  ],
}

test('the Alerts line: how many, what kinds, a Show them toggle and the help; nothing at all with none', () => {
  const html = V.lineHtml(ALERTS, { open: false })
  assert.match(html, /3 alerts/)
  assert.match(html, /1 flow waiting on you/)
  assert.match(html, /1 flow far past its usual time/)
  assert.match(html, /1 session re-reading a large history/)
  assert.match(html, /aria-expanded="false"/)
  assert.match(html, /Show them/)
  assert.match(html, /class="help"/)
  assert.equal(V.lineHtml({ ...ALERTS, alerts: [], counts: { shown: 0, hidden: 0 } }), '')
  assert.equal(V.lineHtml(null), '')
  assert.equal(V.lineHtml({ enabled: false, alerts: [] }), '')
  assert.match(V.lineHtml({ ...ALERTS, alerts: [ALERTS.alerts[2]] }), /1 alert</)
})

test('each alert row: its text escaped, Dismiss for today, the flow to open, and Copy handover request on a context alert', () => {
  const html = V.listHtml(ALERTS)
  assert.match(html, /Fix &lt;login&gt;/)
  assert.doesNotMatch(html, /<login>/)
  assert.equal((html.match(/data-pe-dismiss=/g) || []).length, 3)
  assert.match(html, /href="#\/flows\?flow=a"/)
  assert.equal((html.match(/data-pe-copy/g) || []).length, 1)
  assert.match(html, /Copy handover request/)
  assert.match(html, /Waiting on you/)
  assert.match(html, /Back: it got worse/)
  assert.match(html, /1 dismissed for today/)
})

test('Home: one line with the count and a link to the Agents page; nothing with none', () => {
  assert.match(V.homeHtml(ALERTS), /3 alerts/)
  assert.match(V.homeHtml(ALERTS), /href="#\/agents\?alerts"/)
  assert.equal(V.homeHtml({ ...ALERTS, alerts: [] }), '')
})

test('a flow s Cost: its tokens and dollars so far, the estimate with its range, too few said in words', () => {
  const info = {
    id: 'a', tokens: { tokens: 12_400_000, usd: 4.1, unpriced: false }, stored: true, actual: null, similar: [{ id: 'x', title: 'X <1>' }, { id: 'y', title: 'Y' }, { id: 'z', title: 'Z' }],
    estimate: { at: '2026-11-25T09:00:00Z', minutes: 70, usd: 40, tokens: 3e6, basedOn: ['x', 'y', 'z'], spread: { minutes: [40, 120], usd: [10, 90], tokens: [1e6, 5e6] } },
  }
  const html = V.costHtml(info, { open: true })
  assert.match(html, /Tokens so far: 12.4M, about \$4.10/)
  assert.match(html, /about 1 h 10 min and \$40, based on 3 similar flows/)
  assert.match(html, /40 min to 2 h/)
  assert.match(html, /X &lt;1&gt;/)
  const few = V.costHtml({ ...info, estimate: { ...info.estimate, minutes: null, usd: null, tokens: null, spread: null, few: true } }, { open: true })
  assert.match(few, /No estimate yet: too few similar flows/)
  const none = V.costHtml({ ...info, tokens: { tokens: 0, usd: null, unpriced: false } }, { open: true })
  assert.match(none, /No tokens placed on this flow yet/)
  const unpriced = V.costHtml({ ...info, tokens: { tokens: 5e6, usd: null, unpriced: true } }, { open: true })
  assert.match(unpriced, /Tokens so far: 5M/)
  assert.match(unpriced, /no price/)
})

test('a finished flow s Cost: estimate against actual, inside or outside the range', () => {
  const info = {
    id: 'a', tokens: { tokens: 20e6, usd: 52, unpriced: false }, stored: false, similar: [],
    estimate: { at: '2026-11-25T09:00:00Z', minutes: 70, usd: 40, tokens: 3e6, basedOn: ['x', 'y', 'z'], spread: { minutes: [40, 120], usd: [10, 50], tokens: [1e6, 5e6] } },
    actual: { minutes: 95, usd: 52, tokens: 20e6 },
  }
  const html = V.costHtml(info, { open: false })
  assert.match(html, /Tokens: 20M, about \$52/)
  assert.match(html, /<table/)
  assert.match(html, /1 h 35 min/)
  assert.match(html, /inside the range/)
  assert.match(html, /outside the range/)
  assert.match(html, /worked out afterwards/i)
})

test('a ticket not yet started: its estimate on one line; a started one points at its flow', () => {
  const est = { minutes: 70, usd: null, tokens: null, basedOn: ['x', 'y', 'z'], spread: { minutes: [40, 120], usd: null, tokens: null } }
  assert.match(V.ticketHtml({ id: 'FLA-1', estimate: est, similar: [], flow: null }), /About 1 h 10 min, based on 3 similar flows/)
  assert.match(V.ticketHtml({ id: 'FLA-1', estimate: { ...est, minutes: null, few: true }, similar: [], flow: null }), /No estimate yet: too few similar flows/)
  assert.match(V.ticketHtml({ id: 'FLA-1', estimate: est, similar: [], flow: 'dark-mode' }), /href="#\/flows\?flow=dark-mode"/)
  assert.match(V.ticketHtml({ id: 'FLA-1', estimate: est, similar: [], flow: 'dark-mode', flowDone: true }), /Already done in a flow/)
  assert.match(V.ticketHtml({ id: 'FLA-1', enabled: false, estimate: null, flow: null }), /off/)
})

test('the accuracy table: median error and how many fell in their range; too few to trust under 5', () => {
  const acc = {
    stored: { minutes: { flows: 3, median: 0.4, inRange: 2, ranged: 3, few: true }, usd: { flows: 0, median: null, inRange: 0, ranged: 0, few: true } },
    afterwards: { minutes: { flows: 12, median: 2.05, inRange: 5, ranged: 12, few: false }, usd: { flows: 12, median: 0.5, inRange: 6, ranged: 12, few: false } },
  }
  const html = V.accuracyHtml(acc)
  assert.match(html, /<table/)
  assert.match(html, /Too few to trust/)
  assert.match(html, /205%/)
  assert.match(html, /5 of 12/)
  assert.match(html, /said when the flow started/i)
  assert.match(html, /worked out afterwards/i)
})

test('the placed line of Pipeline tokens: placed on flows and not, with shares; nothing without data', () => {
  const line = V.placedText({ placed: { tokens: 2.4578e9, usd: 853.99 }, unplaced: { tokens: 3.9922e9, usd: 1568.33 } })
  assert.match(line, /On flows: 2.5B tokens \(38%\), about \$854/)
  assert.match(line, /Not on any flow: 4B \(62%\), about \$1,568/)
  assert.equal(V.placedText(null), '')
  assert.equal(V.placedText({ placed: { tokens: 0, usd: null }, unplaced: { tokens: 0, usd: null } }), '')
})

// ═══ wired in ═══

test('wired in: the scripts and the stylesheet on the page, every new file in npm run check, the hooks in place', () => {
  const html = read('public/index.html')
  for (const f of ['predict-view.js', 'predict-alerts.js', 'predict-flow.js']) {
    assert.match(html, new RegExp(`<script src="${f}"></script>`))
    assert.match(read('package.json'), new RegExp(`node --check public/${f}`))
  }
  assert.match(html, /<link rel="stylesheet" href="predict.css">/)
  assert.match(html, /id="homeAlerts" data-pe-home hidden/)
  assert.match(read('public/agents-page.js'), /data-pe-alerts/)
  assert.match(read('public/flow-output.js'), /PredictFlow\?\.block\(c\)/)
  assert.match(read('public/factory.js'), /data-pe-ticket/)
  assert.match(read('public/time-strip.js'), /PredictFlow\?\.accuracy/)
  assert.match(read('public/token-strip.js'), /PredictFlow\?\.placed/)
})

test('the stylesheet uses the page s colour tokens only and calms motion', () => {
  const css = read('public/predict.css')
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|rgb\(/i)
  assert.match(css, /prefers-reduced-motion/)
})

test('every storage access in the page halves is guarded', () => {
  for (const f of ['public/predict-alerts.js', 'public/predict-flow.js']) {
    const src = read(f)
    const uses = (src.match(/localStorage\./g) || []).length
    const guarded = (src.match(/try \{[^}]*localStorage\./g) || []).length
    assert.equal(uses, guarded, f)
  }
})

// ═══ one agent holding many flows: one grouped alert ═══

const slow = (id, agent = 'Master') => ({ key: `stuck:${id}:producing`, kind: 'stuck', text: `Flow ${id} has been with ${agent} for 9 h, 13 times the usual 40 min for that step.`, flow: id, agent, measure: 1 })
const GROUPED = {
  enabled: true, hidden: 0, snoozed: 2,
  alerts: [slow('a'), slow('b'), slow('c'), slow('d'), slow('x', 'Agent 1'), slow('y', 'Agent 1'), ALERTS.alerts[1], ALERTS.alerts[2]],
}

test('3 or more Taking long alerts of one agent are ONE alert, the flows folded under it; 2 stay apart', () => {
  const items = V.groupAlerts(GROUPED.alerts)
  assert.equal(items.length, 5)
  assert.equal(items[0].kind, 'group')
  assert.equal(items[0].agent, 'Master')
  assert.deepEqual(JSON.parse(JSON.stringify(items[0].alerts.map(a => a.flow))), ['a', 'b', 'c', 'd'])
  assert.deepEqual(JSON.parse(JSON.stringify(items.slice(1, 3).map(a => a.flow))), ['x', 'y'])
  // waiting on you is never grouped: it is the user s own, one by one
  assert.equal(V.groupAlerts([1, 2, 3].map(i => ({ ...ALERTS.alerts[1], key: `stuck:q${i}:ask`, agent: 'Master' }))).length, 3)
})

test('the line counts a group as one alert and names it', () => {
  const html = V.lineHtml(GROUPED)
  assert.match(html, /5 alerts/)
  assert.match(html, /Master holds 4 flows longer than usual/)
  assert.match(html, /2 flows far past their usual time/)
  assert.match(V.homeHtml(GROUPED), /5 alerts/)
})

test('the group row: one sentence, Dismiss all for today with every key, the flows folded with their own buttons', () => {
  const html = V.listHtml(GROUPED)
  assert.match(html, /Master holds 4 flows longer than usual for their step/)
  assert.match(html, /data-pe-dismiss-all="stuck:a:producing stuck:b:producing stuck:c:producing stuck:d:producing"/)
  assert.match(html, /Dismiss all for today/)
  assert.match(html, /<details class="pe-fold" data-pe-fold="group:Master">/)
  assert.match(html, /The 4 flows/)
  for (const id of ['a', 'b', 'c', 'd']) {
    assert.match(html, new RegExp(`data-pe-dismiss="stuck:${id}:producing"`))
    assert.match(html, new RegExp(`data-pe-snooze="stuck:${id}:producing"`))
  }
})

test('Snooze for a week on every flow alert, never on a session alert; the snoozed are counted under the list', () => {
  const html = V.listHtml(ALERTS)
  assert.match(html, /data-pe-snooze="stuck:a:qa"/)
  assert.match(html, /data-pe-snooze="stuck:b:ask"/)
  assert.doesNotMatch(html, /data-pe-snooze="context:s1"/)
  assert.match(html, /Snooze for a week/)
  assert.match(V.listHtml(GROUPED), /2 snoozed for a week/)
})

test('the help says what Snooze is for and that a group is one agent holding many flows', () => {
  assert.match(V.ALERTS_HELP, /Snooze for a week/)
  assert.match(V.ALERTS_HELP, /tracking flow/)
  assert.match(V.ALERTS_HELP, /another step/)
  assert.match(V.ALERTS_HELP, /3 or more/)
})

test('the Alerts line sits at the top of the Agents page, above Pipeline score', () => {
  const src = read('public/agents-page.js')
  assert.ok(src.indexOf('id="plAlerts"') > 0)
  assert.ok(src.indexOf('id="plAlerts"') < src.indexOf('id="plScore"'), 'the alerts come before the score')
})
