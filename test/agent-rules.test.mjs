// Tests for agent-rules.mjs: the user's specification and rules for each agent (data/agent-rules.json). The
// validator and the merge are pure; reads and writes take the file as an argument, so every test works in its own
// temp folder. FACTORY_DATA_DIR points at a fresh temp folder BEFORE the import all the same, so the default file
// is never the real one.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rules-test-'))
const R = await import('../agent-rules.mjs')
const { pipelineGraph, DEFAULT_PIPELINE } = await import('../pipeline.mjs')
after(() => fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true }))

const CONFIG = {
  coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', 'Agent 2': 'Agent 2' },
  pipeline: { ...DEFAULT_PIPELINE }, factory: { chat: { name: 'Independent' } },
}
const graph = pipelineGraph(CONFIG)
const AT = '2026-11-24T10:00:00.000Z'
let n = 0
const deps = () => ({ now: () => AT, newId: () => `r${++n}` })
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rules-file-')), 'agent-rules.json')

test('the default file lives in the data folder that FACTORY_DATA_DIR moves', () => {
  assert.equal(R.RULES_FILE, path.join(process.env.FACTORY_DATA_DIR, 'agent-rules.json'))
})

test('the limits: a specification of 2,000 characters, a rule of 1 to 300, 30 rules', () => {
  assert.deepEqual({ ...R.RULE_LIMITS }, { spec: 2000, rule: 300, rules: 30 })
})

test('the agents of a graph are the coordinator, the producers, the chat agent and QA, never Request, Push or Output', () => {
  assert.deepEqual(R.agentLabels(graph), ['Master', 'Agent 1', 'Agent 2', 'Independent', 'QA'])
})

test('a missing file reads as empty; a broken one too', () => {
  const file = tmpFile()
  assert.deepEqual(R.readRules(file), { agents: {} })
  fs.writeFileSync(file, '{ not json')
  assert.deepEqual(R.readRules(file), { agents: {} })
  fs.writeFileSync(file, '[1, 2]')
  assert.deepEqual(R.readRules(file), { agents: {} })
})

test('a hand-edited file keeps only what is well formed', () => {
  const file = tmpFile()
  fs.writeFileSync(file, JSON.stringify({ agents: {
    'Agent 1': { spec: 'Builds pages.', rules: [{ id: 'a', text: 'Be kind.', addedAt: AT }, { id: 7 }, 'loose', { id: 'b', text: '   ' }], updatedAt: AT },
    'Agent 2': 'nope',
  } }))
  const s = R.readRules(file)
  assert.deepEqual(Object.keys(s.agents), ['Agent 1'])
  assert.deepEqual(s.agents['Agent 1'].rules, [{ id: 'a', text: 'Be kind.', addedAt: AT }])
})

test('write then read gives the store back, and the write is whole (no temp file left)', () => {
  const file = tmpFile()
  const store = { agents: { QA: { spec: 'Tests.', rules: [{ id: 'r1', text: 'Use Playwright.', addedAt: AT }], updatedAt: AT } } }
  R.writeRules(store, file)
  assert.deepEqual(R.readRules(file), store)
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['agent-rules.json'])
})

test('checkChange: what is given is cleaned; nothing given is refused in a plain sentence', () => {
  assert.deepEqual(R.checkChange({ spec: '  Builds the web pages.\r\nOnly web.  ' }), { spec: 'Builds the web pages.\nOnly web.' })
  assert.deepEqual(R.checkChange({ rules: ['  Never   touch\nmobile. ', 'Run tests.'] }), { rules: ['Never touch mobile.', 'Run tests.'] })
  assert.deepEqual(R.checkChange({ spec: '' }), { spec: '' })
  assert.match(R.checkChange({}).error, /^Nothing to save/)
  assert.match(R.checkChange(null).error, /^Nothing to save/)
})

