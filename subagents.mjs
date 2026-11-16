// The coordinator's subagents: every subagent of every session of the watched repo,
// live or ended, in a window of days. A subagent is one Agent tool call of a session:
//   <claudeDir>/projects/<folder>/<sessionId>/subagents/agent-<id>.meta.json   who it is
//   <claudeDir>/projects/<folder>/<sessionId>/subagents/agent-<id>.jsonl       what it did
//
// Read only, and cheap: a session can hold hundreds of subagents and a transcript
// runs to megabytes, so the window is decided from file times alone, the small
// meta file is read whole, and only the TAIL of a transcript is scanned, once
// per change of its time or size.
//
// Builder or lookup: a builder worked in a worktree or made a git commit that ran
// without an error. Anything else (a sweep, a search, a question) is a lookup.
// A worktree is a path under .claude/worktrees/ in a tool call, a folder the
// subagent made with `git worktree add`, or a folder it moved into (cd, git -C)
// that git lists as a worktree of the repo.

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { idsInBranch, idsInText } from './transcripts.mjs'

const MAX_DAYS = 7 // the widest window the page offers
const TAIL_BYTES = 4 * 1024 * 1024 // how much of a transcript's end is scanned
const CACHE_MAX = 3000 // scans kept in memory before the oldest are dropped

const WORKTREE_IN_TEXT = /\.claude[\\/]+worktrees[\\/]+([A-Za-z0-9+._-]+)/g
// `git commit` as a step of a command line, with any `-c x=y` or `-C dir` options before it.
const GIT_COMMIT = /(?:^|[\s;&|(])git(?:\s+-[cC]\s+\S+)*\s+commit\b/
const SHELLS = new Set(['Bash', 'PowerShell'])
// A gh pull request command the agent RAN: gh starts a step (the line, or after ; & | ( or a newline), after
// any VAR=value set for it. Tested on the steps with their quoted text removed, so a search for the words,
// an echo or a file body never counts.
const GH_PR_STEP = /(?:^|[;&|(\n])\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*gh(?:\.exe)?\s+pr\s+(?:create|view|merge|checks|status)\b/
const QUOTED = /"[^"]*"|'[^']*'/g // quoted text in a command: words it passes on, not steps it runs
// What git commit prints first: `[branch 1a2b3c4] subject` (`[detached HEAD 1a2b3c4]`, `[main (root-commit) 1a2b3c4]`).
const COMMIT_LINE = /^\[(.+?)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.*)$/gm
// A branch the command creates: git worktree add -b x, git checkout -b x, git switch -c x.
const NEW_BRANCH = /\bgit\s+(?:-[cC]\s+\S+\s+)*(?:worktree\s+add|checkout|switch)\b[^\n;&|]*?\s-[bBc]\s+["']?([A-Za-z0-9._/-]+)/
// A folder a command moves into: cd x, git -C x, Set-Location x (quoted or not).
const MOVED_TO = /(?:(?:^|[\s;&|(])cd\s+(?:\/d\s+)?|\bgit\s+-C\s+|\bSet-Location\s+(?:-Path\s+)?)(?:"([^"]+)"|'([^']+)'|([^\s;&|)]+))/gi
const WORKTREE_ADD = /\bworktree\s+add\b([^\n;&|]*)/
const ABSOLUTE = /^[a-z]:\//
const DIRS_MAX = 40 // distinct folders remembered per transcript

/** A folder path as one comparable key: forward slashes, a Git Bash /c/ drive as c:/, no trailing slash, lower case unless `lower` is false. */
function dirKey(p, lower = true) {
  const s = String(p ?? '').replace(/\\/g, '/').replace(/^\/([A-Za-z])\//, '$1:/').replace(/\/+$/, '')
  return lower ? s.toLowerCase() : s
}
// A flow command of the dashboard CLI and the flow it names: factory.mjs flow say <id> ...
const FLOW_COMMAND = /factory\.mjs["']?\s+flow\s+[a-z-]+\s+["']?([a-z0-9][a-z0-9-]*)(?=["'\s]|$)/g
// Who a flow command runs as: --by "Agent 1", --by=Agent-1, or FACTORY_BY='Agent 1' before it.
const FLOW_BY = /(?:--by[=\s]+|\bFACTORY_BY=)(?:"([^"]+)"|'([^']+)'|([^\s"';&|]+))/g
const PR_LINK = /github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)/g
const STUCK_MS = 15 * 60_000 // not finished and silent this long reads as stuck
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/ // a session or subagent id that is a plain file name
const PRS_MAX = 4 // pull requests shown on one card
const LINE_MAX = 200 // the report's first line on a card
const LAST_TEXT_MAX = 600 // the last words of a subagent that failed or stopped

