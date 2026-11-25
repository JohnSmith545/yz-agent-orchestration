// Tests for what the user sees of Senior around their by-hand work: the flow's checklist (public/flow-hand.js) shows
// Senior's verdict when it sent the work back, marks each step to do again, and says Senior reviews it next instead
// of offering Mark the flow done; Human review (human.mjs) says the same in its one line; and the server refuses to
// mark done a flow Senior gates until Senior passed it (flow-senior.mjs seniorHolds, factory-routes.mjs).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { DEFAULT_PIPELINE, pipelineGraph } from '../pipeline.mjs'
import { seniorHolds } from '../flow-senior.mjs'
import { humanItems } from '../human.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = f => fs.readFileSync(path.join(HERE, '..', f), 'utf8')
const window = { Shell: { ago: () => '3m' } }
vm.runInNewContext(read('public/flow-hand.js'), { window, CSS: { escape: s => s } })
const H = window.FlowHand
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

const G = pipelineGraph({ coordinatorLabel: 'Master', codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', Senior: 'Senior' }, pipeline: { ...DEFAULT_PIPELINE, senior: 'Senior' } })
const PLAIN = pipelineGraph({ coordinatorLabel: 'Master', codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1' }, pipeline: { ...DEFAULT_PIPELINE } })
const step = (id, done) => ({ id, do: `Do ${id}`, expect: 'ok', at: '2026-11-25T09:00:00Z', done: done ? { by: 'you', at: '2026-11-25T10:00:00Z' } : null })
const flow = (over = {}) => ({ id: 'keys', title: 'Rotate the keys', agent: 'Agent 1', status: 'open', tickets: [], nodes: [], updatedAt: '2026-11-25T10:00:00Z', hand: { steps: [step('h1', true), step('h2', true)] }, ...over })
const atSenior = [{ node: 'human', label: 'Human task', role: 'human', state: 'done', visits: 1 }, { node: 'senior', label: 'Senior', role: 'senior', state: 'current', visits: 1, status: 'waiting' }]
const sentBack = { status: 'failed', by: 'Senior', at: '2026-11-25T11:00:00Z', summary: 'The key was rotated in prod, not dev.', redo: ['h2'] }

test('the checklist: every step ticked and the flow at Senior says Senior reviews it next, with no Mark the flow done', () => {
  const h = H.html(flow({ progress: atSenior }))
  assert.match(h, /<span class="fh-next">Senior reviews it next: send Senior a message naming flow keys\.<\/span>/)
  assert.doesNotMatch(h, /data-hand-done/)
  assert.match(H.html(flow()), /data-hand-done>Mark the flow done</, 'no Senior: as before')
})

test('the checklist: Senior sent it back, so its verdict shows over the steps and each step to redo says Do again', () => {
  const f = flow({ hand: { steps: [step('h1', true), step('h2', false)] }, senior: sentBack })
  const h = H.html(f)
  assert.match(h, /<p class="fh-redo" role="note"><b>Senior sent this back\.<\/b> The key was rotated in prod, not dev\.<\/p><ol class="fh-steps">/)
  assert.match(text(h), /2 Do h2 Do again/)
  assert.doesNotMatch(text(h), /1 Do h1 Do again/, 'a step Senior did not name, or one done again, is not marked')
  assert.doesNotMatch(H.html(flow({ senior: { ...sentBack, summary: '<b>x</b>' } })), /<b>x<\/b>/, 'the verdict is escaped')
})

test('Human review: a flow Senior sent back says why; all ticked says Senior reviews it next; without Senior as before', () => {
  const back = humanItems({ flows: [flow({ hand: { steps: [step('h1', true), step('h2', false)] }, senior: sentBack })], senior: 'Senior' })
  assert.equal(back.items[0].reason, 'Senior sent it back: The key was rotated in prod, not dev.')
  assert.equal(humanItems({ flows: [flow()], senior: 'Senior' }).items[0].reason, 'All 2 steps are done by you: Senior reviews them next.')
  assert.equal(humanItems({ flows: [flow()] }).items[0].reason, 'All 2 steps are done by you: mark the flow done.')
  assert.equal(humanItems({ flows: [flow({ status: 'done', senior: { status: 'passed', by: 'Senior', at: '2026-11-25T12:00:00Z' } })], senior: 'Senior' }).items.length, 0, 'a finished flow waits on no one')
})

test('seniorHolds: done waits for a Senior pass on a flow it gates; nothing holds without Senior, without by-hand work, or on the QA path', () => {
  assert.match(seniorHolds(flow(), G), /^Senior reviews the work done by hand before the flow is done: send Senior a message naming flow keys\.$/)
  assert.match(seniorHolds(flow({ hand: undefined, senior: { status: 'asked', by: 'Agent 1', at: '2026-11-25T10:00:00Z' } }), G), /Senior reviews/)
  assert.equal(seniorHolds(flow({ senior: { status: 'passed', by: 'Senior', at: '2026-11-25T12:00:00Z' } }), G), '')
  assert.equal(seniorHolds(flow({ senior: { status: 'senior-failed', by: 'Senior', at: '2026-11-25T12:00:00Z' } }), G), '', 'stopped: the user decides')
  assert.equal(seniorHolds(flow(), PLAIN), '')
  assert.equal(seniorHolds(flow({ hand: undefined }), G), '', 'an answer with no by-hand work')
  assert.equal(seniorHolds(flow({ qa: { status: 'passed', attempt: 1 } }), G), '')
})

test('wired: the store asks seniorHolds before a move to done (test/senior-hold.test.mjs); Human review gets the Senior label', () => {
  assert.match(read('flows.mjs'), /recordHold\(flow, stored, graph\)\r?\n\s+if \(flow\.status === 'done' && before !== 'done'\) \{\r?\n\s+const held = seniorHolds\(flow, graph\)/)
  assert.match(read('human-routes.mjs'), /senior: gateLabels\(CONFIG\)\.senior/)
  assert.match(read('public/human.css'), /\.fh-redo \{/)
})
