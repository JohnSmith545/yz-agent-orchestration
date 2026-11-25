// Tests for the Agents diagram (public/pipeline-layout.js) with the Human task box and Senior: the top row (Agent 1,
// Human task, Senior) on one line, QA and Security where they were, the `no code changes` arrows ending at Human task
// under ONE label on the outermost lane, and the geometry the user checks by eye (no box overlaps another, no arrow
// runs through a box, no line touches a label, no label sits on a box or a label, nothing wider than the screen),
// for the live shape, a pipeline with no optional agents and one with a single producer, at three widths.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { DEFAULT_PIPELINE, pipelineGraph } from '../pipeline.mjs'
import { labelBox, pathPoints, touchedLabels } from './diagram-geometry.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const window = {}
for (const f of ['pipeline-labels.js', 'pipeline-layout.js']) vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8'), { window })
const L = window.PipelineLayout

const agents = n => Object.fromEntries(Array.from({ length: n }, (_, i) => [`Agent ${i + 1}`, `Agent ${i + 1}`]))
/** The live shape: Master, Planner, Agents 1 to 3, Independent, QA, Security, Senior, Push, Output. */
const LIVE = pipelineGraph({
  coordinatorLabel: 'Master', codingAgents: { Master: 'Master', ...agents(3), Planner: 'Planner', Security: 'Security', Senior: 'Senior' },
  factory: { chat: { name: 'Independent' } }, pipeline: { ...DEFAULT_PIPELINE, planner: 'Planner', security: 'Security', senior: 'Senior' },
})
const NONE = pipelineGraph({ coordinatorLabel: 'Master', codingAgents: { Master: 'Master', ...agents(3) }, pipeline: { ...DEFAULT_PIPELINE } })
const ONE = pipelineGraph({ coordinatorLabel: 'Master', codingAgents: { Master: 'Master', ...agents(1), Senior: 'Senior' }, pipeline: { ...DEFAULT_PIPELINE, senior: 'Senior' } })
const SHAPES = [['the live shape', LIVE], ['no optional agents', NONE], ['one producer', ONE]]
/** The diagram's box at 1440, 1024 and 390 wide (the page's gutters taken off). */
const WIDTHS = [1440 - 120, 1024 - 120, 390 - 32]
const at = lay => new Map(lay.nodes.map(n => [n.id, n]))

test('the top row: Agent 1, Human task and Senior on one line, left to right; Human task in QA column, Senior in Security column', () => {
  // the live shape is left to right from about 1300 px; narrower it is top to bottom (the next tests)
  for (const width of [WIDTHS[0], 1600]) {
    for (const rows of [0, 2]) {
      const lay = L.layout(LIVE, { width, rows })
      assert.equal(lay.dir, 'LR')
      const b = at(lay)
      assert.equal(b.get('human').y, b.get('agent-1').y, `${width}`)
      assert.equal(b.get('senior').y, b.get('agent-1').y)
      assert.equal(b.get('human').x, b.get('qa').x)
      assert.equal(b.get('senior').x, b.get('security').x)
      // QA and Security stay level with the middle producer, as before Human task existed
      assert.equal(b.get('qa').y, b.get('agent-2').y)
      assert.equal(b.get('security').y, b.get('agent-2').y)
    }
  }
})

test('the top row with no optional agents and with one producer: Human task level with Agent 1', () => {
  for (const g of [NONE, ONE]) {
    const b = at(L.layout(g, { width: 1320, rows: 1 }))
    assert.equal(b.get('human').y, b.get('agent-1').y)
    assert.equal(b.get('human').x, b.get('qa').x)
    if (b.has('senior')) assert.equal(b.get('senior').y, b.get('agent-1').y)
  }
})

test('on a phone, top to bottom: Human task and Senior in the column of Agent 1 when three producers share the row', () => {
  const b = at(L.layout(LIVE, { width: 358, rows: 2 }))
  assert.equal(b.get('human').x, b.get('agent-1').x)
  assert.equal(b.get('senior').x, b.get('agent-1').x)
  assert.equal(b.get('human').y, b.get('qa').y)
})

