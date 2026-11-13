// The facts the page shows before a branch is sent to its base (pr-routes.mjs
// serves them, public/flow-send.js draws them). Pure logic: git and gh are
// RUNNERS passed in, `(args) => Promise<{ ok, out, err, code? }>`, so the tests
// stub them and no repository or network is touched.
//
// Every git call here reads what the person sees: rev-parse, rev-list, log, diff, config --get, and
// merge-tree --write-tree, which changes no ref, no index and no working tree (it does add the merged
// tree's objects to the object store, as any merge would; git gc removes them). The one fetch and the
// push are the route's, never this file's.
//
//   prFacts({ head, base, remote, bases, protect, enabled, off, title, body, git, gh, fetchFailed })
//     → { head, base, remote, repo, sha, headExists, ahead, behind, pushed, unpushed, mergesCleanly,
//         conflicts, commits: [{ sha, subject }] (≤ 50, oldest first), files, attribution: [{ sha, line }],
//         existingPr: { number, url, state } | null, ghOk, blockers: [], warnings: [] }
//   blockers refuse the send; warnings are shown and do not.

import { commitCredits, commitProblem, creditProblem, textCredit } from './flow-merge.mjs'

const LISTED = 50
const OID = /^[0-9a-f]{40,64}$/
const s = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * The GitHub repository behind a remote address, for gh --repo (so gh never guesses from another remote):
 * `owner/name` on github.com, `host/owner/name` elsewhere; '' for a host with no dot (an ssh host alias
 * from ~/.ssh/config, which gh cannot name: then no --repo at all, and gh reads the remote itself); null
 * when the address is not a repository URL.
 */
