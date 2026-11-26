// The risk label of a task: low, medium or high, with every reason, and what it asks for (a Security review, a
// Senior review, a deeper QA pass). PURE RULES, NO MODEL: the same task always gets the same label, and the user can
// read why. Stored on the flow as `flow.risk` (quality-flow.mjs keeps it) and shown as a chip on the flow card, in
// the Agents diagram chip's tooltip, on the flow page, and to QA at `flow qa-start`.
//
//   flow.risk = { level: low | medium | high, reasons: [why, …], needs: [security | senior | deep-qa, …], at? }
//
// What a rule reads (riskOf):
//   words    the request: the flow's title and why, its step titles, and the plan text when there is one
//   labels   the tickets' labels from the ticket source (factory.mjs readSource), case-insensitive
//   paths    once there is a change, the files it touched (quality-files.mjs): a rule's path is a piece of a path
// A rule fires when ANY of its words, labels or paths matches. The highest level of the rules that fired wins, and
// every reason and every need is listed, once each, in rule order. No rule fired: low, no reasons, no needs.
//
// The defaults (DEFAULT_RISK_RULES) cover what the user named: sign-in and sessions, payments, secrets and config,
// infrastructure and CI, database schema and migrations, deleting data, public pages. config.json
// `quality.riskRules` REPLACES them with the user's own list ({ match: { paths?, words?, labels? }, level, needs, why });
// one bad entry keeps the defaults with ONE warning (riskRules), never a failed start: a typo must not switch the
// labels off.
//
// ⚠️ A word matches WHOLE (`auth` never fires inside `author`), and a phrase's spaces also match a dash or an
// underscore (`sign in` finds sign-in). Words a dashboard like this one uses for everything (pipeline, workflow, table,
// public/ as a folder, a bare `session`, which here is a Claude Code session) are left out of the defaults on purpose:
// a label that is always high says nothing. A user's session is named as one (`user session`, `session cookie`).
//
// riskRoute lays the label over a planned route (flow-route.mjs): a build route that lacks Security gets it before
// Push, an ask route that lacks Senior gets it (after Human task) before the Output, each only when that agent is on
// the pipeline; one that is not is named in `missing`, so the flow page can say so in one line.
// It must not import flows.mjs or config.mjs (config.mjs imports quality-config.mjs, which imports this).

export const LEVELS = Object.freeze(['low', 'medium', 'high'])
export const NEEDS = Object.freeze(['security', 'senior', 'deep-qa'])

const rule = (id, level, needs, why, words, paths = [], labels = []) => Object.freeze({ id, level, needs: Object.freeze(needs), why, match: Object.freeze({ words: Object.freeze(words), paths: Object.freeze(paths), labels: Object.freeze(labels) }) })

