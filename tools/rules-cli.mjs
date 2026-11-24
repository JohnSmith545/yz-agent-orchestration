// The user's rules for each agent, as the agents read them (tools/flow-cli.mjs registers these):
//
//   rules [--by "<label>"]   that agent's specification and rules as plain text, or "No rules set for <label>."
//   withRules(command)       wraps `flow new`: after its usual line, the --by agent's rules
//   withQaRules(commands)    wraps `flow qa-start`: after its usual line, the QA label's rules
//
// The rules are set on the Agents page (agent-rules-routes.mjs) and kept in data/agent-rules.json (agent-rules.mjs).
// Printing them where every request starts means every agent sees them without a brief change, and a change
// on the page reaches the next request. Only a label that is an agent of the graph now has rules to print: the
// file keeps a removed agent's rules, unshown. Nothing extra is printed when there are none, and a refused
// command prints none (the agent has nothing to start yet).
//
// Like the other flow commands they return { out, code } and never print. `config` comes from runFlow's context
// (tests pass their own); left out, config.mjs CONFIG.

import { agentLabels, readRules, rulesBlock } from '../agent-rules.mjs'
import { CONFIG } from '../config.mjs'
import { pipelineGraph } from '../pipeline.mjs'

/** `label`'s rules as rulesBlock prints them, or '' when it has none or is no agent of the graph. */
export function rulesFor(label, config = CONFIG) {
  if (!label || !agentLabels(pipelineGraph(config || CONFIG)).includes(label)) return ''
  return rulesBlock(readRules(), label)
}

const add = (result, block) => (result.code || !block ? result : { ...result, out: `${result.out}\n${block}` })

/** `command` with the rules of `labelOf(flags, context)` (the --by agent by default) after a good result. */
export function withRules(command, labelOf = (_f, ctx) => ctx.by) {
  return (f, ctx) => add(command(f, ctx), rulesFor(labelOf(f, ctx), ctx.config))
}

/** The QA commands, with `qa-start` printing the QA label's rules. */
export function withQaRules(commands) {
  return { ...commands, 'qa-start': withRules(commands['qa-start'], (_f, ctx) => (ctx.config || CONFIG).pipeline?.qa) }
}

export function rulesCommands(noName) {
  return {
    rules(_f, { by, config }) {
      if (!by) return { out: noName, code: 1 }
      return { out: rulesFor(by, config) || `No rules set for ${by}.`, code: 0 }
    },
  }
}
