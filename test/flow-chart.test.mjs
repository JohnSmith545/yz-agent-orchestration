// Tests for public/flow-chart.js, the layered layout and SVG of one flow. The
// file is a browser script, so it runs here in a vm context with a stub
// window: it must not touch the DOM. FACTORY_DATA_DIR points at a fresh temp
// folder BEFORE flows.mjs is imported (for derive), so no test touches data/.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-chart-test-'))
const { derive, DATA_DIR } = await import('../flows.mjs')
after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }))

const window = {}
vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', 'flow-chart.js'), 'utf8'), { window })
const FC = window.FlowChart

const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'dark-mode.json'), 'utf8'))
/** A fresh copy of the spec 7.1 example with its derived state attached. */
const fx = () => {
  const flow = structuredClone(FIXTURE)
  flow.derived = derive(flow)
  return flow
}
const at = (lay, id) => lay.nodes.find(n => n.id === id)
/** Arrays made inside the vm have its prototypes, so strict deepEqual needs plain copies. */
const plain = v => JSON.parse(JSON.stringify(v))
/** The class attribute of the node group for `id`. */
const classOf = (svg, id) => svg.match(new RegExp(`<g class="([^"]*)" data-node="${id}"`))?.[1]
/** The markup of the node group for `id`, up to the next node group. */
const groupOf = (svg, id) => {
  const start = svg.indexOf(`data-node="${id}"`)
  const next = svg.indexOf('<g class="fc-node', start)
  return svg.slice(start, next === -1 ? undefined : next)
}

test('exports the layout constants', () => {
  assert.equal(FC.NODE_W, 260)
  assert.equal(FC.NODE_H, 40)
  assert.equal(FC.GAP_X, 24)
  assert.equal(FC.GAP_Y, 36)
  assert.equal(typeof FC.layout, 'function')
  assert.equal(typeof FC.svg, 'function')
})

test('the fixture lays out as one column, one row per node', () => {
  const lay = FC.layout(fx())
  assert.deepEqual(lay.nodes.map(n => [n.id, n.row, n.col]), [['n1', 0, 0], ['n2', 1, 0], ['n3', 2, 0], ['n4', 3, 0]])
  assert.deepEqual(plain(lay.edges), [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }, { from: 'n3', to: 'n4' }])
  const n3 = at(lay, 'n3')
  assert.equal(n3.x, 0)
  assert.equal(n3.y, 2 * (FC.NODE_H + FC.GAP_Y))
  assert.equal(n3.w, FC.NODE_W)
  assert.equal(n3.h, FC.NODE_H)
  assert.equal(lay.width, FC.NODE_W + FC.GAP_X)
  assert.equal(lay.height, 4 * FC.NODE_H + 3 * FC.GAP_Y + FC.GAP_Y)
})

test('a branch puts siblings side by side and the join one row below both', () => {
  const step = (id, after) => ({ id, type: 'step', title: id, status: 'todo', after, evidence: [] })
  const flow = { env: 'dev', nodes: [step('n1', []), step('n2', []), step('n3', ['n1']), step('n4', ['n2', 'n3'])] }
  const lay = FC.layout(flow)
  assert.equal(at(lay, 'n2').row, 1)
  assert.equal(at(lay, 'n3').row, 1)
  assert.equal(at(lay, 'n4').row, 2)
  assert.equal(at(lay, 'n2').col, 0)
  assert.equal(at(lay, 'n3').col, 1)
  assert.equal(at(lay, 'n3').x, FC.NODE_W + FC.GAP_X)
  assert.equal(lay.width, 2 * FC.NODE_W + FC.GAP_X + FC.GAP_X)
  assert.deepEqual(plain(lay.edges), [
    { from: 'n1', to: 'n2' }, { from: 'n1', to: 'n3' }, { from: 'n2', to: 'n4' }, { from: 'n3', to: 'n4' },
  ])
})

