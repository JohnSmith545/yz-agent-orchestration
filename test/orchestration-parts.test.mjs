// Tests for orchestration-parts.mjs: what an orchestration "style" is made of (the parts), how one is read from
// a project and written to one, and what the bank shows of it (the graph, the summary, the agents with no
// session yet). Every file is a temp one: a temp config.json, a temp projects.json and temp data folders.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-parts-test-'))
process.env.FACTORY_DATA_DIR = ROOT
const O = await import('../orchestration-parts.mjs')
const R = await import('../agent-rules.mjs')
const S = await import('../agent-settings.mjs')
after(() => fs.rmSync(ROOT, { recursive: true, force: true }))

const CONFIG_TEXT = `{
  "repo": "C:/work/app",
  "port": 4317,
  "coordinator": "Master",
  "codingAgents": {
    "Master": "Master",
    "Agent 1": "Agent 1",
    "app-a9": "Agent 3"
  },
  "pinnedAgents": { "Agent 1": { "sessionId": "s1" } },
  "factory": { "me": "x", "chat": { "name": "Independent", "forkFrom": "sess", "model": "claude-opus-5-5" } },
  "pr": { "enabled": false }
}
`
let n = 0
/** A fresh world: a config.json, a projects.json with a primary and a second project, and their data folders. */
function world() {
  const dir = fs.mkdtempSync(path.join(ROOT, 'w-'))
  const configFile = path.join(dir, 'config.json')
  const projectsFile = path.join(dir, 'projects.json')
  fs.writeFileSync(configFile, CONFIG_TEXT)
  fs.writeFileSync(projectsFile, JSON.stringify({
    active: 'app',
    projects: [
      { id: 'app', name: 'App', primary: true, config: {} },
      { id: 'other', name: 'Other', config: { repo: 'C:/work/other', sessionCwdMatch: 'other', pinnedAgents: { X: {} } } },
    ],
  }))
  const opts = { root: dir, projectsFile, configFile }
  return {
    dir, configFile, projectsFile,
    primary: O.projectTarget({ id: 'app', name: 'App', primary: true }, opts),
    other: O.projectTarget({ id: 'other', name: 'Other' }, opts),
  }
}
const deps = { now: () => '2026-11-25T10:00:00.000Z', newId: () => `r${++n}` }
function seedRules(file, label, spec, rules) {
  const store = R.applyChange(R.readRules(file), label, { spec, rules }, deps)
  R.writeRules(store, file)
}

test('the parts that exist today: the agents and pipeline, the rules, then each agents model; each has a key, read and write', () => {
  assert.deepEqual(O.STYLE_PARTS.map(p => p.key), ['agents', 'rules', 'settings'])
  for (const p of O.STYLE_PARTS) {
    assert.equal(typeof p.read, 'function')
    assert.equal(typeof p.write, 'function')
  }
})

test('a target is one project: its data folder, its files, its config as it is on disk now', () => {
  const w = world()
  assert.equal(w.primary.dataDir, w.dir)
  assert.equal(w.other.dataDir, path.join(w.dir, 'projects', 'other'))
  assert.equal(w.other.file('agent-rules.json'), path.join(w.dir, 'projects', 'other', 'agent-rules.json'))
  assert.equal(w.primary.raw().repo, 'C:/work/app')
  assert.equal(w.other.raw().repo, 'C:/work/other')
  assert.equal(w.other.raw().coordinator, undefined) // nothing of the first project
})

test('the agents part copies the coordinator, the labels, the chat name and the pipeline, never sessions or pins', () => {
  const w = world()
  const style = O.takeSnapshot(w.primary)
  const a = style.parts.agents
  assert.equal(a.coordinator, 'Master')
  assert.equal(a.coordinatorLabel, 'Master')
  assert.deepEqual(a.codingAgents, { Master: 'Master', 'Agent 1': 'Agent 1', 'app-a9': 'Agent 3' })
  assert.equal(a.chatName, 'Independent')
  assert.deepEqual(a.pipeline, { qa: 'QA', producers: null, protectedBranches: ['dev', 'stage', 'main', 'master'], maxReworks: 3 }) // none set: the defaults, written out
  const text = JSON.stringify(style)
  for (const secret of ['C:/work/app', 's1', 'sess', 'pinnedAgents', 'forkFrom', '"me"']) assert.ok(!text.includes(secret), secret)
})

