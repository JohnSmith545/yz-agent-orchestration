// The Pipeline tokens route (server.mjs mounts it with makeTokenRoute, beside the other made routes):
//
//   GET /api/tokens[?days=7|30|all]   token-usage.mjs tokenStats over the running index (token-index.mjs) for the
//                                     period, plus { prices: { source, errors, given }, builtAt, lastRead }. Left out
//                                     (or empty) is 30 days, as the score's; the page asks for the window the score
//                                     strip shows, so one switch drives all three blocks.
// Any other window is a 400 with the score's own sentence; any other method a 405. Sent with cache-control no-store.
//
// Rules this file keeps:
// - ⚠️ It never waits on the transcripts. The index is built in the background (start(), right after the server
//   listens) and the route answers from what is ready: `building` true and `progress` (0 to 1) until the first
//   build is done. A request starts a refresh in the background at most once every `refreshMs`.
// - Per finished job divides by Pipeline time's OWN count (time-routes.mjs timeGet, the same flows, the same
//   window), so the two blocks agree on what finished.
// - The dashboard's own runs (spend.mjs spendBetween) are the real dollars of the same period, from local midnight
//   of its first day (All: every line). They ride beside the estimate and are never added to it.
// - Session names come from `names()` (sessionId -> the name the dashboard has now: a live session or a pin), the
//   labels from `labelOf` (server.mjs's own: the coordinator, codingAgents, aliases).

import path from 'node:path'

import { CONFIG } from './config.mjs'
import { DATA_DIR } from './factory-state.mjs'
import { SCORE_WINDOWS } from './score-routes.mjs'
import { spendBetween } from './spend.mjs'
import { timeGet } from './time-routes.mjs'
import { makeTokenIndex } from './token-index.mjs'
import { PRICES_SOURCE, priceTable, tokenStats } from './token-usage.mjs'

const PATH = '/api/tokens'
const REFRESH_MS = 30_000
/** The running index, in the project's data folder (FACTORY_DATA_DIR in tests), never among the transcripts. */
export const TOKEN_INDEX_FILE = path.join(DATA_DIR, 'token-index.json')

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export function makeTokenRoute({ claudeDirs = [], match = '', index = makeTokenIndex({ claudeDirs, match, file: TOKEN_INDEX_FILE }), names = async () => new Map(), labelOf = n => n, config = CONFIG, now = () => Date.now(), refreshMs = REFRESH_MS, log = console.error } = {}) {
  let kickedAt = null
  const kick = () => {
    kickedAt = now()
    index.refresh().catch(err => log(`tokens: could not read the transcripts: ${err?.message || err}`))
  }

  async function tokensGet(raw) {
    const key = raw == null || raw === '' ? '30' : String(raw)
    if (!Object.hasOwn(SCORE_WINDOWS, key)) return { status: 400, body: { error: 'The window must be 7, 30 or all days.' } }
    if (kickedAt === null || now() - kickedAt >= refreshMs) kick()
    const at = now()
    const snap = index.snapshot()
    const { prices, errors } = priceTable(config.tokens)
    let sessionNames = new Map()
    try {
      sessionNames = await names()
    } catch {
      /* the session registry mid-write: the transcripts' own titles only, this once */
    }
    const finished = timeGet(key, { config, now: at }).body.finished
    const days = SCORE_WINDOWS[key]
    const stats = tokenStats({ files: snap.files, now: at, days, prices, names: sessionNames, labelOf, finished, building: snap.building, progress: snap.progress })
    const from = days === null || stats.window.from === null ? null : Date.parse(stats.window.from)
    const spend = spendBetween(from, at)
    const given = config.tokens && typeof config.tokens === 'object' && config.tokens.prices && typeof config.tokens.prices === 'object'
    return {
      status: 200,
      body: { ...stats, spend: { usd: spend.usd, turns: spend.turns }, prices: { source: PRICES_SOURCE, errors, given: Boolean(given) }, builtAt: snap.builtAt, lastRead: snap.lastRead },
    }
  }

  async function route(req, res, url) {
    if (url.pathname !== PATH) return false
    if (req.method !== 'GET') return json(res, 405, { error: 'Only GET is allowed here.' }), true
    const { status, body } = await tokensGet(url.searchParams.get('days'))
    json(res, status, body)
    return true
  }
  /** The first build, in the background: called once the server listens. */
  route.start = kick
  /** What the index holds now, never waiting on a read: the Learn verdicts' cost per job reads it (learn-wiring.mjs). */
  route.snapshot = () => index.snapshot()
  return route
}