/**
 * A subagent's state, one word:
 *   done     it handed back a report (SubagentHandback) and its last reply was not an API error
 *   failed   its last reply was an API error
 *   stopped  it ended without a handback and without an error: it may need resuming
 *   working  not finished, and its transcript was written in the last 15 minutes
 *   stuck    not finished, and nothing was written for 15 minutes or more
 */
export function subagentState({ finished = false, report = '', apiError = false, ageMs = 0 } = {}) {
  if (report && !apiError) return 'done'
  if (apiError) return finished ? 'failed' : ageMs < STUCK_MS ? 'working' : 'stuck'
  if (finished) return 'stopped'
  return ageMs < STUCK_MS ? 'working' : 'stuck'
}

/** A folder name the way Claude Code writes one for a working folder: every non-alphanumeric becomes '-'. */
const folderKey = s => String(s || '').replace(/[^A-Za-z0-9]/g, '-').toLowerCase()

/** When the window of `days` (1 to 7, anything else is 1) starts: local midnight, `days - 1` days before today. */
export function windowStart(days, now = Date.now()) {
  const n = Number.isInteger(days) && days >= 1 ? Math.min(days, MAX_DAYS) : 1
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - (n - 1))
  return d.getTime()
}

/** The entries of a folder, or [] when it is not there. */
async function entries(dir) {
  try {
    return await fs.readdir(dir)
  } catch {
    return []
  }
}

/**
 * Every subagent of the repo whose transcript changed at or after `sinceMs`, from file names and
 * times only (plus its small meta file): { sessionId, id, file, meta, mtimeMs, size, claudeDir }.
 * A project folder counts when its name holds `match` the way a session's working folder does
 * (config sessionCwdMatch). A meta file that does not parse, or has no transcript yet, is skipped.
 */
export async function listSubagentFiles({ claudeDirs = [], match = '', sinceMs = 0 } = {}) {
  const want = folderKey(match)
  const out = []
  const seen = new Set()
  for (const claudeDir of claudeDirs) {
    const projects = path.join(claudeDir, 'projects')
    for (const folder of await entries(projects)) {
      if (!folderKey(folder).includes(want)) continue
      for (const sessionId of await entries(path.join(projects, folder))) {
        if (sessionId.endsWith('.jsonl')) continue // a session's own transcript, not its folder
        const dir = path.join(projects, folder, sessionId, 'subagents')
        for (const name of await entries(dir)) {
          if (!name.startsWith('agent-') || !name.endsWith('.meta.json')) continue
          const id = name.slice('agent-'.length, -'.meta.json'.length)
          const file = path.join(dir, `agent-${id}.jsonl`)
          if (seen.has(file)) continue
          seen.add(file)
          try {
            const st = await fs.stat(file)
            if (st.mtimeMs < sinceMs) continue
            const meta = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'))
            if (!meta || typeof meta !== 'object') continue
            out.push({ sessionId, id, file, meta, mtimeMs: st.mtimeMs, size: st.size, claudeDir })
          } catch {
            /* a file mid-write or gone; the next read tries again */
          }
        }
      }
    }
  }
  return out
}

