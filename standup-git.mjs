// What the Standup creator reads from git (standup-facts.mjs gathers it with the rest). Read only: every command
// here is a `git log` or a ref listing, never a fetch or a write, so pressing Generate never touches the repo.
//
//   readGit({ git, author, base, window, prefixes })
//     → { commits, merges, unmerged, skipped }
//   commits   the author's commits in the window on ALL refs, merges left out, newest first:
//             { sha, at, branch, subject, ids }. `branch` is the ref git reached it by (%S with --all: cheap, one
//             ref per commit, the local branch before its remote copy), shown as a plain branch name.
//   merges    merge commits on the default branch itself (--first-parent) in the window whose subject is
//             `Merge pull request #N from org/branch` and whose branch has at least one of the author's commits:
//             { sha, at, number, branch, ids }. A merge of someone else's pull request is not the author's news.
//   unmerged  the author's branches with commits in the window that the default branch does not have yet:
//             { branch, commits, pushed, ids }. `pushed` is whether origin has a branch of that name.
//   skipped   [{ title, why }] for each part git could not read; the other parts are still read.
//
// Rules this file keeps:
// - ⚠️ `git` is injected and takes an ARGV ARRAY (server.mjs git(), execFile, never a shell), so a name or branch
//   with quotes or spaces is only ever an argument. The author goes in with -F (a fixed string, not a regex:
//   `--author=Yz.31` must not match `Yzx31`).
// - Ticket ids come from ticket-ids.mjs with the dashboard's prefixes, from the subject and from the branch name.
// - At most MERGES_MAX merges are checked (one small `git log -n 1` each): a busy week stays quick.

import { idsInBranch, idsInText } from './ticket-ids.mjs'

const TAB = '%x09'
const MERGES_MAX = 80
const PR = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)/

/** A ref as a branch name: refs/heads/x and refs/remotes/origin/x are both x. Tags and the stash are no branch. */
function branchOf(ref) {
  const r = String(ref || '')
  if (r.startsWith('refs/heads/')) return r.slice(11)
  const remote = /^refs\/remotes\/[^/]+\/(.+)$/.exec(r)
  return remote && remote[1] !== 'HEAD' ? remote[1] : ''
}

/** A commit subject as a short title: the conventional `type(scope): ` and any trailing (ABC-1, ABC-2) go. */
export function cleanSubject(s) {
  return String(s || '')
    .replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '')
    .replace(/\s*\((?:[A-Z][A-Z0-9]*-\d+(?:,\s*)?)+\)\s*$/, '')
    .trim()
}

const rows = out => String(out || '').split('\n').map(l => l.replace(/\r$/, '')).filter(Boolean).map(l => l.split('\t'))
const unique = list => [...new Set(list)]

export async function readGit({ git, author, base, window, prefixes = [] }) {
  const skipped = []
  const range = [`--since=${window.from}`, `--until=${window.to}`]
  const mine = ['-F', `--author=${author}`]
  const idsOf = (subject, branch) => unique([...idsInText(subject, prefixes), ...idsInBranch(branch, prefixes)])

  let commits = []
  const log = await git(['log', '--all', '--no-merges', ...mine, ...range, `--format=%H${TAB}%aI${TAB}%S${TAB}%s`])
  if (log.ok) {
    commits = rows(log.out).map(([sha, at, ref, ...rest]) => {
      const subject = rest.join('\t')
      const branch = branchOf(ref)
      return { sha, at, branch, subject, ids: idsOf(subject, branch) }
    })
    commits.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  } else skipped.push({ title: 'Commits', why: 'git could not read the history.' })

  let merges = []
  const merged = await git(['log', base, '--first-parent', '--merges', ...range, `--format=%H${TAB}%cI${TAB}%P${TAB}%s`])
  if (merged.ok) {
    for (const [sha, at, parents = '', subject = ''] of rows(merged.out).slice(0, MERGES_MAX)) {
      const m = PR.exec(subject)
      const [p1, p2] = parents.split(' ')
      if (!m || !p1 || !p2) continue
      const theirs = await git(['log', '--no-merges', ...mine, '-n', '1', '--format=%H', `${p1}..${p2}`])
      if (!theirs.ok || !theirs.out.trim()) continue
      merges.push({ sha, at, number: Number(m[1]), branch: m[2], ids: idsOf('', m[2]) })
    }
  } else skipped.push({ title: 'Merged pull requests', why: `git could not read ${base}.` })

  let unmerged = []
  const open = await git(['log', '--all', '--no-merges', ...mine, ...range, `--format=%H${TAB}%S`, '--not', base])
  if (open.ok) {
    const remotes = await git(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'])
    const pushed = new Set(remotes.ok ? rows(remotes.out).map(([r]) => r) : [])
    const by = new Map()
    for (const [, ref] of rows(open.out)) {
      const branch = branchOf(ref)
      if (branch) by.set(branch, (by.get(branch) || 0) + 1)
    }
    unmerged = [...by].map(([branch, n]) => ({ branch, commits: n, pushed: pushed.has(`origin/${branch}`), ids: idsOf('', branch) }))
  } else skipped.push({ title: 'Branches not merged yet', why: `git could not compare with ${base}.` })

  return { commits, merges, unmerged, skipped }
}
