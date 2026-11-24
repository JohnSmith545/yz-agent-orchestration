// Tests for human.mjs: what waits on the user, and why, as one list (asks, by-hand work, blocked flows, and tickets
// marked no-code or not-codebase), newest first, each with one plain reason. Pure: built from plain objects.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { humanItems, HUMAN_MARKS, DONE_STATES } = await import('../human.mjs')

const flow = (id, over = {}) => ({ id, title: `Flow ${id}`, agent: 'Agent 1', status: 'open', tickets: [], nodes: [], updatedAt: '2026-11-20T10:00:00Z', ...over })
const ask = (id, over = {}) => ({ id, type: 'ask', title: `Question ${id}?`, kind: 'yesno', yes: 'Go', no: 'Stop', answer: null, after: [], ...over })
const keys = r => r.items.map(i => i.key)

test('an open ask is a row: the flow, its agent, when it was asked, its reason, and what the ask controls need', () => {
  const f = flow('dark', { nodes: [ask('n1', { at: '2026-11-21T09:00:00Z' })], derived: { waiting: ['n1'], reasons: { n1: { text: 'The test passes; dev is where QA can try it', auto: false } } } })
  const r = humanItems({ flows: [f] })
  assert.deepEqual(r.items, [{
    key: 'ask:dark:n1', kind: 'ask', flowId: 'dark', title: 'Flow dark', agent: 'Agent 1', tickets: [], nodeId: 'n1', since: '2026-11-21T09:00:00Z',
    reason: 'The test passes; dev is where QA can try it', ask: { title: 'Question n1?', kind: 'yesno', yes: 'Go', no: 'Stop' },
  }])
  assert.deepEqual(r.counts, { total: 1, ask: 1, hand: 0, blocked: 0, ticket: 0 })
})

test('an answered ask, a dropped, archived, deleted or done flow is not waiting on anyone', () => {
  const answered = flow('a', { nodes: [ask('n1', { answer: 'yes' })] })
  const flows = [answered, ...['dropped', 'done'].map(s => flow(`s-${s}`, { status: s, nodes: [ask('n1')] })),
    flow('arch', { nodes: [ask('n1')], archivedAt: '2026-11-20T10:00:00Z' }), flow('del', { nodes: [ask('n1')], deletedAt: '2026-11-20T10:00:00Z' })]
  assert.deepEqual(keys(humanItems({ flows })), [])
})

test('by-hand steps: one row per unfinished flow with its progress and the next step; all ticked says mark it done', () => {
  const steps = [{ id: 'h1', do: 'Add the secret', expect: 'Listed', at: '2026-11-22T08:00:00Z', done: { by: 'you', at: 'x' } }, { id: 'h2', do: 'Run the workflow once', expect: 'Green', at: '2026-11-22T08:01:00Z', done: null }]
  const r = humanItems({ flows: [flow('ci', { hand: { steps } })] })
  assert.equal(r.items.length, 1)
  assert.deepEqual({ ...r.items[0] }, { key: 'hand:ci', kind: 'hand', flowId: 'ci', title: 'Flow ci', agent: 'Agent 1', tickets: [], since: '2026-11-22T08:01:00Z', reason: '1 of 2 done. Next: Run the workflow once', progress: { done: 1, total: 2 } })
  const all = steps.map(s => ({ ...s, done: { by: 'you', at: 'x' } }))
  assert.equal(humanItems({ flows: [flow('ci', { hand: { steps: all } })] }).items[0].reason, 'All 2 steps are done by you: mark the flow done.')
  assert.deepEqual(keys(humanItems({ flows: [flow('ci', { status: 'done', hand: { steps } })] })), [], 'a finished flow is not waiting')
})

test('an open flow for a ticket marked no-code or not-codebase is by-hand work even with no steps yet, and its ticket is not a second row', () => {
  const marks = { 'FLA-815': { review: 'not-codebase', at: '2026-11-01T00:00:00Z', by: 'Coordinator' } }
  const r = humanItems({ flows: [flow('env', { tickets: ['FLA-815'] })], marks, tickets: new Map([['FLA-815', { title: 'CI/CD: Production environment variables set', state: 'Unstarted' }]]) })
  assert.deepEqual(keys(r), ['hand:env'])
  assert.equal(r.items[0].reason, 'Work only you can do (FLA-815), with no steps yet: ask the agent for them.')
  const asked = humanItems({ flows: [flow('env', { tickets: ['FLA-815'], hand: { steps: [], requestedAt: '2026-11-23T00:00:00Z' } })], marks })
  assert.equal(asked.items[0].reason, 'Steps asked for: waiting on the agent to write them.')
  assert.equal(asked.items[0].since, '2026-11-23T00:00:00Z')
  const failed = humanItems({ flows: [flow('env', { hand: { steps: [], requestedAt: '2026-11-23T00:00:00Z', requestError: 'FAILED' } })] })
  assert.equal(failed.items[0].reason, 'Steps asked for, but the request was not sent: ask again.')
})

