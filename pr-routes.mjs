// The Send routes (factory-routes.mjs mounts them under /api/flows/<id>/):
//
//   GET  pr           { merge, pr, ready, digest, facts }: the facts computed on request (pr-check.mjs),
//                     cached 20 s per flow, after a `git fetch <remote> --prune` at most once a minute;
//                     `digest` is the sha256 of what the page shows for review (head, base, title, body).
//                     An open pull request for exactly that head and base, with none stored, is adopted.
//   POST pr           { pin, confirm: { head, sha, digest } }: the person's click. Checks the send PIN,
//                     that nothing changed since the review, the blockers; pushes EXACTLY the reviewed
//                     commit, opens the pull request with gh, stores `output.pr`, returns { ok, pr }
//   POST pr/refresh   reads the pull request's state and checks, stores and returns { pr }
//
// ═══ THE ONE EXCEPTION TO READ-ONLY ═══ The dashboard never changes the watched repo, except here,
// and only when Send is turned on with a send PIN (config pr.enabled + pr.pinHash) and the person
// types that PIN: `git push <remote> <sha>:refs/heads/<head>` (the full refspec; never --force, never
// a +, no tags; a refused push is shown, never retried) and `gh pr create`. Nothing else: no commit,
// merge, checkout, branch delete, rebase or `gh pr merge`. A head that is a base, HEAD or a pr.protect
// pattern is refused. Every command is an argv array, never a shell string, and every gh value goes as
// one `--flag=value` argument, so a value that starts with a dash is never read as a flag.
//
// ═══ THE QA GATE ═══ A flow that produced code is sent only after QA passed it, and only at the very commit QA
// tested (flow-qa.mjs qaBlockers adds both as blockers to pr-check.mjs's facts). The flow's `qa` is part of the
// facts' cache key, so a new QA result shows at once.
//
// Each handler returns { status, body }. `deps` is { git, push?, gh, pr, port, fetched? }: the runners
// (server.mjs; the tests pass stubs; `push` has its own longer timeout), the Send settings (config.mjs
// prSettings), the dashboard's port (local-origin.mjs), and when the server last fetched a remote.

import { createHash, randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { creditProblem, mergeReady, textCredit } from './flow-merge.mjs'
import { qaBlockers } from './flow-qa.mjs'
import { readFlow, validateFlow, writeFlow } from './flows.mjs'
import { originAllowed } from './local-origin.mjs'
import { checksOf, prFacts, prUrlOf, scrub } from './pr-check.mjs'
import { sharedLock, verifyPin } from './send-pin.mjs'

const FACTS_MS = 20_000
const FETCH_MS = 60_000
const facts = new Map() // flow id -> { key, at, facts }
const fetchedAt = new Map() // remote -> ms
const fetchFailed = new Map() // remote -> whether the last fetch failed
const busy = new Set() // flow ids sending now

/** Tests start clean: no cached facts, no recent fetch, nothing sending, no wrong PINs. */
export function resetPrState() {
  facts.clear()
  fetchedAt.clear()
  fetchFailed.clear()
  busy.clear()
  sharedLock.reset()
}

/** The sha256 of what the person reviews: if any of it changes, the click no longer approves it. */
export const digestOf = merge => createHash('sha256')
  .update(JSON.stringify({ head: merge.head, base: merge.base, title: merge.title, body: merge.body })).digest('hex')

const answer = (status, body) => ({ status, body })
const noFlow = id => answer(404, { error: `No flow ${id}.` })
const STALE = 'Changed since you reviewed it. Review again.'
const NO_PIN = 'Sending is off: set a send PIN in Settings.'

/**
 * The environment of Send's push: ssh in batch mode (a missing key fails at once instead of waiting on a
 * prompt nobody sees), unless the repo (`core.sshCommand`, given as `configured`) or the environment
 * already names an ssh command of its own, which is kept.
 */
export const pushEnv = (configured, env = process.env) =>
  String(configured || '').trim() || env.GIT_SSH_COMMAND ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }

function load(id) {
  const flow = readFlow(id)
  if (!flow) return null
  const problems = validateFlow(flow)
  if (problems.length) throw new Error(problems.join('\n'))
  return flow
}