// ═══ one transcript ═══

/** The text of a tool result, whether it came as a string or as parts. */
function resultText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(c => (c?.type === 'text' ? String(c.text ?? '') : '')).join('\n')
  return ''
}

/** Every GitHub pull request link in `text`, each once, in order: [{ repo: 'owner/name', number, url }]. */
export function prLinks(text) {
  const out = []
  for (const m of String(text ?? '').matchAll(PR_LINK)) {
    const repo = `${m[1]}/${m[2]}`
    const number = Number(m[3])
    if (!out.some(p => p.repo === repo && p.number === number)) out.push({ repo, number, url: `https://github.com/${repo}/pull/${number}` })
  }
  return out
}

function newScan() {
  return {
    worktrees: new Map(), // name -> order of its last mention
    worktree: '', // the one named last: under .claude/worktrees/, or one it made with git worktree add
    dirs: new Map(), // folder it moved into (cd, git -C, Set-Location), lower case -> order of the last time
    committed: false,
    commits: [], // { branch, sha, subject } from what git commit printed
    branchHint: '', // a branch it created (git worktree add -b, checkout -b, switch -c)
    mentions: new Map(), // ticket id -> order of its last mention in a tool call
    createdPrs: [], // links printed by the gh pr commands it ran (create, view, merge, checks, status)
    prosePrs: [], // links it wrote in its own words
    report: '', // the SubagentHandback message, in full
    lastText: '', // the last thing it said
    apiError: false, // its last reply was an API error
    firstAt: null, // the first time stamp in the part that was read
    seq: 0,
    pendingCommits: new Set(), // tool ids of git commit commands still waiting for their result
    pendingPrs: new Set(), // tool ids of gh pr commands still waiting for their result
    flowIds: new Set(), // flows its `factory.mjs flow <command> <id>` commands wrote
    flowBy: new Set(), // the names it gave those commands: --by, or FACTORY_BY
  }
}

/** A tool call of the agent, folded into `scan`. */
function noteCall(c, scan) {
  scan.seq++
  const input = c.input ?? {}
  const command = SHELLS.has(c.name) ? String(input.command ?? '') : ''
  const steps = command.split('<<')[0] // a heredoc body is text the command writes, not steps it runs
  // Where it worked: the paths its tools were pointed at and the steps of its commands. Tool CALLS
  // only (a `git worktree list` result names every worktree), and never a file body or a message.
  const where = [input.file_path, input.path, input.notebook_path, steps].filter(v => typeof v === 'string').join(' ')
  const tree = name => {
    scan.worktrees.set(name, scan.seq)
    scan.worktree = name
  }
  for (const m of where.matchAll(WORKTREE_IN_TEXT)) tree(m[1].replace(/[.]+$/, ''))
  for (const id of idsInText(JSON.stringify(input))) scan.mentions.set(id, scan.seq)
  if (c.name === 'SubagentHandback' && typeof input.message === 'string') scan.report = input.message
  if (!command) return
  for (const m of steps.matchAll(MOVED_TO)) {
    const dir = dirKey(m[1] ?? m[2] ?? m[3])
    if (ABSOLUTE.test(dir) && (scan.dirs.has(dir) || scan.dirs.size < DIRS_MAX)) scan.dirs.set(dir, scan.seq)
  }
  // A worktree it made itself, wherever it put it: the first plain argument of `git worktree add`.
  const added = WORKTREE_ADD.exec(steps)
  if (added) {
    const args = (added[1].match(/"[^"]*"|'[^']*'|\S+/g) || []).map(a => a.replace(/^["']|["']$/g, ''))
    const at = args.findIndex((a, i) => !a.startsWith('-') && !['-b', '-B', '--reason'].includes(args[i - 1]))
    const name = at >= 0 ? path.posix.basename(dirKey(args[at], false)) : ''
    if (name) tree(name)
  }
  if (GIT_COMMIT.test(command)) scan.pendingCommits.add(c.id)
  if (GH_PR_STEP.test(steps.replace(QUOTED, '""'))) scan.pendingPrs.add(c.id)
  const made = NEW_BRANCH.exec(steps)
  if (made) scan.branchHint = made[1]
  // The flows it wrote, and the names it wrote them under (tools/flow-gate.mjs asks whether its work is told).
  if (command.includes('factory.mjs')) {
    for (const m of steps.matchAll(FLOW_COMMAND)) scan.flowIds.add(m[1])
    for (const m of steps.matchAll(FLOW_BY)) scan.flowBy.add((m[1] ?? m[2] ?? m[3]).trim())
  }
}

