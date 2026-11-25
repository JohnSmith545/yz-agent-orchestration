// The routing rules: which agent, model and effort SUGGEST themselves for a task of a given type, risk and size.
// Plain rules the user can read and change (the Routing page, #/routing, writes them to config.json's `routing.rules`),
// with defaults here. The data each suggestion and its outcome leave behind (routing-outcomes.mjs) is what a later
// learning method would start from; no learning method is built now.
//
//   A rule:  { when: { type?, risk?, size? }, agent?, model?, effort?, why }
//            type   a task type (routing-type.mjs) or a list of them; risk low | medium | high; size small | medium | large
//            agent  a dashboard label; model a model id (agent-settings.mjs MODELS); effort low | medium | high
//            why    one plain line, printed after `because`
//
//   routingSettings(raw, warn)        { rules, custom, intakeModel, warning } from config.json's `routing` block
//   checkRules(list)                  { rules, problems }: one plain line per problem ('Rule 2: ...')
//   matchRule(rules, task)            { rule, index } of the FIRST rule that fits, or null
//   suggest(task, rules, who)         { agent, model, effort, rule, why, fixed } or null when no rule fits
//   suggestionLine(s)                 'Suggested: Agent 2, Sonnet 5.5, medium effort, because ...'
//   followedOf(suggested, used)       true | false, or null when nothing was suggested or a part is not known
//
// ═══ THE RULES ═══
// - ORDER MATTERS: the first rule that fits wins, so put the narrow ones first. A key left out of `when` fits
//   anything; a rule that names a risk fits only a task whose risk is known (no risk provider: never).
// - A task of unsure type (type null) fits only a rule that names no type.
// - ⚠️ A SUGGESTION, NEVER AN ORDER: nothing here switches a session, a setting or a route. The pages and the CLI
//   print it; the user or the coordinator takes it or not, and `followed` records which.
// - ⚠️ THE FIXED ROLES ARE NEVER SUGGESTED DOWN: the planner, Security and Senior always run on Opus at high effort
//   (agent-settings.mjs FIXED). A suggestion for one of them, or a rule that names one, says Opus high, whatever
//   the rule said.
// - A config with ANY bad rule keeps the DEFAULTS whole, with ONE warning naming the first problem: half a rule list
//   would route in ways nobody wrote down.
//
// Pure: no file, no clock (the live reader is routing-config.mjs).

import { EFFORTS, FIXED, FIXED_ROLES, MODELS } from './agent-settings.mjs'
import { SIZES, TASK_TYPES } from './routing-type.mjs'

export const RISKS = Object.freeze(['low', 'medium', 'high'])
export const RULE_LIMITS = Object.freeze({ rules: 40, why: 160 })
const WHEN_KEYS = ['type', 'risk', 'size']
/** MUST CHANGE IN LOCKSTEP with flows.mjs AGENT_LABEL. */
const LABEL = /^[A-Za-z0-9 ._-]{1,40}$/

const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'

/** The rules a fresh dashboard starts with: risk first, then the narrow cheap cases, then the large ones. */
export const DEFAULT_RULES = Object.freeze([
  { when: { risk: 'high' }, model: OPUS, effort: 'high', why: 'high-risk work gets the strongest model' },
  { when: { type: 'wording', size: 'small' }, model: SONNET, effort: 'medium', why: 'small wording fixes rarely fail QA' },
  { when: { type: 'style', size: 'small' }, model: SONNET, effort: 'medium', why: 'small style changes are quick to check by eye' },
  { when: { type: 'docs' }, model: SONNET, effort: 'medium', why: 'documentation needs care with words more than deep reasoning' },
  { when: { type: 'small-fix', size: 'small' }, model: SONNET, effort: 'high', why: 'a small fix still needs its cause found' },
  { when: { size: 'large' }, model: OPUS, effort: 'high', why: 'large changes can go wrong in more places' },
].map(r => Object.freeze({ ...r, when: Object.freeze(r.when) })))

/** Why a fixed role's suggestion is what it is, whatever the rule said. */
const FIXED_WHY = 'this role always runs on Opus at high effort'
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)
const modelName = id => MODELS.find(m => m.id === id)?.name || id

/** The problems of one rule, each starting `Rule <n>: `. */
function ruleProblems(r, n) {
  const at = `Rule ${n}: `
  if (!isObj(r)) return [`${at}must be an object with when and why`]
  const out = []
  if (!isObj(r.when)) out.push(`${at}when must be an object such as { "type": "docs" } (or {} for any task)`)
  else {
    for (const k of Object.keys(r.when)) if (!WHEN_KEYS.includes(k)) out.push(`${at}when can only say type, risk or size, not ${k}`)
    const types = r.when.type === undefined ? [] : [].concat(r.when.type)
    if (r.when.type !== undefined && (!types.length || !types.every(t => TASK_TYPES.includes(t)))) out.push(`${at}type must be one of ${TASK_TYPES.join(', ')}`)
    if (r.when.risk !== undefined && !RISKS.includes(r.when.risk)) out.push(`${at}risk must be low, medium or high`)
    if (r.when.size !== undefined && !SIZES.includes(r.when.size)) out.push(`${at}size must be small, medium or large`)
  }
  if (r.agent !== undefined && r.agent !== null && !(typeof r.agent === 'string' && LABEL.test(r.agent))) out.push(`${at}agent must be a dashboard label of 1 to 40 letters, digits, spaces, dots, dashes or underscores`)
  if (r.model !== undefined && r.model !== null && !MODELS.some(m => m.id === r.model)) out.push(`${at}model must be one of ${MODELS.map(m => m.id).join(', ')}`)
  if (r.effort !== undefined && r.effort !== null && !EFFORTS.includes(r.effort)) out.push(`${at}effort must be low, medium or high`)
  if (![r.agent, r.model, r.effort].some(v => v !== undefined && v !== null)) out.push(`${at}must suggest an agent, a model or an effort`)
  if (typeof r.why !== 'string' || !r.why.trim()) out.push(`${at}needs a why: one plain line`)
  else if (r.why.length > RULE_LIMITS.why) out.push(`${at}the why is too long: keep it to ${RULE_LIMITS.why} characters`)
  return out
}

