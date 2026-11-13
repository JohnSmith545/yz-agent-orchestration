// Drafts a Markdown report of what one agent (or one of its subagents) did in a
// time window, from its transcript feed and git. Plain facts only: no model
// writes this, so nothing in it is invented; the user edits it before sending.

import { idsInBranch, idsInText } from './ticket-ids.mjs'

const WORKTREE_IN_TEXT = /\.claude[\\/]+worktrees[\\/]+([A-Za-z0-9+._-]+)/g
// Exit markers the agents print themselves ("api-tsc=0", "exit=1") count too.
const FAILED = /\b(\d+ (tests? )?failed|FAIL\b|failed|error[s]?:|✗|\d+ issues? found|Exit code [1-9])|\w=[1-9]\d*\b/i
const PASSED = /\b(all tests passed|no issues found|tests? passed|\d+ passed|✓|PASS\b|Exit code 0)|\w=0\b/i

const firstLine = s => String(s || '').trim().split('\n')[0]
const hhmm = iso => (iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '?')
const day = iso => (iso ? new Date(iso).toLocaleDateString('en-CA') : '')
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A file path as the repo sees it: a worktree path loses everything up to and
 * including the worktree folder, any other path everything up to the watched
 * repo's own folder (`repoName`, the basename of config.repo). Slashes go forward.
 */
export function shortPath(p, repoName = '') {
  let s = String(p || '').replace(/^.*?[\\/]\.claude[\\/]worktrees[\\/][^\\/]+[\\/]/i, '')
  if (repoName) s = s.replace(new RegExp(`^(?:.*?[\\\\/])?${escapeRe(repoName)}[\\\\/]`, 'i'), '')
  return s.replace(/\\/g, '/')
}

export function testOutcome(ev) {
  if (!ev.doneAt) return 'still running'
  const r = ev.result || ''
  if (ev.isError || (FAILED.test(r) && !PASSED.test(r))) return 'failed'
  if (PASSED.test(r)) return 'passed'
  if (ev.background) return 'started in the background'
  return 'finished (no clear pass or fail in the output)'
}

/**
 * @param o.label       who the report is about ("Agent 1", or "Agent 1 › subagent: ...")
 * @param o.events      feed events (transcripts.mjs), any order
 * @param o.hours       window length; 0 = everything buffered
 * @param o.worktrees   name -> { path, branch } for every worktree
 * @param o.git         (args, cwd) -> { ok, out }
 * @param o.nameOf      session name or pipe address -> the label the user knows
 * @param o.repoName    the watched repo's folder name, for shorter file paths
 * @param o.prefixes    the ticket prefixes in use ([] = the generic shape, ticket-ids.mjs)
 */
