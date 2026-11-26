// Tests for the two small hooks Learn adds to the agent rules (agent-rules.mjs, agent-rules-routes.mjs):
// - a save can be MARKED (`by: 'learn'` for an accepted Learn proposal, `by: 'revert'` for a Revert on the Learn
//   page): the change log keeps the mark and the agent's Changes list says it in words;
// - EVERY save that changed something is told to the rule-change listeners, the user's own typed edit included, with
//   the agent's entry before and after (learn-verdicts.mjs records its baseline there). A listener that throws never
//   fails the save. Temp files only: FACTORY_DATA_DIR points at a temp folder BEFORE the imports.

import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-rules-hook-test-'))
process.env.FACTORY_DATA_DIR = TMP
const { changeSentence, readLog } = await import('../agent-rules.mjs')
const { onRuleChange, rulesPut } = await import('../agent-rules-routes.mjs')
const { DEFAULT_PIPELINE } = await import('../pipeline.mjs')
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const CFG = { coordinator: 'Master', coordinatorLabel: 'Master', codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1' }, pipeline: { ...DEFAULT_PIPELINE }, factory: { chat: { name: 'Independent' } } }
const PORT = 4999
const OWN = { origin: `http://127.0.0.1:${PORT}` }
let file
let logFile
let n = 0
const deps = (over = {}) => ({ config: CFG, file, logFile, port: PORT, now: () => `2026-11-24T10:00:0${n++ % 10}.000Z`, newId: () => `r${n}`, ...over })

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(TMP, 'f-'))
  file = path.join(dir, 'agent-rules.json')
  logFile = path.join(dir, 'agent-rules-log.jsonl')
})

test('a save marked by Learn keeps the mark on its log line, and the Changes list says so', () => {
  const r = rulesPut('Agent 1', { rules: ['Test every limit.'] }, OWN, deps({ by: 'learn', onChange: () => {} }))
  assert.equal(r.status, 200)
  const [line] = readLog(logFile)
  assert.equal(line.by, 'learn')
  assert.equal(r.body.changes[0].text, 'Agent 1 got 1 new rule. From Learn.')
  assert.equal(changeSentence({ label: 'QA', spec: null, added: [], removed: ['x'], by: 'revert' }), '1 rule was removed from QA. Reverted on the Learn page.')
})

test('an unmarked save, or one with an unknown mark, is the user own: no mark kept', () => {
  rulesPut('Agent 1', { rules: ['One.'] }, OWN, deps({ onChange: () => {} }))
  rulesPut('Agent 1', { rules: ['One.', 'Two.'] }, OWN, deps({ by: 'agent', onChange: () => {} }))
  assert.deepEqual(readLog(logFile).map(l => l.by), [undefined, undefined])
  fs.appendFileSync(logFile, JSON.stringify({ at: '2026-11-24T11:00:00.000Z', label: 'QA', spec: null, added: ['x'], removed: [], by: 'someone' }) + '\n')
  assert.equal(readLog(logFile).at(-1).by, undefined) // a hand-made mark is not trusted
})

test('every save that changed something is told, with the entry before and after; a save that changed nothing is not', () => {
  const heard = []
  const onChange = e => heard.push(e)
  rulesPut('Agent 1', { spec: 'Builds the web.', rules: ['One.'] }, OWN, deps({ onChange }))
  rulesPut('Agent 1', { rules: ['One.'] }, OWN, deps({ onChange })) // the same: nothing changed
  rulesPut('Agent 1', { rules: ['Two.'] }, OWN, deps({ onChange }))
  assert.equal(heard.length, 2)
  assert.deepEqual(heard[1].line.added, ['Two.'])
  assert.deepEqual(heard[1].line.removed, ['One.'])
  assert.deepEqual(heard[1].before.rules.map(r => r.text), ['One.'])
  assert.deepEqual(heard[1].after.rules.map(r => r.text), ['Two.'])
  assert.equal(heard[1].before.spec, 'Builds the web.')
})

test('a refused save tells nobody', () => {
  const heard = []
  assert.equal(rulesPut('Agent 1', { rules: ['x'.repeat(301)] }, OWN, deps({ onChange: e => heard.push(e) })).status, 400)
  assert.equal(rulesPut('Agent 1', { rules: ['ok'] }, {}, deps({ onChange: e => heard.push(e) })).status, 403)
  assert.equal(heard.length, 0)
})

test('the default listeners: one registered with onRuleChange hears a save; one that throws never fails it', () => {
  const heard = []
  const off1 = onRuleChange(() => {
    throw new Error('boom')
  })
  const off2 = onRuleChange(e => heard.push(e.line.label))
  const quiet = console.error
  console.error = () => {}
  try {
    const r = rulesPut('Agent 1', { rules: ['Kept.'] }, OWN, deps())
    assert.equal(r.status, 200)
  } finally {
    console.error = quiet
    off1()
    off2()
  }
  assert.deepEqual(heard, ['Agent 1'])
  rulesPut('Agent 1', { rules: ['Kept.', 'More.'] }, OWN, deps())
  assert.deepEqual(heard, ['Agent 1'], 'unsubscribed')
})
