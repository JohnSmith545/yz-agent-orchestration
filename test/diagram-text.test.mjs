// Tests for diagram-text.mjs, the small arrow language behind `flow diagram`:
// `A -> B: label; B -> [store] C`. parseDiagram is pure and never throws, so
// every case here is a plain call.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DIAGRAM_KINDS, DIAGRAM_MAX, parseDiagram, slug } from '../diagram-text.mjs'

const ok = text => {
  const r = parseDiagram(text)
  assert.deepEqual(r.errors, [], text)
  return r.diagram
}
const labels = d => d.nodes.map(n => n.label)
const arrows = d => d.edges.map(e => `${e.from}>${e.to}${e.label ? `:${e.label}` : ''}`)

test('one arrow makes two boxes and one arrow; labels keep their spaces', () => {
  const d = ok('Settings page -> Browser storage')
  assert.deepEqual(d.nodes, [
    { id: 'settings-page', label: 'Settings page', kind: 'box' },
    { id: 'browser-storage', label: 'Browser storage', kind: 'box' },
  ])
  assert.deepEqual(d.edges, [{ from: 'settings-page', to: 'browser-storage', label: '' }])
})

test('a chain A -> B -> C is two arrows, and each part may carry the label of the arrow that enters it', () => {
  assert.deepEqual(arrows(ok('A -> B -> C')), ['a>b', 'b>c'])
  assert.deepEqual(arrows(ok('A -> B: first -> C: second')), ['a>b:first', 'b>c:second'])
})

test('the edge label is everything after the first colon, trimmed; a colon in the first box stays in its label', () => {
  const d = ok('Step 1: build -> Deploy: when green: and tagged')
  assert.deepEqual(labels(d), ['Step 1: build', 'Deploy'])
  assert.deepEqual(arrows(d), ['step-1-build>deploy:when green: and tagged'])
})

test('a kind prefix in square brackets sets the kind; no prefix is a box', () => {
  const d = ok('[actor] User -> Settings page: clicks the moon; Settings page -> [store] Browser storage: saves the choice; Settings page -> [decision] System prefers dark?')
  assert.deepEqual(d.nodes.map(n => [n.id, n.kind]), [
    ['user', 'actor'], ['settings-page', 'box'], ['browser-storage', 'store'], ['system-prefers-dark', 'decision'],
  ])
  assert.deepEqual(arrows(d), ['user>settings-page:clicks the moon', 'settings-page>browser-storage:saves the choice', 'settings-page>system-prefers-dark'])
  assert.deepEqual(DIAGRAM_KINDS, ['box', 'actor', 'store', 'decision'])
  assert.equal(ok('[box] Plain').nodes[0].kind, 'box')
  assert.equal(ok('[ Store ] Disk').nodes[0].kind, 'store', 'the kind is read loosely: spaces and case')
})

test('the same label is the same box, whatever its case or spacing; the first spelling and the first kind given win', () => {
  const d = ok('Job -> [store] Queue; queue -> Worker;   QUEUE   ->  Job')
  assert.deepEqual(labels(d), ['Job', 'Queue', 'Worker'])
  assert.deepEqual(d.nodes.map(n => n.kind), ['box', 'store', 'box'])
  assert.deepEqual(arrows(d), ['job>queue', 'queue>worker', 'queue>job'])
  // a plain mention first, the kind later: the kind is taken
  assert.equal(ok('Db -> App; App -> [store] Db').nodes[0].kind, 'store')
})

test('statements split on semicolons and on new lines alike; blank ones are skipped', () => {
  const a = ok('A -> B; B -> C')
  const b = ok('A -> B\nB -> C\r\n\n')
  const c = ok(';A -> B;;\n B -> C ;')
  assert.deepEqual(b, a)
  assert.deepEqual(c, a)
})

test('a lone label declares a box with no arrow', () => {
  const d = ok('[actor] Night operator; A -> B')
  assert.deepEqual(labels(d), ['Night operator', 'A', 'B'])
  assert.deepEqual(d.edges.length, 1)
  assert.deepEqual(ok('Just one').nodes, [{ id: 'just-one', label: 'Just one', kind: 'box' }])
})