test('checkChange: each limit is a plain sentence', () => {
  assert.match(R.checkChange({ spec: 'x'.repeat(2001) }).error, /specification is too long.*2,000/)
  assert.equal(R.checkChange({ spec: 'x'.repeat(2000) }).error, undefined)
  assert.match(R.checkChange({ rules: ['ok', '  '] }).error, /Rule 2 is empty/)
  assert.match(R.checkChange({ rules: ['ok', 'x'.repeat(301)] }).error, /Rule 2 is too long.*300/)
  assert.equal(R.checkChange({ rules: ['x'.repeat(300)] }).error, undefined)
  assert.match(R.checkChange({ rules: Array.from({ length: 31 }, (_, i) => `r${i}`) }).error, /too many rules.*30/)
  assert.equal(R.checkChange({ rules: Array.from({ length: 30 }, (_, i) => `r${i}`) }).error, undefined)
  assert.match(R.checkChange({ spec: 5 }).error, /specification must be text/)
  assert.match(R.checkChange({ rules: 'one' }).error, /rules must be a list/)
  assert.match(R.checkChange({ rules: [1] }).error, /rules must be a list/)
  for (const e of [R.checkChange({ spec: 'x'.repeat(2001) }).error, R.checkChange({ rules: [''] }).error]) assert.doesNotMatch(e, /—/)
})

test('applyChange replaces only what is given and stamps the time', () => {
  let s = R.applyChange({ agents: {} }, 'Agent 1', { spec: 'Builds pages.' }, deps())
  assert.deepEqual(s.agents['Agent 1'], { spec: 'Builds pages.', rules: [], updatedAt: AT })
  s = R.applyChange(s, 'Agent 1', { rules: ['One.'] }, deps())
  assert.equal(s.agents['Agent 1'].spec, 'Builds pages.', 'the spec stays when only rules are sent')
  assert.equal(s.agents['Agent 1'].rules[0].text, 'One.')
})

test('applyChange keeps the id and time of each rule whose text did not change; a new or changed one gets new ones', () => {
  const old = { agents: { 'Agent 1': { spec: '', updatedAt: AT, rules: [
    { id: 'keep', text: 'Same.', addedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'gone', text: 'Old.', addedAt: '2026-01-01T00:00:00.000Z' },
  ] } } }
  const s = R.applyChange(old, 'Agent 1', { rules: ['New.', 'Same.'] }, { now: () => AT, newId: () => 'fresh' })
  assert.deepEqual(s.agents['Agent 1'].rules, [
    { id: 'fresh', text: 'New.', addedAt: AT },
    { id: 'keep', text: 'Same.', addedAt: '2026-01-01T00:00:00.000Z' },
  ])
  assert.equal(old.agents['Agent 1'].rules.length, 2, 'the store passed in is not changed')
})

test('two rules with the same text each keep one old id, never the same one twice', () => {
  const old = { agents: { QA: { spec: '', updatedAt: AT, rules: [{ id: 'a', text: 'Twice.', addedAt: AT }] } } }
  let k = 0
  const s = R.applyChange(old, 'QA', { rules: ['Twice.', 'Twice.'] }, { now: () => AT, newId: () => `n${++k}` })
  assert.deepEqual(s.agents.QA.rules.map(r => r.id), ['a', 'n1'])
})

test('rulesView: every agent in the graph, empty when nothing is saved; a label no longer in the graph is kept but not shown', () => {
  const store = { agents: { 'Agent 1': { spec: 'Pages.', rules: [], updatedAt: AT }, Gone: { spec: 'Old.', rules: [], updatedAt: AT } } }
  const v = R.rulesView(store, graph)
  assert.deepEqual(Object.keys(v.agents), ['Master', 'Agent 1', 'Agent 2', 'Independent', 'QA'])
  assert.deepEqual(v.agents.Master, { spec: '', rules: [], updatedAt: null })
  assert.equal(v.agents['Agent 1'].spec, 'Pages.')
  assert.equal(v.agents.Gone, undefined)
  assert.ok(store.agents.Gone, 'still in the store')
})