test('a blocked flow is a row with its first blocked step; an open ask or by-hand work stands for it instead', () => {
  const blocked = flow('b', { status: 'blocked', nodes: [{ id: 'n1', type: 'step', title: 'Deploy to stage', status: 'blocked' }] })
  assert.deepEqual(humanItems({ flows: [blocked] }).items.map(i => [i.kind, i.reason]), [['blocked', 'Blocked at: Deploy to stage']])
  assert.equal(humanItems({ flows: [flow('c', { status: 'blocked', why: 'Waiting on the cloud account.' })] }).items[0].reason, 'Blocked. Waiting on the cloud account.')
  assert.equal(humanItems({ flows: [flow('c', { status: 'blocked' })] }).items[0].reason, 'The agent marked this flow blocked.')
  assert.deepEqual(keys(humanItems({ flows: [{ ...blocked, nodes: [...blocked.nodes, ask('n2')] }] })), ['ask:b:n2'])
  assert.deepEqual(keys(humanItems({ flows: [{ ...blocked, hand: { steps: [{ id: 'h1', do: 'x', expect: 'y', done: null }] } }] })), ['hand:b'])
})

test('a ticket marked no-code or not-codebase that is not finished and no live flow carries is a row: its title, who marked it, the note', () => {
  const marks = {
    'FLA-820': { review: 'not-codebase', at: '2026-11-10T00:00:00Z', by: 'Coordinator', note: 'Link the billing account in the cloud console.' },
    'FLA-806': { review: 'no-code', at: '2026-11-12T00:00:00Z', by: 'you' },
    'FLA-900': { review: 'not-codebase', at: '2026-11-12T00:00:00Z', by: 'you' },
    'FLA-1': { review: 'reviewed', at: '2026-11-12T00:00:00Z' },
    'FLA-2': { review: 'needs-review', at: '2026-11-12T00:00:00Z' },
  }
  const tickets = new Map([['FLA-820', { title: 'Cloud Hosting: Billing account linked', state: 'Unstarted' }], ['FLA-806', { title: 'CI/CD: Test step passes', state: 'Started' }], ['FLA-900', { title: 'Done already', state: 'Accepted' }]])
  const r = humanItems({ marks, tickets })
  assert.deepEqual(r.items.map(i => [i.key, i.title, i.agent, i.reason]), [
    ['ticket:FLA-806', 'CI/CD: Test step passes', '', 'Marked no code yet: it needs a decision or work from you before an agent can build it.'],
    ['ticket:FLA-820', 'Cloud Hosting: Billing account linked', 'Coordinator', 'Link the billing account in the cloud console.'],
  ])
  assert.equal(humanItems({ marks: { 'FLA-7': { review: 'no-code', at: 'x' } } }).items[0].title, 'FLA-7', 'a ticket no source knows shows its id')
  assert.deepEqual(keys(humanItems({ marks, tickets, flows: [flow('done-one', { status: 'done', tickets: ['FLA-820'] })] })), ['ticket:FLA-806'], 'a finished flow covers its ticket')
  assert.deepEqual([...HUMAN_MARKS], ['no-code', 'not-codebase'])
  assert.ok(DONE_STATES.includes('Accepted'))
})

test('newest first by when it started waiting; a long reason is cut to one line at a word', () => {
  const flows = [
    flow('old', { nodes: [ask('n1', { at: '2026-11-01T00:00:00Z', why: 'w'.repeat(10) + ' ' + 'word '.repeat(40) })] }),
    flow('new', { nodes: [ask('n1', { at: '2026-11-24T00:00:00Z' })] }),
  ]
  const r = humanItems({ flows, marks: { 'FLA-3': { review: 'no-code', at: '2026-11-10T00:00:00Z' } } })
  assert.deepEqual(keys(r), ['ask:new:n1', 'ticket:FLA-3', 'ask:old:n1'])
  const why = r.items[2].reason
  assert.ok(why.length <= 140 && why.endsWith('…') && !/\s…$/.test(why), why)
  assert.equal(r.items[1].reason.includes('\n'), false)
})

test('nothing in, nothing out: an empty list with zero counts', () => {
  assert.deepEqual(humanItems(), { items: [], counts: { total: 0, ask: 0, hand: 0, blocked: 0, ticket: 0 } })
  assert.deepEqual(humanItems({ flows: [null, undefined], marks: null }).items, [])
})
