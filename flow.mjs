// The Flow view's data: what each agent did on each task, as chains of
// operation nodes, with the hand-offs between agents.
//
// One lane per coding session (config.codingAgents, the coordinator first).
// Inside a lane, one row per task (a ticket id, or a worktree whose branch names
// none), and one row per subagent, placed under the task it was spawned for.
// A row is that agent's events on that task, in time order, as nodes:
//
//   your prompt, or a message from the coordinator     brief    "Briefed by Master"
//   a message from anyone else (an agent reporting)    heard    "From Agent 1"
//   Read, Grep, Glob, web, browser, other commands     explore  "Explored"
//   Edit, MultiEdit, Write, NotebookEdit, sed -i, ...  edit     "Edited 6 files"
//   a test, lint or typecheck command                  test     pass / fail from its output
//   SendMessage, SubagentHandback                      message  "Messaged Master"
//   Agent / Task                                       spawn    "Spawned subagent"
//   git commit, git cherry-pick                        commit
//   git merge                                          merge
//   git push                                           push
// and from git, on the row of the agent that did most of the work on the task:
//   commits naming the ticket that no transcript shows commit
//   the task's branch landing on followup, dev, stage  land     "Merged into followup", "On dev", "On stage"
//   the next level it has not reached                  pending  a dashed ghost node
//
// Runs of one kind collapse into one node (14 edits -> "Edited 6 files"); the
// agent's own notes between them ride along as the node's latest note.
//
// Which task an event belongs to: a worktree path in it (its branch's ticket
// ids), else a ticket id it names (prompts, messages, commands, paths; never the
// agent's own prose), else the task of the event before it. A prompt or message
// that names nothing takes the task of what comes right after it.
//
// Turning a row's items into labelled nodes is flow-nodes.mjs; the git half
// (branches, landings, commits) is flow-git.mjs. READ ONLY:
// git log, rev-list, rev-parse, merge-base and for-each-ref. Nothing writes.

import path from 'node:path'

import { gitFacts, LEVELS } from './flow-git.mjs'
import { OUTCOME, toNodes, finalize } from './flow-nodes.mjs'
import { testOutcome } from './report.mjs'
import { idsInBranch, idsInText } from './transcripts.mjs'