/** One parsed line of a transcript, folded into `scan`. */
function noteRecord(rec, scan) {
  if (!scan.firstAt && typeof rec?.timestamp === 'string') scan.firstAt = rec.timestamp
  // The handback as the harness logged it for its hooks: the same message, when the tool call itself is not in the tail.
  if (rec?.type === 'attachment') {
    const a = rec.attachment
    if (a?.type !== 'hook_success' || !/:SubagentHandback$/.test(String(a.hookName || '')) || scan.report) return
    try {
      const message = JSON.parse(a.stdout)?.tool_input?.message
      if (typeof message === 'string') scan.report = message
    } catch {
      /* a hook that printed something else */
    }
    return
  }
  const content = rec?.message?.content
  if (!Array.isArray(content)) return
  if (rec.type === 'assistant') {
    scan.apiError = Boolean(rec.isApiErrorMessage)
    for (const c of content) {
      if (c?.type === 'text' && c.text?.trim()) {
        scan.lastText = c.text.trim()
        if (!rec.isApiErrorMessage) scan.prosePrs.push(...prLinks(c.text))
      }
      else if (c?.type === 'tool_use') noteCall(c, scan)
    }
  } else if (rec.type === 'user') {
    for (const c of content) {
      if (c?.type !== 'tool_result') continue
      const wasCommit = scan.pendingCommits.delete(c.tool_use_id)
      const wasPr = scan.pendingPrs.delete(c.tool_use_id)
      if (c.is_error || !(wasCommit || wasPr)) continue
      const text = resultText(c.content)
      if (wasCommit) {
        scan.committed = true
        for (const m of text.matchAll(COMMIT_LINE)) scan.commits.push({ branch: m[1] === 'detached HEAD' ? '' : m[1], sha: m[2], subject: m[3] })
      }
      if (wasPr) scan.createdPrs.push(...prLinks(text))
    }
  }
}

const scans = new Map() // file -> { key, scan }

/**
 * What a subagent did, from the last `tailBytes` of its transcript: its worktrees, commits, tickets,
 * pull requests, final report and last words (newScan), and when it started if the tail is the whole file.
 * Cached by the file's time and size, so a finished subagent is read once. A line cut off at either
 * end of the tail (the start of the window, or a write in progress) does not parse and is skipped.
 */
export async function scanSubagent(file, { tailBytes = TAIL_BYTES } = {}) {
  const st = await fs.stat(file)
  const key = `${st.mtimeMs}:${st.size}:${tailBytes}`
  const hit = scans.get(file)
  if (hit?.key === key) return hit.scan
  const start = Math.max(0, st.size - tailBytes)
  const handle = await fs.open(file, 'r')
  let text
  try {
    const buf = Buffer.alloc(st.size - start)
    const { bytesRead } = await handle.read(buf, 0, buf.length, start)
    text = buf.toString('utf8', 0, bytesRead)
  } finally {
    await handle.close()
  }
  const scan = newScan()
  const lines = text.split('\n')
  scan.fromStart = start === 0
  if (start > 0) lines.shift() // the tail starts mid-line
  lines.forEach((line, i) => {
    // Most of a transcript is request bookkeeping: only the agent's turns, tool results and the
    // handback matter, plus the very first line, which says when it started.
    const wanted = line.includes('"assistant"') || line.includes('"tool_result"') || line.includes('SubagentHandback') || (i === 0 && scan.fromStart)
    if (!line.startsWith('{') || !wanted) return
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      return // a cut-off line
    }
    noteRecord(rec, scan)
  })
  if (scans.size >= CACHE_MAX) scans.delete(scans.keys().next().value)
  scans.set(file, { key, scan })
  return scan
}

