// The state of a subagent's pull request (subagents.mjs finds the links): open,
// merged or closed, and whether its checks pass. READ ONLY: the one gh command
// here is `gh pr view <n> --repo=<owner/name> --json=...`. Nothing in this file
// creates, edits, merges, closes or comments on a pull request.
//
// gh is a RUNNER passed in, `(args, timeoutMs) => Promise<{ ok, out }>` (server.mjs
// gives the one that runs config pr.gh), so the tests stub it.
//
//   makePrStates({ gh }) -> { refresh(prs, { budgetMs }), get(pr), withStates(prs) }
//
// Each pull request is read at most once a minute, a few at a time, and a
// merged one never again (it cannot change). A gh that is missing, signed
// out, slow or wrong only hides the state: get() answers null and the page
// shows the plain link.

import { checksOf } from './pr-check.mjs'

const TTL_MS = 60_000 // one read a minute per pull request
const TIMEOUT_MS = 8_000 // how long one gh call may take
const IN_FLIGHT = 4 // gh calls at once
const CACHE_MAX = 500 // pull requests remembered
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/
const STATES = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' }

/** `owner/name#12` for a link that is safe to hand to gh, else null. */
function keyOf(pr) {
  const repo = String(pr?.repo ?? '')
  return REPO.test(repo) && Number.isInteger(pr?.number) && pr.number > 0 ? `${repo}#${pr.number}` : null
}

/** What gh pr view printed as { state, checks, draft }, or null when it is not a pull request's JSON. */
function parse(r) {
  if (!r?.ok) return null
  let body
  try {
    body = JSON.parse(r.out)
  } catch {
    return null
  }
  const state = STATES[String(body?.state || '').toUpperCase()]
  return state ? { state, checks: checksOf(body.statusCheckRollup), draft: Boolean(body.isDraft) } : null
}

export function makePrStates({ gh, ttlMs = TTL_MS, timeoutMs = TIMEOUT_MS, now = Date.now } = {}) {
  const cache = new Map() // key -> { triedAt, value }
  const running = new Map() // key -> the read in flight

  /** One gh pr view, never longer than the timeout and never a throw: the parsed state or null. */
  async function read(pr) {
    let timer
    const gaveUp = new Promise(resolve => {
      timer = setTimeout(() => resolve(null), timeoutMs)
    })
    try {
      const args = ['pr', 'view', String(pr.number), `--repo=${pr.repo}`, '--json=state,isDraft,statusCheckRollup']
      return parse(await Promise.race([Promise.resolve().then(() => gh(args, timeoutMs)), gaveUp]))
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /** Reads one pull request unless it is fresh, final or already being read. A failure keeps the last good state. */
  function load(pr, key) {
    const hit = cache.get(key)
    if (hit && (hit.value?.state === 'merged' || now() - hit.triedAt < ttlMs)) return null
    if (running.has(key)) return running.get(key)
    const job = read(pr)
      .then(value => {
        if (!cache.has(key) && cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
        cache.set(key, { triedAt: now(), value: value ? { ...value, at: new Date(now()).toISOString() } : hit?.value ?? null })
      })
      .finally(() => running.delete(key))
    running.set(key, job)
    return job
  }

  /**
   * Brings the states of `prs` up to date, a few gh calls at a time. Resolves when they are all
   * read or, with `budgetMs`, after that long at most: the reads go on and land for the next get().
   */
  async function refresh(prs, { budgetMs } = {}) {
    const todo = new Map()
    for (const pr of prs || []) {
      const key = keyOf(pr)
      if (key && !todo.has(key)) todo.set(key, pr)
    }
    const queue = [...todo.entries()]
    const all = Promise.all(Array.from({ length: Math.min(IN_FLIGHT, queue.length) }, async () => {
      while (queue.length) {
        const [key, pr] = queue.shift()
        await load(pr, key)
      }
    }))
    if (budgetMs == null) return void (await all)
    let timer
    await Promise.race([all, new Promise(resolve => { timer = setTimeout(resolve, budgetMs) })])
    clearTimeout(timer)
  }

  /** The last state read for a pull request, or null when it is not known. No gh call. */
  const get = pr => cache.get(keyOf(pr))?.value ?? null

  /** Each link with its state added when one is known. */
  const withStates = prs => (prs || []).map(pr => ({ ...pr, ...(get(pr) || {}) }))

  return { refresh, get, withStates }
}
