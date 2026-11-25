// What the Standup creator knows before it writes (standup-routes.mjs, the Standup creator on #/generators): the
// author's git work in the window (standup-git.mjs), the saved ticket list, the dashboard's flows and the open
// Human review items. standup-text.mjs turns it into the model's input and the page's Read line.
//
//   gatherFacts({ window, now, git, settings, prefixes, repoName, fallbackBase, readTickets, readFlows, readHuman })
//     → { mode, window, author, name, project, base, commits, merges, unmerged, tickets, next, flows, waiting,
//         ticketListAt, skipped }
//
// Sources, as the user chose them: git, the SAVED ticket list (the factory sources under data/sources/, never a
// live Switchboard call: a GET of the list runs no paid turn) and the flows. The list can be days old, so its
// `fetchedAt` goes to the page and to the model as `ticketListAt`.
//
// Rules this file keeps:
// - ⚠️ The SERVER builds every ticket link (ticketLink, from standup.ticketUrl) and every ticket's whole first line,
//   `ID: title — link`; the model only copies them (standup-prompt.mjs). A ticket the saved list does not have still
//   gets a line: the flow's title, else its first commit's subject, stands in, and `known` is false.
// - A source that fails (a missing or broken file, a git error) is left out and named in `skipped`; it never stops
//   the run. Whose work it is: standup.author, else `git config user.name`. With neither, git is not read at all.
// - `readTickets`, `readFlows` and `readHuman` are injected (server.mjs passes the real readers), so tests never
//   touch data/.

import { cleanSubject, readGit } from './standup-git.mjs'
import { idsInText } from './ticket-ids.mjs'

export const DEFAULT_TICKET_URL = 'https://app.switchboardpm.ai/stories/{id}'
/** Ticket states that mean work in hand (the real states in data/sources/*.json), in the order What's next lists them. */
export const IN_PROGRESS = Object.freeze(['Started', 'Rejected', 'Finished', 'Delivered'])
const NEXT_MAX = 25
const WAITING_MAX = 20
/** The Human review kinds (human.mjs) that go into the facts as Blocker candidates. */
export const WAITING_KINDS = Object.freeze(['ask', 'hand', 'blocked'])
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/

const text = v => (typeof v === 'string' ? v.trim() : '')

/**
 * The `standup` block of config.json, every key optional: { author, name, project, base, ticketUrl }. A link pattern
 * must be http(s) and hold {id}; a base must look like a branch (never a flag). A bad value falls back with a warning.
 */
export function standupSettings(raw, warn = console.warn) {
  const out = { author: '', name: '', project: '', base: '', ticketUrl: DEFAULT_TICKET_URL }
  if (raw === undefined || raw === null) return out
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warn('config.json: "standup" should be an object such as { "name": "Your Name" }; the defaults are used.')
    return out
  }
  for (const k of ['author', 'name', 'project']) out[k] = text(raw[k])
  const base = text(raw.base)
  if (base && BRANCH.test(base) && !base.startsWith('-')) out.base = base
  else if (base) warn('config.json: standup.base needs a branch name such as origin/dev; origin/HEAD is used.')
  const url = text(raw.ticketUrl)
  if (url && /^https?:\/\//.test(url) && url.includes('{id}')) out.ticketUrl = url
  else if (url) warn('config.json: standup.ticketUrl needs an http(s) address with {id} in it; the Switchboard link is used.')
  return out
}

/** A ticket's link: `{id}` in the pattern replaced by the id, encoded. */
export const ticketLink = (pattern, id) => String(pattern).split('{id}').join(encodeURIComponent(id))

/**
 * The saved ticket list across every collection (factory.mjs `collections()` and `readSource`, injected):
 * { fetchedAt, tickets }, the first collection that has a ticket wins, and `fetchedAt` is the OLDEST save, since
 * that is how old the facts can be. Throws when no collection has a saved list (gatherFacts names it as left out).
 */
export function savedTicketList({ collections, readSource }) {
  const tickets = {}
  let fetchedAt = null
  let any = false
  for (const c of collections || []) {
    let src = null
    try {
      src = readSource(c.id)
    } catch {
      src = null
    }
    if (!src || typeof src.tickets !== 'object') continue
    any = true
    if (typeof src.fetchedAt === 'string' && (!fetchedAt || Date.parse(src.fetchedAt) < Date.parse(fetchedAt))) fetchedAt = src.fetchedAt
    for (const [id, t] of Object.entries(src.tickets)) if (!(id in tickets)) tickets[id] = { ...t, id }
  }
  if (!any) throw new Error('No saved ticket list.')
  return { fetchedAt, tickets }
}

/** Run a reader; a throw becomes a `skipped` entry and `fallback`. */
function attempt(fn, title, why, skipped, fallback) {
  try {
    return fn()
  } catch {
    skipped.push({ title, why })
    return fallback
  }
}

