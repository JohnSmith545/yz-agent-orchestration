// Pipeline tokens, the PURE half: what the orchestration's Claude Code sessions spent in tokens, and what those tokens
// would cost at API prices, for the block under Pipeline time on the Agents page (public/token-view.js,
// public/token-strip.js, GET /api/tokens). token-index.mjs reads the transcripts and keeps the running totals; this
// file turns one record into one counted response, and the totals into the block's numbers.
//
//   responseOf(record)                     { kind: 'usage', id, model, at, vec, special } | { kind: 'skip' } | null
//   newTally() / tallyRecord(t, rec, ctx)  one file's running totals, a record at a time, de-duplicated (below)
//   priceTable(tokensBlock)                { prices, errors }: DEFAULT_PRICES with config.json's tokens.prices over them
//   priceFor(model, prices) / costOf(vec, price)   the price a model takes, and dollars for a vector
//   tokenStats({ files, now, days, prices, names, labelOf, finished, spend, building, progress })   the whole block
//
// A VECTOR is [new input, output, 5 minute cache writes, 1 hour cache writes, cache reads, responses] (I O W5 W1 R N).
//
// THE RULES (proved on the real transcripts, 2026-11-25: 507 files, 2.1 GB, 93,467 assistant records)
// - One API response is one assistant record with `message.usage`. A response is written as SEVERAL records, one per
//   content block, sharing `message.id` (and `requestId`). Mostly they carry the same usage; 734 times the first was
//   a partial written while streaming (stop_reason null, a few output tokens) and a later one, at most 10 lines on,
//   the final usage with more output; nothing else ever differed. So: each message id counts ONCE, and a later record
//   of the same id with a bigger usage REPLACES the one counted, while it is still among the file's last TAIL_MAX ids.
//   No id: the request id; neither: skipped.
// - The SAME response can be in two files: 13,755 times. A session moved to the second account's folder carries its
//   history there (the same session id under both ~/.claude and ~/.claude-account2), and a forked session copies its
//   parent's. So de-duplication is across every file: the first file read owns an id (token-index.mjs reads the
//   oldest first), and another file that meets it counts a `dupe` and remembers whose it was (`dupOf`).
// - A record with no usage, an unreadable usage or no time is never guessed: it is counted in `skipped`. A
//   `<synthetic>` reply (an API error or 'No response requested', all zeros) is no API response and is left out.
// - Cache writes come split by lifetime (usage.cache_creation): 5 minute and 1 hour writes have different prices.
//   No split, or a split that does not add up: the rest counts as 5 minute writes, the cheaper rate.
// - Fast mode and US only inference cost more than the standard rates this estimate uses: such responses are
//   counted in `special` so the help can say so (none in the real transcripts on 2026-11-25).
// - The day is the record's own timestamp's LOCAL day, as Pipeline time's period is (time-stats.mjs periodOf).
// - Sessions are named, in this order: the name the dashboard has for it now (a live session or a pin) when config
//   maps that name to a label, else the last `custom-title` record of its newest transcript, else the dashboard's
//   name as it is; then config's maps (labelOf) make the label. With no name at all: Unnamed sessions.
//   A subagent's transcript (<session>/subagents/agent-*.jsonl) counts under the session that started it.
//
// ⚠️ PURE: no file, no clock, no config; token-routes.mjs passes them in.

import { periodOf } from './time-stats.mjs'

export const I = 0
export const O = 1
export const W5 = 2
export const W1 = 3
export const R = 4
export const N = 5
const SLOTS = 6
/** How many of a file's newest ids keep what was counted for them, so a final record can replace a partial one. */
export const TAIL_MAX = 64
const MILLION = 1_000_000
const UNNAMED = 'Unnamed sessions'

/**
 * Dollars per million tokens, from Anthropic's public pricing page, read on 2026-11-25:
 * https://platform.claude.com/docs/en/about-claude/pricing (Model pricing). Only the models the transcripts hold.
 * cacheWrite is the 5 minute cache write, cacheWrite1h the 1 hour one, cacheRead the cache hit.
 * ⚠️ Claude Haiku 5.5 is left out on purpose: its prices double and more for prompts over 100,000 tokens, which one
 * rate per kind cannot say. Prices change: they are the user's to keep current in config.json (tokens.prices).
 */