test('a repeated arrow is drawn once; a label given later fills an empty one', () => {
  assert.deepEqual(arrows(ok('A -> B; A -> B: again; A -> B: third')), ['a>b:again'])
})

test('ids are slugs of the label, made unique with -2, -3; a label with no letters or digits gets n<index>', () => {
  const d = ok('Build & test -> Build test -> build-test? -> !!! -> ???')
  assert.deepEqual(d.nodes.map(n => n.id), ['build-test', 'build-test-2', 'build-test-3', 'n4', 'n5'])
  assert.equal(slug('  Ünïcode  Box!! '), 'n-code-box')
  assert.equal(slug('x'.repeat(80)).length <= 40, true, 'a slug is at most 40 characters')
  assert.equal(slug('---'), '')
})

test('every error is one line naming its statement, never a throw, and nothing is returned with errors', () => {
  const cases = [
    ['A ->', 'statement 1: nothing after ->'],
    ['A -> B; -> C', 'statement 2: nothing before ->'],
    ['A -> -> B', 'statement 1: nothing between two ->'],
    ['A -> : just a label', 'statement 1: nothing after ->'],
    ['[robot] A', 'statement 1: unknown kind [robot]: use box, actor, store or decision'],
    ['[actor]', 'statement 1: [actor] with no label after it'],
    ['A -> A', 'statement 1: an arrow from A to itself'],
    [`${'x'.repeat(33)} -> B`, 'statement 1: keep it high level: a box label is at most 32 characters (this has 33)'],
    [`A -> B: ${'y'.repeat(25)}`, 'statement 1: keep it high level: an arrow label is at most 24 characters (this has 25)'],
    ['[actor] A; [store] A', 'statement 2: A already has the kind actor'],
    ['', 'nothing to draw: write A -> B; B -> C'],
    ['  ;\n ; ', 'nothing to draw: write A -> B; B -> C'],
  ]
  for (const [text, line] of cases) {
    const r = parseDiagram(text)
    assert.deepEqual(r.errors, [line], JSON.stringify(text))
    assert.equal(r.diagram, null)
  }
  assert.doesNotThrow(() => parseDiagram(undefined))
  assert.deepEqual(parseDiagram(42).errors, ['nothing to draw: write A -> B; B -> C'])
  // several problems: one line each, in statement order
  assert.deepEqual(parseDiagram('A ->; [x] B; C -> C').errors, [
    'statement 1: nothing after ->', 'statement 2: unknown kind [x]: use box, actor, store or decision', 'statement 3: an arrow from C to itself',
  ])
})

test('the limits keep it high level: at most 8 boxes, 10 arrows, 32 characters a box and 24 an arrow, and a refusal says why', () => {
  assert.deepEqual(DIAGRAM_MAX, { nodes: 8, edges: 10, label: 32, edgeLabel: 24 })
  const chain = n => Array.from({ length: n }, (_, i) => `Box ${i}`).join(' -> ')
  assert.equal(ok(chain(8)).nodes.length, 8)
  assert.deepEqual(parseDiagram(chain(11)).errors, ['keep it high level: at most 8 boxes (this has 11)'], 'its 10 arrows are within the limit')
  // 4 boxes all joined both ways is 12 arrows
  const mesh = n => {
    const out = []
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) out.push(`B${i} -> B${j}`)
    return out.join('; ')
  }
  assert.equal(ok('B0 -> B1 -> B2 -> B3 -> B0; B0 -> B2; B1 -> B3; B2 -> B0; B3 -> B1; B1 -> B0').edges.length, 9)
  assert.deepEqual(parseDiagram(mesh(4)).errors, ['keep it high level: at most 10 arrows (this has 12)'])
  assert.equal(ok(`${'x'.repeat(32)} -> B: ${'y'.repeat(24)}`).nodes[0].label.length, 32)
})
