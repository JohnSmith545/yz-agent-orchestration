// Tests for predict-state.mjs (dismissing an alert for the day, the worse-by-half rule, the log of alerts raised) and
// predict-signals.mjs (THE CONTRACT feat/smart-learn reads: alerts raised and estimate misses in a window).

import { after, afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// the store modules fix their data folder when first imported: a temp one, never the real data
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'predict-state-data-'))
const { pipelineGraph } = await import('../pipeline.mjs')
const { RAISED_MAX, WORSE, applyDismissals, dismissAlert, noteRaised, readAlertState, withDismissal, withRaised } = await import('../predict-state.mjs')
const { signalsFrom } = await import('../predict-signals.mjs')
const { localDay } = await import('../token-usage.mjs')

after(() => fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true }))

const HOUR = 3_600_000
const NOW = new Date(2026, 10, 25, 14, 0).getTime() // local 14:00, so the next local day is a sure 10 hours on
const DAY_NOW = localDay(NOW)
const alert = (key, measure, more = {}) => ({ key, kind: key.split(':')[0], text: `${key} text`, measure, ...more })

test('a dismissed alert is hidden for the rest of the day while it is no worse than half as large again', () => {
  const state = withDismissal({ day: null, dismissed: {}, raised: [] }, { key: 'stuck:a:qa', measure: 100, now: NOW })
  assert.equal(WORSE, 1.5)
  const at = m => applyDismissals([alert('stuck:a:qa', m), alert('spike:s1', 5)], state, NOW)
  assert.deepEqual(at(149).shown.map(a => a.key), ['spike:s1'])
  assert.equal(at(149).hidden, 1)
  assert.deepEqual(at(150).shown.map(a => a.key), ['stuck:a:qa', 'spike:s1'], 'half as large again: it comes back')
  assert.equal(at(150).shown[0].returned, true)
})

test('a dismissal lasts the day: the next local day every alert shows again', () => {
  const state = withDismissal({ day: null, dismissed: {}, raised: [] }, { key: 'stuck:a:qa', measure: 100, now: NOW })
  assert.equal(state.day, DAY_NOW)
  const tomorrow = NOW + 12 * HOUR
  assert.equal(applyDismissals([alert('stuck:a:qa', 100)], state, tomorrow).shown.length, 1)
  const fresh = withDismissal(state, { key: 'spike:s1', measure: 7, now: tomorrow })
  assert.deepEqual(Object.keys(fresh.dismissed), ['spike:s1'], 'yesterday s dismissals are gone')
})

test('the raised log notes each alert once a day, newest kept, and says when nothing new was raised', () => {
  const empty = { day: null, dismissed: {}, raised: [] }
  const once = withRaised(empty, [alert('stuck:a:qa', 1, { flow: 'a', agent: 'QA' })], NOW)
  assert.equal(once.raised.length, 1)
  assert.deepEqual(once.raised[0], { at: new Date(NOW).toISOString(), day: DAY_NOW, key: 'stuck:a:qa', kind: 'stuck', text: 'stuck:a:qa text', flow: 'a', agent: 'QA' })
  assert.equal(withRaised(once, [alert('stuck:a:qa', 9)], NOW + HOUR), null, 'the same alert again that day: nothing new')
  assert.equal(withRaised(once, [alert('stuck:a:qa', 9)], NOW + 12 * HOUR).raised.length, 2, 'the next day it is noted again')
  let big = empty
  for (let i = 0; i < RAISED_MAX + 3; i++) big = withRaised(big, [alert(`spike:s${i}`, 1)], NOW)
  assert.equal(big.raised.length, RAISED_MAX)
  assert.equal(big.raised.at(-1).key, `spike:s${RAISED_MAX + 2}`)
})

// ═══ the file ═══

let dir
let file
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'predict-state-test-'))
  file = path.join(dir, 'alerts-state.json')
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

test('the state file: missing or broken reads as empty; a dismissal and a raised alert are written atomically', () => {
  assert.deepEqual(readAlertState(file), { day: null, dismissed: {}, raised: [] })
  fs.writeFileSync(file, '{ broken')
  assert.deepEqual(readAlertState(file), { day: null, dismissed: {}, raised: [] })
  dismissAlert(file, { key: 'spike:s1', measure: 40, now: NOW })
  assert.equal(readAlertState(file).dismissed['spike:s1'].measure, 40)
  assert.equal(noteRaised(file, [alert('spike:s1', 40)], NOW), true)
  assert.equal(noteRaised(file, [alert('spike:s1', 40)], NOW), false, 'nothing new: no write')
  assert.equal(readAlertState(file).raised.length, 1)
  assert.equal(readAlertState(file).dismissed['spike:s1'].measure, 40, 'noting kept the dismissal')
  fs.writeFileSync(file, JSON.stringify({ day: 3, dismissed: 'x', raised: {} }))
  assert.deepEqual(readAlertState(file), { day: null, dismissed: {}, raised: [] }, 'a hand-edited file of the wrong shape is empty')
})

// ═══ the contract ═══

test('signals: the alerts raised since the time given and the estimate misses, as { kind, text, flow?, agent? }', () => {
  const graph = pipelineGraph({ coordinator: 'Master', coordinatorLabel: 'Master', codingAgents: { Master: 'Master' }, pipeline: { qa: 'QA' } })
  const start = NOW - 10 * HOUR
  const late = {
    id: 'late', title: 'Slow one', agent: 'Master', status: 'done', createdAt: new Date(start).toISOString(), updatedAt: new Date(start + 5 * HOUR).toISOString(), nodes: [],
    qa: { status: 'passed', attempt: 1, by: 'QA', startedAt: new Date(start + 4 * HOUR).toISOString(), at: new Date(start + 5 * HOUR).toISOString(), pushedAt: new Date(start + 5 * HOUR).toISOString() },
    estimate: { at: new Date(start).toISOString(), minutes: 60, usd: null, tokens: null, basedOn: ['a', 'b', 'c'], spread: { minutes: [30, 90], usd: null, tokens: null } },
  }
  const raised = [
    { at: new Date(NOW - 20 * HOUR).toISOString(), day: 'x', key: 'spike:old', kind: 'spike', text: 'old' },
    { at: new Date(NOW - HOUR).toISOString(), day: 'x', key: 'stuck:a:qa', kind: 'stuck', text: 'A was stuck', flow: 'a', agent: 'QA' },
  ]
  const list = signalsFrom({ raised, flows: [late], graph, since: NOW - 12 * HOUR, now: NOW })
  // oldest first: the flow finished 5 hours ago, the alert was raised 1 hour ago
  assert.deepEqual(list.map(s => s.kind), ['estimate-miss', 'stuck'])
  assert.deepEqual(list[1], { kind: 'stuck', text: 'A was stuck', flow: 'a', agent: 'QA' })
  assert.equal(list[0].flow, 'late')
  assert.equal(list[0].agent, 'Master')
  assert.match(list[0].text, /Slow one took 5 h/)
  assert.deepEqual(signalsFrom({ raised: [], flows: [], graph, since: NOW, now: NOW }), [])
})
