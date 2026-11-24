// What an orchestration "style" is made of: everything that says how the agents work together, and nothing that
// belongs to one repo. The Orchestration bank (orchestration-bank.mjs) saves styles; a project starts from one
// or switches to one (projects-routes.mjs, bank-routes.mjs).
//
//   STYLE_PARTS                      the parts, in the order they are written: [{ key, read(target), write(value, target), check?(value) }]
//   projectTarget(project, opts)     one project as the parts see it: { project, dataDir, file(name), raw(), writeConfig(changes) }
//   takeSnapshot(target, parts)      { parts: { <key>: value } }: the style a project has now
//   checkSnapshot(snapshot, parts)   one plain sentence for what is wrong, or null
//   applySnapshot(snapshot, target, parts)   writes each part the snapshot has; { applied, skipped }
//   styleView(snapshot)              { graph, agents: [{ label, role, spec, rules }], summary } for the page
//   summaryOf / sameStyle / noSessionFor
//
// ═══ PLUGGING IN ONE MORE PER-AGENT STORE ═══ A part is one line in STYLE_PARTS. For a store kept in the
// project's data folder as <name>.json, with read(file) and write(value, file) functions:
//   { key: 'settings', read: t => readSettings(t.file('agent-settings.json')), write: (v, t) => writeSettings(v, t.file('agent-settings.json')) }
// `t.file(name)` is that file in the TARGET project's folder (never DATA_DIR: a new project is written before
// the server has switched to it). An optional `check(value)` returns a sentence to refuse a bad saved value
// before ANY part is written. A style saved before a part existed simply has no value for it: that part is
// left as it is (skipped), never cleared.
//
// What is NOT a style: the repo, the session match, session ids, pinned sessions, aliases, ticket settings and
// the levels. The session NAMES in codingAgents are kept: they are how a session gets its label, and a name the
// project has no session for does no harm (noSessionFor says which agents wait for one).
//
// The agents part copies `pipeline` WHOLE, as it is in the config (or the defaults written out when there is
// none), so keys this file does not know yet (another builder adds pipeline.planner and pipeline.security)
// travel with the style.

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { agentLabels, appendLog, applyChange, checkChange, diffEntries, readRules, RULES_FILE, RULES_LOG, rulesOf, writeRules } from './agent-rules.mjs'
import { coordinatorSettings, DEFAULT_CHAT_NAME } from './config.mjs'
import { setKeys, writeConfigKeys } from './config-write.mjs'
import { AGENT_LABEL } from './flows.mjs'
import { pipelineGraph, pipelineSettings } from './pipeline.mjs'
import { CONFIG_JSON, DATA_ROOT, effectiveStore, PROJECTS_FILE, projectDataDir, projectRaw, readProjects, writeProjects } from './project-store.mjs'

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)
const silent = () => {}
const RULES_NAME = path.basename(RULES_FILE)
const LOG_NAME = path.basename(RULES_LOG)
/** At most this many session names in a style, and agents in its rules. */
const MAX_AGENTS = 40

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * One project as the parts see it. `raw()` is its config as the files say NOW (not CONFIG, which was fixed when
 * the server started); `writeConfig(changes)` writes dotted-path changes to config.json for the primary project
 * (config-write.mjs, in place) and to its entry in projects.json for any other.
 */
export function projectTarget(project, { root = DATA_ROOT, projectsFile = PROJECTS_FILE, configFile = CONFIG_JSON } = {}) {
  const dataDir = projectDataDir(project, root)
  const fresh = () => {
    const base = readJson(configFile)
    const store = effectiveStore(readProjects(projectsFile, silent), base)
    return { base, store, entry: store.projects.find(p => p.id === project.id) || project }
  }
  return {
    project,
    dataDir,
    file: name => path.join(dataDir, name),
    raw() {
      const { base, store, entry } = fresh()
      return projectRaw(base, store, entry)
    },
    writeConfig(changes) {
      if (project.primary) return writeConfigKeys(configFile, changes)
      const store = readProjects(projectsFile, silent)
      const entry = store?.projects.find(p => p.id === project.id)
      if (!entry) throw new Error(`${project.name} is no longer in the list of projects.`)
      entry.config = setKeys(entry.config, changes)
      writeProjects(store, projectsFile)
    },
  }
}