const within = (iso, window) => {
  const t = Date.parse(iso || '')
  return !Number.isNaN(t) && t >= Date.parse(window.from) && t <= Date.parse(window.to)
}

export async function gatherFacts({
  window, now = new Date(), git, settings = standupSettings(undefined), prefixes = [], repoName = '', fallbackBase = 'origin/dev',
  readTickets = () => null, readFlows = () => [], readHuman = () => [],
}) {
  const skipped = []
  let author = settings.author
  if (!author) {
    const r = await git(['config', 'user.name'])
    author = r.ok ? text(r.out) : ''
  }
  let base = settings.base
  if (!base) {
    const r = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    base = r.ok && BRANCH.test(text(r.out)) ? text(r.out) : fallbackBase
  }
  let g = { commits: [], merges: [], unmerged: [], skipped: [] }
  if (author) g = await readGit({ git, author, base, window, prefixes })
  else skipped.push({ title: 'Git', why: 'No author: set standup.author in config.json or git config user.name in the repo.' })
  skipped.push(...g.skipped)

  const list = attempt(readTickets, 'Ticket list', 'The saved ticket list could not be read.', skipped, null)
  const saved = list && typeof list.tickets === 'object' ? list.tickets : {}
  const flowsAll = attempt(readFlows, 'Flows', 'The flows could not be read.', skipped, [])
  const humanAll = attempt(readHuman, 'Waiting items', 'What waits on you could not be read.', skipped, [])

  // ⚠️ Only TICKET work from the flows and Human review: an item goes in only when it carries a ticket id of the
  // configured prefixes, and only those ids go with it. The dashboard's own flows (no ticket, or a test ticket such
  // as ABC-101) once reached a stand-up as "Agent tooling in the dashboard" (QA, 2026-11-25). Left out silently:
  // it is not a failed source, so it is not in `skipped`.
  const oursOf = ids => (Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && idsInText(id, prefixes)[0] === id)
  const flows = (Array.isArray(flowsAll) ? flowsAll : [])
    .filter(f => f && !f.deletedAt && (within(f.updatedAt, window) || within(f.createdAt, window)))
    .map(f => ({ id: f.id, title: text(f.title) || f.id, status: f.status, agent: text(f.agent), tickets: oursOf(f.tickets), updatedAt: f.updatedAt }))
    .filter(f => f.tickets.length)
  // Only what really waits on a person for this work: questions, by-hand steps and blocked flows. A `ticket` row is a
  // tracker ticket merely marked no-code: backlog, not a blocker, so it stays out (silently, like the rest above).
  const waiting = (Array.isArray(humanAll) ? humanAll : [])
    .filter(i => i && WAITING_KINDS.includes(i.kind))
    .map(i => ({ kind: i.kind, title: text(i.title), reason: text(i.reason), tickets: oursOf(Array.isArray(i.tickets) ? i.tickets : i.ticketId ? [i.ticketId] : []) }))
    .filter(i => i.tickets.length)
    .slice(0, WAITING_MAX)
  const next = Object.values(saved)
    .filter(t => t && t.owner === 'me' && IN_PROGRESS.includes(t.state))
    .sort((a, b) => IN_PROGRESS.indexOf(a.state) - IN_PROGRESS.indexOf(b.state) || String(a.id).localeCompare(String(b.id), 'en', { numeric: true }))
    .slice(0, NEXT_MAX)

  // every ticket the stand-up may name, each once: the work first, then what waits, then what is in hand
  const ids = [
    ...g.merges.flatMap(m => m.ids), ...g.commits.flatMap(c => c.ids), ...g.unmerged.flatMap(u => u.ids),
    ...flows.flatMap(f => f.tickets), ...waiting.flatMap(w => w.tickets), ...next.map(t => t.id),
  ]
  const tickets = [...new Set(ids)].map(id => {
    const t = saved[id]
    const stand = flows.find(f => f.tickets.includes(id))?.title || cleanSubject(g.commits.find(c => c.ids.includes(id))?.subject) || 'title not in the saved ticket list'
    const title = text(t?.title) || stand
    const link = ticketLink(settings.ticketUrl, id)
    return { id, title, state: text(t?.state), mine: t?.owner === 'me', known: !!t, link, line: `${id}: ${title} — ${link}` }
  })

  return {
    mode: window.mode, window, author, base,
    name: settings.name || author, project: settings.project || repoName,
    commits: g.commits, merges: g.merges, unmerged: g.unmerged, tickets,
    next: next.map(t => tickets.find(x => x.id === t.id)), flows, waiting,
    ticketListAt: typeof list?.fetchedAt === 'string' ? list.fetchedAt : null, skipped, builtAt: now.toISOString(),
  }
}
