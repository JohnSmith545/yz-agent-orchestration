// Tests for public/flow-picture.js, the SUMMARY chart the Output view draws from
// a flow that has neither a screenshot nor an agent diagram. High level on
// purpose: each run of steps between two questions is one or two boxes, never
// one box per step, and never more than 7 shapes. A browser script, so it runs
// in a vm with a stub window. FACTORY_DATA_DIR points at a temp folder BEFORE
// flows.mjs is imported (for validateFlow and derive), so no test touches data/.
//
// The fixtures (test/fixtures/*.json) hold answers and verified ticks. `flow
// write` never carries an answer or a verified tick from a file (by design:
// only you answer and verify), so a fixture that needs them in a running
// dashboard is loaded by writing its file into data/flows directly.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-picture-test-'))
const { derive, validateFlow, DATA_DIR, clip } = await import('../flows.mjs')
after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }))

const window = {}
vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', 'flow-picture.js'), 'utf8'), { window })
const P = window.FlowPicture
const plain = v => JSON.parse(JSON.stringify(v))

const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'no-visual.json'), 'utf8'))
const fx = (edit = () => {}) => {
  const flow = structuredClone(FIXTURE)
  edit(flow)
  flow.derived = derive(flow)
  return flow
}
const step = (id, status, title = `Step ${id}`) => ({ id, type: 'step', title, status, after: [], evidence: [], verified: null })
const ask = (id, answer = null, title = `Question ${id}?`) => ({ id, type: 'ask', title, after: [], kind: 'yesno', yes: '', no: '', answer })
const flowOf = nodes => {
  const flow = { id: 'x', title: 'X', agent: 'Agent 3', status: 'open', nodes }
  flow.derived = derive(flow)
  return flow
}

test('the no-visual fixture is a valid flow of 16 nodes with no output and no screenshot: its visual is the auto chart', () => {
  assert.deepEqual(validateFlow(FIXTURE), [])
  assert.equal(FIXTURE.nodes.length, 16)
  assert.equal(derive(FIXTURE).output.visual, 'auto')
})

test('the fixture sums up to 6 shapes: done work, a decision answered Yes, done work, work left with 1 blocked, an open decision, work left', () => {
  const g = plain(P.graph(fx()))
  assert.deepEqual(g.nodes.map(n => [n.kind, n.label, n.sub || '', n.goto]), [
    ['box', 'Read how the nightly report job…', '+4 more', 'n1'],
    ['decision', 'Run both schedulers side by side…', '', 'n6'],
    ['box', 'Turn on the new schedule in dev', '+1 more', 'n7'],
    ['box', '3 left', '1 blocked', 'n9'],
    ['decision', 'Turn off the old scheduler now?', '', 'n12'],
    ['box', '2 left', '', 'n13'],
  ])
  assert.deepEqual(g.edges.map(e => [e.from, e.to, e.label]), [
    ['s1', 's2', ''], ['s2', 's3', 'Yes'], ['s3', 's4', ''], ['s4', 's5', ''], ['s5', 's6', ''],
  ], 'an open question has no ? on its arrow: its warn colour says it waits')
  assert.equal(g.line, '7 done · 5 left · 2 decisions')
})

test('done boxes are solid with no proof dot; work left is dashed, warn when blocked; a decision open or answered', () => {
  const [done, yes, done2, left, open, left2] = plain(P.graph(fx())).nodes
  assert.match(done.cls, /\bdg-done\b/)
  for (const n of plain(P.graph(fx())).nodes) assert.equal(n.mark, undefined, 'no proof dots in the summary chart')
  assert.match(left.cls, /\bdg-left\b/)
  assert.match(left.cls, /\bdg-blocked\b/)
  assert.doesNotMatch(left2.cls, /dg-blocked/)
  assert.match(yes.cls, /\bdg-ask\b/)
  assert.doesNotMatch(yes.cls, /dg-open/)
  assert.match(open.cls, /\bdg-ask dg-open\b/)
  assert.match(done2.cls, /\bdg-done\b/)
  const last = plain(P.graph(flowOf([step('a', 'done'), ask('q1')])))
  assert.equal(last.nodes.at(-1).sub, undefined, 'an open last question shows nothing under it either')
})

test('a run all done has no +N more for one step; a run with nothing done is only its dashed box; skipped steps and notes never count', () => {
  const g = plain(P.graph(flowOf([step('a', 'done', 'Only one'), { id: 'n', type: 'note', title: 'A note', after: [] }, step('s', 'skipped')])))
  assert.deepEqual(g.nodes.map(n => n.label), ['Only one'])
  assert.equal(g.line, '1 done')
  const todo = plain(P.graph(flowOf([step('a', 'todo'), step('b', 'doing')])))
  assert.deepEqual(todo.nodes.map(n => [n.label, n.goto]), [['2 left', 'a']])
  assert.equal(todo.line, '2 left')
})

test('a text answer is its first three words on the arrow; the last question with no arrow after it shows its answer under it', () => {
  const g = plain(P.graph(flowOf([
    step('a', 'done'), { ...ask('q1'), kind: 'text', answer: 'Use the staging mail relay please' }, step('b', 'todo'), ask('q2', 'no'),
  ])))
  assert.equal(g.edges.find(e => e.from === 's2').label, 'Use the staging…')
  assert.equal(g.nodes.at(-1).sub, 'No')
  assert.equal(g.line, '1 done · 1 left · 2 decisions')
})