/** The built-in rules, in the order their reasons are listed. */
export const DEFAULT_RISK_RULES = Object.freeze([
  rule('sign-in', 'high', ['security', 'deep-qa'], 'It touches sign-in or sessions.',
    ['sign in', 'sign out', 'signin', 'login', 'log in', 'logout', 'log out', 'password', 'passwords', 'user session', 'user sessions', 'session cookie', 'session token', 'session expiry', 'session timeout', 'sessions expire', 'auth', 'authentication', 'oauth', '2fa', 'two factor', 'jwt', 'id token', 'cookie', 'cookies'],
    ['auth/', 'auth.', 'oauth', 'session', 'login', 'signin', 'sign-in', 'send-pin', 'local-origin'], ['auth', 'login', 'account']),
  rule('payments', 'high', ['security', 'deep-qa'], 'It touches payments.',
    ['payment', 'payments', 'billing', 'stripe', 'subscription', 'subscriptions', 'invoice', 'invoices', 'checkout', 'refund', 'refunds'],
    ['payment', 'billing', 'stripe', 'subscription', 'checkout'], ['payment', 'billing', 'subscription']),
  rule('secrets', 'high', ['security'], 'It touches secrets or settings files.',
    ['secret', 'secrets', 'api key', 'api keys', 'credential', 'credentials', 'private key', 'env file', '.env'],
    ['.env', 'secret', 'credential', 'config.json', '.pem', '.key'], ['secret']),
  rule('infra', 'high', ['security', 'senior'], 'It touches infrastructure or CI.',
    ['terraform', 'infrastructure', 'ci', 'github actions', 'deploy', 'deploys', 'deployment', 'cloud run', 'cloud sql', 'gcloud', 'dns', 'firewall', 'iam'],
    ['infra/', '.tf', '.github/', 'dockerfile', 'cloudbuild', 'firebase.json'], ['infra', 'devops', 'ci/cd', 'deployment']),
  rule('database', 'high', ['senior', 'deep-qa'], 'It changes the database schema or a migration.',
    ['migration', 'migrations', 'schema', 'database', 'sql', 'prisma', 'alter table', 'drop table', 'new column', 'index on'],
    ['db/', 'migrations/', '.sql', 'schema.prisma'], ['database', 'schema']),
  rule('deleting', 'medium', ['deep-qa'], 'It deletes data.',
    ['delete', 'deletes', 'deleting', 'deletion', 'purge', 'purges', 'wipe', 'erase', 'truncate', 'remove data', 'remove accounts'],
    ['purge', 'deletion', 'trash'], ['deletion', 'gdpr']),
  rule('public', 'medium', ['security'], 'It changes a page anyone can see without signing in.',
    ['public page', 'public pages', 'public profile', 'public profiles', 'seo', 'landing page', 'share link', 'unauthenticated', 'anonymous', 'logged out'],
    ['pages/public', 'public-profile', 'robots.txt', 'sitemap'], ['public profile', 'seo']),
])

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A whole word or phrase, case-insensitive; a space in it also matches a dash or an underscore. */
const wordRe = w => new RegExp(`(?:^|[^a-z0-9])${escape(w.trim().toLowerCase()).replace(/\s+/g, '[\\s_-]+')}(?=$|[^a-z0-9])`, 'i')
const RE_CACHE = new Map()
const reOf = w => {
  if (!RE_CACHE.has(w)) RE_CACHE.set(w, wordRe(w))
  return RE_CACHE.get(w)
}

/** The request as one text: title, why, every node title, the plan. */
function requestText(flow, planText) {
  const nodes = Array.isArray(flow?.nodes) ? flow.nodes : []
  return [flow?.title, flow?.why, ...nodes.map(n => n?.title), planText].filter(isText).join('\n')
}

/** Which of `r`'s matchers fire on this task. */
function fires(r, { text, labels, files }) {
  const m = r.match || {}
  if ((m.words || []).some(w => reOf(w).test(text))) return true
  const lowLabels = labels.map(l => l.toLowerCase())
  if ((m.labels || []).some(l => lowLabels.some(x => x.includes(l.toLowerCase())))) return true
  // a label is read as words too: "Billing & Payments" fires on the word payments
  if (lowLabels.length && (m.words || []).some(w => lowLabels.some(x => reOf(w).test(x)))) return true
  const lowFiles = files.map(f => f.replace(/\\/g, '/').toLowerCase())
  return (m.paths || []).some(p => lowFiles.some(f => f.includes(p.toLowerCase())))
}

/**
 * The risk label of `flow`: { level, reasons, needs }. `files` the change touched (none before there is a change),
 * `labels` its tickets' labels, `planText` the plan when there is one, `rules` config's (default: the built-in ones).
 * The CONTRACT feat/smart-routing reads through an injected provider: riskOf(flow, { files }).
 */
export function riskOf(flow, { files = [], labels = [], planText = '', rules = DEFAULT_RISK_RULES } = {}) {
  const facts = {
    text: requestText(flow, planText),
    labels: (Array.isArray(labels) ? labels : []).filter(isText),
    files: (Array.isArray(files) ? files : []).filter(isText),
  }
  let level = 0
  const reasons = []
  const needs = []
  for (const r of Array.isArray(rules) ? rules : DEFAULT_RISK_RULES) {
    if (!fires(r, facts)) continue
    level = Math.max(level, LEVELS.indexOf(r.level))
    if (!reasons.includes(r.why)) reasons.push(r.why)
    for (const n of r.needs) if (!needs.includes(n)) needs.push(n)
  }
  return { level: LEVELS[level], reasons, needs }
}

// ═══ the user's rules (config.json quality.riskRules) ═══

const textList = v => Array.isArray(v) && v.every(isText)

