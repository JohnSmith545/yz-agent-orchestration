// Ticket intake on the Tickets page: each ticket sorted into what kind of work it is, with the reason, and likely
// duplicates among the open tickets flagged. Pure: the store is routing-intake-store.mjs, the model run
// routing-intake-run.mjs, the page public/routing-tickets.js.
//
//   KINDS                           code | no-code | needs-a-person
//     code             a change to the code an agent can build and QA can test
//     no-code          work with no code change: a console, DNS, a cloud or analytics setting, a manual check. An
//                      agent can write the steps; a person does them (Human review, By hand)
//     needs-a-person   a decision or an act only a person can take: legal, billing, a sign-off, marketing, access
//   intakeRules(ticket)             { kind, confidence, reason } from its words, labels and story type
//   sortTickets(tickets, stored)    id -> { kind, reason, by: you | model | rules, confidence }: the user's correction
//                                   wins, then the model's answer, then the rules
//   unsureIds(tickets, sorted)      the open tickets the rules could not sort and nobody else has, at most MODEL_MAX
//   intakePrompt(tickets)           { system, text } for the ONE cheap model run over them
//   parseIntakeReply(reply, ids)    id -> { kind, reason } for the asked ids only; anything else is dropped
//   duplicates(tickets, notDup)     id -> { of, reason }: a later open ticket that looks like an earlier one
//   pairKey(a, b)                   the key a remembered Not a duplicate is stored under
//   humanKinds(sorted)              id -> kind, only the sure ones: what the Human review list reads
//
// ═══ THE RULES ═══ Like routing-type.mjs: weighted words, a `Prefix:` bonus, the story type (a bug or a feature is
// code). certain needs a strong lead; likely a clear one; anything else is unsure, and only an unsure ticket goes to
// the model, and only when the user switched the model on (config routing.intakeModel).
// ═══ DUPLICATES ═══ No model. The words of a title leave out its `Heading:` (two, as in SEO Monitoring: Alert on:),
// common words and checklist boilerplate (verify, check, define, configured...). Two open tickets are a likely pair
// when they share at least DUP_SHARED words and either those make up at least DUP_RATIO of all their words, or one
// of them is a NAME (written with a capital in both titles, not just as the first word of both, and in no other open
// title: Sentry, Firestore) and they make up at least NAME_RATIO. Or a ticket's title names another open ticket's id.
// Tuned on the 112 real tickets (QA, 2026-11-26): the old rule flagged none and missed Sentry error reporting against
// Sentry error monitoring. The later ticket (higher number) looks like the earlier one. A pair the user
// marked Not a duplicate is never shown again.

import { DONE_STATES } from './human.mjs'
import { buildsCode } from './routing-type.mjs'

export const KINDS = Object.freeze(['code', 'no-code', 'needs-a-person'])
export const MODEL_MAX = 30
const PREFIX_BONUS = 2
const STORY_WEIGHT = 2
const CERTAIN_MIN = 5
const LIKELY_MIN = 2
const DUP_SHARED = 2
const DUP_RATIO = 0.6
const NAME_RATIO = 0.25
const NAME_MAX_TITLES = 2
const REASON_MAX = 140