test('the pipeline block is copied WHOLE, with keys this dashboard does not know yet', () => {
  const w = world()
  fs.writeFileSync(w.configFile, CONFIG_TEXT.replace('"port": 4317,', '"port": 4317,\n  "pipeline": { "qa": "Tester", "planner": "Planner", "security": { "label": "Security" }, "maxReworks": 1 },'))
  const a = O.takeSnapshot(w.primary).parts.agents
  assert.deepEqual(a.pipeline, { qa: 'Tester', planner: 'Planner', security: { label: 'Security' }, maxReworks: 1 })
})

test('the rules part holds each agent of the graph with its specification and rule texts, nothing else', () => {
  const w = world()
  seedRules(w.primary.file('agent-rules.json'), 'Agent 1', 'Builds the web pages.', ['Never touch mobile.', 'Write the test first.'])
  seedRules(w.primary.file('agent-rules.json'), 'Gone', 'Not in the graph.', ['x'])
  const r = O.takeSnapshot(w.primary).parts.rules
  assert.deepEqual(Object.keys(r.agents), ['Master', 'Agent 1', 'Agent 3', 'Independent', 'QA'])
  assert.deepEqual(r.agents['Agent 1'], { spec: 'Builds the web pages.', rules: ['Never touch mobile.', 'Write the test first.'] })
  assert.deepEqual(r.agents.Master, { spec: '', rules: [] })
})

test('a style written to another project changes its config in projects.json and its own rules and settings files only', () => {
  const w = world()
  seedRules(w.primary.file('agent-rules.json'), 'Agent 1', 'Builds.', ['Rule one.'])
  const style = O.takeSnapshot(w.primary)
  const before = fs.readFileSync(w.configFile, 'utf8')
  const done = O.applySnapshot(style, w.other)
  assert.deepEqual(done, { applied: ['agents', 'rules', 'settings'], skipped: [] })
  assert.equal(fs.readFileSync(w.configFile, 'utf8'), before) // config.json untouched
  const other = JSON.parse(fs.readFileSync(w.projectsFile, 'utf8')).projects[1]
  assert.equal(other.config.repo, 'C:/work/other') // its own keys stay
  assert.deepEqual(other.config.pinnedAgents, { X: {} })
  assert.equal(other.config.coordinator, 'Master')
  assert.deepEqual(other.config.codingAgents, style.parts.agents.codingAgents)
  assert.equal(other.config.factory.chat.name, 'Independent')
  assert.deepEqual(R.rulesOf(R.readRules(w.other.file('agent-rules.json')), 'Agent 1').rules.map(r => r.text), ['Rule one.'])
  assert.deepEqual(O.takeSnapshot(w.other).parts, style.parts) // read back, it is the same style
})

test('a style written to the first project goes into config.json in place, and the change is in the rules log', () => {
  const w = world()
  seedRules(w.primary.file('agent-rules.json'), 'Agent 1', 'Old spec.', ['Old rule.'])
  const style = O.takeSnapshot(w.primary)
  style.parts.agents.coordinatorLabel = 'Boss'
  style.parts.agents.pipeline = { qa: 'Tester', maxReworks: 2 }
  style.parts.rules.agents['Agent 1'] = { spec: 'New spec.', rules: ['Old rule.', 'New rule.'] }
  O.applySnapshot(style, w.primary)
  const cfg = JSON.parse(fs.readFileSync(w.configFile, 'utf8'))
  assert.equal(cfg.coordinatorLabel, 'Boss')
  assert.deepEqual(cfg.pipeline, { qa: 'Tester', maxReworks: 2 })
  assert.deepEqual(cfg.pinnedAgents, { 'Agent 1': { sessionId: 's1' } })
  assert.ok(fs.readFileSync(w.configFile, 'utf8').startsWith('{\n  "repo": "C:/work/app",\n  "port": 4317,\n  "coordinator": "Master",'))
  const entry = R.rulesOf(R.readRules(w.primary.file('agent-rules.json')), 'Agent 1')
  assert.equal(entry.spec, 'New spec.')
  assert.deepEqual(entry.rules.map(r => r.text), ['Old rule.', 'New rule.'])
  const log = R.readLog(w.primary.file('agent-rules-log.jsonl'))
  assert.equal(log.at(-1).label, 'Agent 1')
  assert.deepEqual(log.at(-1).added, ['New rule.'])
})

