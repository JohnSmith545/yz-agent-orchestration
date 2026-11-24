// Tests for the Human review box (public/human-review.js): its rows, its count and its calm empty line, where the
// layout puts it in the Agents diagram (under every box and arrow, lined up with the outermost boxes, at 1440, 1024
// and 390 wide with the real pipeline-layout.js), Home's one line, and the wiring. The pure parts run in a vm.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { pipelineGraph } from '../pipeline.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = f => fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8')
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

function load() {
  const window = { Shell: { ago: iso => (iso ? '3h' : '') }, FlowDrawer: { delivery: () => '' } }
  vm.runInNewContext(read('flow-board.js'), { window })
  vm.runInNewContext(read('pipeline-layout.js'), { window })
  vm.runInNewContext(read('human-review.js'), { window })
  return window
}

const ASK = { key: 'ask:dark:n3', kind: 'ask', flowId: 'dark', nodeId: 'n3', title: 'Add a <dark> mode toggle', agent: 'Agent 3', since: '2026-11-24T08:00:00Z', reason: 'The test passes; dev is where QA can try it', ask: { title: 'Deploy the fix to dev?', kind: 'yesno', yes: 'Deploy it', no: 'Leave it' } }
const HAND = { key: 'hand:ci', kind: 'hand', flowId: 'ci', title: 'Production deploy needs its secrets', agent: 'Agent 2', since: '2026-11-24T07:00:00Z', reason: '1 of 4 done. Next: Add the deploy token', progress: { done: 1, total: 4 } }
const TICKET = { key: 'ticket:FLA-820', kind: 'ticket', ticketId: 'FLA-820', title: 'Cloud Hosting: Billing account linked', agent: '', since: '2026-11-10T00:00:00Z', reason: 'Marked not codebase work: a person, console or process task.' }
const BLOCKED = { key: 'blocked:b', kind: 'blocked', flowId: 'b', title: 'Deploy', agent: 'Agent 1', since: '2026-11-09T00:00:00Z', reason: 'Blocked at: Deploy to stage' }

test('the box: Human review, the count on its face, then a row per thing, each its title, kind, agent and how long it has waited, and one reason', () => {
  const H = load().HumanReview
  const h = H.html({ items: [ASK, HAND, TICKET, BLOCKED], counts: { total: 4 } })
  assert.match(h, /<h3 class="hr-h" id="hrHead" tabindex="-1"><i class="hr-dot" aria-hidden="true"><\/i>Human review<\/h3><span class="hr-count" aria-label="4 things waiting on you">4<\/span><span class="hr-sub">waiting on you<\/span>/)
  assert.match(text(h), /Add a &lt;dark&gt; mode toggle Question · Agent 3 · waiting 3h Deploy the fix to dev\? Yes No Why\? The test passes; dev is where QA can try it/)
  assert.match(text(h), /Production deploy needs its secrets By hand · 1 of 4 · Agent 2 · waiting 3h 1 of 4 done\. Next: Add the deploy token/)
  assert.match(text(h), /Cloud Hosting: Billing account linked Ticket FLA-820 · waiting 3h Marked not codebase work/)
  assert.match(text(h), /Deploy Blocked · Agent 1 · waiting 3h Blocked at: Deploy to stage/)
  assert.match(h, /<ol class="hr-rows" tabindex="0" aria-label="What waits on you, newest first">/, 'the rows scroll inside the box, by keyboard too')
})