// `place`: console, DNS, billing, account and legal name WHERE work happens; a title that builds a UI or code object
// (routing-type.mjs buildsCode: Add a refund button to billing) is code, so they do not count there (QA, 2026-11-26)
const W = (re, weight, word, place = false) => ({ re: new RegExp(`(?:^|[^a-z0-9])(?:${re})(?![a-z0-9])`), weight, word, place })
const WORDS = {
  code: [W('bug', 2, 'bug'), W('fix(?:es|ed)?', 1, 'fix'), W('feat(?:ure)?', 2, 'feature'), W('add(?:s|ed)?', 1, 'add'), W('implement(?:ed)?', 2, 'implement'),
    W('refactor', 3, 'refactor'), W('crash(?:es|ed)?', 2, 'crash'), W('errors?', 1, 'error'), W('api', 2, 'API'), W('endpoints?', 2, 'endpoint'),
    W('component', 2, 'component'), W('button', 2, 'button'), W('page', 1, 'page'), W('ui', 1, 'UI'), W('css', 2, 'CSS'), W('n\\+1', 3, 'N+1'),
    W('quer(?:y|ies)', 2, 'query'), W('indexes', 2, 'indexes'), W('minify', 3, 'minify'), W('caching', 2, 'caching'), W('feature flags?', 3, 'feature flag'),
    W('robots\\.txt', 2, 'robots.txt'), W('sitemap', 2, 'sitemap'), W('json-ld|schema', 2, 'schema'), W('headers', 2, 'headers'), W('unit tests?', 2, 'unit tests'),
    W('distorted|truncated', 1, 'layout')],
  'no-code': [W('console', 3, 'console', true), W('dns', 3, 'DNS', true), W('gsc', 3, 'GSC'), W('webmaster', 3, 'Webmaster'), W('cloud hosting', 2, 'cloud hosting'),
    W('quotas?', 3, 'quota'), W('google analytics', 2, 'Google Analytics'), W('semrush', 3, 'Semrush'), W('configured?', 1, 'configure'),
    W('enabled?', 1, 'enable'), W('iam', 2, 'IAM'), W('secret manager', 2, 'Secret Manager'), W('smoke test', 3, 'smoke test'), W('verify', 1, 'verify'),
    W('check (?:production|prod|ga|monitoring)', 3, 'check'), W('drill', 3, 'drill'), W('manual(?:ly)?', 3, 'manual'), W('by hand', 3, 'by hand'),
    W('backups? (?:scheduled|taken|restore)|take final manual db backup', 2, 'backup'), W('alerts? routed', 3, 'alert routing'), W('environment variables', 2, 'environment variables')],
  'needs-a-person': [W('legal', 4, 'legal', true), W('privacy policy', 3, 'privacy policy'), W('terms of service', 3, 'terms of service'), W('billing', 4, 'billing', true),
    W('account', 1, 'account', true), W('sign[- ]?off', 4, 'sign off'), W('marketing', 4, 'marketing'), W('access review|grant access|access', 3, 'access'),
    W('contract', 4, 'contract'), W('purchase|buy', 3, 'purchase'), W('approv(?:e|al)', 3, 'approval'), W('decision|decide', 3, 'decision'),
    W('communicate|notify team', 3, 'tell the team'), W('on-call rota', 3, 'on-call rota'), W('budget', 3, 'budget'), W('kpis?', 2, 'KPIs'), W('vendor', 3, 'vendor')],
}
const STORY = Object.freeze({ bug: 'code', feature: 'code' })
const NAME = Object.freeze({ code: 'code', 'no-code': 'no code', 'needs-a-person': 'needs a person' })

const lower = v => (typeof v === 'string' ? v : '').toLowerCase()
const list = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`)
const oneLine = (s, max = REASON_MAX) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`
}
const open = t => !DONE_STATES.includes(t?.state)

export function intakeRules(ticket) {
  const title = lower(ticket?.title)
  const prefix = /^\s*([^:]{1,40}):/.exec(title)?.[1] || ''
  const labels = Array.isArray(ticket?.labels) ? ticket.labels.map(lower).join(' | ') : ''
  const score = {}
  const builds = buildsCode(title)
  for (const [kind, words] of Object.entries(WORDS)) {
    for (const w of words) {
      if (w.place && builds) continue
      const inTitle = w.re.test(title)
      if (!inTitle && !w.re.test(labels)) continue
      const s = (score[kind] ||= { n: 0, words: [], story: false })
      s.n += (inTitle ? w.weight : w.weight / 2) + (inTitle && w.re.test(prefix) ? PREFIX_BONUS : 0)
      if (!s.words.includes(w.word)) s.words.push(w.word)
    }
  }
  const story = STORY[lower(ticket?.type).trim()]
  if (story) {
    const s = (score[story] ||= { n: 0, words: [], story: false })
    s.n += STORY_WEIGHT
    s.story = true
  }
  const ranked = Object.entries(score).sort((a, b) => b[1].n - a[1].n || KINDS.indexOf(a[0]) - KINDS.indexOf(b[0]))
  const [top, next] = ranked
  if (!top || top[1].n < 1) return { kind: 'code', confidence: 'unsure', reason: 'Too little to go on: no words or labels say what kind of work this is.' }
  const why = s => [s.words.length ? `the words ${list(s.words.slice(0, 3))}` : '', s.story ? `the story type ${lower(ticket.type)}` : ''].filter(Boolean).join(' and ')
  const second = next?.[1].n || 0
  if (top[1].n === second) return { kind: top[0], confidence: 'unsure', reason: oneLine(`Unsure between ${NAME[top[0]]} and ${NAME[next[0]]}: ${why(top[1])}; ${why(next[1])}.`) }
  const confidence = top[1].n >= CERTAIN_MIN && top[1].n >= 2 * second ? 'certain' : top[1].n >= LIKELY_MIN ? 'likely' : 'unsure'
  const lead = `${NAME[top[0]].charAt(0).toUpperCase()}${NAME[top[0]].slice(1)}`
  return { kind: top[0], confidence, reason: oneLine(`${lead}: ${why(top[1])}.`) }
}