test('an agent the style leaves empty has its rules cleared; one outside the style is left alone', () => {
  const w = world()
  seedRules(w.primary.file('agent-rules.json'), 'QA', 'Tests.', ['Push only what you tested.'])
  seedRules(w.primary.file('agent-rules.json'), 'Elsewhere', 'Kept.', ['Kept rule.'])
  const style = O.takeSnapshot(w.primary)
  style.parts.rules.agents.QA = { spec: '', rules: [] }
  O.applySnapshot(style, w.primary)
  const store = R.readRules(w.primary.file('agent-rules.json'))
  assert.deepEqual(R.rulesOf(store, 'QA').rules, [])
  assert.equal(R.rulesOf(store, 'Elsewhere').spec, 'Kept.')
})

test('a bad style is refused whole, with a plain sentence, before anything is written', () => {
  const w = world()
  const good = O.takeSnapshot(w.primary)
  const before = fs.readFileSync(w.configFile, 'utf8')
  const bad = structuredClone(good)
  bad.parts.rules.agents['Agent 1'] = { spec: 'x', rules: ['y'.repeat(301)] }
  assert.throws(() => O.applySnapshot(bad, w.primary), /Agent 1: Rule 1 is too long/)
  assert.equal(fs.readFileSync(w.configFile, 'utf8'), before)
  const bad2 = structuredClone(good)
  bad2.parts.agents.coordinatorLabel = 'bad\nlabel'
  assert.throws(() => O.applySnapshot(bad2, w.primary), /coordinator/i)
  const bad3 = structuredClone(good)
  bad3.parts.agents = 'nope'
  assert.match(O.checkSnapshot(bad3), /agents/i)
  assert.match(O.checkSnapshot(null), /not a saved orchestration/i)
})

test('a style saved before a part existed leaves that part as it is (skipped); an unknown part is ignored', () => {
  const w = world()
  const style = O.takeSnapshot(w.primary)
  delete style.parts.rules
  style.parts.future = { anything: true }
  assert.deepEqual(O.applySnapshot(style, w.other), { applied: ['agents', 'settings'], skipped: ['rules'] })
})

test('one more per-agent store plugs in as one line in the list of parts', () => {
  const w = world()
  const extra = {
    key: 'pins',
    read: t => JSON.parse(fs.existsSync(t.file('agent-pins.json')) ? fs.readFileSync(t.file('agent-pins.json'), 'utf8') : '{}'),
    write: (v, t) => { fs.mkdirSync(t.dataDir, { recursive: true }); fs.writeFileSync(t.file('agent-pins.json'), JSON.stringify(v)) },
  }
  fs.writeFileSync(w.primary.file('agent-pins.json'), JSON.stringify({ QA: { model: 'x' } }))
  const parts = [...O.STYLE_PARTS, extra]
  const style = O.takeSnapshot(w.primary, parts)
  assert.deepEqual(style.parts.pins, { QA: { model: 'x' } })
  O.applySnapshot(style, w.other, parts)
  assert.deepEqual(JSON.parse(fs.readFileSync(w.other.file('agent-pins.json'), 'utf8')), { QA: { model: 'x' } })
})

test('the view of a style: its graph, each agent with its role, specification and rules, and one summary line', () => {
  const w = world()
  seedRules(w.primary.file('agent-rules.json'), 'Agent 1', 'Builds.', ['One.', 'Two.'])
  seedRules(w.primary.file('agent-rules.json'), 'QA', '', ['Three.'])
  const v = O.styleView(O.takeSnapshot(w.primary))
  assert.ok(v.graph.nodes.some(nd => nd.role === 'qa' && nd.label === 'QA'))
  assert.deepEqual(v.agents.map(a => [a.label, a.role]), [['Master', 'coordinator'], ['Agent 1', 'producer'], ['Agent 3', 'producer'], ['Independent', 'chat'], ['QA', 'qa']])
  assert.deepEqual(v.agents[1], { label: 'Agent 1', role: 'producer', spec: 'Builds.', rules: ['One.', 'Two.'] })
  assert.equal(v.summary, 'Master hands to 2 agents, QA tests, 3 rules')
})