// QA B-4 (390 wide): the Human task box read Huma…, 8 qu…, 2 by…. Its name (13 px bold) and its longest count line
// (12 px, `99 questions`) must fit whole in the box at a phone width, with the box padding (10 px each side).
const TEXT_12 = 7 // px a character at 12 to 13 px, a little over the real average
test('on a phone the Human task and Senior boxes are wide enough to read their name and count lines whole', () => {
  for (const [name, g] of SHAPES) {
    const b = at(L.layout(g, { width: 358, rows: 3 }))
    for (const id of ['human', 'senior']) {
      if (!b.has(id)) continue
      const need = Math.max('Human task'.length, '99 questions'.length) * TEXT_12 + 20
      assert.ok(b.get(id).w >= need, `${name}: ${id} is ${b.get(id).w} px, needs ${need}`)
    }
    // still under Agent 1: from its left edge, or as far left as the row allows, and under part of it
    const [h, a] = [b.get('human'), b.get('agent-1')]
    assert.ok(h.x <= a.x && h.x + h.w > a.x, `${name}: Human task ${h.x}..${h.x + h.w}, Agent 1 ${a.x}..${a.x + a.w}`)
  }
})

test('the no code changes arrows of the coordinator and the producers end at Human task, under ONE label on the outermost lane', () => {
  for (const [name, g] of SHAPES) {
    for (const width of WIDTHS) {
      const lay = L.layout(g, { width, rows: 1 })
      const into = lay.edges.filter(e => e.to === 'human' && e.kind === 'skip')
      assert.equal(into.length, g.edges.filter(e => e.to === 'human' && e.kind === 'skip').length)
      const human = at(lay).get('human')
      for (const e of into) {
        const [x, y] = pathPoints(e.head)[0]
        assert.ok(x >= human.x - 1 && x <= human.x + human.w + 1 && y >= human.y - 1 && y <= human.y + human.h + 1, `${name} ${width}: ${e.from} ends at ${x},${y}`)
      }
      const labels = lay.labels.filter(l => l.edges.some(i => g.edges[i].to === 'human' && g.edges[i].kind === 'skip'))
      assert.equal(labels.length, 1, `${name} ${width}`)
      assert.equal(labels[0].text, 'no code changes')
      assert.deepEqual([...labels[0].edges].sort((a, b) => a - b), [...into.map(e => e.i)].sort((a, b) => a - b))
      // outside every box, on the corridor side (above them left to right, left of them top to bottom)
      const top = Math.min(...lay.nodes.map(n => (lay.dir === 'LR' ? n.y : n.x)))
      assert.ok((lay.dir === 'LR' ? labels[0].y : labels[0].x) < top, `${name} ${width}: the label is on the outer lane`)
    }
  }
})

test('Senior: done by hand, reviewed and redo are each labelled once; with no Senior, Human task goes to the Output', () => {
  const lay = L.layout(LIVE, { width: 1320, rows: 1 })
  for (const text of ['done by hand', 'reviewed', 'redo']) assert.equal(lay.labels.filter(l => l.text === text).length, 1, text)
  const plain = L.layout(NONE, { width: 1320, rows: 1 })
  const done = plain.edges.find(e => e.from === 'human' && e.to === 'outcome')
  assert.ok(done)
  assert.equal(plain.labels.filter(l => l.text === 'done by hand').length, 1)
})

for (const [name, g] of SHAPES) {
  for (const width of WIDTHS) {
    test(`geometry: ${name} at ${width}: no box on a box, no arrow through a box, no line on a label, no label on a box`, () => {
      for (const rows of [0, 1, 3]) {
        const lay = L.layout(g, { width, rows })
        const where = `${name}, ${width}, ${lay.dir}, ${rows} chip rows`
        assert.ok(lay.width <= width, `${where}: ${lay.width} wide`)
        const boxes = lay.nodes
        for (const [i, a] of boxes.entries()) {
          for (const b of boxes.slice(i + 1)) assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${where}: ${a.id} on ${b.id}`)
        }
        for (const e of lay.edges) {
          for (const [x, y] of pathPoints(e.d)) {
            const hit = boxes.find(b => x > b.x + 1 && x < b.x + b.w - 1 && y > b.y + 1 && y < b.y + b.h - 1)
            assert.ok(!hit, `${where}: ${e.from} -> ${e.to} runs through ${hit?.id}`)
          }
        }
        assert.deepEqual(touchedLabels(lay), [], where)
        const texts = lay.labels.map(l => labelBox(l, 0))
        for (const [i, t] of texts.entries()) {
          for (const n of boxes) assert.ok(!(t[0] < n.x + n.w && n.x < t[2] && t[1] < n.y + n.h && n.y < t[3]), `${where}: ${lay.labels[i].text} on ${n.id}`)
          for (const u of texts.slice(i + 1)) assert.ok(!(t[0] < u[2] && u[0] < t[2] && t[1] < u[3] && u[1] < t[3]), `${where}: two labels overlap`)
          assert.ok(t[0] >= 0 && t[1] >= 0 && t[2] <= lay.width && t[3] <= lay.height, `${where}: ${lay.labels[i].text} outside the drawing`)
        }
      }
    })
  }
}