test('never more than 7 shapes: the middle merges into one box of N steps and M decisions, from the middle outward', () => {
  // 9 shapes: done, ask, done, ask, done, ask, done, ask, done
  const nodes = []
  for (let i = 0; i < 5; i++) {
    nodes.push(step(`s${i}`, 'done'))
    if (i < 4) nodes.push(ask(`q${i}`, 'yes'))
  }
  const g = plain(P.graph(flowOf(nodes)))
  assert.equal(g.nodes.length, 7)
  assert.deepEqual(g.nodes.map(n => n.label), ['Step s0', 'Question q0?', 'Step s1', '1 step and 2 decisions', 'Step s3', 'Question q3?', 'Step s4'])
  assert.equal(g.nodes[3].goto, 'q1', 'a click goes to the first node it holds')
  assert.match(g.nodes[3].cls, /dg-merged/)
  assert.equal(g.edges.length, 6)
  assert.equal(g.line, '5 done · 4 decisions')
})

test('a 40-node flow still draws at most 7 shapes', () => {
  const statuses = ['done', 'todo', 'blocked', 'doing', 'done']
  const nodes = Array.from({ length: 40 }, (_, i) => (i % 3 === 2 ? ask(`q${i}`, i % 2 ? 'yes' : null) : step(`s${i}`, statuses[i % 5])))
  const g = plain(P.graph(flowOf(nodes)))
  assert.ok(g.nodes.length <= 7, `${g.nodes.length} shapes`)
  assert.ok(g.nodes.some(n => /steps and \d+ decisions/.test(n.label)))
  assert.equal(new Set(g.nodes.map(n => n.id)).size, g.nodes.length)
})

// ═══ the journey: a long run of done steps with nothing to break it up shows its stages ═══

test('13 done and 5 left with no asks: the done run is split into 4 stages, then the dashed box, joined in order', () => {
  const nodes = [...Array.from({ length: 13 }, (_, i) => step(`d${i + 1}`, 'done', `Stage step number ${i + 1} of the work`)), ...Array.from({ length: 5 }, (_, i) => step(`t${i + 1}`, 'todo'))]
  const g = plain(P.graph(flowOf(nodes)))
  const done = g.nodes.filter(n => /dg-done/.test(n.cls))
  assert.equal(done.length, 4, 'four stages, not one box of 13')
  assert.deepEqual(done.map(n => n.sub), ['+3 more', '+2 more', '+2 more', '+2 more'], 'even chunks: 4, 3, 3, 3')
  assert.deepEqual(done.map(n => n.goto), ['d1', 'd5', 'd8', 'd11'], 'each opens its first step')
  assert.ok(done.every(n => n.label.startsWith('Stage step number')), 'labelled by the first step of the stage')
  assert.deepEqual(g.nodes.at(-1).label, '5 left')
  assert.equal(g.nodes.length, 5)
  assert.deepEqual(g.edges.map(e => [e.from, e.to]), [['s1', 's2'], ['s2', 's3'], ['s3', 's4'], ['s4', 's5']])
  assert.equal(g.line, '13 done · 5 left')
})

test('3 done steps stay one box, as before; and the split never takes the chart past 7 shapes', () => {
  const three = plain(P.graph(flowOf([step('a', 'done'), step('b', 'done'), step('c', 'done')])))
  assert.equal(three.nodes.length, 1)
  assert.equal(three.nodes[0].sub, '+2 more')
  const withAsks = plain(P.graph(flowOf([...Array.from({ length: 8 }, (_, i) => step(`d${i}`, 'done')), ask('q1', 'yes'), step('x', 'todo')])))
  assert.ok(withAsks.nodes.length <= 7, `${withAsks.nodes.length}`)
  assert.ok(withAsks.nodes.length >= 4)
})

test('an empty flow is one dashed box saying so, and no line', () => {
  const g = plain(P.graph({ id: 'x', nodes: [] }))
  assert.deepEqual(g.nodes.map(n => n.label), ['No steps yet'])
  assert.equal(g.nodes[0].goto, undefined)
  assert.equal(g.line, '')
})

test('a title is cut after a whole word, never on a small word: the same cutter as the server story (clip, in step)', () => {
  const table = [
    ['one two three four five six seven', 20], ['  one   two  ', 34], ['Turn on the new schedule in the dev cluster', 30],
    ['Move the nightly report job to the new scheduler', 34], ['Supercalifragilisticexpialidocious', 12], ['Use the staging mail relay please', 18],
    ['Ship it, then tell the team.', 15], ['', 10], ['short', 90], ['Run both schedulers side by side for a week', 34],
  ]
  for (const [text, max] of table) assert.equal(P.clip(text, max), clip(text, max), `${text} @ ${max}`)
  assert.equal(P.clip('Turn on the new schedule in the dev cluster', 30), 'Turn on the new schedule…')
  assert.equal(P.clip('  one   two  ', 34), 'one two')
})