test('rows follow the longest path, not the shortest', () => {
  const step = (id, after) => ({ id, type: 'step', title: id, status: 'todo', after, evidence: [] })
  // n4 joins n1 (row 0) and n3 (row 2), so it sits below n3.
  const flow = { env: 'dev', nodes: [step('n1', []), step('n2', []), step('n3', []), step('n4', ['n1', 'n3'])] }
  assert.equal(at(FC.layout(flow), 'n4').row, 3)
})

test('a lone child sits under its parent, later siblings move right', () => {
  const step = (id, after) => ({ id, type: 'step', title: id, status: 'todo', after, evidence: [] })
  const flow = {
    env: 'dev',
    nodes: [step('a', []), step('b', ['a']), step('c', ['a']), step('d', ['c']), step('e', ['b'])],
  }
  const lay = FC.layout(flow)
  assert.equal(at(lay, 'c').col, 1)
  assert.equal(at(lay, 'd').col, 1, 'd is under its parent c')
  assert.equal(at(lay, 'e').col, 2, 'e keeps list order: it cannot sit left of d')
})

test('an empty flow lays out to nothing', () => {
  const lay = FC.layout({ env: 'dev', nodes: [] })
  assert.deepEqual(plain(lay.nodes), [])
  assert.deepEqual(plain(lay.edges), [])
  assert.match(FC.svg({ env: 'dev', nodes: [] }, lay), /^<svg[\s\S]*<\/svg>$/)
})

