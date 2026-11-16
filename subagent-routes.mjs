// The routes behind the Subagents page (public/subagents-page.js). Read only, GET only:
//
//   GET /api/subagents?days=1..7[&refresh]   every subagent of the watched repo in the window (today by
//       default), newest first: { at, days, since, counts, subagents: [...] }. Each subagent is what
//       subagents.mjs describes, plus `parent` (the session it belongs to: its label while that session
//       is live), `flow` (the flow that tells its work, subagents.mjs flowFor) with `noStory` (what a
//       builder that is no longer working still owes: no flow, no story or no picture; '' when nothing), and, on its pull
//       requests, the state gh gave (subagent-prs.mjs) when it is known.
//   GET /api/subagents/report?session=<id>&sub=<id>   one subagent's final report in full: { report }
//
// Nothing here runs a model, writes a file or touches the watched repo. The list is kept for a few
// seconds so the page and Home's strip polling together cost one read of the files.

import { flowFor, subagentReport, listRepoSubagents, storyGap, windowStart } from './subagents.mjs'

const CACHE_MS = 5_000 // how long one window's list is reused
const PR_BUDGET_MS = 2_500 // how long a list waits for gh before answering without the states
const MAX_DAYS = 7

/** The `days` of a request: a whole number from 1 to 7, the nearest allowed one otherwise (1 when it is not a number). */
export function daysOf(raw) {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) return 1
  return Math.min(n, MAX_DAYS)
}

/** How many subagents are in each state, and how many are builders and lookups. */
export function countsOf(subagents) {
  const counts = { working: 0, stuck: 0, done: 0, stopped: 0, failed: 0, builders: 0, lookups: 0 }
  for (const h of subagents) {
    if (h.state in counts) counts[h.state]++
    counts[h.builder ? 'builders' : 'lookups']++
  }
  return counts
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * `route(req, res, url)` answers the two paths above and resolves true, or resolves false for any
 * other path. `listWorktrees` is git's worktree list, `sessions` the live sessions as
 * sessionId -> { label }, `flows` every flow (flows.mjs listFlows), `prStates` a makePrStates
 * (subagent-prs.mjs); any of the four may fail without stopping the list.
 */
export function makeSubagentRoutes({ claudeDirs, match, listWorktrees, sessions, flows, prStates, now = Date.now, prBudgetMs = PR_BUDGET_MS }) {
  const cache = new Map() // days -> { at, subagents }
  const building = new Map() // days -> the read in flight

  /** The value of an optional source, or `fallback` when it throws. */
  const soft = async (fn, fallback) => {
    try {
      return (await fn?.()) ?? fallback
    } catch {
      return fallback
    }
  }

  /** The subagents of one window, without pull request states: read at most once per CACHE_MS and once at a time. */
  async function subagentsFor(days, force) {
    const hit = cache.get(days)
    if (!force && hit && now() - hit.at < CACHE_MS) return hit.subagents
    if (!building.has(days)) {
      building.set(days, (async () => {
        const [trees, live, told] = await Promise.all([soft(listWorktrees, null), soft(sessions, new Map()), soft(flows, [])])
        const list = await listRepoSubagents({ claudeDirs, match, sinceMs: windowStart(days, now()), trees, now: now() })
        const subagents = list.map(h => {
          const flow = flowFor(h, told)
          return { ...h, parent: { label: live.get(h.sessionId)?.label || '', live: live.has(h.sessionId) }, flow, noStory: storyGap(h, flow) }
        })
        cache.set(days, { at: now(), subagents })
        return subagents
      })().finally(() => building.delete(days)))
    }
    return building.get(days)
  }

  async function list(url) {
    const days = daysOf(url.searchParams.get('days'))
    const subagents = await subagentsFor(days, url.searchParams.has('refresh'))
    // gh is asked on every list, but each pull request at most once a minute (subagent-prs.mjs).
    await soft(() => prStates?.refresh(subagents.flatMap(h => h.prs), { budgetMs: prBudgetMs }))
    const withPrs = subagents.map(h => ({ ...h, prs: prStates ? prStates.withStates(h.prs) : h.prs }))
    return { at: new Date(now()).toISOString(), days, since: new Date(windowStart(days, now())).toISOString(), counts: countsOf(withPrs), subagents: withPrs }
  }

  return async function route(req, res, url) {
    const isList = url.pathname === '/api/subagents'
    if (!isList && url.pathname !== '/api/subagents/report') return false
    if (req.method !== 'GET') {
      send(res, 405, { error: 'Only GET is supported here.' })
      return true
    }
    try {
      if (isList) send(res, 200, await list(url))
      else {
        const report = await subagentReport({ claudeDirs, match, sessionId: url.searchParams.get('session'), id: url.searchParams.get('sub') })
        if (report == null) send(res, 404, { error: 'No such subagent.' })
        else send(res, 200, { report })
      }
    } catch (e) {
      // the full error stays in the server log; the page gets a line it can show
      console.error('subagents route:', e)
      send(res, 500, { error: isList ? 'Could not read the subagents. Try again.' : 'Could not read that report. Try again.' })
    }
    return true
  }
}