export function repoOf(url) {
  const u = String(url || '').trim()
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?)([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(u)
    || /^[^@/\s]+@([^:/]+):([^/]+)\/([^/]+?)(?:\.git)?$/.exec(u)
  if (!m || ![m[1], m[2], m[3]].every(x => /^[A-Za-z0-9._-]+$/.test(x))) return null
  if (!m[1].includes('.')) return ''
  return m[1].toLowerCase() === 'github.com' ? `${m[2]}/${m[3]}` : `${m[1]}/${m[2]}/${m[3]}`
}

/** `*` matches anything; everything else is literal. */
const glob = pattern => new RegExp(`^${pattern.split('*').map(x => x.replace(/[.+?^${}()|[\]\\/-]/g, '\\$&')).join('.*')}$`)

/** Why a branch may never be sent from (a base, HEAD, a pr.protect pattern), or null. */
export function isProtected(head, { bases = [], protect = [] } = {}) {
  if (bases.includes(head)) return `${head} is a base branch: send a feature branch into it instead.`
  if (head === 'HEAD' || protect.some(p => glob(p).test(head))) return `${head} is a protected branch (pr.protect): send a feature branch instead.`
  return null
}

/** What git merge-tree --write-tree --name-only said: { clean, conflicts }, or null when it could not tell (an old git, a bad ref). */
export function mergeTreeOf(r) {
  if (r.ok) return { clean: true, conflicts: [] }
  const lines = String(r.out || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (!OID.test(lines[0] || '')) return null
  return { clean: false, conflicts: [...new Set(lines.slice(1))] }
}

/** The pull request link in what gh pr create printed: its last https …/pull/N, or null. */
export function prUrlOf(stdout) {
  const all = String(stdout || '').match(/https:\/\/[^\s'"<>]+\/pull\/\d+/g)
  return all ? all.at(-1) : null
}

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'])
/**
 * gh pr view --json statusCheckRollup as one word: `failing` when any check failed (it wins over
 * pending), `pending` while any is queued or running, `passing`, or `none` when there are none.
 */
export function checksOf(rollup) {
  const list = Array.isArray(rollup) ? rollup : []
  if (!list.length) return 'none'
  const word = c => String(c?.conclusion || c?.state || '').toUpperCase()
  if (list.some(c => FAILED.has(word(c)))) return 'failing'
  const done = c => (c?.__typename === 'StatusContext' ? !['PENDING', 'EXPECTED'].includes(word(c)) : String(c?.status || '').toUpperCase() === 'COMPLETED')
  return list.every(done) ? 'passing' : 'pending'
}

/**
 * What git or gh said, safe to show and store: the hints dropped, any user:token@ in a link and any
 * GitHub token removed, on one line, at most 300 characters. ⚠️ A remote URL may carry a token;
 * nothing the dashboard returns or stores may.
 */
export function scrub(text) {
  return String(text || '')
    .split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^hint:/i.test(l)).join(' ')
    .replace(/\/\/[^/\s@]+@/g, '//')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g, '***')
    .slice(0, 300)
}

/** The facts and what they mean for sending; see the head of this file. */
export async function prFacts({ head, base, remote, bases = [], protect = [], enabled, off, title = '', body = '', git, gh, fetchFailed = false }) {
  const f = {
    head, base, remote, repo: null, sha: null, headExists: false, ahead: 0, behind: 0, pushed: false, unpushed: 0, mergesCleanly: null,
    conflicts: [], commits: [], files: 0, attribution: [], existingPr: null, ghOk: false, blockers: [], warnings: [],
  }
  if (!enabled) return { ...f, off: true, blockers: [off || 'Sending is turned off: set pr.enabled to true in config.json.'] }
  const sha = async ref => {
    const r = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    return r.ok && OID.test(r.out.trim()) ? r.out.trim() : null
  }
  const headRef = `refs/heads/${head}`
  const baseRef = `refs/remotes/${remote}/${base}`
  const remoteHeadRef = `refs/remotes/${remote}/${head}`

  const guarded = head === base ? null : isProtected(head, { bases, protect })
  if (guarded) f.blockers.push(guarded)
  if (!bases.includes(base)) f.blockers.push(`${base} is not a branch this dashboard sends to (pr.bases: ${bases.join(', ')}).`)
  if (head === base) f.blockers.push('The branch and its base are the same branch.')
  const [headSha, baseSha, remoteSha, address] = await Promise.all([sha(headRef), sha(baseRef), sha(remoteHeadRef), git(['config', '--get', `remote.${remote}.url`])])
  f.headExists = !!headSha
  f.sha = headSha
  // the raw address (config --get), not get-url, which would rewrite it through any url.insteadOf
  f.repo = address.ok ? repoOf(address.out) : null
  if (f.repo === null) f.blockers.push(`Could not tell the GitHub repository from the address of ${remote}.`)
  if (!headSha) f.blockers.push(`There is no branch ${head} in the repo.`)
  if (!baseSha) f.blockers.push(`${remote} has no branch ${base}.`)

  if (headSha && baseSha && head !== base) {
    const [counts, log, diff, tree] = await Promise.all([
      git(['rev-list', '--left-right', '--count', `${baseRef}...${headRef}`]),
      git(['log', '--reverse', '--format=%H%x1f%s%x1f%B%x1e', `${baseRef}..${headRef}`]),
      git(['diff', '--name-only', `${baseRef}...${headRef}`]),
      git(['merge-tree', '--write-tree', '--name-only', '--no-messages', baseRef, headRef]),
    ])
    const [behind, ahead] = counts.ok ? counts.out.trim().split(/\s+/).map(Number) : [0, 0]
    f.behind = behind || 0
    f.ahead = ahead || 0
    const records = String(log.ok ? log.out : '').split('\x1e').map(r => r.replace(/^\s+/, '')).filter(Boolean).map(r => r.split('\x1f'))
    f.commits = records.slice(0, LISTED).map(([full, subject]) => ({ sha: full.slice(0, 7), subject: subject || '' }))
    for (const [full, , message] of records) for (const line of commitCredits(message)) f.attribution.push({ sha: full.slice(0, 7), line })
    f.files = diff.ok ? diff.out.split(/\r?\n/).filter(l => l.trim()).length : 0
    const merged = mergeTreeOf(tree)
    f.mergesCleanly = merged ? merged.clean : null
    f.conflicts = merged?.conflicts || []
    if (!merged) f.warnings.push('Could not check that it merges cleanly (needs git 2.38 or newer).')

    if (!f.ahead) f.blockers.push(`${head} has no commits that ${base} does not have.`)
    if (merged && !merged.clean) f.blockers.push(`It does not merge cleanly into ${base}: ${f.conflicts.join(', ') || 'files'} conflict.`)
    if (f.behind) f.warnings.push(`${head} is ${s(f.behind, 'commit')} behind ${base}.`)
  }
  for (const a of f.attribution) f.blockers.push(commitProblem(a.sha, a.line))
  const credit = textCredit(title) ?? textCredit(body)
  if (credit) f.blockers.push(creditProblem(credit))

  f.pushed = !!headSha && remoteSha === headSha
  if (headSha && !f.pushed) {
    if (!remoteSha) {
      f.unpushed = f.ahead
      f.warnings.push(`CI has never run on these commits: ${head} is not on ${remote} yet.`)
    } else {
      const r = await git(['rev-list', '--count', `${remoteHeadRef}..${headRef}`])
      f.unpushed = r.ok ? Number(r.out.trim()) || 0 : 0
      if (f.unpushed === 1) f.warnings.push(`CI has not run on the newest commit: it is not on ${remote} yet.`)
      else if (f.unpushed > 1) f.warnings.push(`CI has not run on the newest ${f.unpushed} commits: they are not on ${remote} yet.`)
    }
  }
  if (f.ahead > LISTED) f.warnings.push(`${f.ahead} commits: only the first ${LISTED} are listed.`)
  if (fetchFailed) f.warnings.push(`Could not reach ${remote}: these facts may be out of date.`)

  f.ghOk = (await gh(['auth', 'status'])).ok
  if (!f.ghOk) f.blockers.push('The GitHub CLI (gh) is missing or not signed in: run gh auth login.')
  else if (f.repo !== null) {
    // --flag=value: a value that starts with a dash can never be read as a flag
    const r = await gh(['pr', 'list', ...(f.repo ? [`--repo=${f.repo}`] : []), `--head=${head}`, `--base=${base}`, '--state=all', '--json=number,url,state', '--limit=1'])
    if (!r.ok) f.warnings.push('Could not check for an existing pull request.')
    let pr = null
    try { pr = r.ok ? JSON.parse(r.out)[0] ?? null : null } catch {}
    if (pr && Number.isInteger(pr.number) && /^https:\/\//.test(String(pr.url))) {
      f.existingPr = { number: pr.number, url: pr.url, state: String(pr.state || '').toLowerCase() }
      if (f.existingPr.state === 'open') f.blockers.push(`A pull request is already open for ${head}: #${pr.number}.`)
    }
  }
  return f
}