export async function buildReport({ label, events, hours, worktrees, git, nameOf = x => x, repoName = '', prefixes = [] }) {
  const now = Date.now()
  const from = hours > 0 ? now - hours * 3600_000 : 0
  const inWindow = events.filter(e => e.t && new Date(e.t).getTime() >= from).sort((a, b) => a.seq - b.seq)
  if (!inWindow.length) return `# ${label}: report\n\nNothing recorded in this window.\n`

  const start = inWindow[0].t
  const end = inWindow[inWindow.length - 1].t
  const tools = inWindow.filter(e => e.kind === 'tool')

  // Worktrees it worked in, from the paths and commands of its tool calls.
  const touched = new Set()
  for (const e of tools) {
    const hay = `${e.file || ''} ${e.command || ''}`
    for (const m of hay.matchAll(WORKTREE_IN_TEXT)) {
      const name = m[1].replace(/[.]+$/, '')
      if (worktrees[name]) touched.add(name)
    }
  }
  const tickets = new Set()
  for (const e of inWindow) for (const id of idsInText(`${e.text || ''} ${e.command || ''} ${e.file || ''}`, prefixes)) tickets.add(id)
  for (const name of touched) for (const id of idsInBranch(worktrees[name].branch, prefixes)) tickets.add(id)

  // Commits made in the window on each touched branch, and what is left uncommitted.
  const since = new Date(from || new Date(start).getTime()).toISOString()
  const branchLines = []
  const openLines = []
  for (const name of touched) {
    const wt = worktrees[name]
    const [log, status] = await Promise.all([
      git(['log', '--no-merges', `--since=${since}`, '--format=%h %s', `origin/dev..${wt.branch}`]),
      git(['status', '--porcelain'], wt.path),
    ])
    // Branches here are often cut from followup, so their history carries other
    // tickets' commits. Keep the ones naming this branch's own tickets;
    // a branch that names no ticket keeps every commit.
    const own = idsInBranch(wt.branch, prefixes)
    const commits = (log.ok ? log.out.split('\n').filter(Boolean) : []).filter(c => !own.length || own.some(id => c.toUpperCase().includes(id)))
    branchLines.push(`- \`${wt.branch}\`: ${commits.length ? `${commits.length} commit${commits.length > 1 ? 's' : ''}` : 'no commits in this window'}`)
    for (const c of commits.slice(0, 15)) branchLines.push(`  - ${c}`)
    const dirty = status.ok ? status.out.split('\n').filter(Boolean) : []
    if (dirty.length) openLines.push(`- \`${wt.branch}\`: ${dirty.length} uncommitted file${dirty.length > 1 ? 's' : ''} (${dirty.slice(0, 6).map(l => shortPath(l.slice(3), repoName)).join(', ')}${dirty.length > 6 ? ', …' : ''})`)
  }

  const edits = new Map()
  for (const e of tools.filter(e => ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(e.tool) && e.file)) {
    const k = shortPath(e.file, repoName)
    edits.set(k, (edits.get(k) || 0) + (e.edits?.length || 1))
  }

  const tests = tools.filter(e => e.testing)
  const prompts = inWindow.filter(e => e.kind === 'user')
  const messages = inWindow.filter(e => e.kind === 'msg-in' || (e.kind === 'tool' && e.tool === 'SendMessage'))
  const spawned = tools.filter(e => e.spawn)
  const lastSummary = [...inWindow].reverse().find(e => e.kind === 'text' && e.text.length > 80)

  const out = []
  out.push(`# ${label}: report`)
  out.push('')
  out.push(`**When:** ${day(start)} ${hhmm(start)} to ${hhmm(end)}${day(end) !== day(start) ? ` (${day(end)})` : ''}`)
  out.push(`**Tickets:** ${tickets.size ? [...tickets].sort().join(', ') : 'none named'}`)
  out.push(`**Activity:** ${tools.length} tool calls, ${edits.size} files edited, ${tests.length} test or check runs, ${spawned.length} subagents started`)
  out.push('')
  if (prompts.length) {
    out.push('## What it was asked')
    for (const p of prompts.slice(-10)) out.push(`- ${hhmm(p.t)} ${firstLine(p.text).slice(0, 200)}`)
    out.push('')
  }
  out.push('## Branches and commits')
  out.push(...(branchLines.length ? branchLines : ['- No worktree touched in this window.']))
  out.push('')
  if (edits.size) {
    out.push('## Files changed')
    for (const [f, n] of [...edits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) out.push(`- \`${f}\` (${n} edit${n > 1 ? 's' : ''})`)
    if (edits.size > 30) out.push(`- …and ${edits.size - 30} more`)
    out.push('')
  }
  if (tests.length) {
    out.push('## Tests and checks')
    for (const t of tests.slice(-12)) out.push(`- ${hhmm(t.t)} \`${firstLine(t.command).slice(0, 140)}\`: ${testOutcome(t)}`)
    out.push('')
  }
  if (spawned.length) {
    out.push('## Subagents started')
    for (const s of spawned.slice(-10)) out.push(`- ${hhmm(s.t)} ${s.summary || 'task'}`)
    out.push('')
  }
  if (messages.length) {
    out.push('## Messages')
    for (const m of messages.slice(-12)) {
      const who = m.kind === 'msg-in' ? `from ${nameOf(m.fromSocket || m.from) || m.from}` : `to ${nameOf(m.to) || m.to}`
      out.push(`- ${hhmm(m.t)} ${who}: ${firstLine(m.text).slice(0, 180)}`)
    }
    out.push('')
  }
  if (openLines.length) {
    out.push('## Not committed yet')
    out.push(...openLines)
    out.push('')
  }
  if (lastSummary) {
    out.push('## Where it stands (its latest note)')
    out.push(lastSummary.text.trim().slice(0, 1500))
    out.push('')
  }
  out.push('---')
  out.push(`_Drafted from the agent's transcript and git at ${hhmm(new Date(now).toISOString())}. The transcript is read from ${hhmm(events[0]?.t)} onward, so earlier work in a long session may be missing._`)
  return out.join('\n')
}