/** `git fetch <remote> --prune`, at most once a minute, and not when the server fetched that remote in the last minute. */
async function freshen(remote, { git, fetched }) {
  const now = Date.now()
  const last = Math.max(fetchedAt.get(remote) || 0, Date.parse(fetched?.(remote) || '') || 0)
  if (now - last < FETCH_MS) return
  fetchedAt.set(remote, now)
  fetchFailed.set(remote, !(await git(['fetch', remote, '--prune', '--quiet'])).ok)
}

/** The facts for a flow's merge record, with the QA gate's blockers; `fresh` skips the cache (a send always looks again). */
async function factsFor(flow, merge, deps, fresh = false) {
  const { id } = flow
  const { pr } = deps
  const key = JSON.stringify([merge, pr, flow.qa ?? null])
  const hit = facts.get(id)
  if (!fresh && hit && hit.key === key && Date.now() - hit.at < FACTS_MS) return hit.facts
  if (pr.enabled) await freshen(pr.remote, deps)
  const f = await prFacts({
    ...merge, remote: pr.remote, bases: pr.bases, protect: pr.protect, enabled: pr.enabled, off: pr.off,
    git: deps.git, gh: deps.gh, fetchFailed: !!fetchFailed.get(pr.remote),
  })
  f.blockers.push(...qaBlockers(flow, f.sha))
  facts.set(id, { key, at: Date.now(), facts: f })
  return f
}

/** Store `pr` on the flow as it is NOW (re-read, so an agent write in between is kept). */
function storePr(id, pr) {
  const flow = readFlow(id)
  if (!flow) return
  flow.output = { ...flow.output, pr }
  writeFlow(flow)
}

/**
 * What a failed send stores: the reason (and that the branch was pushed, when it was), and any earlier
 * pull request kept under `previous`, so a failed try never wipes the record of one that was opened.
 */
function failedRecord(id, error, pushed) {
  const old = readFlow(id)?.output?.pr
  const previous = old?.url ? { ...old, previous: undefined } : old?.previous
  if (previous) delete previous.previous
  return { error, ...(pushed ? { pushed: true } : {}), ...(previous ? { previous } : {}) }
}

// ═══ GET pr ═══

export async function prGet(id, deps) {
  const flow = load(id)
  if (!flow) return noFlow(id)
  const out = flow.output || {}
  const merge = out.merge ?? null
  let pr = out.pr ?? null
  let ready = mergeReady(out)
  // a pull request that stands for this record needs no facts: the page shows its state
  const f = merge && ready ? await factsFor(flow, merge, deps) : null
  if (f?.existingPr?.state === 'open' && !pr?.url) {
    // opened by hand (or by an earlier dashboard) for exactly this head and base: adopt it
    pr = { url: f.existingPr.url, number: f.existingPr.number, state: 'open', openedAt: new Date().toISOString(), checks: 'pending', checkedAt: null, error: null }
    storePr(id, pr)
    facts.delete(id)
    ready = false
  }
  return answer(200, { merge, pr, ready, digest: merge ? digestOf(merge) : null, facts: ready ? f : null })
}

// ═══ POST pr ═══

/**
 * The send. ⚠️ Three locks, each for a different threat:
 *   - the Origin must be the dashboard's own (127.0.0.1 or localhost at its port, local-origin.mjs), and a
 *     request with none is refused, unlike the other routes: an ordinary website or a script is out;
 *   - the send PIN (send-pin.mjs), five wrong tries lock it for ten minutes: anything that drives the page
 *     itself (the chat agent's browser, a rebinding site, a stale tab) does not know it;
 *   - `confirm` must still match what was reviewed: the branch, its commit and the digest of the text.
 * A process with a shell on this machine could always run git and gh itself; Send gives it nothing new.
 */
export async function prSend(id, b, headers, deps) {
  if (!originAllowed(headers.origin, deps.port)) return answer(403, { error: 'Sending is only done from the dashboard page, by your click.' })
  // no PIN to check against: say so, and count no wrong try
  if (!deps.pr.pinHash) return answer(409, { error: NO_PIN })
  // five wrong PINs lock Send for ten minutes: for this server, whatever the flow, and the Settings page too
  const lock = sharedLock.get()
  const wait = lock.locked()
  if (wait) return answer(429, { error: `Too many wrong PINs: sending is locked for 10 minutes (${Math.ceil(wait / 60_000)} left).` })
  if (busy.has(id)) return answer(409, { busy: true })
  if (!verifyPin(typeof b?.pin === 'string' ? b.pin : '', deps.pr.pinHash)) {
    lock.fail()
    return answer(403, { error: 'Wrong PIN.' })
  }
  lock.ok()
  busy.add(id)
  try {
    return await send(id, b?.confirm, deps)
  } finally {
    busy.delete(id)
  }
}

