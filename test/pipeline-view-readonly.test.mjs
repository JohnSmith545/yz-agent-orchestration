// The Human review box (human-review.js) is placed under the Agents page's OWN diagram only. PipelineView is also
// used to draw a saved orchestration on the Orchestration bank page, which is a picture and not the live pipeline,
// so the box is an option of the view, off unless the caller asks for it. A minimal stub DOM runs create() and
// update() in a vm; the layout, tickets and details helpers are stubs too.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')

function el() {
  const e = {
    style: {}, dataset: {}, innerHTML: '', classList: { toggle() {} },
    setAttribute() {}, addEventListener() {}, querySelector: () => el(), querySelectorAll: () => [],
  }
  return e
}

function load() {
  const placed = []
  const window = {
    PipelineLayout: { layout: () => ({ width: 300, height: 120, dir: 'lr', nodes: [], edges: [], labels: [] }) },
    PipelineTickets: { byNode: () => ({}), chipRows: () => 0, labelsOf: () => ({}), chips: () => ({ shown: [], more: 0 }) },
    PipelineDetails: { pushes: () => 0 },
    HumanReview: { place: (canvas, lay) => placed.push(lay) },
    addEventListener() {},
  }
  vm.runInNewContext(fs.readFileSync(path.join(PUBLIC, 'pipeline-view.js'), 'utf8'), { window })
  const box = { ...el(), clientWidth: 900 }
  return { V: window.PipelineView, box, placed }
}
const GRAPH = { nodes: [{ id: 'request', kind: 'start', label: 'Request', role: 'request' }], edges: [] }

test('by default the view places NO Human review box: any other page draws a picture, not the live pipeline', () => {
  const { V, box, placed } = load()
  V.create(box).update({ graph: GRAPH })
  assert.equal(placed.length, 0)
})

test('the Agents page asks for it, and then it is placed on each layout', () => {
  const { V, box, placed } = load()
  V.create(box, { humanReview: true }).update({ graph: GRAPH })
  assert.equal(placed.length, 1)
})

test('the Agents page passes the option, and the bank page does not', () => {
  assert.match(fs.readFileSync(path.join(PUBLIC, 'agents-page.js'), 'utf8'), /PipelineView\.create\(.*humanReview: true/)
  assert.doesNotMatch(fs.readFileSync(path.join(PUBLIC, 'bank-page.js'), 'utf8'), /humanReview/)
})