// ═══ the agents and the pipeline ═══

/** The agents part of a raw config: who coordinates, the session labels, the chat agent's name, the pipeline block whole. */
function agentsOf(raw) {
  const c = coordinatorSettings(raw, silent)
  return {
    coordinator: c.coordinator,
    coordinatorLabel: c.coordinatorLabel,
    codingAgents: isObj(raw.codingAgents) ? { ...raw.codingAgents } : { [c.coordinator]: c.coordinatorLabel },
    pipeline: isObj(raw.pipeline) ? structuredClone(raw.pipeline) : structuredClone({ ...pipelineSettings(undefined, silent) }),
    chatName: typeof raw.factory?.chat?.name === 'string' ? raw.factory.chat.name : DEFAULT_CHAT_NAME,
  }
}

function checkAgents(v) {
  if (!isObj(v)) return 'The agents of this orchestration are missing.'
  if (typeof v.coordinator !== 'string' || !v.coordinator.trim() || v.coordinator.length > 100) return 'The coordinator needs a session name of 1 to 100 characters.'
  if (typeof v.coordinatorLabel !== 'string' || !AGENT_LABEL.test(v.coordinatorLabel)) return 'The coordinator needs a label of 1 to 40 letters, digits, spaces, dots, dashes or underscores.'
  if (!isObj(v.codingAgents) || Object.keys(v.codingAgents).length > MAX_AGENTS) return `The agents need a list of at most ${MAX_AGENTS} session names and labels.`
  for (const [name, label] of Object.entries(v.codingAgents)) {
    if (!name.trim() || name.length > 100 || typeof label !== 'string' || !AGENT_LABEL.test(label)) return `The agent ${name.slice(0, 40)} needs a label of 1 to 40 letters, digits, spaces, dots, dashes or underscores.`
  }
  if (!isObj(v.pipeline)) return 'The pipeline of this orchestration is missing.'
  if (typeof v.chatName !== 'string' || v.chatName.length > 40) return 'The chat agent needs a name of at most 40 characters.'
  return null
}

const agentsPart = {
  key: 'agents',
  read: t => agentsOf(t.raw()),
  check: checkAgents,
  write: (v, t) => t.writeConfig({ coordinator: v.coordinator, coordinatorLabel: v.coordinatorLabel, codingAgents: v.codingAgents, pipeline: v.pipeline, 'factory.chat.name': v.chatName }),
}

/** The graph a style's agents part draws (pipeline.mjs), the same one the Agents page would draw from it. */
export function graphOf(agents) {
  const a = isObj(agents) ? agents : {}
  return pipelineGraph({
    coordinator: a.coordinator,
    coordinatorLabel: a.coordinatorLabel,
    codingAgents: isObj(a.codingAgents) ? a.codingAgents : {},
    pipeline: pipelineSettings(isObj(a.pipeline) ? a.pipeline : undefined, silent),
    factory: { chat: { name: typeof a.chatName === 'string' ? a.chatName : '' } },
  })
}

// ═══ the specification and rules of each agent ═══

function checkRules(v) {
  if (!isObj(v) || !isObj(v.agents)) return 'The rules of this orchestration are missing.'
  const labels = Object.keys(v.agents)
  if (labels.length > MAX_AGENTS) return `An orchestration keeps rules for at most ${MAX_AGENTS} agents.`
  for (const label of labels) {
    if (!AGENT_LABEL.test(label)) return `${label.slice(0, 40)} is not an agent label.`
    const e = v.agents[label]
    const c = checkChange({ spec: e?.spec ?? '', rules: e?.rules ?? [] })
    if (c.error) return `${label}: ${c.error}`
  }
  return null
}