/**
 * The worktree a subagent worked in, as { name, branch }: of the folders it moved into, the one it
 * used last that git lists as a worktree (`trees`: git worktree list, the main checkout first and
 * never counted), else the one its transcript names (scan.worktree) with git's branch for it.
 */
export function worktreeOf(scan, trees) {
  const others = (trees || []).slice(1).map(t => ({ key: dirKey(t.path), name: path.posix.basename(dirKey(t.path, false)), branch: t.branch || '' }))
  let best = null
  for (const [dir, seq] of scan.dirs) {
    const t = others.find(o => dir === o.key || dir.startsWith(o.key + '/'))
    if (t && (!best || seq > best.seq)) best = { name: t.name, branch: t.branch, seq }
  }
  const named = scan.worktrees.get(scan.worktree) ?? -1
  if (best && best.seq >= named) return { name: best.name, branch: best.branch }
  return { name: scan.worktree, branch: others.find(o => o.name === scan.worktree)?.branch || '' }
}

// ═══ the list ═══

/** Runs async jobs with at most `n` in flight, so a first read is not hundreds of open files. */
async function pool(items, n, fn) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }))
  return results
}

const unique = list => [...new Set(list)]

/**
 * One subagent as the page shows it, from its file entry and its scan. `trees` is git's own
 * worktree list ([{ path, branch }], the main checkout first), when the caller has it.
 *   builder  it worked in a worktree or committed; anything else is a lookup
 *   branch   the branch of its last commit, else its worktree's, else one it created
 *   built    the tickets it built: in its branch name, its commit subjects or its task name
 *   tickets  those, or for a subagent that built none the last four it looked at
 *   prs      its pull requests: the links in its report, in what the gh pr commands it ran printed, and in
 *            its own words. Never a link in a file it read, wrote or searched, or in any other output.
 *   flowIds  the flows its own flow commands wrote, whatever name it signed them with
 */
function describe(f, scan, { trees, now }) {
  const description = String(f.meta.description || f.meta.agentType || 'subagent')
  const tree = worktreeOf(scan, trees)
  const builder = Boolean(tree.name) || scan.committed
  const branch = scan.commits.findLast(c => c.branch)?.branch || tree.branch || scan.branchHint || ''
  const built = builder ? unique([...idsInBranch(branch), ...scan.commits.flatMap(c => idsInText(c.subject)), ...idsInText(description)]) : []
  const looked = [...scan.mentions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id]) => id)
  const prs = []
  for (const p of [...prLinks(scan.report), ...scan.createdPrs, ...scan.prosePrs]) if (!prs.some(x => x.repo === p.repo && x.number === p.number)) prs.push(p)
  const finished = Boolean(f.meta.finished)
  const state = subagentState({ finished, report: scan.report, apiError: scan.apiError, ageMs: now - f.mtimeMs })
  return {
    id: f.id,
    sessionId: f.sessionId,
    description,
    agentType: String(f.meta.agentType || ''),
    model: String(f.meta.model || ''),
    finished,
    state,
    builder,
    startedAt: scan.fromStart ? scan.firstAt : null,
    updatedAt: new Date(f.mtimeMs).toISOString(),
    worktree: tree.name,
    branch,
    tickets: built.length ? built : looked,
    built,
    prs: prs.slice(0, PRS_MAX),
    flowIds: [...scan.flowIds],
    hasReport: Boolean(scan.report),
    reportLine: scan.report.trim().split('\n')[0].slice(0, LINE_MAX),
    lastText: state === 'failed' || state === 'stopped' ? scan.lastText.slice(0, LAST_TEXT_MAX) : '',
  }
}