export const DEFAULT_PRICES = Object.freeze({
  'claude-opus-5-5': Object.freeze({ input: 4, output: 20, cacheWrite: 5, cacheWrite1h: 8, cacheRead: 0.2 }),
  'claude-opus-5': Object.freeze({ input: 5, output: 25, cacheWrite: 6.25, cacheWrite1h: 10, cacheRead: 0.5 }),
  'claude-sonnet-5-5': Object.freeze({ input: 2, output: 10, cacheWrite: 2.5, cacheWrite1h: 4, cacheRead: 0.1 }),
  'claude-fable-5-2': Object.freeze({ input: 8, output: 40, cacheWrite: 10, cacheWrite1h: 16, cacheRead: 0.2 }),
  'claude-fable-5-1': Object.freeze({ input: 10, output: 50, cacheWrite: 12.5, cacheWrite1h: 20, cacheRead: 0.25 }),
})
export const PRICES_SOURCE = Object.freeze({ url: 'https://platform.claude.com/docs/en/about-claude/pricing', read: '2026-11-25' })

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isCount = v => typeof v === 'number' && Number.isFinite(v) && v >= 0
const count = v => (isCount(v) ? v : 0)
const isText = v => typeof v === 'string' && v.trim() !== ''
const pad = n => String(n).padStart(2, '0')
const zero = () => new Array(SLOTS).fill(0)

