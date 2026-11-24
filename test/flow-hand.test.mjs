// Tests for Do this by hand (public/flow-hand.js): an opened flow's by-hand steps as a checklist with the user's
// ticks, a Copy button on a value to paste, Mark the flow done once every step is ticked, and the honest empty state
// with Ask the agent for steps. The pure html() runs in a vm; the click and change handlers run on a tiny stub
// element with a stub fetch, so every POST is checked.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = f => fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8')
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

function load(answers = {}) {
  const posts = []
  const fetch = async (url, init) => {
    posts.push([url, JSON.parse(init?.body || '{}')])
    const a = answers[url] || { status: 200, body: { ok: true } }
    return { ok: a.status < 400, status: a.status, json: async () => structuredClone(a.body) }
  }
  const loads = []
  const window = { Shell: { ago: () => '3m' }, FlowsView: { load: () => loads.push('flows') }, HumanReview: { refresh: () => loads.push('human') }, alert: () => {}, FactoryChat: { prefill: t => loads.push(['prefill', t]) } }
  vm.runInNewContext(read('flow-hand.js'), { window, fetch, CSS: { escape: s => s }, setTimeout: () => 0, navigator: {} })
  return { H: window.FlowHand, posts, loads }
}

const STEPS = [
  { id: 'h1', do: 'Add the deploy secret', why: 'The deploy job reads it', where: 'GitHub › Settings › Secrets', copy: 'FIREBASE_TOKEN=<abc>', expect: 'It is listed', done: { by: 'you', at: 'x' } },
  { id: 'h2', do: 'Run the workflow once', expect: 'A green tick', done: null },
]
const flow = (over = {}) => ({ id: 'ci', title: 'Set up the deploy', status: 'open', hand: { steps: structuredClone(STEPS) }, ...over })

test('the checklist: Do this by hand · 1 of 2 done, then each step numbered with why, where, the value to copy and what to see', () => {
  const { H } = load()
  const h = H.html(flow())
  assert.match(h, /<h3 class="fh-h" id="fh-h-ci" tabindex="-1">Do this by hand <span class="faint">· 1 of 2 done<\/span><\/h3>/)
  assert.match(text(h), /1 Add the deploy secret Why: The deploy job reads it Where: GitHub › Settings › Secrets FIREBASE_TOKEN=&lt;abc&gt; Copy You should see: It is listed 2 Run the workflow once You should see: A green tick/)
  assert.match(h, /<input type="checkbox" class="fh-tick" id="fh-tick-h1" data-hand-tick="h1" checked>/)
  assert.match(h, /<input type="checkbox" class="fh-tick" id="fh-tick-h2" data-hand-tick="h2">/)
  assert.match(h, /<label class="fh-do" for="fh-tick-h1">/, 'the step text is the tick label, so a click on it ticks')
  assert.match(h, /<pre class="fh-copy-v" id="fh-copy-h1">FIREBASE_TOKEN=&lt;abc&gt;<\/pre><button type="button" class="fh-copy-b" data-hand-copy="h1"/)
  assert.doesNotMatch(h, /data-hand-done/, 'not every step is ticked yet')
})

test('every step ticked: one button, Mark the flow done; not on a done, dropped or read-only flow', () => {
  const { H } = load()
  const all = flow({ hand: { steps: STEPS.map(s => ({ ...s, done: { by: 'you', at: 'x' } })) } })
  assert.match(H.html(all), /<button type="button" class="primary" data-hand-done>Mark the flow done<\/button>/)
  assert.doesNotMatch(H.html({ ...all, status: 'done' }), /data-hand-done/)
  assert.doesNotMatch(H.html({ ...all, status: 'dropped' }), /data-hand-done/)
  assert.doesNotMatch(H.html(all, { readonly: true }), /data-hand-done/)
  assert.match(H.html(flow(), { readonly: true }), /data-hand-tick="h2" disabled>/, 'read-only: the ticks show, fixed')
})