/** A stored answer that can be used: a known kind, by the user or the model. */
const usable = s => s && typeof s === 'object' && KINDS.includes(s.kind) && (s.by === 'you' || s.by === 'model')

export function sortTickets(tickets, stored = {}) {
  const out = {}
  for (const t of Array.isArray(tickets) ? tickets : []) {
    if (!t?.id) continue
    const s = stored?.[t.id]
    if (usable(s)) out[t.id] = { kind: s.kind, reason: oneLine(s.reason || (s.by === 'you' ? 'Set by you.' : 'Sorted by the model.')), by: s.by, confidence: s.by === 'you' ? 'certain' : 'likely' }
    else out[t.id] = { ...intakeRules(t), by: 'rules' }
  }
  return out
}

export function unsureIds(tickets, sorted) {
  return (Array.isArray(tickets) ? tickets : []).filter(t => open(t) && sorted?.[t.id]?.by === 'rules' && sorted[t.id].confidence === 'unsure').map(t => t.id).slice(0, MODEL_MAX)
}

const clean = s => String(s ?? '').replace(/[\r\n|]+/g, ' ').trim().slice(0, 200)

export function intakePrompt(tickets) {
  const system = [
    'You sort tickets from a software team\'s tracker into what kind of work each one is. For each ticket answer with exactly one kind:',
    '- code: a change to the code that a coding agent can build and a tester can test.',
    '- no-code: work with no code change, done in a console, DNS, a cloud or analytics setting, or by checking something by hand.',
    '- needs-a-person: a decision or an act only a person can take, such as legal, billing, a sign-off, marketing or giving access.',
    'Reply with ONLY a JSON array, one object per ticket: [{"id":"ABC-1","kind":"code","reason":"one short plain sentence"}].',
    'Keep each reason under 20 words. Use only the ids you are given.',
  ].join('\n')
  const text = (Array.isArray(tickets) ? tickets : []).map(t => [t.id, clean(t.title), `labels: ${(t.labels || []).map(clean).join(', ') || 'none'}`, `type: ${clean(t.type) || 'none'}`].join(' | ')).join('\n')
  return { system, text }
}

export function parseIntakeReply(reply, ids) {
  if (typeof reply !== 'string') return {}
  const start = reply.indexOf('[')
  const end = reply.lastIndexOf(']')
  if (start < 0 || end <= start) return {}
  let items
  try {
    items = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return {}
  }
  const asked = new Set(ids || [])
  const out = {}
  for (const i of Array.isArray(items) ? items : []) {
    if (!i || typeof i !== 'object' || !asked.has(i.id) || !KINDS.includes(i.kind)) continue
    out[i.id] = { kind: i.kind, reason: oneLine(typeof i.reason === 'string' && i.reason.trim() ? i.reason : 'Sorted by the model.') }
  }
  return out
}

// ═══ duplicates ═══

/** Checklist boilerplate: the verbs and filler every checklist title uses, which say nothing about WHAT it is. */
const BOILER = new Set(['verify', 'check', 'define', 'set', 'setup', 'enable', 'configure', 'create', 'implement', 'document', 'ensure', 'perform',
  'live', 'prod', 'production', 'plan', 'run', 'web', 'app', 'site', 'use', 'using', 'after', 'before', 'each', 'one'])
const STOP = new Set(['the', 'and', 'for', 'with', 'not', 'does', 'did', 'are', 'was', 'from', 'into', 'onto', 'this', 'that', 'when', 'all', 'any', 'our', 'your', 'its', 'has', 'have', 'can', 'cannot', 'will', 'should', 'same', 'like', 'per', 'via', 'bug', 'feat', 'fix', 'add', 'new', 'page'])
/** A light stem, so load and loading match; a short word is left whole (feed must not become fe). */
const stem = w => (w.length > 4 ? w.replace(/(?:ing|ed|es|s)$/, '') : w)
/**
 * The significant words of a title, without its `Heading:` prefix: stem -> the word as written (for the reason), lower
 * case, no short or common words.
 */
