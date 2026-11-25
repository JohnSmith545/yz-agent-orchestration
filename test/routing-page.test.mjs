// Tests for the browser halves of routing: public/routing-page.js (the Routing page's markup) and
// public/routing-tickets.js (ticket intake on the Tickets page), loaded in a vm with a bare window like the other
// browser files; and the shell knowing #/routing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = f => fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8')
const load = file => {
  const ctx = vm.createContext({ window: {} })
  vm.runInContext(read(file), ctx)
  return ctx.window
}
const P = load('routing-page.js').RoutingPage
const T = load('routing-tickets.js').RoutingTickets
const S = load('shell.js').Shell

const MODELS = [{ id: 'claude-opus-5-5', name: 'Opus 5.5' }, { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' }]
const view = (over = {}) => ({
  draft: [{ when: { type: 'wording', size: 'small' }, model: 'claude-sonnet-5-5', effort: 'medium', why: 'small <wording> fixes' }],
  types: ['wording', 'small-fix', 'docs'], sizes: ['small', 'medium', 'large'], risks: ['low', 'medium', 'high'], models: MODELS, efforts: ['low', 'medium', 'high'],
  agents: [{ label: 'Agent 2', role: 'producer' }, { label: 'Planner', role: 'planner' }],
  table: { rows: [], recorded: 0, target: 100 }, flows: [], warning: null, ...over,
})

test('the rules: each rule a row with its selects set, the why escaped, and the fixed roles never offered as agents', () => {
  const h = P.html(view())
  assert.match(h, /<option value="wording" selected>wording<\/option>/)
  assert.match(h, /<option value="small" selected>small<\/option>/)
  assert.match(h, /<option value="claude-sonnet-5-5" selected>Sonnet 5\.5<\/option>/)
  assert.match(h, /small &lt;wording&gt; fixes/)
  assert.match(h, /Agent 2/)
  assert.doesNotMatch(h, /value="Planner"/, 'the planner is a fixed role: never a rule target')
  assert.match(h, /A suggestion, not an order/)
  assert.match(h, /data-rr-save disabled/, 'nothing to save until something changes')
  assert.doesNotMatch(P.html(view(), { dirty: true }), /data-rr-save disabled/)
})

test('a list of types shows as one choice, and a bad config says so', () => {
  const h = P.html(view({ draft: [{ when: { type: ['wording', 'docs'] }, effort: 'low', why: 'x' }], warning: 'config.json: routing.rules has a problem' }))
  assert.match(h, /<option value="wording,docs" selected>wording or docs<\/option>/)
  assert.match(h, /routing\.rules has a problem/)
})

test('the table: the count against 100, Too few to trust under 5, cost not known when not recorded', () => {
  const h = P.tableHtml({ recorded: 7, target: 100, rows: [
    { type: 'wording', model: 'claude-sonnet-5-5', flows: 5, right: 3, judged: 4, firstTime: 0.75, medianMinutes: 30, medianUsd: null, costOf: 0, fewer: false },
    { type: 'small-fix', model: null, flows: 2, fewer: true },
  ] }, MODELS)
  assert.match(h, /<b>7<\/b> finished flows recorded, of the 100 a learning method needs/)
  assert.match(h, /75%/)
  assert.match(h, /3 of 4/)
  assert.match(h, /30 min/)
  assert.match(h, /not known/)
  assert.match(h, /small fix<\/td><td>not known<\/td><td class="num">2<\/td><td colspan="3" class="faint">Too few to trust/)
  assert.match(P.tableHtml({ rows: [], recorded: 0, target: 100 }), /Nothing has finished/)
})

test('the latest flows: type select, followed in words, used model not set said plainly', () => {
  const h = P.flowsHtml([{ id: 'f1', title: 'Fix <it>', agent: 'Agent 2', status: 'done', routing: { type: 'wording', confidence: 'likely', size: 'small',
    suggested: { agent: null, model: 'claude-sonnet-5-5', effort: 'medium' }, used: { agent: 'Agent 2', model: null, effort: null }, followed: null } }], view())
  assert.match(h, /data-rr-flowtype="f1"/)
  assert.match(h, /Fix &lt;it&gt;/)
  assert.match(h, /Suggested: Sonnet 5\.5, medium effort/)
  assert.match(h, /Used: Agent 2, model not set, effort not set/)
  assert.match(h, />Not known</)
  assert.match(P.flowsHtml([], view()), /No flow has a routing record yet/)
})

test('tickets: the kind tag, Looks like for a duplicate, the facet, the chips and the suggestion line', () => {
  const e = { kind: 'no-code', reason: 'No code: the words DNS.', by: 'rules', confidence: 'likely', type: 'infra', typeConfidence: 'likely', typeBy: 'rules',
    suggestion: 'Suggested: Sonnet 5.5, medium effort, because x', suggested: { model: 'claude-sonnet-5-5' }, duplicate: { of: 'FLA-761', reason: 'Both titles say dns.' } }
  const tag = T.rowTag(e)
  assert.match(tag, /rt-k-no-code" title="No code: the words DNS.">No code</)
  assert.match(tag, /Looks like FLA-761/)
  assert.equal(T.kindOf({ ...e, confidence: 'unsure' }), 'unsure')
  assert.equal(T.kindOf(null), 'unsure')
  assert.equal(T.rowTag(null), '')
  const f = T.facet(() => 'code')
  assert.equal(f.label, 'Sort')
  assert.deepEqual([...f.order], ['code', 'no-code', 'needs-a-person', 'unsure'])
  const chips = T.chipsHtml(k => ({ code: 3, 'no-code': 2 })[k] || 0, (facet, v, n, label) => `[${facet}:${v}:${n}:${label}]`)
  assert.match(chips, /\[kind:code:3:Code\]\[kind:no-code:2:No code\]\[kind:needs-a-person:0:Needs a person\]\[kind:unsure:0:Unsure\]/)
  assert.match(T.suggestionHtml(e), /Suggested: Sonnet 5\.5.*A suggestion, not an order/)
  const d = T.detailHtml('FLA-800', e, ['infra', 'docs'])
  assert.match(d, /data-rt-kind="FLA-800"/)
  assert.match(d, /data-rt-type="FLA-800"/)
  assert.match(d, /data-rt-notdup="FLA-800" data-rt-of="FLA-761"/)
  assert.match(d, /sorted by the rules/)
})

test('the shell knows #/routing and its query', () => {
  assert.equal(S.resolve('#/routing').view, 'routing')
  assert.equal(S.resolve('#/routing?flow=abc').params.query.flow, 'abc')
})
