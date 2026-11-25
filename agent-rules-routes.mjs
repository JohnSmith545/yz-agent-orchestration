// The agent rules routes (factory-routes.mjs mounts them), behind the Settings button of an agent's details pane
// on the Agents page (public/agent-rules.js):
//
//   GET /api/agents/rules           { agents: { "<label>": { spec, rules: [{ id, text, addedAt }], updatedAt } },
//                                   changes: { "<label>": [{ at, text }] }, limits } for every agent of the graph now
//                                   (empty spec and rules when none are saved; `changes` is the agent's last ten
//                                   saved changes, newest first, each as one plain sentence)
//   PUT /api/agents/rules/<label>   { spec?: string, rules?: [string] }: replaces what is given (agent-rules.mjs
//                                   applyChange keeps the ids of unchanged rules). 200 { ok, label, agent, changes };
//                                   404 for a label that is not an agent of the graph; 400 { error } for a limit problem.
//
// ⚠️ The PUT needs the page's OWN Origin, never a missing one (local-origin.mjs, like the Settings routes): what is
// saved here is printed to every agent at the start of every request, so only the dashboard page may write it.
// Every save that changed something adds one line to the change log (agent-rules.mjs appendLog), and only AFTER
// the store was written: a failed store write throws first and logs nothing.
//
// Each handler returns { status, body }. `deps` is { config, file, logFile, port, now?, newId?, by?, onChange? }: the
// config (config.mjs CONFIG by default), the rules file and its log (agent-rules.mjs RULES_FILE, RULES_LOG), the
// server port the Origin must name, and the clock and id maker for tests.
// - `by` marks the save on its log line (agent-rules.mjs CHANGE_BY): the Learn page passes 'learn' for an accepted
//   proposal and 'revert' for a Revert, through THIS function, so they are saved exactly as the user's own edit is.
// - `onChange({ line, before, after })` hears every save that changed something, AFTER the store and the log were
//   written: the log line and the agent's entry before and after. Left out, it is every listener registered with
//   onRuleChange (learn-wiring.mjs registers the verdict baseline). A listener that throws is said on stderr and
//   never fails the save.

import {
  agentLabels, appendLog, applyChange, CHANGE_BY, changesOf, checkChange, diffEntries, readLog, readRules,
  RULE_LIMITS, RULES_FILE, RULES_LOG, rulesOf, rulesView, writeRules,
} from './agent-rules.mjs'
import { CONFIG } from './config.mjs'
import { originAllowed } from './local-origin.mjs'
import { pipelineGraph } from './pipeline.mjs'

const answer = (status, body) => ({ status, body })

/** Who hears a rule change by default (learn-verdicts.mjs, through learn-wiring.mjs). */
const listeners = new Set()
/** Hear every rule change saved from now on; returns the function that stops it. */
export function onRuleChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
/** Each listener on its own: one that throws is said on stderr and the next still hears the change. */
const toListeners = change => {
  for (const fn of [...listeners]) {
    try {
      fn(change)
    } catch (err) {
      console.error(`agent rules: a listener failed on a change for ${change?.line?.label}: ${err?.message || err}`)
    }
  }
}
/** How many of an agent's changes the pane lists. */
const CHANGES_SHOWN = 10

export function rulesGet({ config = CONFIG, file = RULES_FILE, logFile = RULES_LOG } = {}) {
  const graph = pipelineGraph(config)
  const lines = readLog(logFile)
  const changes = Object.fromEntries(agentLabels(graph).map(label => [label, changesOf(lines, label, CHANGES_SHOWN)]))
  return answer(200, { ...rulesView(readRules(file), graph), changes, limits: { ...RULE_LIMITS } })
}

export function rulesPut(label, b, headers, { config = CONFIG, file = RULES_FILE, logFile = RULES_LOG, port = CONFIG.port, now, newId, by, onChange = toListeners } = {}) {
  if (!originAllowed(headers?.origin, port)) return answer(403, { error: 'Rules are changed only from the dashboard page.' })
  if (!agentLabels(pipelineGraph(config)).includes(label)) return answer(404, { error: `There is no agent called ${label}.` })
  const change = checkChange(b)
  if (change.error) return answer(400, { error: change.error })
  const before = readRules(file)
  const store = applyChange(before, label, change, { ...(now ? { now } : {}), ...(newId ? { newId } : {}) })
  const diff = diffEntries(rulesOf(before, label), rulesOf(store, label))
  if (!diff) return answer(200, { ok: true, label, agent: rulesOf(before, label), changes: changesOf(readLog(logFile), label, CHANGES_SHOWN) })
  writeRules(store, file)
  const line = { at: store.agents[label].updatedAt, label, ...diff, ...(CHANGE_BY.includes(by) ? { by } : {}) }
  appendLog(line, logFile)
  try {
    onChange({ line, before: rulesOf(before, label), after: rulesOf(store, label) })
  } catch (err) {
    console.error(`agent rules: a listener failed on a change for ${label}: ${err?.message || err}`)
  }
  return answer(200, { ok: true, label, agent: rulesOf(store, label), changes: changesOf(readLog(logFile), label, CHANGES_SHOWN) })
}
