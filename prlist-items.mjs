// The Pull requests list (the fog on the Agents page and Home), the pure half: which flow names which pull
// request, what gh's JSON about one means, and the list itself. No file, no gh, no clock: prlist-store.mjs
// reads the flows and asks gh, and hands the answers in here.
//
// ═══ WHERE A FLOW'S PULL REQUEST COMES FROM ═══ Two places, and a flow uses one:
//   - `output.pr.url`, the server's record of the pull request the user's Send opened (pr-routes.mjs): read by
//     its link with `gh pr view <url>`;
//   - `output.merge`, the agent's record of the branch its work becomes (`flow pr`, flow-merge.mjs), when no sent
//     pull request stands for it (mergeReady): the agent may have opened the pull request itself, so it is looked
//     up by its branch with `gh pr list --head --base`. Until GitHub says there is one, nothing shows: a record is
//     not a pull request.
// The lookup key carries the record's time (`merge.at`), so a new `flow pr` after a merged pull request is a new
// lookup and the merged one is never read again.
//
// ═══ WHAT IS ON THE LIST ═══ Every flow's pull request that is OPEN on GitHub (a draft too), newest first, until
// it is merged or closed, or the user marks the flow Completed (`completedAt`, completed.mjs). Archived flows
// count: archiving is not a sign-off. Two flows naming the same pull request show it once, on the flow updated
// last. A read that failed keeps the last good answer and marks the item `stale`, so the page can say so; a sent
// pull request not read yet shows from what the flow stored.
//
//   lookupOf(flow)            { key, by: 'url', url } | { key, by: 'head', head, base, at } | null
//   readOf(ghJson)            { url, number, repo, title, state, draft, openedAt, checks, needs } | null
//   prItems(flows, reads)     the list; `reads` is a Map key -> { value: readOf(..) or null (none found), stale }
//   repoOfPrUrl(url)          `owner/name` of a pull request link, or null
//   PR_JSON                   the fields every gh read asks for

import { checksOf } from './pr-check.mjs'
import { isBranch, mergeReady } from './flow-merge.mjs'

export const PR_JSON = 'number,url,title,state,isDraft,createdAt,statusCheckRollup,reviewDecision,reviewRequests,mergeable'
const STATES = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' }
const TITLE_MAX = 300
const PR_LINK = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)\/?$/
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const text = v => (typeof v === 'string' && v.trim() ? v.trim().slice(0, TITLE_MAX) : null)
/** One link, one spelling: no trailing slash, the host in lower case, so two flows naming it match. */
const sameLink = url => String(url).replace(/\/+$/, '').replace(/^https:\/\/([^/]+)/i, (_, host) => `https://${host.toLowerCase()}`)

/** `owner/name` of a GitHub pull request link (github.com or an Enterprise host), else null. */
export function repoOfPrUrl(url) {
  const m = PR_LINK.exec(String(url ?? ''))
  return m ? `${m[1]}/${m[2]}` : null
}

/** What to ask gh about this flow, or null when it names no pull request; see the head of this file. */
export function lookupOf(flow) {
  const out = isObject(flow?.output) ? flow.output : {}
  const pr = isObject(out.pr) ? out.pr : null
  const m = isObject(out.merge) ? out.merge : null
  // a sent pull request stands for the record (mergeReady false): read it by its link
  if (pr?.url && !(m && mergeReady(out))) return PR_LINK.test(pr.url) ? { key: `url:${sameLink(pr.url)}`, by: 'url', url: sameLink(pr.url) } : null
  if (m && isBranch(m.head) && isBranch(m.base)) return { key: `head:${m.head}:${m.base}:${m.at || ''}`, by: 'head', head: m.head, base: m.base, at: m.at || null }
  return null
}

/** The checks in the list's own words: gh's `pending` is `running` here. */
const checksWord = c => (c === 'pending' ? 'running' : ['passing', 'failing', 'none'].includes(c) ? c : null)

/**
 * What gh said about one pull request, or null when it is not one. `needs`: `review` when a review is requested
 * of someone (or the base requires one), `merge` when it is mergeable, its checks pass and nobody asked for
 * changes, else null. A draft, or a pull request no longer open, never needs anyone.
 */
export function readOf(j) {
  if (!isObject(j)) return null
  const state = STATES[String(j.state || '').toUpperCase()]
  const url = typeof j.url === 'string' && PR_LINK.test(j.url) ? sameLink(j.url) : null
  if (!state || !url) return null
  const draft = j.isDraft === true
  const checks = checksWord(checksOf(j.statusCheckRollup))
  const decision = String(j.reviewDecision || '').toUpperCase()
  const asked = (Array.isArray(j.reviewRequests) && j.reviewRequests.length > 0) || decision === 'REVIEW_REQUIRED'
  const green = String(j.mergeable || '').toUpperCase() === 'MERGEABLE' && checks === 'passing' && decision !== 'CHANGES_REQUESTED'
  const needs = state !== 'open' || draft ? null : asked ? 'review' : green ? 'merge' : null
  return {
    url, number: Number.isInteger(j.number) && j.number > 0 ? j.number : Number(PR_LINK.exec(url)[3]),
    repo: repoOfPrUrl(url), title: text(j.title), state, draft, openedAt: text(j.createdAt), checks, needs,
  }
}

/** A sent pull request as the flow stored it, for before the first read. */
function storedOf(pr) {
  const state = ['open', 'merged', 'closed'].includes(pr.state) ? pr.state : 'open'
  const url = sameLink(pr.url)
  return {
    url, number: Number.isInteger(pr.number) ? pr.number : Number(PR_LINK.exec(url)?.[3]) || null, repo: repoOfPrUrl(url),
    title: null, state, draft: false, openedAt: text(pr.openedAt), checks: checksWord(pr.checks), needs: null,
  }
}

/** The list; see the head of this file. */
export function prItems(flows, reads) {
  const known = reads instanceof Map ? reads : new Map()
  const list = (Array.isArray(flows) ? flows : []).filter(f => isObject(f) && typeof f.id === 'string')
  // the flow updated last wins a pull request two flows name: it goes first, and the first one in is kept
  const byNewest = [...list].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
  const seen = new Set()
  const items = []
  for (const flow of byNewest) {
    if (flow.completedAt) continue
    const look = lookupOf(flow)
    if (!look) continue
    const read = known.get(look.key)
    const pr = read ? read.value : look.by === 'url' ? storedOf(flow.output.pr) : null
    if (!pr || pr.state !== 'open' || seen.has(pr.url)) continue
    seen.add(pr.url)
    const label = pr.repo && pr.number ? `${pr.repo} #${pr.number}` : pr.number ? `#${pr.number}` : ''
    items.push({
      key: pr.url, url: pr.url, repo: pr.repo, number: pr.number, label,
      title: pr.title || text(flow.output?.merge?.title) || text(flow.title) || label,
      flow: { id: flow.id, title: String(flow.title ?? '') }, agent: typeof flow.agent === 'string' ? flow.agent : '',
      openedAt: pr.openedAt, draft: pr.draft, checks: pr.checks, needs: pr.needs, stale: !!read?.stale,
    })
  }
  // newest pull request first; one with no opening time goes last, in the order the flows gave
  // (two with no time: -Infinity minus -Infinity is NaN, which is falsy, so the flows' order decides)
  const at = x => (Number.isNaN(x.t) ? -Infinity : x.t)
  return items
    .map((item, i) => ({ item, i, t: Date.parse(item.openedAt || '') }))
    .sort((a, b) => at(b) - at(a) || a.i - b.i)
    .map(x => x.item)
}