const rulesPart = {
  key: 'rules',
  read(t) {
    const store = readRules(t.file(RULES_NAME))
    const agents = {}
    for (const label of agentLabels(graphOf(agentsOf(t.raw())))) {
      const e = rulesOf(store, label)
      agents[label] = { spec: e.spec, rules: e.rules.map(r => r.text) }
    }
    return { agents }
  },
  check: checkRules,
  write(v, t) {
    const file = t.file(RULES_NAME)
    let store = readRules(file)
    const lines = []
    const at = new Date().toISOString()
    for (const [label, e] of Object.entries(v.agents)) {
      const before = rulesOf(store, label)
      store = applyChange(store, label, checkChange({ spec: e.spec ?? '', rules: e.rules ?? [] }), { now: () => at })
      const d = diffEntries(before, rulesOf(store, label))
      if (d) lines.push({ at, label, ...d })
    }
    writeRules(store, file)
    for (const line of lines) appendLog(line, t.file(LOG_NAME)) // the orchestration log shows what the switch changed
  },
}

/** The parts of a style, in the order they are written. ONE line per part: see the header. */
export const STYLE_PARTS = [agentsPart, rulesPart]

// ═══ snapshots ═══

export function takeSnapshot(target, parts = STYLE_PARTS) {
  const out = {}
  for (const p of parts) out[p.key] = p.read(target)
  return { parts: out }
}

export function checkSnapshot(snapshot, parts = STYLE_PARTS) {
  if (!isObj(snapshot) || !isObj(snapshot.parts)) return 'That is not a saved orchestration.'
  for (const p of parts) {
    if (snapshot.parts[p.key] === undefined) continue
    const why = p.check?.(snapshot.parts[p.key])
    if (why) return why
  }
  return null
}

/** Writes every part the snapshot has, after checking them ALL; throws the check's sentence and writes nothing. */
export function applySnapshot(snapshot, target, parts = STYLE_PARTS) {
  const why = checkSnapshot(snapshot, parts)
  if (why) throw new Error(why)
  const applied = []
  const skipped = []
  for (const p of parts) {
    if (snapshot.parts[p.key] === undefined) skipped.push(p.key)
    else {
      p.write(snapshot.parts[p.key], target)
      applied.push(p.key)
    }
  }
  return { applied, skipped }
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "Master hands to 3 agents, QA tests, 6 rules": one line read from the snapshot. */
export function summaryOf(snapshot) {
  const graph = graphOf(snapshot?.parts?.agents)
  const nodes = graph.nodes || []
  const coord = nodes.find(n => n.role === 'coordinator')?.label || 'The coordinator'
  const qa = nodes.find(n => n.role === 'qa')?.label
  const producers = nodes.filter(n => n.role === 'producer').length
  const rules = Object.values(snapshot?.parts?.rules?.agents || {}).reduce((sum, e) => sum + (Array.isArray(e?.rules) ? e.rules.length : 0), 0)
  return [`${coord} hands to ${plural(producers, 'agent')}`, ...(qa ? [`${qa} tests`] : []), rules ? plural(rules, 'rule') : 'no rules'].join(', ')
}

/** What the page draws: the graph, each agent with its role and its saved specification and rules, the summary. */
export function styleView(snapshot) {
  const graph = graphOf(snapshot?.parts?.agents)
  const rules = snapshot?.parts?.rules?.agents || {}
  const agents = (graph.nodes || []).filter(n => n.kind === 'agent').map(n => ({
    label: n.label,
    role: n.role,
    spec: typeof rules[n.label]?.spec === 'string' ? rules[n.label].spec : '',
    rules: Array.isArray(rules[n.label]?.rules) ? rules[n.label].rules.filter(r => typeof r === 'string') : [],
  }))
  return { graph, agents, summary: summaryOf(snapshot) }
}

function sorted(v) {
  if (Array.isArray(v)) return v.map(sorted)
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])]))
  return v
}
export const sameStyle = (a, b) => JSON.stringify(sorted(a?.parts ?? null)) === JSON.stringify(sorted(b?.parts ?? null))

/**
 * The agent labels of a style that no session of the project would carry, given the project's session `names`:
 * a session's label is the style's (coordinator, then codingAgents), else its own name. The chat agent is the
 * Ask drawer, never a session, so it is never listed.
 */
export function noSessionFor(snapshot, names) {
  const a = snapshot?.parts?.agents || {}
  const labelOf = name => (name === a.coordinator ? a.coordinatorLabel : a.codingAgents?.[name] ?? name)
  const have = new Set((names || []).map(labelOf))
  return (graphOf(a).nodes || []).filter(n => n.kind === 'agent' && n.role !== 'chat' && !have.has(n.label)).map(n => n.label)
}