const WORKTREE_IN_TEXT = /\.claude[\\/]+worktrees[\\/]+([A-Za-z0-9+._-]+)/g
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const EXPLORE_TOOLS = { Read: 'read', Grep: 'search', Glob: 'search', WebFetch: 'web', WebSearch: 'web', LS: 'read' }
// Harness plumbing, not work on a task.
const SKIP_TOOLS = new Set([
  'ToolSearch', 'TaskStop', 'TodoWrite', 'Skill', 'EnterWorktree', 'ExitWorktree', 'Monitor', 'Artifact', 'ArtifactComments',
  'ArtifactData', 'AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode', 'TaskOutput', 'BashOutput', 'KillShell', 'KillBash',
])
const GIT_STEP = /^(?:\w+=\S*\s+)*git\s+(?:(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)|-c\s+\S+|--no-pager)\s+)*(commit|merge|push|cherry-pick)(?![\w-])(.*)$/
const SHELL_EDIT =
  /\bsed\s+(?:-\w+\s+)*-i|\bperl\s+-\w*i|\.write_text\(|\.write\(|open\([^)]*['"][wa]\+?['"]|\b(?:Set|Add)-Content\b|\bOut-File\b|\bgit\s+apply\b|\bcat\s*>\s*["']?[\w./\\-]/
const COMMIT_IN_RESULT = /\[([^\]\s]+)(?: \([^)]*\))? ([0-9a-f]{7,40})\] ([^\n]*)/g
const LOG_PATH = /(?:[A-Za-z]:)?[\\/][^\s"'`;|&<>()]+\.(?:log|txt|output|out)\b/gi
const DAY = 86_400_000

const clip = (s, n) => {
  s = String(s ?? '').trim()
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}
const firstLine = s => String(s || '').trim().split('\n')[0]
const ms = iso => (iso ? new Date(iso).getTime() : NaN)
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// ─── commands ─────────────────────────────────────────────────────────────────

/** The git steps of a command line that change history: commit, merge, push, cherry-pick. */
function gitSteps(command) {
  return String(command || '')
    .split(/&&|\|\||;|\n/)
    .map(s => s.trim().replace(/^\(+/, ''))
    .map(s => GIT_STEP.exec(s))
    .filter(Boolean)
    .map(m => ({ verb: m[1], args: m[2] }))
}

/** Branch names among a git step's arguments (flags and quoted messages dropped). */
function refsIn(args) {
  return String(args)
    .replace(/"[^"]*"|'[^']*'/g, ' ')
    .split(/\s+/)
    .filter(a => a && !a.startsWith('-') && !/^(origin|HEAD|2>&1|>|\d)$/.test(a) && /^[\w./+-]+$/.test(a))
}

function commitsInResult(result) {
  return [...String(result || '').matchAll(COMMIT_IN_RESULT)].map(m => ({ branch: m[1], sha: m[2], subject: clip(m[3], 160) }))
}

const normPath = p => p.replace(/\\/g, '/').toLowerCase()
/** A fork's first prompt carries the harness's own boilerplate block; the brief is what follows. */
const harnessFree = text => String(text || '').replace(/<fork-boilerplate>[\s\S]*?<\/fork-boilerplate>/g, '').trim()

// ─── one lane ─────────────────────────────────────────────────────────────────

/**
 * A background test run says nothing about pass or fail; the agent reads its
 * log later. Finds that later read (a command or Read naming a log path the test
 * wrote) and judges the test by what it showed.
 */
function resolveBackgroundTests(events) {
  events.forEach((e, i) => {
    if (e.kind !== 'tool' || !e.testing) return
    const outcome = OUTCOME[testOutcome(e)]
    if (outcome === 'pass' || outcome === 'fail') return
    // Literal log files, and log folders held in shell variables (LOG="C:/.../run-logs").
    const files = [...`${e.command || ''}\n${e.result || ''}`.matchAll(LOG_PATH)].map(m => normPath(m[0])).filter(p => !p.includes('$') && p.length > 12)
    const dirs = [...String(e.command || '').matchAll(/\b[A-Z_]+="([^"$]+)"/g)]
      .map(m => normPath(m[1]).replace(/\/+$/, ''))
      .filter(d => d.length > 20 && /[\\/]/.test(d) && !/\/(scratchpad|tmp|temp)$/.test(d))
    const paths = [...files, ...dirs]
    if (!paths.length) return
    const until = ms(e.t) + 3 * 3600_000
    for (const later of events.slice(i + 1, i + 250)) {
      if (ms(later.t) > until) break
      if (later.kind !== 'tool' || later.result == null) continue
      const hay = normPath(`${later.command || ''} ${later.file || ''}`)
      if (!paths.some(p => hay.includes(p))) continue
      const verdict = OUTCOME[testOutcome({ doneAt: later.doneAt || later.t, result: later.result, isError: false })]
      if (verdict === 'pass' || verdict === 'fail') {
        e._later = { verdict, t: later.t, result: later.result }
        return
      }
    }
  })
}

function classify(e, lane, ctx) {
  const t = e.t
  if (e.kind === 'text') return { type: 'note', t, text: e.text }
  if (e.kind === 'user') return { type: 'brief', t, from: lane.briefFrom, text: harnessFree(e.text), ev: e }
  if (e.kind === 'msg-in') {
    const from = e.from === 'a subagent' ? 'a subagent' : ctx.nameOf(e.fromSocket, e.from)
    return { type: from === ctx.coordinator || from === 'You' ? 'brief' : 'heard', t, from, text: e.text, ev: e }
  }
  if (e.kind !== 'tool') return null
  const tool = e.tool
  if (EDIT_TOOLS.has(tool)) return { type: 'edit', t, file: e.file, n: e.edits?.length || 1, ev: e }
  if (tool === 'Bash' || tool === 'PowerShell') {
    const steps = gitSteps(e.command)
    const has = v => steps.some(s => s.verb === v)
    if (has('commit') || has('cherry-pick')) return { type: 'commit', t, ev: e, commits: commitsInResult(e.result), pushed: has('push') }
    if (has('merge')) return { type: 'merge', t, ev: e, branches: steps.filter(s => s.verb === 'merge').flatMap(s => refsIn(s.args)), pushed: has('push') }
    if (has('push')) return { type: 'push', t, ev: e, refs: steps.filter(s => s.verb === 'push').flatMap(s => refsIn(s.args)) }
    if (e.testing) return { type: 'test', t, ev: e }
    if (SHELL_EDIT.test(e.command || '')) return { type: 'edit', t, shell: true, ev: e }
    return { type: 'explore', t, what: 'command', ev: e }
  }
  if (tool === 'Agent' || tool === 'Task') return { type: 'spawn', t, ev: e }
  if (tool === 'SendMessage') return { type: 'message', t, to: ctx.nameOf(e.to, e.to), toSub: ctx.subById.has(e.to) ? e.to : '', text: e.text, ev: e }
  if (tool === 'SubagentHandback') return { type: 'message', t, to: lane.parentLabel || 'its parent', text: e.text, ev: e, handback: true }
  if (SKIP_TOOLS.has(tool)) return null
  if (EXPLORE_TOOLS[tool]) return { type: 'explore', t, what: EXPLORE_TOOLS[tool], ev: e }
  if (tool.startsWith('mcp__playwright__')) return { type: 'explore', t, what: 'browser', ev: e }
  return { type: 'explore', t, what: 'other', ev: e }
}

/** The task an event names by itself, or null. Candidates when it names several ids. */
function explicitKey(e, ctx) {
  if (e.kind === 'text') return null
  const hay = [e.file, e.command, e.kind === 'tool' && e.tool !== 'SendMessage' ? e.summary : '', e.kind !== 'tool' || e.spawn || e.tool === 'SendMessage' ? e.text : '']
    .filter(Boolean)
    .join('\n')
  if (!hay) return null
  for (const m of hay.matchAll(WORKTREE_IN_TEXT)) {
    const name = m[1].replace(/[.]+$/, '')
    const ids = ctx.idsOfTree(name)
    return { keys: [ids.length ? ids.join('+') : `wt:${name}`] }
  }
  const ids = idsInText(hay)
  return ids.length ? { keys: [...new Set(ids.map(ctx.keyOfId))] } : null
}

/** Task key per event: named, else carried forward, else taken from what follows a brief. */
function keyEvents(events, ctx) {
  const isBrief = e => e.kind === 'user' || e.kind === 'msg-in'
  const out = new Array(events.length).fill(null)
  let cur = null
  events.forEach((e, i) => {
    const named = explicitKey(e, ctx)
    if (named) cur = named.keys.includes(cur) ? cur : named.keys[0]
    else if (isBrief(e)) cur = null
    out[i] = cur
  })
  let next = null
  for (let i = events.length - 1; i >= 0; i--) {
    if (out[i]) next = out[i]
    else out[i] = next
    if (isBrief(events[i]) && !explicitKey(events[i], ctx)) next = null
  }
  return out.map(k => k || 'none')
}

// ─── the whole flow ───────────────────────────────────────────────────────────

/**
 * @param o.lanes        [{ label, sessionId, coordinator, state, events, subagents: [{ id, description, agentType, model, toolUseId, events }] }]
 * @param o.hours        window length; 0 = everything buffered
 * @param o.worktrees    [{ path, branch }] from `git worktree list`
 * @param o.git          (args, cwd) -> { ok, out }
 * @param o.nameOf       session name or pipe address -> label
 * @param o.coordinator  the coordinator's label
 * @param o.titleOf      ticket id -> title or ''
 * @param o.dirtyOf      worktree name -> uncommitted file count, when known
 * @param o.repo         repo path, cut off file paths
 */
export async function buildFlow({ lanes, hours, worktrees, git, nameOf, coordinator, titleOf = () => '', dirtyOf = () => null, repo = '' }) {
  const now = Date.now()
  let from = hours > 0 ? now - hours * 3600_000 : Infinity
  if (!(hours > 0)) for (const l of lanes) for (const e of l.events) if (e.t) from = Math.min(from, ms(e.t))
  if (!Number.isFinite(from)) from = now - DAY

  const repoRe = new RegExp(`^${repo.replace(/[\\/]/g, '[\\\\/]').replace(/[.*+?^${}()|]/g, '\\$&')}[\\\\/]`, 'i')
  const branchOfTree = new Map(worktrees.map(w => [path.basename(w.path), w.branch]))
  const multi = new Map()
  for (const b of worktrees.map(w => w.branch)) {
    const ids = idsInBranch(b)
    if (ids.length > 1) for (const id of ids) multi.set(id, ids.join('+'))
  }
  for (const b of worktrees.map(w => w.branch)) {
    const ids = idsInBranch(b)
    if (ids.length === 1) multi.delete(ids[0]) // a branch of its own: keep it a task of its own
  }
  // A SendMessage can address a running subagent by its agent id.
  const subById = new Map(lanes.flatMap(l => l.subagents.map(s => [s.id, s])))
  let seq = 0
  const ctx = {
    now,
    coordinator,
    subById,
    nameOf: (key, fallback) => (subById.has(key) ? `subagent: ${clip(subById.get(key).description, 40)}` : nameOf(key, fallback)),
    nodeOfEvent: new Map(),
    nextId: () => `n${++seq}`,
    keyOfId: id => multi.get(id) || id,
    idsOfTree: name => {
      const b = branchOfTree.get(name)
      const ids = idsInBranch(b || '')
      return ids.length ? ids : idsInBranch(name)
    },
    short: p =>
      String(p || '')
        .replace(/^.*?[\\/]\.claude[\\/]+worktrees[\\/]+[^\\/]+[\\/]/i, '')
        .replace(repoRe, '')
        .replace(/\\/g, '/'),
  }
  const inWindow = e => e.t && ms(e.t) >= from

  // Rows, keyed by lane and task; subagents get their own rows.
  const rows = []
  const rowByKey = new Map()
  const rowOf = (laneIdx, key) => {
    const k = `${laneIdx}|${key}`
    if (!rowByKey.has(k)) {
      const row = { id: `r${rows.length + 1}`, lane: laneIdx, key, sub: null, parent: null, items: [] }
      rows.push(row)
      rowByKey.set(k, row)
    }
    return rowByKey.get(k)
  }
  const spawnByToolId = new Map() // Agent tool_use id -> { item, row }
  const sends = [] // { item, laneIdx, row }
  const inbox = [] // { item, laneIdx }

  lanes.forEach((lane, li) => {
    resolveBackgroundTests(lane.events)
    const keys = keyEvents(lane.events, ctx)
    lane.events.forEach((e, i) => {
      if (!inWindow(e)) return
      const it = classify(e, { briefFrom: 'You' }, ctx)
      if (!it) return
      if (it.type === 'merge' && it.branches.length) {
        // One `git merge` line can merge several tasks' branches: split it.
        const byKey = new Map()
        for (const b of it.branches) {
          const ids = idsInBranch(b)
          const k = ids.length ? ids.map(ctx.keyOfId)[0] : keys[i]
          byKey.set(k, [...(byKey.get(k) || []), b])
        }
        for (const [k, branches] of byKey) rowOf(li, k).items.push({ ...it, branches })
        return
      }
      const row = rowOf(li, keys[i])
      row.items.push(it)
      if (it.type === 'spawn') spawnByToolId.set(e.toolId, { row, item: it })
      if (it.type === 'message') sends.push({ item: it, laneIdx: li, row })
      if (it.type === 'brief' || it.type === 'heard') inbox.push({ item: it, laneIdx: li })
    })
  })

  // Subagents: a row each, under the task row it was spawned from.
  lanes.forEach((lane, li) => {
    const pending = [...lane.subagents]
    // A subagent can spawn its own; take parents before children.
    for (let guard = 0; pending.length && guard < 6; guard++) {
      for (const s of [...pending]) {
        const spawn = spawnByToolId.get(s.toolUseId)
        if (!spawn && lane.subagents.some(o => o !== s && o.events.some(e => e.toolId === s.toolUseId)) && guard < 5) continue
        pending.splice(pending.indexOf(s), 1)
        const events = s.events.filter(inWindow)
        if (!events.length) continue
        resolveBackgroundTests(s.events)
        const parentLabel = spawn ? lanes[spawn.row.lane].label : lane.label
        const keys = keyEvents(s.events, ctx)
        const ownKey = keys.find(k => k !== 'none') || 'none'
        const row = {
          id: `r${rows.length + 1}`,
          lane: li,
          key: spawn ? spawn.row.key : ownKey,
          sub: { id: s.id, description: s.description, agentType: s.agentType, model: s.model },
          parent: spawn ? spawn.row.id : null,
          items: [],
          spawnItem: spawn?.item || null,
        }
        rows.push(row)
        let first = true
        for (const e of s.events) {
          if (!inWindow(e)) continue
          // A fork's transcript replays its parent's Agent call first; that is the parent's step.
          if (e.kind === 'tool' && e.toolId && e.toolId === s.toolUseId) continue
          const it = classify(e, { briefFrom: parentLabel, parentLabel }, ctx)
          if (!it) continue
          if (it.type === 'brief' && !it.text) it.text = spawn?.item.ev.text || ''
          if (it.type === 'brief' && first) it.subBrief = true
          first = false
          row.items.push(it)
          if (it.type === 'spawn') spawnByToolId.set(e.toolId, { row, item: it })
        }
      }
    }
  })

  // Tasks and their git facts.
  const taskByKey = new Map()
  for (const row of rows) {
    if (row.key === 'none' || !row.items.length) continue
    const t0 = Math.min(...row.items.map(it => ms(it.t)).filter(Number.isFinite))
    const task = taskByKey.get(row.key) || { key: row.key, ids: row.key.startsWith('wt:') ? [] : row.key.split('+'), firstT: t0 }
    task.firstT = Math.min(task.firstT, t0)
    taskByKey.set(row.key, task)
  }
  const tasks = [...taskByKey.values()]
  const facts = await gitFacts(git, tasks, from, worktrees)

  // Transcript commits, so git does not draw them twice.
  const seenShas = []
  for (const row of rows) for (const it of row.items) if (it.type === 'commit') for (const c of it.commits) seenShas.push(c.sha)
  const seen = sha => seenShas.some(s => s.startsWith(sha.slice(0, 7)) || sha.startsWith(s.slice(0, 7)))

  // The row that gets git's facts: the coding agent with the most work on the
  // task, else the coordinator's row.
  for (const task of tasks) {
    const candidates = rows.filter(r => r.key === task.key && !r.sub && r.items.length)
    const score = r => r.items.filter(it => it.type !== 'note').length
    const coding = candidates.filter(r => !lanes[r.lane].coordinator).sort((a, b) => score(b) - score(a))
    const home = coding[0] || candidates[0]
    if (!home) continue
    task.homeRow = home.id
    const f = facts.get(task.key)
    if (!f) continue
    // Only what followed this row's own work: commits and landings from an
    // earlier round of the ticket are not this agent's operations.
    const start = Math.min(...home.items.map(it => ms(it.t)).filter(Number.isFinite)) - 5 * 60_000
    for (const c of f.commits) if (ms(c.t) >= Math.max(from, start) && !seen(c.sha)) home.items.push({ type: 'commit', t: c.t, git: true, commit: c })
    home.items.push(...f.landings.filter(l => ms(l.t) >= start))
    task.branch = f.newest?.name || ''
    task.reached = f.reached
    // The next level this task has not reached, as a ghost at the row's end.
    const tree = worktrees.find(w => w.branch === task.branch)
    const dirty = tree ? dirtyOf(path.basename(tree.path)) : null
    home.ghosts = []
    if (dirty) home.ghosts.push({ label: `${plural(dirty, 'file')} uncommitted`, sub: path.basename(tree.path), detail: { worktree: path.basename(tree.path), dirty } })
    if (f.reached) {
      const next = f.reached.dev ? LEVELS.slice(2).find(l => !f.reached[l.key]) : LEVELS.find(l => !f.reached[l.key])
      if (next) home.ghosts.push({ label: next.todo, sub: task.branch, detail: { level: next.key, branch: task.branch, reached: f.reached } })
    }
  }

  // Items -> nodes, rows in display order.
  for (const row of rows) {
    row.items.sort((a, b) => ms(a.t) - ms(b.t))
    row.nodes = toNodes(row.items, ctx)
  }
  // Hand-offs between lanes and down to subagents.
  const links = []
  const usedInbox = new Set()
  for (const s of sends) {
    if (s.item.handback) continue
    if (s.item.toSub) {
      // To a subagent: its first step at or after the message.
      const row = rows.find(r => r.sub?.id === s.item.toSub)
      const t0 = ms(s.item.t)
      const hit = row?.nodes.find(n => ms(n.t) >= t0 - 60_000 && ms(n.t) - t0 < 20 * 60_000)
      const a = ctx.nodeOfEvent.get(s.item.ev)
      if (a && hit) links.push({ from: a, to: hit.id, kind: 'message' })
      continue
    }
    const fromLabel = lanes[s.laneIdx].label
    const candidates = inbox.filter(
      m => !usedInbox.has(m) && lanes[m.laneIdx].label === s.item.to && m.item.from === fromLabel && Math.abs(ms(m.item.t) - ms(s.item.t)) < 5 * 60_000
    )
    const key = firstLine(s.item.text).slice(0, 50)
    const match = candidates.find(m => firstLine(m.item.text).slice(0, 50) === key) || candidates.sort((a, b) => Math.abs(ms(a.item.t) - ms(s.item.t)) - Math.abs(ms(b.item.t) - ms(s.item.t)))[0]
    if (!match) continue
    usedInbox.add(match)
    const a = ctx.nodeOfEvent.get(s.item.ev)
    const b = ctx.nodeOfEvent.get(match.item.ev)
    if (a && b) links.push({ from: a, to: b, kind: match.item.type === 'brief' ? 'brief' : 'message' })
  }
  for (const row of rows.filter(r => r.sub && r.nodes.length)) {
    const parentRow = rows.find(r => r.id === row.parent)
    if (row.spawnItem) {
      const a = ctx.nodeOfEvent.get(row.spawnItem.ev)
      if (a) links.push({ from: a, to: row.nodes[0].id, kind: 'spawn' })
    }
    // Reporting back: to the parent's first node after the subagent's last.
    if (parentRow) {
      const end = ms(row.nodes[row.nodes.length - 1].t2 || row.nodes[row.nodes.length - 1].t)
      const back = parentRow.nodes.find(n => ms(n.t) >= end && ms(n.t) - end < 2 * 3600_000)
      if (back) links.push({ from: row.nodes[row.nodes.length - 1].id, to: back.id, kind: 'report' })
    }
  }
  // A coordinator's `git merge` -> the branch landing in followup.
  const lands = rows.flatMap(r => r.nodes.filter(n => n.type === 'land' && n.level === 'followup'))
  for (const row of rows) {
    for (const n of row.nodes.filter(n => n.type === 'merge')) {
      const branches = n.items.flatMap(it => it.branches)
      for (const l of lands) {
        if (l.items.some(it => branches.includes(it.branch)) && Math.abs(ms(l.t) - ms(n.t)) < 30 * 60_000) links.push({ from: n.id, to: l.id, kind: 'merge' })
      }
    }
  }

  // Display order: per lane, task rows by first activity, each followed by its subagents.
  const ordered = []
  lanes.forEach((_, li) => {
    const laneRows = rows.filter(r => r.lane === li && r.nodes.length)
    const firstT = r => ms(r.nodes[0].t)
    const place = parent => {
      for (const child of laneRows.filter(r => r.parent === parent.id).sort((a, b) => firstT(a) - firstT(b))) {
        ordered.push(child)
        place(child)
      }
    }
    for (const r of laneRows.filter(r => !r.sub).sort((a, b) => firstT(a) - firstT(b))) {
      ordered.push(r)
      place(r)
    }
    for (const r of laneRows.filter(r => r.sub && !laneRows.some(p => p.id === r.parent)).sort((a, b) => firstT(a) - firstT(b))) {
      ordered.push(r)
      place(r)
    }
  })

  const taskInfo = key => {
    if (key === 'none') return { key, ids: [], label: 'No ticket', title: 'Work that names no ticket or worktree' }
    if (key.startsWith('wt:')) return { key, ids: [], label: key.slice(3), title: `worktree ${key.slice(3)}`, branch: branchOfTree.get(key.slice(3)) || '' }
    const ids = key.split('+')
    const t = taskByKey.get(key)
    const title = ids.map(titleOf).find(Boolean) || facts.get(key)?.commits.find(c => !/^Merge /.test(c.subject))?.subject || ''
    return { key, ids, label: ids.join(' + '), title, branch: t?.branch || '', reached: t?.reached || null }
  }

  const outRows = ordered.map(r => {
    const nodes = r.nodes.map(n => finalize(n, ctx))
    for (const g of r.ghosts || []) nodes.push(finalize({ id: ctx.nextId(), type: 'pending', items: [{}], label: g.label, sub: g.sub, detail: g.detail }, ctx))
    return {
      id: r.id,
      lane: r.lane,
      task: taskInfo(r.key),
      sub: r.sub,
      parent: r.parent,
      depth: r.sub ? depthOf(r, rows) : 0,
      nodes,
    }
  })
  const shown = new Set(outRows.flatMap(r => r.nodes.map(n => n.id)))
  const seenLink = new Set()
  return {
    builtAt: new Date(now).toISOString(),
    from: new Date(from).toISOString(),
    hours,
    lanes: lanes.map((l, i) => ({ index: i, label: l.label, sessionId: l.sessionId, coordinator: Boolean(l.coordinator), state: l.state })),
    rows: outRows,
    links: links.filter(l => {
      const k = `${l.from}>${l.to}`
      if (!shown.has(l.from) || !shown.has(l.to) || seenLink.has(k)) return false
      seenLink.add(k)
      return true
    }),
    tasks: [...new Map(outRows.map(r => [r.task.key, r.task])).values()].sort((a, b) => a.label.localeCompare(b.label)),
  }
}

function depthOf(row, rows) {
  let d = 0
  let cur = row
  while (cur?.parent && d < 4) {
    cur = rows.find(r => r.id === cur.parent)
    if (cur?.sub) d++
    else break
  }
  return d + 1
}