/**
 * Every subagent in the window, newest first, with what its transcript shows (describe). A transcript
 * that cannot be read is left out. The full report is not in the list: subagentReport reads it.
 */
export async function listRepoSubagents({ claudeDirs = [], match = '', sinceMs = 0, trees = null, now = Date.now() } = {}) {
  const files = await listSubagentFiles({ claudeDirs, match, sinceMs })
  const subagents = await pool(files, 6, async f => {
    let scan
    try {
      scan = await scanSubagent(f.file)
    } catch {
      return null
    }
    return describe(f, scan, { trees, now })
  })
  return subagents.filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** Where one subagent's transcript is, among the repo's project folders; null when it is not there or an id is not a plain name. */
export async function repoSubagentFile({ claudeDirs = [], match = '', sessionId, id } = {}) {
  if (!SAFE_ID.test(String(sessionId ?? '')) || !SAFE_ID.test(String(id ?? ''))) return null
  const want = folderKey(match)
  for (const claudeDir of claudeDirs) {
    const projects = path.join(claudeDir, 'projects')
    for (const folder of await entries(projects)) {
      if (!folderKey(folder).includes(want)) continue
      const file = path.join(projects, folder, sessionId, 'subagents', `agent-${id}.jsonl`)
      try {
        await fs.stat(file)
        return file
      } catch {
        /* not in this folder */
      }
    }
  }
  return null
}

/** One subagent's final report in full: '' when it has not handed back, null when there is no such subagent. */
export async function subagentReport(where) {
  const file = await repoSubagentFile(where)
  if (!file) return null
  try {
    return (await scanSubagent(file)).report
  } catch {
    return null
  }
}

/** One subagent by its session and id, whatever its age, described like in the list; null when it is not there or cannot be read. */
export async function oneSubagent({ claudeDirs = [], match = '', sessionId, id, trees = null, now = Date.now() } = {}) {
  const file = await repoSubagentFile({ claudeDirs, match, sessionId, id })
  if (!file) return null
  try {
    const st = await fs.stat(file)
    const meta = JSON.parse(await fs.readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'))
    if (!meta || typeof meta !== 'object') return null
    return describe({ sessionId, id, file, meta, mtimeMs: st.mtimeMs, size: st.size }, await scanSubagent(file), { trees, now })
  } catch {
    return null
  }
}

/**
 * The transcript path of a session of the repo, found by its id alone, so a session that has ended
 * (and left the harness's registry) can still be opened: <projects>/<folder>/<sessionId>.jsonl when
 * that file or the session's own folder is there. null when neither is, or the id is not a plain name.
 */
export async function sessionFile({ claudeDirs = [], match = '', sessionId } = {}) {
  if (!SAFE_ID.test(String(sessionId ?? ''))) return null
  const want = folderKey(match)
  for (const claudeDir of claudeDirs) {
    const projects = path.join(claudeDir, 'projects')
    for (const folder of await entries(projects)) {
      if (!folderKey(folder).includes(want)) continue
      const file = path.join(projects, folder, `${sessionId}.jsonl`)
      for (const there of [file, path.join(projects, folder, sessionId)]) {
        try {
          await fs.stat(there)
          return file
        } catch {
          /* not this one */
        }
      }
    }
  }
  return null
}

// ═══ who built a ticket ═══

const LABEL_MAX = 24 // a subagent's name on a grid chip

/** A subagent's task name short enough for a chip: whole when it fits, else cut at a word (or hard, for one long word) with an ellipsis. */
export function shortLabel(text, max = LABEL_MAX) {
  const s = String(text ?? '').trim().replace(/\s+/g, ' ')
  if (s.length <= max) return s
  const cut = s.slice(0, max - 1)
  const at = cut.lastIndexOf(' ')
  const whole = s[max - 1] === ' ' // the cut already ends on a whole word
  return `${(at > 0 && !whole ? cut.slice(0, at) : cut).trimEnd()}…`
}

/**
 * ticket id -> the subagent that built it, for the Tickets grid: { sessionId, id, description, label, parent }.
 * Only builders count, and only the tickets they built (their branch, their commit subjects, their
 * task name), never one they merely looked at. The newest subagent wins. `parentLabel(sessionId)` is
 * the label of the session that started it, '' when that session has ended.
 */
export function ticketBuilders(subagents, parentLabel = () => '') {
  const out = new Map()
  const newestFirst = [...(subagents || [])].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  for (const h of newestFirst) {
    if (!h.builder) continue
    for (const ticket of h.built || []) {
      if (!out.has(ticket)) out.set(ticket, { sessionId: h.sessionId, id: h.id, description: h.description, label: shortLabel(h.description), parent: parentLabel(h.sessionId) || '' })
    }
  }
  return out
}

// ═══ a subagent's flow ═══

const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase() && String(a ?? '').trim() !== ''

/**
 * The flow that tells a subagent's work, as { id, title, story, visual }, or null. In order: a flow
 * the subagent wrote (its agent, the `--by` of the flow commands, is the subagent's task name, or the
 * subagent ran its flow commands on it, whatever name it signed with), a flow
 * whose recorded pull request starts from the subagent's branch, a flow that names a ticket the subagent
 * built; the newest of equals. Dropped flows never count. `story` is whether it has `flow say`
 * lines, `visual` whether it has a result screenshot (not only a before shot) or a diagram.
 */
export function flowFor(subagent, flows) {
  const rank = f => {
    if (f.status === 'dropped') return 0
    if (sameName(f.agent, subagent.description) || (subagent.flowIds || []).includes(f.id)) return 3
    if (subagent.branch && f.output?.merge?.head === subagent.branch) return 2
    return (subagent.built || []).some(t => (f.tickets || []).includes(t)) ? 1 : 0
  }
  let best = null
  for (const f of flows || []) {
    const r = rank(f)
    if (!r) continue
    if (!best || r > best.r || (r === best.r && String(f.updatedAt || '') > String(best.f.updatedAt || ''))) best = { f, r }
  }
  return best ? { id: best.f.id, title: best.f.title, ...flowTold(best.f) } : null
}

/** What a flow tells so far: `story`, it has `flow say` lines; `visual`, it has a result screenshot (not only a before shot) or a diagram. */
export function flowTold(flow) {
  const out = flow?.output || {}
  return {
    story: (out.story?.length || 0) > 0,
    visual: (out.result || []).some(r => r?.when !== 'before') || (out.diagram?.nodes?.length || 0) > 0,
  }
}

/**
 * Whether an agent's work is told: one of `flows` is its own (its agent is one of `names`, any case,
 * or its id is one of `ids`, the flows the agent ran commands on), is not dropped, was written at or
 * after `since` (when the work started; null skips that), and has both a story and a visual.
 */
export function toldBy(flows, { names = [], ids = [], since = null } = {}) {
  const from = since ? Date.parse(since) : NaN
  return (flows || []).some(f => {
    if (f.status === 'dropped') return false
    if (!ids.includes(f.id) && !names.some(n => sameName(n, f.agent))) return false
    if (!Number.isNaN(from) && Date.parse(f.updatedAt) < from) return false
    const { story, visual } = flowTold(f)
    return story && visual
  })
}

/**
 * What a builder still owes its reader, one plain line for the "no story" badge; '' when nothing.
 * Always '' for a lookup, and for a builder still working: it tells its work when it is finished.
 */
export function storyGap(subagent, flow) {
  if (!subagent.builder || subagent.state === 'working') return ''
  if (!flow) return 'No flow recorded'
  if (!flow.story && !flow.visual) return 'Its flow has no story and no picture'
  if (!flow.story) return 'Its flow has no story'
  return flow.visual ? '' : 'Its flow has no picture'
}
