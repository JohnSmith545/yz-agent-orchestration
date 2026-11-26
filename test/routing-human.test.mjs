// Tests for ticket intake reaching Human review (human.mjs `kinds`) and for what intake stores
// (routing-intake-store.mjs): a ticket sorted as code leaves the Tickets list even when marked, one sorted no-code
// or needs-a-person joins it unmarked, a ticket with no kind keeps the mark's say; the user's corrections, the
// model's answers (never over the user's) and the remembered not-a-duplicate pairs. FACTORY_DATA_DIR first.

import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-human-test-'))
const { humanItems } = await import('../human.mjs')
const S = await import('../routing-intake-store.mjs')
const { STATE_FILE, readState } = await import('../factory-state.mjs')
const { pairKey } = await import('../routing-intake.mjs')
after(() => fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true }))
beforeEach(() => fs.rmSync(STATE_FILE, { force: true }))

const mark = review => ({ review, at: '2026-11-20T10:00:00Z', by: 'you' })
const tickets = new Map([['FLA-1', { title: 'Billing account linked', state: 'Unstarted' }], ['FLA-2', { title: 'Fix the crash', state: 'Unstarted' }], ['FLA-3', { title: 'DNS records', state: 'Unstarted' }], ['FLA-4', { title: 'Done one', state: 'Accepted' }], ['FLA-5', { title: 'Marked', state: 'Started' }]])
const ids = r => r.items.map(i => i.ticketId)

test('with no kinds the Tickets list is the marked tickets, as before', () => {
  const r = humanItems({ marks: { 'FLA-2': mark('no-code'), 'FLA-5': mark('not-codebase') }, tickets })
  assert.deepEqual(ids(r).sort(), ['FLA-2', 'FLA-5'])
  assert.equal(r.items[0].sorted, undefined)
})

test('a ticket sorted as code leaves the list even when marked; a ticket with no kind keeps its mark', () => {
  const r = humanItems({ marks: { 'FLA-2': mark('no-code'), 'FLA-5': mark('not-codebase') }, tickets, kinds: { 'FLA-2': 'code' } })
  assert.deepEqual(ids(r), ['FLA-5'])
})

test('a ticket sorted no-code or needs-a-person joins the list unmarked, with a plain reason; a finished one does not', () => {
  const r = humanItems({ marks: {}, tickets, kinds: { 'FLA-1': 'needs-a-person', 'FLA-3': 'no-code', 'FLA-4': 'no-code', 'FLA-9': 'no-code' } })
  assert.deepEqual(ids(r).sort(), ['FLA-1', 'FLA-3'])
  const one = r.items.find(i => i.ticketId === 'FLA-1')
  assert.equal(one.sorted, 'needs-a-person')
  assert.match(one.reason, /needing a person/)
  assert.equal(r.counts.ticket, 2)
})

test('a marked ticket sorted no-code is ONE row, the marked one; a live flow carrying it is that flow instead', () => {
  const r = humanItems({ marks: { 'FLA-3': mark('no-code') }, tickets, kinds: { 'FLA-3': 'no-code' } })
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].mark, 'no-code')
  const f = { id: 'dns', title: 'DNS', agent: 'Agent 1', status: 'open', tickets: ['FLA-3'], nodes: [], updatedAt: '2026-11-20T10:00:00Z' }
  assert.deepEqual(humanItems({ flows: [f], marks: {}, tickets, kinds: { 'FLA-3': 'no-code' } }).items.filter(i => i.kind === 'ticket'), [])
})

test('setKind: the user corrects a ticket and can take it off; a bad id or kind is refused in plain words', () => {
  S.setKind('FLA-2', 'no-code', { now: () => '2026-11-25T10:00:00.000Z' })
  assert.deepEqual(S.intakeState().intake['FLA-2'], { kind: 'no-code', reason: 'Set by you.', by: 'you', at: '2026-11-25T10:00:00.000Z' })
  S.setKind('FLA-2', null)
  assert.equal(S.intakeState().intake['FLA-2'], undefined)
  assert.throws(() => S.setKind('../x', 'code'), /ticket id/)
  assert.throws(() => S.setKind('FLA-2', 'maybe'), /Pick code/)
})

test('setModelKinds stores the model answers by model, never over the user, and keeps the marks', () => {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify({ marks: { 'FLA-1': mark('no-code') } }))
  S.setKind('FLA-2', 'code')
  const n = S.setModelKinds({ 'FLA-2': { kind: 'no-code', reason: 'x' }, 'FLA-3': { kind: 'no-code', reason: 'A DNS setting.' }, bad: { kind: 'code' }, 'FLA-4': { kind: 'poems' } }, '2026-11-25T11:00:00.000Z')
  assert.equal(n, 1)
  const st = readState()
  assert.equal(st.intake['FLA-2'].by, 'you')
  assert.deepEqual(st.intake['FLA-3'], { kind: 'no-code', reason: 'A DNS setting.', by: 'model', at: '2026-11-25T11:00:00.000Z' })
  assert.deepEqual(st.marks['FLA-1'].review, 'no-code', 'the review marks are untouched')
})

test('setNotDuplicate remembers the pair either way round; setTicketType stores the task type correction', () => {
  S.setNotDuplicate('FLA-9', 'FLA-3')
  assert.ok(S.intakeState().notDuplicate[pairKey('FLA-3', 'FLA-9')])
  assert.throws(() => S.setNotDuplicate('FLA-3', 'FLA-3'), /itself/)
  S.setTicketType('FLA-3', 'infra')
  assert.equal(S.intakeState().taskTypes['FLA-3'], 'infra')
  S.setTicketType('FLA-3', null)
  assert.equal(S.intakeState().taskTypes['FLA-3'], undefined)
  assert.throws(() => S.setTicketType('FLA-3', 'poems'), /task type/)
})

test('intakeTickets reads the collections, inside their filter only', () => {
  const dir = path.join(process.env.FACTORY_DATA_DIR, 'sources')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'c1.json'), JSON.stringify({ tickets: { 'FLA-1': { title: 'A', state: 'None', labels: ['x'], type: 'bug' }, 'FLA-50': { title: 'Out of range' }, 'FLA-99': { title: 'Extra' } } }))
  const list = S.intakeTickets([{ id: 'c1', filter: { prefix: 'FLA', range: [1, 10], extras: [99] } }, { id: 'missing' }])
  assert.deepEqual(list.map(t => t.id), ['FLA-1', 'FLA-99'])
  assert.deepEqual(list[0], { id: 'FLA-1', title: 'A', state: 'Unstarted', labels: ['x'], type: 'bug' })
})