/** Why one entry is not a rule, or ''. */
function badRule(r) {
  if (!isObject(r)) return 'is not an object'
  const m = r.match
  if (!isObject(m)) return 'needs "match" with paths, words or labels'
  for (const key of ['paths', 'words', 'labels']) if (m[key] !== undefined && !textList(m[key])) return `needs match.${key} as a list of non-empty text`
  if (!['paths', 'words', 'labels'].some(k => Array.isArray(m[k]) && m[k].length)) return 'needs at least one path, word or label to match'
  if (!LEVELS.includes(r.level)) return `needs "level" as ${LEVELS.join(', ')}`
  if (!(Array.isArray(r.needs) && r.needs.every(n => NEEDS.includes(n)))) return `needs "needs" as a list of ${NEEDS.join(', ')} (or [])`
  if (!isText(r.why) || r.why.length > 160) return 'needs "why", one plain sentence of at most 160 characters'
  return ''
}

/**
 * The rules from config.json quality.riskRules: left out are the defaults; a good list REPLACES them; any bad entry
 * keeps the defaults with ONE warning (`warn`) naming the first bad one.
 */
export function riskRules(raw, warn = console.warn) {
  if (raw === undefined || raw === null) return DEFAULT_RISK_RULES
  if (!Array.isArray(raw)) {
    warn('config.json: quality.riskRules should be a list of { match, level, needs, why }; the built-in risk rules are used.')
    return DEFAULT_RISK_RULES
  }
  const at = raw.findIndex(badRule)
  if (at >= 0) {
    warn(`config.json: quality.riskRules[${at}] ${badRule(raw[at])}; the built-in risk rules are used.`)
    return DEFAULT_RISK_RULES
  }
  return raw.map((r, i) => rule(`rule-${i + 1}`, r.level, [...new Set(r.needs)], r.why.trim(), [...(r.match.words || [])], [...(r.match.paths || [])], [...(r.match.labels || [])]))
}

// ═══ the label over a route ═══

const roleId = (graph, role) => (graph?.nodes || []).find(n => n.role === role)?.id || null

/**
 * The planned `route` with what the label asks for: { steps, missing, unmet, changed }. Security before Push on a build
 * route; Senior (after Human task) before the Output on an ask route; each only when on the pipeline (`graph`).
 * `missing` lists the needs (security, senior) the pipeline has no agent for; `unmet` the ones it has but this KIND of
 * route never passes: Security reviews code changes (build), Senior reviews work done by hand (no code, ask).
 */
export function riskRoute(route, risk, graph) {
  let steps = Array.isArray(route?.steps) ? [...route.steps] : []
  const needs = Array.isArray(risk?.needs) ? risk.needs : []
  const missing = []
  const unmet = []
  const security = roleId(graph, 'security')
  const senior = roleId(graph, 'senior')
  if (needs.includes('security')) {
    if (!security) missing.push('security')
    else if (route?.type !== 'build') unmet.push('security')
    else if (!steps.includes(security) && steps.includes('push')) steps.splice(steps.indexOf('push'), 0, security)
  }
  if (needs.includes('senior')) {
    if (!senior) missing.push('senior')
    else if (route?.type !== 'ask') unmet.push('senior')
    else if (!steps.includes(senior) && steps.at(-1) === 'outcome') {
      const end = steps.pop()
      if (!steps.includes('human')) steps.push('human')
      steps = [...steps, senior, end]
    }
  }
  const changed = JSON.stringify(steps) !== JSON.stringify(route?.steps || [])
  return { steps: changed ? steps : route?.steps || [], missing, unmet, changed }
}

// ═══ words ═══

export const NEED_WORDS = Object.freeze({ security: 'a Security review', senior: 'a Senior review', 'deep-qa': 'a deeper QA pass' })
const joinAnd = parts => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`)

/**
 * One plain line: `Risk: high. It touches sign-in or sessions. It asks for a Security review and a deeper QA pass.`
 * Low is '' (nothing to say), as the page shows no chip for it (QA, 2026-11-26).
 */
export function riskText(risk) {
  if (!isObject(risk) || !LEVELS.includes(risk.level) || risk.level === 'low') return ''
  const needs = (risk.needs || []).map(n => NEED_WORDS[n]).filter(Boolean)
  return [`Risk: ${risk.level}.`, ...(risk.reasons || []), ...(needs.length ? [`It asks for ${joinAnd(needs)}.`] : [])].join(' ')
}