/** A rule list checked: the rules as given (only the known keys kept) and one plain line per problem. */
export function checkRules(list) {
  if (!Array.isArray(list)) return { rules: [], problems: ['The rules must be a list.'] }
  if (list.length > RULE_LIMITS.rules) return { rules: [], problems: [`That is too many rules: keep it to at most ${RULE_LIMITS.rules}.`] }
  const problems = list.flatMap((r, i) => ruleProblems(r, i + 1))
  if (problems.length) return { rules: [], problems }
  const rules = list.map(r => {
    const when = {}
    for (const k of WHEN_KEYS) if (r.when[k] !== undefined) when[k] = r.when[k]
    const out = { when }
    for (const k of ['agent', 'model', 'effort']) if (r[k] !== undefined && r[k] !== null) out[k] = r[k]
    out.why = r.why.trim()
    return out
  })
  return { rules, problems: [] }
}

/**
 * config.json's `routing` block as settings: the user's rules when they are all good (custom: true), else the
 * defaults (a bad list says so ONCE through `warn`), and the intake model (null: the model sort is off).
 */
export function routingSettings(raw, warn = console.warn) {
  const r = isObj(raw) ? raw : {}
  let rules = DEFAULT_RULES
  let custom = false
  let warning = null
  if (r.rules !== undefined) {
    const checked = checkRules(r.rules)
    if (checked.problems.length) {
      warning = `config.json: routing.rules has a problem (${checked.problems[0]}); the defaults are used until it is fixed.`
      warn(warning)
    } else {
      rules = checked.rules
      custom = true
    }
  }
  let intakeModel = null
  if (r.intakeModel !== undefined && r.intakeModel !== null && r.intakeModel !== false && r.intakeModel !== '') {
    if (MODELS.some(m => m.id === r.intakeModel)) intakeModel = r.intakeModel
    else warn(`config.json: routing.intakeModel must be one of ${MODELS.map(m => m.id).join(', ')}; the model sort stays off.`)
  }
  return { rules, custom, intakeModel, warning }
}

/** Whether `rule` fits `task` ({ type, risk, size }). */
function fits(rule, task) {
  const w = rule.when || {}
  if (w.type !== undefined && !(task.type && [].concat(w.type).includes(task.type))) return false
  if (w.risk !== undefined && w.risk !== task.risk) return false
  if (w.size !== undefined && w.size !== task.size) return false
  return true
}

export function matchRule(rules, task = {}) {
  const list = Array.isArray(rules) ? rules : []
  const index = list.findIndex(r => isObj(r) && fits(r, task || {}))
  return index < 0 ? null : { rule: list[index], index }
}

/**
 * The suggestion for `task` from `rules`, for the work going to `who.agent` (of graph role `who.role`); `who.roleOf`
 * gives the role of an agent a rule names. Null when no rule fits.
 */
export function suggest(task, rules, who = {}) {
  const hit = matchRule(rules, task)
  if (!hit) return null
  const { rule, index } = hit
  const agent = rule.agent ?? null
  const role = agent ? who.roleOf?.(agent) ?? null : who.role ?? null
  const fixed = FIXED_ROLES.includes(role)
  return {
    agent, model: fixed ? FIXED.model : rule.model ?? null, effort: fixed ? FIXED.effort : rule.effort ?? null,
    rule: index, why: fixed ? FIXED_WHY : rule.why, fixed,
  }
}

/** The one line the pages and the CLI print. */
export function suggestionLine(s) {
  if (!s) return 'No routing rule fits this task: use your usual choice.'
  const parts = [s.agent, s.model ? modelName(s.model) : null, s.effort ? `${s.effort} effort` : null].filter(Boolean)
  return `Suggested: ${parts.join(', ')}, because ${s.fixed ? FIXED_WHY : s.why}`
}

/**
 * Whether what was used is what was suggested: each part the suggestion named (agent, model, effort) must match. A
 * known mismatch is false; a part not known (null) leaves it null unless another part already mismatched.
 */
export function followedOf(suggested, used) {
  if (!isObj(suggested) || !isObj(used)) return null
  let unknown = false
  for (const k of ['agent', 'model', 'effort']) {
    if (suggested[k] === null || suggested[k] === undefined) continue
    if (used[k] === null || used[k] === undefined) unknown = true
    else if (used[k] !== suggested[k]) return false
  }
  return unknown ? null : true
}