async function send(id, confirm, deps) {
  const flow = load(id)
  if (!flow) return noFlow(id)
  const out = flow.output || {}
  const merge = out.merge
  if (!merge) return answer(400, { error: 'Nothing to send: the agent has not recorded a pull request (flow pr).' })
  if (confirm?.head !== merge.head) return answer(400, { error: `confirm must be the branch being sent (${merge.head}).` })
  if (!mergeReady(out)) return answer(409, { error: `Already sent: pull request #${out.pr?.number ?? ''} stands for this branch.` })
  if (confirm.digest !== digestOf(merge)) return answer(409, { error: STALE, changed: true })

  const f = await factsFor(flow, merge, deps, true)
  if (f.blockers.length) return answer(409, { error: f.blockers.join(' '), blockers: f.blockers })
  if (!f.sha || confirm.sha !== f.sha) return answer(409, { error: STALE, changed: true })
  // the text exactly as it will be sent, checked one last time
  const credit = textCredit(merge.title) ?? textCredit(merge.body)
  if (credit) return answer(409, { error: creditProblem(credit), blockers: [creditProblem(credit)] })

  const { remote } = deps.pr
  const fail = (error, pushed = false) => {
    storePr(id, failedRecord(id, error, pushed))
    facts.delete(id)
    return answer(502, { error, ...(pushed ? { pushed: true } : {}) })
  }
  // exactly the reviewed commit, to the full ref: no +, no --force, no tags; refused is refused (never retried)
  const pushed = await (deps.push || deps.git)(['push', remote, `${f.sha}:refs/heads/${merge.head}`])
  if (!pushed.ok) return fail(`The push was refused (it is never forced): ${scrub(pushed.err || pushed.out) || 'no reason given'}`.slice(0, 300))

  const file = path.join(os.tmpdir(), `flow-pr-body-${randomUUID()}.md`)
  let created
  try {
    writeFileSync(file, merge.body, 'utf8')
    created = await deps.gh(['pr', 'create', ...(f.repo ? [`--repo=${f.repo}`] : []), `--base=${merge.base}`, `--head=${merge.head}`, `--title=${merge.title}`, `--body-file=${file}`])
  } finally {
    rmSync(file, { force: true })
  }
  const url = created.ok ? prUrlOf(created.out) : null
  if (!url) return fail(`The branch was pushed, but GitHub did not open the pull request: ${scrub(created.err || created.out) || 'no reason given'}`.slice(0, 300), true)

  // opened: from here on nothing is an error that hides the link
  let number = Number(/\/pull\/(\d+)$/.exec(url)?.[1]) || null
  let state = 'open'
  const view = await deps.gh(['pr', 'view', url, '--json=number,state,url'])
  try {
    const j = view.ok ? JSON.parse(view.out) : null
    if (Number.isInteger(j?.number)) number = j.number
    if (['OPEN', 'MERGED', 'CLOSED'].includes(j?.state)) state = j.state.toLowerCase()
  } catch {}
  const pr = { url, number, state, openedAt: new Date().toISOString(), checks: 'pending', checkedAt: null, error: null }
  storePr(id, pr)
  facts.delete(id)
  return answer(200, { ok: true, pr })
}

// ═══ POST pr/refresh ═══

export async function prRefresh(id, deps) {
  const flow = load(id)
  if (!flow) return noFlow(id)
  const pr = flow.output?.pr
  if (!pr?.url) return answer(400, { error: 'No pull request to refresh.' })
  const r = await deps.gh(['pr', 'view', pr.url, '--json=state,mergedAt,statusCheckRollup'])
  let j = null
  try { j = r.ok ? JSON.parse(r.out) : null } catch {}
  if (!j) return answer(502, { error: `Could not read the pull request: ${scrub(r.err || r.out) || 'no answer'}` })
  const state = ['OPEN', 'MERGED', 'CLOSED'].includes(j.state) ? j.state.toLowerCase() : pr.state
  const next = { ...pr, state, checks: checksOf(j.statusCheckRollup), checkedAt: new Date().toISOString() }
  storePr(id, next)
  return answer(200, { pr: next })
}