test('rulesBlock: the text an agent is shown, or empty when it has nothing', () => {
  const store = { agents: { 'Agent 1': { spec: 'Builds the web pages.', rules: [{ id: 'a', text: 'Never touch the mobile app.', addedAt: AT }, { id: 'b', text: 'Run the tests before you say done.', addedAt: AT }], updatedAt: AT } } }
  assert.equal(R.rulesBlock(store, 'Agent 1'), [
    'Rules for Agent 1, set by the user on the dashboard. Follow them:',
    'Specification: Builds the web pages.',
    '1. Never touch the mobile app.',
    '2. Run the tests before you say done.',
  ].join('\n'))
  assert.equal(R.rulesBlock(store, 'Agent 2'), '')
  assert.equal(R.rulesBlock({ agents: { QA: { spec: '', rules: [{ id: 'a', text: 'Only one.', addedAt: AT }], updatedAt: AT } } }, 'QA'),
    'Rules for QA, set by the user on the dashboard. Follow them:\n1. Only one.')
})

test('rulesText: every agent of the graph that has something, in graph order, blank line between; empty when nothing is set', () => {
  assert.equal(R.rulesText({ agents: {} }, graph), '')
  const store = { agents: {
    QA: { spec: 'Tests.', rules: [], updatedAt: AT },
    Master: { spec: '', rules: [{ id: 'a', text: 'Plan first.', addedAt: AT }], updatedAt: AT },
    Gone: { spec: 'Not shown.', rules: [], updatedAt: AT },
  } }
  const text = R.rulesText(store, graph)
  assert.equal(text, 'Rules for Master, set by the user on the dashboard. Follow them:\n1. Plan first.\n\n' +
    'Rules for QA, set by the user on the dashboard. Follow them:\nSpecification: Tests.')
  assert.equal(R.rulesText(null, graph), '')
})

// ═══ the change log (agent-rules-log.jsonl) ═══

test('the log file lives beside the store, and keeps the newest 500 lines', () => {
  assert.equal(R.RULES_LOG, path.join(process.env.FACTORY_DATA_DIR, 'agent-rules-log.jsonl'))
  assert.equal(R.LOG_KEEP, 500)
})

const entryOf = (spec, ...rules) => ({ spec, rules: rules.map((text, i) => ({ id: `r${i}`, text, addedAt: AT })), updatedAt: AT })

test('diffEntries: what a save changed, or null when it changed nothing', () => {
  const none = { spec: '', rules: [], updatedAt: null }
  assert.deepEqual(R.diffEntries(none, entryOf('Pages.', 'A', 'B')), { spec: 'set', added: ['A', 'B'], removed: [] })
  assert.deepEqual(R.diffEntries(entryOf('Pages.', 'A', 'B'), entryOf('Pages and docs.', 'B', 'C')), { spec: 'changed', added: ['C'], removed: ['A'] })
  assert.deepEqual(R.diffEntries(entryOf('Pages.', 'A'), entryOf('', 'A')), { spec: 'cleared', added: [], removed: [] })
  assert.equal(R.diffEntries(entryOf('Pages.', 'A', 'B'), entryOf('Pages.', 'A', 'B')), null)
  assert.equal(R.diffEntries(entryOf('Pages.', 'A', 'B'), entryOf('Pages.', 'B', 'A')), null, 'a new order only is no change')
  assert.deepEqual(R.diffEntries(entryOf('', 'A'), entryOf('', 'A', 'A')), { spec: null, added: ['A'], removed: [] }, 'a second copy is an added rule')
  assert.equal(R.diffEntries(null, none), null)
})

test('appendLog adds one JSON line and readLog reads them back; a broken line is skipped', () => {
  const file = tmpFile().replace('agent-rules.json', 'agent-rules-log.jsonl')
  assert.deepEqual(R.readLog(file), [], 'no file: no lines')
  assert.equal(R.appendLog({ at: AT, label: 'QA', spec: null, added: ['A'], removed: [] }, file), true)
  fs.appendFileSync(file, '{ torn\n"just a string"\n')
  R.appendLog({ at: AT, label: 'Agent 1', spec: 'set', added: [], removed: [] }, file)
  assert.deepEqual(R.readLog(file).map(l => l.label), ['QA', 'Agent 1'])
})