test('no steps: nothing at all, unless the flow needs the user or steps were asked for; then the honest empty state with one button', () => {
  const { H } = load()
  assert.equal(H.html({ id: 'x', title: 'X', status: 'open' }), '')
  assert.equal(H.html({ id: 'x', title: 'X', status: 'open', hand: { steps: [] } }), '')
  const empty = H.html({ id: 'x', title: 'X', status: 'open' }, { needs: true })
  assert.match(text(empty), /^Do this by hand This is work only you can do, and the agent has not written the steps yet\. Ask the agent for steps$/)
  assert.match(empty, /<button type="button" class="primary" data-hand-ask>Ask the agent for steps<\/button>/)
  const now = Date.parse('2026-11-24T10:10:00Z')
  const asked = H.html({ id: 'x', title: 'X', status: 'open', hand: { steps: [], requestedAt: '2026-11-24T10:00:00Z' } }, { now })
  assert.match(asked, /<span class="fh-asked">Asked 3m<\/span>/)
  const failed = H.html({ id: 'x', title: 'X', status: 'open', hand: { steps: [], requestedAt: '2026-11-24T10:00:00Z', requestError: 'FAILED: no session' } }, { now })
  assert.match(failed, /<span class="fh-asked is-bad" title="FAILED: no session">Not sent<\/span>/)
  assert.doesNotMatch(read('flow-hand.js'), /steps: \[\{|do: '/, 'the page never makes up a step')
})

/** A slot element: innerHTML, and a recorder of its two listeners. */
function slot() {
  const on = {}
  return { on, hidden: true, innerHTML: '', ownerDocument: { activeElement: null }, contains: () => false, querySelector: () => null, addEventListener: (t, fn) => (on[t] = fn) }
}
const target = (attrs, extra = {}) => {
  const el = { dataset: {}, ...extra, closest: sel => (Object.keys(attrs).some(a => sel.includes(`[${a}]`)) ? el : null) }
  for (const [k, v] of Object.entries(attrs)) el.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v
  return el
}
const settle = () => new Promise(r => setTimeout(r, 0))

test('a tick posts { step, done } to the hand route and reloads the flows and Human review; a refusal puts the box back', async () => {
  const { H, posts, loads } = load({ '/api/flows/ci/hand': { status: 400, body: { error: 'no' } } })
  const el = slot()
  H.fill(el, flow())
  assert.equal(el.hidden, false)
  const box = target({ 'data-hand-tick': 'h2' }, { checked: true, disabled: false })
  await el.on.change({ target: box })
  assert.deepEqual(JSON.parse(JSON.stringify(posts)), [['/api/flows/ci/hand', { step: 'h2', done: true }]])
  assert.equal(box.checked, false, 'refused: unticked again')
  assert.deepEqual(loads, ['flows', 'human'])
})

test('Mark the flow done posts the existing status change; Ask the agent for steps posts request-hand, and via the chat fills the Ask drawer', async () => {
  const { H, posts, loads } = load({ '/api/flows/ci/request-hand': { status: 200, body: { ok: true, via: 'chat', text: 'Flow ci: steps please' } } })
  const el = slot()
  H.fill(el, flow())
  await el.on.click({ target: target({ 'data-hand-done': '' }) })
  await el.on.click({ target: target({ 'data-hand-ask': '' }, { disabled: false }) })
  await settle()
  assert.deepEqual(JSON.parse(JSON.stringify(posts)), [['/api/flows/ci/status', { status: 'done' }], ['/api/flows/ci/request-hand', {}]])
  assert.ok(loads.some(l => Array.isArray(l) && l[1] === 'Flow ci: steps please'))
})

test('wired: flows.js draws the checklist above the views and opens a flow at it; index.html loads it before flows.js; npm run check covers it', () => {
  const flows = read('flows.js')
  assert.match(flows, /<div class="fl-open-sub"><\/div>\s*<div class="fl-hand" hidden><\/div>/)
  assert.match(flows, /window\.FlowHand\?\.fill\(\$\('\.fl-hand', board\), f, \{ needs: !!window\.HumanReview\?\.needsHand\(f\.id\), readonly: readonly\(f\) \}\)/)
  assert.match(flows, /gotoHand,/)
  const html = read('index.html')
  const at = s => html.indexOf(`<script src="${s}"></script>`)
  assert.ok(at('flow-hand.js') > 0 && at('flow-hand.js') < at('flows.js'))
  assert.match(html, /<link rel="stylesheet" href="human.css">/)
  assert.match(read('flows-page.js'), /if \(q\.at === 'hand'\) return window\.FlowsView\.gotoHand\?\.\(id\)/)
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
  assert.ok(pkg.scripts.check.includes('node --check public/flow-hand.js'))
})