test('a question is answered in the box with the same controls as everywhere: Yes and No (data-answer, data-node), or a text field', () => {
  const H = load().HumanReview
  const h = H.rowHtml(ASK)
  assert.match(h, /<div class="hr-ask" data-flow="dark">/)
  assert.match(h, /<button type="button" class="fl-yes" data-answer="yes" data-node="n3" title="Deploy it">Yes<\/button>/)
  const t = H.rowHtml({ ...ASK, ask: { ...ASK.ask, kind: 'text' } })
  assert.match(t, /<form class="fl-text" data-text="n3"><input name="answer" data-key="hr:dark:n3"/)
  assert.match(read('human-review.js'), /window\.FlowsView\?\.answer\(/, 'the one answer path')
  assert.doesNotMatch(read('human-review.js'), /\/answer`/, 'never a second POST of its own')
})

test('a title opens the right place: the question at its node, the by-hand steps, the flow, or the ticket', () => {
  const H = load().HumanReview
  assert.match(H.rowHtml(ASK), /data-hr-open="dark" data-hr-kind="ask" data-hr-node="n3" title="Open the question in its flow"/)
  assert.match(H.rowHtml(HAND), /data-hr-open="ci" data-hr-kind="hand" title="Open the steps in its flow"/)
  assert.match(H.rowHtml(BLOCKED), /data-hr-open="b" data-hr-kind="blocked" title="Open the flow"/)
  assert.match(H.rowHtml(TICKET), /data-hr-ticket="FLA-820" title="Open the ticket"/)
  const src = read('human-review.js')
  assert.match(src, /kind === 'hand' \? window\.FlowsView\?\.gotoHand\(id\) : window\.FlowsView\?\.gotoFlow\(id, node \|\| undefined\)/)
  assert.match(src, /window\.FactoryView\?\.gotoTicket\(ticket\.dataset\.hrTicket\)/)
  assert.match(src, /box\.addEventListener\('click', async e => \{\s*e\.stopPropagation\(\)/, 'a click in the box is never a click on a diagram node')
})

test('empty: the count says 0 and one calm line; loading and a failure say so too', () => {
  const H = load().HumanReview
  const h = H.html({ items: [], counts: { total: 0 } })
  assert.match(h, /<span class="hr-count is-zero" aria-label="0 things waiting on you">0<\/span>/)
  assert.match(h, /<p class="hr-empty">Nothing waits on you\. The agents can go on by themselves\.<\/p>/)
  assert.doesNotMatch(h, /hr-rows/)
  assert.match(H.html(null), /Loading…/)
  assert.match(H.html({ error: 'offline' }), /Could not load what waits on you: offline/)
})

/** Every box, arrow end and label of a real layout, as rectangles: nothing may reach into the Human review box. */
function occupied(lay) {
  const rects = lay.nodes.map(n => [n.x, n.y, n.x + n.w, n.y + n.h])
  for (const e of lay.edges) for (const m of `${e.d} ${e.head}`.matchAll(/(-?\d+(?:\.\d+)?)[ ,](-?\d+(?:\.\d+)?)/g)) rects.push([+m[1], +m[2], +m[1], +m[2]])
  for (const l of lay.labels) rects.push([l.x - 60, l.y - 12, l.x + 60, l.y + 4])
  return rects
}

test('placed by the layout under every box, arrow and label, its edges on the outermost boxes, at 1440, 1024 and 390 wide, with two more agents too', () => {
  const w = load()
  const base = { coordinatorLabel: 'Master', codingAgents: { a: 'Master', b: 'Agent 1', c: 'Agent 2', d: 'Agent 3' }, factory: { chat: { name: 'Independent' } }, pipeline: { qa: 'QA' } }
  const more = { ...base, codingAgents: { ...base.codingAgents, e: 'Planner', f: 'Security' } }
  for (const config of [base, more]) {
    for (const width of [1440 - 120, 1024 - 120, 390 - 32]) {
      const lay = w.PipelineLayout.layout(pipelineGraph(config), { width, rows: 4 })
      const s = w.HumanReview.spot(lay)
      const left = Math.min(...lay.nodes.map(n => n.x))
      const right = Math.max(...lay.nodes.map(n => n.x + n.w))
      assert.equal(s.x, left, `left edge on the boxes at ${width}`)
      assert.equal(s.x + s.w, right, `right edge on the boxes at ${width}`)
      assert.ok(s.y >= lay.height, `below the whole layout at ${width}`)
      for (const [, , , y2] of occupied(lay)) assert.ok(y2 < s.y, `nothing drawn reaches into the box at ${width} (y ${y2} vs ${s.y})`)
    }
  }
  assert.deepEqual(JSON.parse(JSON.stringify(w.HumanReview.spot({ nodes: [], width: 300, height: 0 }))), { x: 12, y: 6, w: 276 })
})

test('Home says how many things need you, what they are, and links to the box; or that nothing does', () => {
  const H = load().HumanReview
  const h = H.homeHtml({ counts: { total: 5, ask: 2, hand: 1, blocked: 0, ticket: 2 } })
  assert.match(text(h), /^5 things need you 2 questions, 1 by-hand task, 2 tickets only you can do Open Human review$/)
  assert.match(h, /<a class="link" href="#\/agents\?human" data-hr-show>Open Human review<\/a>/)
  assert.match(text(H.homeHtml({ counts: { total: 1, ask: 1, hand: 0, blocked: 0, ticket: 0 } })), /^1 thing needs you 1 question/)
  assert.match(H.homeHtml({ counts: { total: 0 } }), /Nothing needs you right now\./)
  assert.equal(H.homeHtml(null), '')
})

test('wired: pipeline-view.js hands the box each layout (one line), index.html loads it and its stylesheet, npm run check covers it', () => {
  const view = read('pipeline-view.js')
  assert.match(view, /window\.HumanReview\?\.place\(st\.canvas, lay\)/)
  assert.equal(view.split('HumanReview').length - 1, 1, 'one call, nothing else in the shared file')
  assert.doesNotMatch(fs.readFileSync(path.join(HERE, '..', 'pipeline.mjs'), 'utf8'), /human/i, 'not a node or an edge of any route')
  const html = read('index.html')
  assert.match(html, /<script src="human-review.js"><\/script>/)
  assert.match(html, /<link rel="stylesheet" href="human.css">/)
  assert.match(read('human.css'), /\.hr-box \{ position: absolute;[^}]*border-left: 3px solid var\(--warn\)/)
  assert.match(read('human.css'), /max-height: 340px/, 'it never grows the diagram past this: the rows scroll inside it')
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
  assert.ok(pkg.scripts.check.includes('node --check public/human-review.js'))
})