test('appendLog keeps only the newest lines past the cap', () => {
  const file = tmpFile().replace('agent-rules.json', 'agent-rules-log.jsonl')
  for (let i = 0; i < 8; i++) R.appendLog({ at: AT, label: `A${i}`, spec: null, added: ['x'], removed: [] }, file, 5)
  assert.deepEqual(R.readLog(file).map(l => l.label), ['A3', 'A4', 'A5', 'A6', 'A7'])
})

test('appendLog never throws: a log that cannot be written is said on stderr and the save stands', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rules-log-dir-'))
  const errors = []
  const saved = console.error
  console.error = m => errors.push(m)
  try {
    assert.equal(R.appendLog({ at: AT, label: 'QA', spec: null, added: ['A'], removed: [] }, dir), false, 'a folder is no file')
  } finally {
    console.error = saved
  }
  assert.equal(errors.length, 1)
})

test('changeSentence: one plain sentence per change', () => {
  const s = (spec, added = [], removed = [], label = 'Agent 1') => R.changeSentence({ at: AT, label, spec, added, removed })
  assert.equal(s('changed', ['a', 'b']), 'Agent 1 got 2 new rules and its specification changed.')
  assert.equal(s(null, [], ['a'], 'QA'), '1 rule was removed from QA.')
  assert.equal(s(null, [], ['a', 'b'], 'QA'), '2 rules were removed from QA.')
  assert.equal(s(null, ['a']), 'Agent 1 got 1 new rule.')
  assert.equal(s(null, ['a'], ['b']), 'Agent 1 got 1 new rule and lost 1 rule.')
  assert.equal(s('set'), 'Agent 1 got a specification.')
  assert.equal(s('changed'), 'The specification of Agent 1 changed.')
  assert.equal(s('cleared'), 'The specification of Agent 1 was cleared.')
  assert.equal(s('set', ['a'], ['b', 'c']), 'Agent 1 got 1 new rule, lost 2 rules and its specification was set.')
  for (const t of [s('changed', ['a']), s(null, [], ['a'])]) assert.doesNotMatch(t, /—/)
})

test('ruleEvents: the lines of the last days as events, newest first, in the exact shape', () => {
  const now = Date.parse('2026-11-24T12:00:00.000Z')
  const lines = [
    { at: '2026-11-10T09:00:00.000Z', label: 'QA', spec: 'set', added: [], removed: [] }, // too old for 7 days
    { at: '2026-11-23T09:00:00.000Z', label: 'Agent 1', spec: 'changed', added: ['a', 'b'], removed: [] },
    { at: '2026-11-24T09:00:00.000Z', label: 'QA', spec: null, added: [], removed: ['x'] },
    { at: 'not a time', label: 'QA', spec: null, added: ['y'], removed: [] },
  ]
  assert.deepEqual(R.ruleEvents(lines, { now, days: 7 }), [
    { at: '2026-11-24T09:00:00.000Z', kind: 'rule', agent: 'QA', flow: null, cell: null, text: '1 rule was removed from QA.' },
    { at: '2026-11-23T09:00:00.000Z', kind: 'rule', agent: 'Agent 1', flow: null, cell: null, text: 'Agent 1 got 2 new rules and its specification changed.' },
  ])
  assert.equal(R.ruleEvents(lines, { now, days: 30 }).length, 3)
  assert.deepEqual(R.ruleEvents(null, { now }), [])
})

test('changesOf: one agent last changes, newest first, as { at, text }, at most n', () => {
  const lines = Array.from({ length: 12 }, (_, i) => ({ at: `2026-11-${String(10 + i).padStart(2, '0')}T09:00:00.000Z`, label: i % 2 ? 'QA' : 'Agent 1', spec: null, added: ['a'], removed: [] }))
  const qa = R.changesOf(lines, 'QA', 3)
  assert.deepEqual(qa.map(c => c.at), ['2026-11-21T09:00:00.000Z', '2026-11-19T09:00:00.000Z', '2026-11-17T09:00:00.000Z'])
  assert.equal(qa[0].text, 'QA got 1 new rule.')
  assert.equal(R.changesOf(lines, 'QA').length, 6, 'ten by default, all six here')
})