test('svg marks the open ask as waiting with Yes and No buttons', () => {
  const flow = fx()
  const svg = FC.svg(flow, FC.layout(flow))
  assert.match(svg, /^<svg[\s\S]*<\/svg>$/)
  assert.ok(svg.includes('<g class="fc-node type-ask waiting" data-node="n3"'))
  const n3 = groupOf(svg, 'n3')
  assert.equal((n3.match(/data-answer="/g) || []).length, 2)
  assert.ok(n3.includes('<g class="fc-ans" data-answer="yes" data-node="n3"'))
  assert.ok(n3.includes('<g class="fc-ans" data-answer="no" data-node="n3"'))
  assert.match(n3, /<path [^>]*class="fc-shape"/, 'an ask is a diamond path')
  assert.ok(n3.includes('>?</text>'))
})

test('svg classes: pending, status, type and proof', () => {
  const flow = fx()
  const svg = FC.svg(flow, FC.layout(flow))
  assert.ok(classOf(svg, 'n4').split(' ').includes('pending'))
  assert.ok(classOf(svg, 'n4').split(' ').includes('st-todo'))
  assert.ok(classOf(svg, 'n2').split(' ').includes('proof-verified'))
  assert.ok(classOf(svg, 'n2').split(' ').includes('type-check'))
  assert.ok(classOf(svg, 'n1').split(' ').includes('proof-claimed'))
  assert.ok(!classOf(svg, 'n1').split(' ').includes('pending'))
  assert.ok(!classOf(svg, 'n4').split(' ').some(c => c.startsWith('proof-')), 'no proof class while not done')
})

test('svg glyphs follow status and type', () => {
  const flow = fx()
  flow.nodes.push(
    { id: 'g1', type: 'step', title: 'a', status: 'doing', after: [], evidence: [] },
    { id: 'g2', type: 'step', title: 'b', status: 'blocked', after: [], evidence: [] },
    { id: 'g3', type: 'step', title: 'c', status: 'skipped', after: [], evidence: [] },
    { id: 'g4', type: 'note', title: 'd', after: [] },
  )
  flow.derived = derive(flow)
  const svg = FC.svg(flow, FC.layout(flow))
  const glyph = id => groupOf(svg, id).match(/<text class="fc-glyph"[^>]*>([^<]*)<\/text>/)?.[1]
  assert.equal(glyph('n1'), '●')
  assert.equal(glyph('n4'), '○')
  assert.equal(glyph('g1'), '◐')
  assert.equal(glyph('g2'), '■')
  assert.equal(glyph('g3'), '–')
  assert.equal(glyph('g4'), '·')
  assert.equal(glyph('n3'), '?')
  assert.match(groupOf(svg, 'n1'), /<rect [^>]*class="fc-shape"/, 'a step is a rect')
})

test('svg shows the env pill only when it differs from the flow, and the evidence count', () => {
  const flow = fx()
  flow.nodes[3].env = 'stage'
  const svg = FC.svg(flow, FC.layout(flow))
  assert.ok(!groupOf(svg, 'n1').includes('class="fc-env"'))
  assert.match(groupOf(svg, 'n4'), /<text class="fc-env"[^>]*>stage<\/text>/)
  assert.match(groupOf(svg, 'n1'), /<text class="fc-ev"[^>]*>1<\/text>/)
  assert.ok(!groupOf(svg, 'n4').includes('class="fc-ev"'))
})

test('svg draws an elbow edge per edge and a rail per row', () => {
  const flow = fx()
  flow.nodes[3].env = 'stage'
  const lay = FC.layout(flow)
  const svg = FC.svg(flow, lay)
  const edges = svg.match(/<path class="fc-edge"[^>]*>/g) || []
  assert.equal(edges.length, 3)
  // n1 bottom centre (130, 40) down to n2 top centre (130, 76).
  assert.match(edges[0], /d="M130 40 V58 H130 V76"/)
  const rails = svg.match(/<rect class="fc-rail env-[^"]*"[^>]*>/g) || []
  assert.equal(rails.length, 4)
  assert.ok(rails[0].includes('env-dev'))
  assert.ok(rails[2].includes('env-dev'), 'an ask row without env takes the flow env')
  assert.ok(rails[3].includes('env-stage'))
  assert.match(rails[1], /y="76"[^>]*height="40"/)
})

test('an answered ask shows its answer instead of buttons', () => {
  const flow = fx()
  flow.nodes[2].answer = 'yes'
  flow.derived = derive(flow)
  let svg = FC.svg(flow, FC.layout(flow))
  assert.ok(!svg.includes('data-answer='))
  assert.ok(!classOf(svg, 'n3').split(' ').includes('waiting'))
  assert.match(groupOf(svg, 'n3'), /<text class="fc-answer"[^>]*>Yes<\/text>/)
  flow.nodes[2].answer = 'no'
  svg = FC.svg(flow, FC.layout(flow))
  assert.match(groupOf(svg, 'n3'), /<text class="fc-answer"[^>]*>No<\/text>/)
  flow.nodes[2].kind = 'text'
  flow.nodes[2].answer = 'After <QA> ok'
  svg = FC.svg(flow, FC.layout(flow))
  assert.match(groupOf(svg, 'n3'), /<text class="fc-answer"[^>]*>After &lt;QA&gt; ok<\/text>/)
  // A long text keeps its first 20 chars at most, then is cut to fit its area.
  flow.nodes[2].answer = 'Wait for the <QA> sign-off first please'
  svg = FC.svg(flow, FC.layout(flow))
  const shown = groupOf(svg, 'n3').match(/<text class="fc-answer"[^>]*>([^<]*)<\/text>/)[1]
  assert.ok(shown.startsWith('Wait for the') && shown.endsWith('…'), shown)
  assert.ok('Wait for the &lt;QA&gt; si'.startsWith(shown.slice(0, -1).trimEnd()), shown)
})

test('svg escapes every text and cuts long titles', () => {
  const flow = fx()
  flow.nodes[0].title = '<script>alert("x")</script> & a very long title that cannot possibly fit in one node'
  flow.nodes[1].title = 'Toggle works'
  flow.nodes[0].env = 'p"rod'
  const svg = FC.svg(flow, FC.layout(flow))
  assert.ok(!svg.includes('<script>'))
  assert.ok(!svg.includes('"x"'))
  assert.ok(svg.includes('&lt;script&gt;'))
  assert.ok(svg.includes('env-p&quot;rod'))
  const title = groupOf(svg, 'n1').match(/<text class="fc-title"[^>]*>([^<]*)<\/text>/)[1]
  assert.ok(title.endsWith('…'), title)
  assert.ok(title.length < 60, title)
  assert.equal(groupOf(svg, 'n2').match(/<text class="fc-title"[^>]*>([^<]*)<\/text>/)[1],
    'Toggle works', 'a short title is not cut')
})

// ═══ ask nodes keep the question clear of the buttons and the answer ═══
// A copy of the per-character width estimate in flow-chart.js (charW, textW).
const charW = c =>
  ' iljtf.,:;|!\'"()[]'.includes(c) ? 0.3 : 'mwMW@%'.includes(c) ? 0.85 : c >= 'A' && c <= 'Z' ? 0.68 : 0.56
const textW = (text, px, weight) => [...text].reduce((w, c) => w + charW(c), 0) * px * (weight >= 600 ? 1.06 : 1)
const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
const QUESTION = 'Should we switch the header to enforcing on every environment?'.slice(0, 60)
const titleOf = g => {
  const m = g.match(/<text class="fc-title" x="([\d.]+)"[^>]*>([^<]*)<\/text>/)
  return { x: Number(m[1]), text: unesc(m[2]) }
}

test('an open ask with a long question cuts it clear of the Yes button', () => {
  const flow = fx()
  flow.nodes[2].title = QUESTION
  assert.equal(QUESTION.length, 60)
  const g = groupOf(FC.svg(flow, FC.layout(flow)), 'n3')
  const title = titleOf(g)
  const yesLeft = Number(g.match(/data-answer="yes"[^>]*><rect x="([\d.]+)"/)[1])
  assert.ok(title.text.endsWith('…'), title.text)
  assert.ok(title.x + textW(title.text, 13, 500) <= yesLeft - 8, `${title.text} runs under Yes at ${yesLeft}`)
})

test('an answered text ask fits the question and the answer into their own areas', () => {
  const flow = fx()
  Object.assign(flow.nodes[2], { title: QUESTION, kind: 'text', answer: 'Wait until QA have signed off.' })
  assert.equal(flow.nodes[2].answer.length, 30)
  flow.derived = derive(flow)
  const g = groupOf(FC.svg(flow, FC.layout(flow)), 'n3')
  const title = titleOf(g)
  const m = g.match(/<text class="fc-answer" x="([\d.]+)"[^>]*>([^<]*)<\/text>/)
  const ansEnd = Number(m[1])
  const ans = unesc(m[2])
  const ansLeft = ansEnd - textW(ans, 12, 600)
  assert.ok(title.text.endsWith('…') && title.text.length < 60, title.text)
  assert.ok(ans.length <= 20, ans)
  assert.ok(ans.endsWith('…'), ans)
  assert.ok(textW(ans, 12, 600) <= 100, `${ans} is wider than its area`)
  assert.ok(title.x + textW(title.text, 13, 500) <= ansLeft - 8, `${title.text} runs into ${ans}`)
})

test('an open ask with its own env keeps exactly two buttons and no env pill over them', () => {
  const flow = fx()
  flow.nodes[2].env = 'stage'
  const g = groupOf(FC.svg(flow, FC.layout(flow)), 'n3')
  assert.equal((g.match(/<g class="fc-ans"/g) || []).length, 2)
  assert.ok(!g.includes('class="fc-env"'), 'no room for the env pill beside the buttons')
  assert.equal((g.match(/<g[ >]/g) || []).length + 1, (g.match(/<\/g>/g) || []).length, 'the node group and its two buttons close')
  assert.ok(g.endsWith('</g>'))
})

test('an answered ask shows its own env beside a short answer', () => {
  const flow = fx()
  Object.assign(flow.nodes[2], { env: 'stage', answer: 'yes' })
  flow.derived = derive(flow)
  const g = groupOf(FC.svg(flow, FC.layout(flow)), 'n3')
  assert.match(g, /<text class="fc-env"[^>]*>stage<\/text>/)
})

test('a flow with no steps says so in one line that points to Output, and the Process tab draws it instead of a blank chart', () => {
  assert.equal(FC.empty(), '<p class="empty">No steps recorded. The story and test steps are under Output.</p>')
  const flows = fs.readFileSync(path.join(HERE, '..', 'public', 'flows.js'), 'utf8')
  assert.ok(flows.includes('if (!lay.nodes.length) {'), 'the chart is not drawn for a flow with no steps')
  assert.ok(flows.includes('scroller.innerHTML = window.FlowChart.empty()'))
})
