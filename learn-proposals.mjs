// The Learn run's answer, parsed and CHECKED by the server: the model proposes, the server decides what is shown.
//
//   parseProposals(text, { labels, flowIds, rules, rejected })
//     -> { proposals: [{ n, target, action, rule, old, flows, evidence, effect, check, state: 'open' }], dropped: [{ why }],
//          nothing: string | null }   or { error } when the answer is not the agreed JSON at all
//
// THE CHECKS, each failure dropping the proposal with one plain `why` the page can show:
// - target: an agent label of the graph (case forgiven, the graph's spelling kept) or `settings`.
// - action: add, change or remove. A rule is 1 to 300 characters, as agent-rules.mjs allows. `add` needs a rule the
//   agent does not have yet; `change` and `remove` need `old`, a rule it HAS now, word for word (spaces forgiven).
//   A settings proposal is text the user applies by hand: Learn never edits config.json.
// - EVIDENCE: `flows` must name at least one flow id of the pack (learn-pack.mjs flowIds); ids the pack does not have
//   are taken off, and a proposal left with none is dropped. The evidence, the effect and the check are cut.
// - An idea the user REJECTED before (same target and rule, case and spaces forgiven) is dropped.
// - At most PROPOSALS_MAX: the first 3 that pass are kept, any more are dropped. None is a valid answer, shown as such.
// PURE: no file, no config.

import { extractObject } from './learn.mjs'

export const PROPOSALS_MAX = 3
const RULE_MAX = 300
const BAD = 'The Learn run did not answer in the agreed format, so nothing was proposed.'
const ACTIONS = ['add', 'change', 'remove']

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const line = s => String(s ?? '').replace(/\s+/g, ' ').trim()
const clip = (s, max) => {
  const t = line(s)
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`
}
const same = (a, b) => line(a).toLowerCase() === line(b).toLowerCase()

/** One proposal checked: { p } or { why }. */
function check(raw, { labels, flowIds, rules, rejected }) {
  if (!isObject(raw)) return { why: 'A proposal was not an object.' }
  const t = line(raw.target)
  const target = t.toLowerCase() === 'settings' ? 'settings' : labels.find(l => l.toLowerCase() === t.toLowerCase())
  if (!target) return { why: `${t || 'A proposal'} is not an agent of the pipeline, nor settings.` }
  const action = line(raw.action).toLowerCase()
  if (!ACTIONS.includes(action)) return { why: `A proposal for ${target} did not say add, change or remove.` }
  const rule = line(raw.rule)
  const old = line(raw.old)
  if (action !== 'remove' && !rule) return { why: `A proposal for ${target} had no rule text.` }
  if (rule.length > RULE_MAX) return { why: `A proposal for ${target} had a rule over ${RULE_MAX} characters.` }
  const has = (rules?.[target] || []).map(line)
  if (target !== 'settings') {
    if (action === 'add' && has.some(r => same(r, rule))) return { why: `${target} already has the rule: ${clip(rule, 120)}` }
    if (action !== 'add' && !has.some(r => r === old)) return { why: `${target} has no rule that reads: ${clip(old || '(none given)', 120)}` }
  }
  const text = action === 'remove' ? old : rule
  if ((rejected || []).some(r => same(r.target, target) && same(r.rule, text))) return { why: `This idea was rejected before: ${clip(text, 120)}` }
  const flows = [...new Set((Array.isArray(raw.flows) ? raw.flows : []).filter(id => typeof id === 'string' && flowIds.has(id)))]
  if (!flows.length) return { why: `A proposal for ${target} names no flow from the evidence pack, so it was thrown away.` }
  return { p: { target, action, rule, old: action === 'add' ? '' : old, flows, evidence: clip(raw.evidence, 600), effect: clip(raw.effect, 300), check: clip(raw.check, 300), state: 'open' } }
}

export function parseProposals(text, { labels = [], flowIds = new Set(), rules = {}, rejected = [] } = {}) {
  const answer = extractObject(text)
  if (!answer || !Array.isArray(answer.proposals)) return { error: BAD }
  const proposals = []
  const dropped = []
  for (const raw of answer.proposals) {
    const r = check(raw, { labels, flowIds, rules, rejected })
    if (r.why) dropped.push({ why: r.why })
    else if (proposals.length >= PROPOSALS_MAX) dropped.push({ why: `The run proposed more than ${PROPOSALS_MAX} changes; only the first ${PROPOSALS_MAX} are kept.` })
    else proposals.push({ n: proposals.length + 1, ...r.p })
  }
  const nothing = proposals.length ? null : clip(answer.nothing, 300) || 'The run found nothing worth changing.'
  return { proposals, dropped, nothing }
}