/** 'YYYY-MM-DD' of the LOCAL day `ms` falls on. */
export function localDay(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
/** Local midnight of a 'YYYY-MM-DD' key. */
const dayMs = key => {
  const [y, m, d] = String(key).split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

// ═══ one record ═══

/** One transcript record as one counted response, `{ kind: 'skip' }` when it cannot be counted, null when it is none. */
export function responseOf(rec) {
  if (!isObject(rec) || rec.type !== 'assistant') return null
  const m = isObject(rec.message) ? rec.message : {}
  if (m.model === '<synthetic>') return null
  const u = m.usage
  const at = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN
  const id = isText(m.id) ? m.id : isText(rec.requestId) ? rec.requestId : null
  if (!isObject(u) || !isCount(u.input_tokens) || !isCount(u.output_tokens) || Number.isNaN(at) || !id) return { kind: 'skip' }
  const writes = count(u.cache_creation_input_tokens)
  const split = isObject(u.cache_creation) ? u.cache_creation : {}
  const w1 = Math.min(count(split.ephemeral_1h_input_tokens), writes)
  const vec = [u.input_tokens, u.output_tokens, writes - w1, w1, count(u.cache_read_input_tokens), 1]
  const special = u.speed === 'fast' || u.inference_geo === 'us'
  return { kind: 'usage', id, model: isText(m.model) ? m.model : 'unknown model', at, vec, special }
}

// ═══ one file's running totals ═══

/**
 * A file's totals: `days` { 'YYYY-MM-DD': { model: vector } }, `ids` every id it counted (it owns them), `tail` its
 * newest ids with what was counted ([id, day, model, vector]), `title` its last custom-title, and the counts the help
 * shows. Plain JSON, so token-index.mjs stores it as it is.
 */
export function newTally() {
  return { days: {}, ids: [], tail: [], title: null, skipped: 0, dupes: 0, special: 0, dupOf: [] }
}

const addInto = (t, day, model, vec, sign = 1) => {
  const models = (t.days[day] ||= {})
  const into = (models[model] ||= zero())
  for (let i = 0; i < SLOTS; i++) into[i] += sign * vec[i]
}

/**
 * One parsed record into tally `t` of the file `self`. `owners` (id -> the file that counted it) is shared by every
 * file, so a response counts once across them all (the rules above).
 */
export function tallyRecord(t, rec, { self, owners }) {
  if (isObject(rec) && rec.type === 'custom-title' && isText(rec.customTitle)) {
    t.title = rec.customTitle.trim()
    return
  }
  const r = responseOf(rec)
  if (!r) return
  if (r.kind === 'skip') {
    t.skipped++
    return
  }
  const owner = owners.get(r.id)
  if (owner === undefined) {
    const day = localDay(r.at)
    owners.set(r.id, self)
    addInto(t, day, r.model, r.vec)
    t.ids.push(r.id)
    t.tail.push([r.id, day, r.model, r.vec])
    if (t.tail.length > TAIL_MAX) t.tail.shift()
    if (r.special) t.special++
    return
  }
  if (owner !== self) {
    t.dupes++
    if (!t.dupOf.includes(owner)) t.dupOf.push(owner)
    return
  }
  // the same response again in this file: a final record replaces a partial one when it says more
  const seen = t.tail.find(x => x[0] === r.id)
  if (!seen || r.vec.every((v, i) => v <= seen[3][i])) return
  const [, day, model, old] = seen
  addInto(t, day, model, old, -1)
  addInto(t, day, model, r.vec)
  seen[3] = r.vec
}

// ═══ prices ═══

const RATES = ['input', 'output', 'cacheWrite', 'cacheRead']

/** DEFAULT_PRICES with config.json's `tokens.prices` over them: an entry adds or replaces one, null removes one. */
export function priceTable(block) {
  const prices = { ...DEFAULT_PRICES }
  const errors = []
  const given = isObject(block) && isObject(block.prices) ? block.prices : {}
  for (const [id, p] of Object.entries(given)) {
    if (p === null) {
      delete prices[id]
      continue
    }
    const ok = isObject(p) && RATES.every(k => isCount(p[k])) && (p.cacheWrite1h === undefined || isCount(p.cacheWrite1h))
    if (!ok) {
      delete prices[id]
      errors.push(id)
      continue
    }
    prices[id] = { input: p.input, output: p.output, cacheWrite: p.cacheWrite, ...(p.cacheWrite1h !== undefined ? { cacheWrite1h: p.cacheWrite1h } : {}), cacheRead: p.cacheRead }
  }
  return { prices, errors }
}

/** The price `model` takes: its exact id, else the longest id it starts with; null when none. */
export function priceFor(model, prices) {
  if (!isText(model) || !isObject(prices)) return null
  if (Object.hasOwn(prices, model)) return { match: model, price: prices[model] }
  let best = null
  for (const id of Object.keys(prices)) if (id && model.startsWith(id) && (!best || id.length > best.length)) best = id
  return best ? { match: best, price: prices[best] } : null
}

/** Dollars for a vector at `price`; 1 hour writes at cacheWrite1h, or at cacheWrite when it is not given. */
export function costOf(vec, price) {
  const w1 = isCount(price.cacheWrite1h) ? price.cacheWrite1h : price.cacheWrite
  return (vec[I] * price.input + vec[O] * price.output + vec[W5] * price.cacheWrite + vec[W1] * w1 + vec[R] * price.cacheRead) / MILLION
}

// ═══ the whole block ═══

const kinds = v => ({ input: v[I], output: v[O], cacheWrite: v[W5] + v[W1], cacheRead: v[R], all: v[I] + v[O] + v[W5] + v[W1] + v[R] })

/** A row's running sums: a vector, dollars for the priced part, whether any part had no price, the models. */
const newSum = () => ({ vec: zero(), usd: 0, priced: false, unpriced: false, models: new Set() })
function addSum(sum, model, vec, priced) {
  for (let i = 0; i < SLOTS; i++) sum.vec[i] += vec[i]
  sum.models.add(model)
  if (priced) {
    sum.usd += costOf(vec, priced.price)
    sum.priced = true
  } else sum.unpriced = true
}
const usdOf = sum => (sum.priced ? sum.usd : null)

/**
 * Each session's name: the dashboard's now when config maps it to a label (flinki-v2-b6 is Security), else the
 * custom-title of its newest main transcript that has one (the name the user gave it: a derived registry name such
 * as flinki-v2-9b says nothing), else the dashboard's name as it is.
 */
function sessionNames(files, names, labelOf) {
  const best = new Map()
  for (const f of files) {
    if (f.sub || !isText(f.title)) continue
    const was = best.get(f.sessionId)
    if (!was || f.mtimeMs > was.mtimeMs) best.set(f.sessionId, f)
  }
  return id => {
    const live = names?.get(id)
    const mapped = isText(live) && labelOf(live) !== live
    return (mapped ? live : null) ?? best.get(id)?.title ?? live ?? null
  }
}

/** The whole block's numbers over the period `days` names (7, 30, or null for All) up to `now`. */
export function tokenStats({ files = [], now = Date.now(), days = 30, prices = {}, names = new Map(), labelOf = n => n, finished = null, spend = null, building = false, progress = 1 } = {}) {
  const list = Array.isArray(files) ? files.filter(isObject) : []
  const allDays = list.flatMap(f => Object.keys(isObject(f.days) ? f.days : {}))
  const first = allDays.length ? Math.min(...allDays.map(dayMs)) : null
  const period = periodOf(now, days, first)
  const today = localDay(now)
  const inPeriod = key => period.from !== null && dayMs(key) >= period.from && key <= today
  const nameOf = sessionNames(list, names, labelOf)
  const priceCache = new Map()
  const priced = model => {
    if (!priceCache.has(model)) priceCache.set(model, priceFor(model, prices))
    return priceCache.get(model)
  }

  const total = newSum()
  const models = new Map()
  const agents = new Map()
  const buckets = new Map()
  const week = period.bucket === 'week'
  const bucketOf = key => {
    if (!week) return key
    const d = new Date(dayMs(key))
    return localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime())
  }
  for (const f of list) {
    const name = nameOf(f.sessionId)
    const label = name === null ? UNNAMED : String(labelOf(name) ?? name)
    if (!agents.has(label)) agents.set(label, { label, sum: newSum(), subs: newSum(), sessions: new Set(), subFiles: 0 })
    const row = agents.get(label)
    let counted = false
    for (const [day, perModel] of Object.entries(isObject(f.days) ? f.days : {})) {
      if (!inPeriod(day) || !isObject(perModel)) continue
      for (const [model, vec] of Object.entries(perModel)) {
        if (!Array.isArray(vec) || vec.length < SLOTS) continue
        const p = priced(model)
        counted = true
        addSum(total, model, vec, p)
        addSum(row.sum, model, vec, p)
        if (f.sub) addSum(row.subs, model, vec, p)
        if (!models.has(model)) models.set(model, newSum())
        addSum(models.get(model), model, vec, p)
        const b = bucketOf(day)
        if (!buckets.has(b)) buckets.set(b, newSum())
        addSum(buckets.get(b), model, vec, p)
      }
    }
    if (counted) {
      row.sessions.add(f.sessionId)
      if (f.sub) row.subFiles++
    }
  }

  const all = kinds(total.vec).all
  const anyPrice = total.priced
  const unpriced = [...models].filter(([, s]) => s.unpriced).map(([m]) => m).sort()
  const agentRows = [...agents.values()]
    .filter(a => a.sessions.size > 0)
    .map(a => ({
      label: a.label,
      sessions: a.sessions.size,
      ...kinds(a.sum.vec),
      responses: a.sum.vec[N],
      usd: usdOf(a.sum),
      unpriced: a.sum.unpriced,
      share: all ? kinds(a.sum.vec).all / all : null,
      models: [...a.sum.models].sort(),
      subs: { files: a.subFiles, ...kinds(a.subs.vec), usd: usdOf(a.subs) },
    }))
    .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.all - a.all || a.label.localeCompare(b.label))
  const modelRows = [...models]
    .map(([model, s]) => {
      const p = priced(model)
      return { model, ...kinds(s.vec), responses: s.vec[N], usd: usdOf(s), price: p ? { match: p.match, ...p.price } : null }
    })
    .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.all - a.all || a.model.localeCompare(b.model))

  const jobs = finished ? (Number(finished.tickets) || 0) + (Number(finished.jobs) || 0) : 0
  const sum = key => list.reduce((t, f) => t + (Number(f[key]) || 0), 0)
  const input = total.vec[I] + total.vec[W5] + total.vec[W1] + total.vec[R]
  const iso = t => (t === null ? null : new Date(t).toISOString())

  return {
    window: { days: period.from !== null && Number.isFinite(days) && days > 0 ? days : null, from: iso(period.from), to: iso(now), dayCount: period.dayCount, bucket: period.bucket },
    totals: { ...kinds(total.vec), responses: total.vec[N] },
    cost: { usd: anyPrice ? total.usd : null, unpriced, unpricedTokens: unpriced.reduce((t, m) => t + kinds(models.get(m).vec).all, 0), w1hAtWriteRate: modelRows.some(m => m.cacheWrite > 0 && m.price && m.price.cacheWrite1h === undefined) },
    perJob: jobs > 0 && all > 0 ? { jobs, tickets: Number(finished.tickets) || 0, otherJobs: Number(finished.jobs) || 0, tokens: all / jobs, usd: anyPrice ? total.usd / jobs : null } : null,
    cacheShare: input > 0 ? total.vec[R] / input : null,
    spend: spend ? { usd: Number(spend.usd) || 0, turns: Number(spend.turns) || 0 } : null,
    agents: agentRows,
    models: modelRows,
    bars: barsOf(period, now, buckets, anyPrice),
    skipped: sum('skipped'),
    dupes: sum('dupes'),
    special: sum('special'),
    files: list.length,
    building: Boolean(building),
    progress: Math.max(0, Math.min(1, Number(progress) || 0)),
  }
}

/** One bar per local day of the period (per week from Monday for All): its tokens and, with any price, its dollars. */
function barsOf(period, now, buckets, anyPrice) {
  if (period.from === null) return []
  const week = period.bucket === 'week'
  const d0 = new Date(period.from)
  const first = week ? new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() - ((d0.getDay() + 6) % 7)).getTime() : period.from
  const bars = []
  const f = new Date(first)
  // 2000 bars is a guard against a clock gone wrong, as Pipeline time's
  for (let i = 0, t = first; t <= now && i < 2000; i++, t = new Date(f.getFullYear(), f.getMonth(), f.getDate() + (week ? 7 * i : i)).getTime()) {
    const key = localDay(t)
    const s = buckets.get(key)
    bars.push({ day: key, tokens: s ? kinds(s.vec).all : 0, usd: anyPrice ? (s ? s.usd : 0) : null })
  }
  return bars
}
