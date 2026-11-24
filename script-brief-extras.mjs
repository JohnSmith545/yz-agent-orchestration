// The two extra sections of SCRIPT's orchestration brief (script-brief.mjs orchestrationBrief `extras`): what the
// user told each agent (agent-rules.mjs rulesText: every specification and rule) and how the pipeline scores now
// (score.mjs scoreText, the last 30 days). server.mjs calls it on every read of the brief, so both are fresh.
//
// Rules this file keeps:
// - A section with nothing to say is LEFT OUT: no rules saved, or nothing scored yet, gives no empty heading.
// - It never throws: a store or a flow list that cannot be read gives no section, and the brief still goes.
// - Everything can be passed in (tests do); the defaults read the real store and the flow files.

import { readRules, rulesText } from './agent-rules.mjs'
import { listFlows } from './flows.mjs'
import { scoreOf, scoreText } from './score.mjs'

const RULES_TITLE = 'What the user told each agent'
const SCORE_TITLE = 'How the pipeline scores'
const SCORE_DAYS = 30

const quiet = fn => {
  try {
    return fn()
  } catch {
    return ''
  }
}

/** [{ title, text }] for orchestrationBrief's `extras`: the rules section, then the score section, each only when it has text. */
export function briefExtras({ graph, rules, flows, now = Date.now() } = {}) {
  const rulesPart = quiet(() => rulesText(rules === undefined ? readRules() : rules, graph))
  const scorePart = quiet(() => {
    const score = scoreOf(flows === undefined ? listFlows({ archived: 'any' }).flows : flows, graph, { now, days: SCORE_DAYS })
    const counted = Object.values(score.counts).reduce((a, b) => a + b, 0)
    return counted ? scoreText(score) : ''
  })
  return [
    { title: RULES_TITLE, text: rulesPart },
    { title: SCORE_TITLE, text: scorePart },
  ].filter(x => typeof x.text === 'string' && x.text.trim())
}
