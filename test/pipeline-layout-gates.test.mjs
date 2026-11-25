// Tests for the Agents page diagram (public/pipeline-layout.js) with the planner and Security on the pipeline: the
// nine agent and step boxes lay out in layers in execution order, no two boxes overlap, every arrow has both ends,
// and Security's `failed` arrows back to every producer carry ONE label, not one per producer stacked in one place.
// The graphs come from the real pipeline.mjs; the browser file runs in a vm.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { DEFAULT_PIPELINE, pipelineGraph } from '../pipeline.mjs'
import { labelBox, touchedLabels } from './diagram-geometry.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const window = {}
for (const f of ['pipeline-labels.js', 'pipeline-layout.js']) vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8'), { window })
const L = window.PipelineLayout

const G_CONFIG = {
  coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', 'Agent 2': 'Agent 2', 'Agent 3': 'Agent 3', Planner: 'Planner', Security: 'Security' },
  pipeline: { ...DEFAULT_PIPELINE, planner: 'Planner', security: 'Security' }, factory: { chat: { name: 'Independent' } },
}
const G = pipelineGraph(G_CONFIG)

test('the layers run Request, Master, the planner, the producers, QA, Security, Push, Output', () => {
  const r = L.ranks(G)
  assert.deepEqual([r.request, r.master, r.independent, r.planner, r['agent-1'], r['agent-3'], r.qa, r.security, r.push, r.outcome], [0, 1, 1, 2, 3, 3, 4, 5, 6, 7])
})

for (const width of [1400, 1000, 360]) {
  test(`at ${width} wide no two boxes overlap and every arrow is drawn`, () => {
    const lay = L.layout(G, { width, rows: 2 })
    const boxes = lay.nodes
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y
        assert.ok(apart, `${a.id} and ${b.id} overlap at ${width}`)
      }
    }
    assert.equal(lay.edges.length, G.edges.length)
    for (const e of lay.edges) assert.match(e.d, /^M[\d.-]+ [\d.-]+/, `${e.from} to ${e.to}`)
  })
}

test('Security sends work back to every producer under ONE failed label; every QA return is labelled too', () => {
  for (const width of [1400, 1000, 358]) {
    const lay = L.layout(G, { width })
    const fromSecurity = lay.labels.filter(l => l.text === 'failed' && l.edges.every(i => G.edges[i].from === 'security'))
    assert.equal(fromSecurity.length, 1, `at ${width}`)
    assert.equal(fromSecurity[0].edges.length, 3)
    const fromQa = lay.labels.filter(l => l.text === 'failed' && l.edges.every(i => G.edges[i].from === 'qa'))
    assert.equal(fromQa.flatMap(l => l.edges).length, 3, `at ${width}`)
  }
})

test('each Security return ends in the head of the QA return to the same producer: one arrival, no second head', () => {
  for (const width of [1400, 1000, 358]) {
    const lay = L.layout(G, { width })
    for (const p of ['agent-1', 'agent-2', 'agent-3']) {
      const qa = lay.edges.find(e => e.from === 'qa' && e.to === p && e.kind === 'rework')
      const sec = lay.edges.find(e => e.from === 'security' && e.to === p)
      assert.equal(sec.head, qa.head, `${p} at ${width}`)
    }
  }
})

// QA 2026-11-25: Security's return arrow and the skip lines ran into the producers' failed labels. No arrow,
// arrowhead or dashed line may touch or run under any label, with both new agents on and with neither.
const PLAIN = pipelineGraph({ ...G_CONFIG, codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', 'Agent 2': 'Agent 2', 'Agent 3': 'Agent 3' }, pipeline: { ...DEFAULT_PIPELINE } })
for (const [name, graph] of [['both new agents', G], ['neither', PLAIN]]) {
  for (const width of [1440 - 120, 1024 - 120, 390 - 32]) {
    test(`no line touches a label: ${name}, ${width} wide`, () => {
      for (const rows of [0, 1, 4]) {
        const lay = L.layout(graph, { width, rows })
        assert.deepEqual(touchedLabels(lay), [], `${lay.dir}, ${rows} chip rows`)
        // and no label sits on a box or on another label
        const boxes = lay.labels.map(l => labelBox(l, 0))
        for (const [i, b] of boxes.entries()) {
          for (const n of lay.nodes) assert.ok(!(b[0] < n.x + n.w && n.x < b[2] && b[1] < n.y + n.h && n.y < b[3]), `${lay.labels[i].text} on ${n.id}`)
          for (const c of boxes.slice(i + 1)) assert.ok(!(b[0] < c[2] && c[0] < b[2] && b[1] < c[3] && c[1] < b[3]), `two labels overlap at ${width}`)
        }
      }
    })
  }
}

test('on a phone (a 358 px box) the nine boxes fit with no inner scroll: Security returns share one corridor lane', () => {
  const lay = L.layout(G, { width: 358, rows: 2 })
  assert.equal(lay.dir, 'TB')
  assert.ok(lay.width <= 358, `${lay.width}`)
  for (const n of lay.nodes) assert.ok(n.w >= 72, `${n.id} is ${n.w} wide`)
  // the three return arrows of Security run along the same corridor line: their long vertical run is at one x
  const runs = lay.edges.filter(e => e.from === 'security' && e.kind === 'rework').map(e => [...e.d.matchAll(/L([\d.]+) [\d.]+/g)].map(m => Number(m[1])))
  const shared = runs.map(xs => Math.max(...xs))
  assert.equal(new Set(shared).size, 1, JSON.stringify(shared))
})