/** A title without its heading, or two (SEO Monitoring: Alert on: ...). */
const bodyOf = title => String(title ?? '').replace(/^\s*[^:]{1,40}:\s*/, '').replace(/^\s*[^:]{1,40}:\s*/, '')

function wordsOf(title) {
  const out = new Map()
  for (const w of bodyOf(title).toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOP.has(w) || BOILER.has(w) || /^\d+$/.test(w)) continue
    const s = stem(w)
    if (s.length >= 3 && !STOP.has(s) && !BOILER.has(s) && !out.has(s)) out.set(s, w)
  }
  return out
}

/** The stems a title writes with a capital: { first: as the body's first word, later: anywhere after it }. */
function capitalsOf(title) {
  const raw = bodyOf(title).split(/[^A-Za-z0-9]+/).filter(Boolean)
  const caps = raw.map((w, i) => ({ s: stem(w.toLowerCase()), first: i === 0, cap: /^[A-Z]/.test(w) })).filter(x => x.cap)
  return { first: new Set(caps.filter(x => x.first).map(x => x.s)), later: new Set(caps.filter(x => !x.first).map(x => x.s)) }
}

/** A stem as the title writes it (Sentry, not sentry), for the reason. */
const wordAsWritten = (title, k) => bodyOf(title).split(/[^A-Za-z0-9]+/).find(w => stem(w.toLowerCase()) === k) || k
const numOf = id => Number(String(id).split('-').at(-1)) || 0

export const pairKey = (a, b) => [a, b].sort().join('|')

export function duplicates(tickets, notDup = {}) {
  const live = (Array.isArray(tickets) ? tickets : []).filter(t => t?.id && open(t)).sort((a, b) => numOf(a.id) - numOf(b.id) || a.id.localeCompare(b.id))
  const ids = new Set(live.map(t => t.id))
  const words = new Map(live.map(t => [t.id, wordsOf(t.title)]))
  const caps = new Map(live.map(t => [t.id, capitalsOf(t.title)]))
  const titlesWith = new Map()
  for (const w of words.values()) for (const k of w.keys()) titlesWith.set(k, (titlesWith.get(k) || 0) + 1)
  /** A name: both titles write it with a capital, not only as the first word of both, and no other open title has it. */
  const isName = (k, x, y) => {
    const a = caps.get(x)
    const b = caps.get(y)
    const capped = c => c.first.has(k) || c.later.has(k)
    return capped(a) && capped(b) && (a.later.has(k) || b.later.has(k)) && titlesWith.get(k) <= NAME_MAX_TITLES
  }
  const out = {}
  const skip = (a, b) => !!notDup?.[pairKey(a, b)]
  for (const t of live) {
    // a title that names another open ticket
    const named = [...String(t.title ?? '').matchAll(/\b[A-Z][A-Z0-9]*-\d+\b/g)].map(m => m[0]).find(id => id !== t.id && ids.has(id) && !skip(t.id, id))
    if (named) {
      out[t.id] = { of: named, reason: `Its title names ${named}.` }
      continue
    }
    let best = null
    for (const e of live) {
      if (numOf(e.id) >= numOf(t.id) && !(numOf(e.id) === numOf(t.id) && e.id < t.id)) continue
      if (skip(t.id, e.id)) continue
      const a = words.get(t.id)
      const b = words.get(e.id)
      const shared = [...a.keys()].filter(w => b.has(w))
      const ratio = shared.length / new Set([...a.keys(), ...b.keys()]).size
      const named = shared.filter(w => isName(w, t.id, e.id))
      const pair = shared.length >= DUP_SHARED && (ratio >= DUP_RATIO || (named.length >= 1 && ratio >= NAME_RATIO))
      // the reason names the shared names first, as the title writes them
      const said = [...named.map(w => wordAsWritten(t.title, w)), ...shared.filter(w => !named.includes(w)).map(w => a.get(w))]
      if (pair && (!best || ratio > best.ratio)) best = { of: e.id, ratio, shared: said }
    }
    if (best) out[t.id] = { of: best.of, reason: oneLine(`Both titles say ${list(best.shared.slice(0, 4))}.`) }
  }
  return out
}

export function humanKinds(sorted) {
  const out = {}
  for (const [id, s] of Object.entries(sorted || {})) if (KINDS.includes(s?.kind) && s.confidence !== 'unsure') out[id] = s.kind
  return out
}