test('summary wording: one agent, one rule, no rules', () => {
  const one = { parts: { agents: { coordinator: 'M', coordinatorLabel: 'M', codingAgents: { M: 'M', A: 'A' }, pipeline: { qa: 'QA' }, chatName: '' }, rules: { agents: { A: { spec: '', rules: ['x'] } } } } }
  assert.equal(O.summaryOf(one), 'M hands to 1 agent, QA tests, 1 rule')
  delete one.parts.rules
  assert.equal(O.summaryOf(one), 'M hands to 1 agent, QA tests, no rules')
})

test('two styles are the same when their parts are, whatever the key order', () => {
  const a = { parts: { agents: { x: 1, y: [1, 2] }, rules: { agents: {} } } }
  const b = { parts: { rules: { agents: {} }, agents: { y: [1, 2], x: 1 } } }
  assert.ok(O.sameStyle(a, b))
  assert.ok(!O.sameStyle(a, { parts: { agents: { x: 2 } } }))
})

test('the agents of a style that have no session in the project yet (the chat agent is the Ask drawer, never one)', () => {
  const w = world()
  const style = O.takeSnapshot(w.primary)
  assert.deepEqual(O.noSessionFor(style, ['Master', 'app-a9']), ['Agent 1', 'QA'])
  assert.deepEqual(O.noSessionFor(style, ['Master', 'Agent 1', 'app-a9', 'QA']), [])
  assert.deepEqual(O.noSessionFor(style, []), ['Master', 'Agent 1', 'Agent 3', 'QA'])
})

test('a style carries the model and effort chosen for each agent, and never the files an agent was given', () => {
  const w = world()
  let from = S.applyModel(S.readAgentSettings(w.primary.file('agent-settings.json')), 'Agent 1', { model: 'claude-sonnet-5-5', effort: 'low' }).store
  from = S.addFile(from, 'Agent 1', { title: 'House rules', text: 'Only for this repo.', kind: 'note' }).store
  S.writeAgentSettings(from, w.primary.file('agent-settings.json'))
  const style = O.takeSnapshot(w.primary)
  assert.deepEqual(style.parts.settings.agents['Agent 1'], { model: 'claude-sonnet-5-5', effort: 'low' })
  assert.deepEqual(style.parts.settings.agents.QA, { model: null, effort: null })
  assert.ok(!JSON.stringify(style).includes('Only for this repo.'))

  // the target keeps its own files, takes the model, and an agent with no choice in the style loses its own
  let to = S.applyModel(S.readAgentSettings(w.other.file('agent-settings.json')), 'QA', { model: 'claude-haiku-5-5' }).store
  to = S.addFile(to, 'Agent 1', { title: 'Other repo notes', text: 'Stays here.', kind: 'note' }).store
  fs.mkdirSync(w.other.dataDir, { recursive: true })
  S.writeAgentSettings(to, w.other.file('agent-settings.json'))
  O.applySnapshot(style, w.other)
  const after = S.readAgentSettings(w.other.file('agent-settings.json'))
  assert.equal(S.entryOf(after, 'Agent 1').model, 'claude-sonnet-5-5')
  assert.equal(S.entryOf(after, 'Agent 1').effort, 'low')
  assert.deepEqual(S.entryOf(after, 'Agent 1').files.map(x => x.text), ['Stays here.'])
  assert.equal(S.entryOf(after, 'QA').model, null)
})

test('a saved model that is not one of the listed models is refused before anything is written', () => {
  const w = world()
  const style = O.takeSnapshot(w.primary)
  style.parts.settings.agents.QA = { model: 'not-a-model', effort: null }
  assert.match(O.checkSnapshot(style), /QA: Pick one of the listed models./)
  assert.throws(() => O.applySnapshot(style, w.other), /Pick one of the listed models/)
  assert.equal(fs.existsSync(w.other.file('agent-settings.json')), false)
})
