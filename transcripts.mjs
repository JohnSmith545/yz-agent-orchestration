// Reading Claude session transcripts (~/.claude): which worktrees and tickets a
// session touched, its live activity feed, its subagents, and whether it is
// Testing, Active or Idle.
//
// Transcripts run to 100+ MB. Each is read ONCE in full (cheaply: most lines are
// skipped unparsed) and after that only the bytes appended since the last read.
// The activity feed is built from the last FEED_TAIL_BYTES on the first read and
// from every new line after that.

import { createReadStream, promises as fs, readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { CONFIG } from './config.mjs'
import { DATA_DIR } from './flows.mjs'
import * as Ids from './ticket-ids.mjs'

// ─── ticket ids ───────────────────────────────────────────────────────────────
// ticket-ids.mjs is pure; here its functions are bound to the prefixes this
// dashboard knows: config.ticketPrefixes, else the collection filters and the
// ids in data/sources/*.json (re-read at most once a minute, since a refresh
// rewrites them). Most modules import idsInText and idsInBranch from here.

const PREFIXES_TTL_MS = 60_000
let prefixCache = null
let prefixOverride = null

function sourceIds() {
  const dir = path.join(DATA_DIR, 'sources')
  let names = []
  try {
    names = readdirSync(dir).filter(n => n.endsWith('.json') && !n.endsWith('.prev.json'))
  } catch {
    return []
  }
  const ids = []
  for (const n of names) {
    try {
      ids.push(...Object.keys(JSON.parse(readFileSync(path.join(dir, n), 'utf8')).tickets || {}))
    } catch {
      /* a source mid-write or broken; the next read tries again */
    }
  }
  return ids
}

/** The ticket prefixes in use now, in rank order; [] means the generic shape (ticket-ids.mjs). */
export function ticketPrefixes() {
  if (prefixOverride) return prefixOverride
  if (prefixCache && Date.now() - prefixCache.at < PREFIXES_TTL_MS) return prefixCache.list
  const configured = CONFIG.ticketPrefixes
  const list = Ids.knownPrefixes({ configured, collections: CONFIG.factory.collections, sourceIds: Array.isArray(configured) ? [] : sourceIds() })
  prefixCache = { at: Date.now(), list }
  return list
}

/** Tests only: fix the prefix list (null goes back to the config and the sources). */
export function useTicketPrefixes(list) {
  prefixOverride = list
  prefixCache = null
}

export const idsInText = text => Ids.idsInText(text, ticketPrefixes())
export const idsInBranch = branch => Ids.idsInBranch(branch, ticketPrefixes())
const mayHoldTicketId = line => Ids.mayHoldTicketId(line, ticketPrefixes())

export const CLAUDE_DIR = path.join(os.homedir(), '.claude')
/**
 * Every Claude config folder to look for sessions in: ~/.claude, the one this
 * server was started under (CLAUDE_CONFIG_DIR, e.g. a second account), and any
 * listed in config.claudeDirs. Sessions from several accounts show side by side.
 */
export const CLAUDE_DIRS = [...new Set([CLAUDE_DIR, process.env.CLAUDE_CONFIG_DIR, ...CONFIG.claudeDirs].filter(Boolean).map(d => path.resolve(d)))]
const FEED_TAIL_BYTES = 4 * 1024 * 1024
const FEED_MAX_EVENTS = 500
const TEXT_MAX = 4000
const RESULT_MAX = 2500
const EDIT_MAX = 6000

const WORKTREE_IN_TEXT = /\.claude[\\/]+worktrees[\\/]+([A-Za-z0-9+._-]+)/g
// A command that runs tests, analysis or type checks: what "Testing" means.
// Matched against the START of each step of a command line (after `cd x &&`),
// so a grep or a heredoc that merely mentions vitest does not count.
const TEST_STEP =
  /^(npx\s+|pnpm\s+(exec\s+)?)?(vitest|jest|tsc|eslint|playwright\s+test)\b|^flutter\s+(test|analyze)\b|^dart\s+test\b|^pnpm\s+(run\s+)?(test|precheck|typecheck|lint)\b|^pnpm\s+--filter\s+\S+\s+(run\s+)?(test|typecheck|lint)\b|^npm\s+(run\s+)?test\b/i

export function isTestCommand(command) {
  return String(command || '')
    .split('<<')[0] // a heredoc body is a script's text, not steps of the command
    .split(/&&|\|\||;|\n/)
    .map(s => s.trim().replace(/^\(+/, ''))
    .some(step => TEST_STEP.test(step))
}

const clip = (s, n) => {
  s = String(s ?? '')
  return s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s
}

// ─── incremental reader ───────────────────────────────────────────────────────

const scans = new Map() // file -> scan

function newScan() {
  return {
    offset: 0, // bytes read so far
    rest: Buffer.alloc(0),
    lines: 0,
    feedFrom: 0, // byte position the feed starts at
    worktrees: new Map(), // name -> line number of last mention
    tickets: new Map(),
    feed: { events: [], seq: 0, byToolId: new Map() },
    mtime: null,
    model: null, // the model of the newest reply read (the agent window warns when the planner or Security is not on Opus)
  }
}

/** Reads whatever was appended to `file` since last time. */
export async function scanTranscript(file, ownCwd, knownTrees) {
  const { size, mtime } = await fs.stat(file)
  let scan = scans.get(file)
  if (!scan || size < scan.offset) {
    scan = newScan()
    scan.feedFrom = Math.max(0, size - FEED_TAIL_BYTES)
    scans.set(file, scan)
  }
  scan.mtime = mtime.toISOString()
  if (size <= scan.offset) return scan

  let base = scan.offset - scan.rest.length // file position of rest[0]
  let pending = scan.rest
  for await (const chunk of createReadStream(file, { start: scan.offset, end: size - 1 })) {
    const buf = pending.length ? Buffer.concat([pending, chunk]) : chunk
    let start = 0
    let nl
    while ((nl = buf.indexOf(10, start)) !== -1) {
      const lineStartPos = base + start
      scan.lines++
      handleLine(buf.toString('utf8', start, nl), scan, ownCwd, knownTrees, lineStartPos >= scan.feedFrom)
      start = nl + 1
    }
    pending = buf.subarray(start)
    base += start
  }
  scan.rest = Buffer.from(pending)
  scan.offset = size
  return scan
}

function handleLine(line, scan, ownCwd, knownTrees, inFeed) {
  if (!line.startsWith('{')) return
  // Outside the feed window only worktree and ticket mentions matter, so skip
  // the JSON parse for the many lines that cannot hold one.
  if (!inFeed && !(line.includes('worktrees') || mayHoldTicketId(line))) return
  let rec
  try {
    rec = JSON.parse(line)
  } catch {
    return
  }
  noteMentions(rec, scan, ownCwd, knownTrees)
  // the model the session really runs on: its newest reply says (a <synthetic> one is the CLI's own, not a model)
  if (rec.type === 'assistant' && typeof rec.message?.model === 'string' && /^[a-z]/i.test(rec.message.model)) scan.model = rec.message.model
  if (inFeed) noteFeed(rec, scan.feed)
}

function noteMentions(rec, scan, ownCwd, knownTrees) {
  const parts = []
  // A session started inside a worktree stamps that cwd on every line; only a
  // cd somewhere else says anything about what it is doing now.
  if (typeof rec.cwd === 'string' && rec.cwd.toLowerCase() !== ownCwd) parts.push(rec.cwd)
  // Tool CALLS only, never tool output: a `git worktree list` result names
  // every worktree and would credit the session with all of them.
  const content = rec.type === 'assistant' ? rec.message?.content : null
  if (Array.isArray(content)) for (const c of content) if (c?.type === 'tool_use') parts.push(JSON.stringify(c.input ?? {}))
  if (!parts.length) return
  const hay = parts.join(' ')
  for (const m of hay.matchAll(WORKTREE_IN_TEXT)) {
    const name = m[1].replace(/[.]+$/, '')
    if (!knownTrees || knownTrees.has(name)) scan.worktrees.set(name, scan.lines)
  }
  if (rec.type === 'assistant') for (const id of idsInText(hay)) scan.tickets.set(id, scan.lines)
}

// ─── activity feed ────────────────────────────────────────────────────────────

function pushEvent(feed, ev) {
  ev.seq = ++feed.seq
  ev.upd = ev.seq
  feed.events.push(ev)
  if (feed.events.length > FEED_MAX_EVENTS) {
    const dropped = feed.events.shift()
    if (dropped.toolId) feed.byToolId.delete(dropped.toolId)
  }
}

/** Removes the harness's injected blocks so a prompt reads as the user wrote it. */
function cleanUserText(text) {
  return String(text)
    .replace(/<system-reminder[^>]*>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<(command-[a-z-]+|local-command-[a-z-]+)>[\s\S]*?<\/\1>/g, '')
    .replace(/^\[Request interrupted by user[^\]]*\]$/gm, '')
    .trim()
}

function resultText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(c => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : '')).join('\n')
  return ''
}

function toolEvent(c, t) {
  const input = c.input ?? {}
  const ev = { t, kind: 'tool', tool: c.name, toolId: c.id }
  switch (c.name) {
    case 'Edit':
      ev.file = input.file_path
      ev.edits = [{ old: clip(input.old_string, EDIT_MAX), new: clip(input.new_string, EDIT_MAX) }]
      ev.all = Boolean(input.replace_all)
      break
    case 'MultiEdit':
      ev.file = input.file_path
      ev.edits = (input.edits || []).slice(0, 20).map(e => ({ old: clip(e.old_string, EDIT_MAX), new: clip(e.new_string, EDIT_MAX) }))
      break
    case 'Write':
      ev.file = input.file_path
      ev.content = clip(input.content, EDIT_MAX)
      break
    case 'NotebookEdit':
      ev.file = input.notebook_path
      ev.content = clip(input.new_source, EDIT_MAX)
      break
    case 'Bash':
    case 'PowerShell':
      ev.command = clip(input.command, TEXT_MAX)
      ev.summary = input.description || ''
      ev.background = Boolean(input.run_in_background)
      ev.testing = isTestCommand(input.command)
      break
    case 'Read':
      ev.file = input.file_path
      ev.summary = input.offset ? `from line ${input.offset}` : ''
      break
    case 'Grep':
      ev.summary = `${input.pattern ?? ''}${input.path ? ` in ${input.path}` : ''}${input.glob ? ` (${input.glob})` : ''}`
      break
    case 'Glob':
      ev.summary = `${input.pattern ?? ''}${input.path ? ` in ${input.path}` : ''}`
      break
    case 'Agent':
    case 'Task':
      ev.summary = input.description || ''
      ev.text = clip(input.prompt, TEXT_MAX)
      ev.spawn = true
      break
    case 'SendMessage':
      ev.to = String(input.to ?? '').replace(/\s*\[[0-9a-f]+\]$/i, '')
      ev.summary = `to ${ev.to}`
      ev.text = clip(input.message, TEXT_MAX)
      break
    case 'SubagentHandback':
      ev.summary = 'to its parent'
      ev.text = clip(input.message, TEXT_MAX)
      break
    default:
      ev.summary = clip(JSON.stringify(input), 400)
  }
  return ev
}

// A message from another session arrives inside the harness's own wording:
// <cross-session-message from="<socket>" from-name="Coordinator" ...>body</...>.
const PEER_MESSAGE = /<cross-session-message\b([^>]*)>([\s\S]*?)<\/cross-session-message>/g
const SUBAGENT_HANDBACK = /<agent-message\b[^>]*>([\s\S]*?)<\/agent-message>/g
const HARNESS_WRAPPER = [
  /Another Claude session sent a message[^\n]*\n?/g,
  /This came from another Claude session[\s\S]*$/g,
  /That "other Claude session" is an agent[\s\S]*$/g,
  /<task-notification>[\s\S]*?<\/task-notification>/g,
  /\[SYSTEM NOTIFICATION[\s\S]*$/g,
]

const attr = (attrs, name) => (new RegExp(`${name}="([^"]*)"`).exec(attrs) || [])[1] || ''

/** Pulls peer messages out of `text`; returns them and what is left over. */
function takePeerMessages(text) {
  const found = []
  let rest = String(text).replace(PEER_MESSAGE, (_, attrs, body) => {
    found.push({ fromName: attr(attrs, 'from-name'), fromSocket: attr(attrs, 'from'), body: body.trim() })
    return ''
  })
  rest = rest.replace(SUBAGENT_HANDBACK, (_, body) => {
    found.push({ fromName: '', fromSocket: '', subagent: true, body: body.trim() })
    return ''
  })
  for (const re of HARNESS_WRAPPER) rest = rest.replace(re, '')
  return { found, rest }
}

function pushIncoming(feed, t, found) {
  for (const m of found) {
    const key = `${m.fromName}|${m.body.slice(0, 120)}`
    if (feed.seenIncoming?.has(key)) continue // the same message as attachment AND user turn
    ;(feed.seenIncoming ??= new Set()).add(key)
    pushEvent(feed, {
      t,
      kind: 'msg-in',
      from: m.subagent ? 'a subagent' : m.fromName || 'another session',
      fromSocket: m.fromSocket,
      text: clip(m.body, TEXT_MAX),
    })
  }
}

function noteFeed(rec, feed) {
  const t = rec.timestamp || null
  const content = rec.message?.content
  if (rec.type === 'attachment') {
    for (const r of rec.rendered || []) {
      if (typeof r?.content !== 'string') continue
      pushIncoming(feed, t, takePeerMessages(r.content).found)
      // A message the user typed while the agent was mid-turn arrives here too.
      const typed = /The user sent a new message while you were working:\n([\s\S]*?)(?:\n\nThis is how Claude Code surfaces|<\/system-reminder>|$)/.exec(r.content)
      if (typed?.[1].trim()) pushEvent(feed, { t, kind: 'user', text: clip(typed[1].trim(), TEXT_MAX) })
    }
    return
  }
  if (rec.type === 'assistant' && Array.isArray(content)) {
    for (const c of content) {
      if (c?.type === 'text' && c.text?.trim()) pushEvent(feed, { t, kind: 'text', text: clip(c.text, TEXT_MAX) })
      else if (c?.type === 'tool_use') {
        const ev = toolEvent(c, t)
        pushEvent(feed, ev)
        feed.byToolId.set(c.id, ev)
      }
    }
    return
  }
  if (rec.type !== 'user' || rec.isMeta) return
  const userText = raw => {
    const { found, rest } = takePeerMessages(raw)
    pushIncoming(feed, t, found)
    const text = cleanUserText(rest)
    if (text) pushEvent(feed, { t, kind: 'user', text: clip(text, TEXT_MAX) })
  }
  if (typeof content === 'string') return userText(content)
  if (!Array.isArray(content)) return
  for (const c of content) {
    if (c?.type === 'tool_result') {
      const ev = feed.byToolId.get(c.tool_use_id)
      if (!ev) continue
      ev.result = clip(resultText(c.content), RESULT_MAX)
      ev.isError = Boolean(c.is_error)
      ev.doneAt = t
      ev.upd = ++feed.seq
    } else if (c?.type === 'text') {
      userText(c.text)
    }
  }
}

/**
 * Who talked to whom, from one session's feed. `self` is this session's label;
 * `nameOf` turns a SendMessage target or a sender socket into a label.
 *   You -> self       a prompt the user typed
 *   self -> X         a SendMessage
 *   X -> self         a message that arrived from another session
 *   self -> subagent  a subagent briefed with the Agent tool
 */
export function conversationsOf(scan, self, nameOf) {
  const out = []
  for (const e of scan.feed.events) {
    const line = String(e.text || '').trim().split('\n')[0].slice(0, 160)
    if (e.kind === 'user') out.push({ t: e.t, from: 'You', to: self, text: line, via: 'prompt' })
    else if (e.kind === 'msg-in') out.push({ t: e.t, from: nameOf(e.fromSocket, e.from), to: self, text: line, via: 'message' })
    else if (e.kind === 'tool' && e.tool === 'SendMessage') out.push({ t: e.t, from: self, to: nameOf(e.to, e.to), text: line, via: 'message' })
    else if (e.kind === 'tool' && e.spawn) out.push({ t: e.t, from: self, to: `subagent: ${e.summary || 'task'}`, text: line, via: 'subagent' })
  }
  return out
}

/** Events added or changed after `since` (all buffered ones when since is 0). */
export function feedSince(scan, since, limit = 200) {
  const out = scan.feed.events.filter(e => e.upd > since)
  return { events: out.slice(-limit), cursor: scan.feed.seq }
}

// ─── state ────────────────────────────────────────────────────────────────────

/**
 * Testing: working, and its latest tool call runs tests or checks (still
 *          running, or finished under two minutes ago).
 * Active:  working on anything else.
 * Idle:    not working.
 */
export function stateOf(scan, working) {
  const last = [...scan.feed.events].reverse().find(e => e.kind === 'tool')
  const lastTool = last ? { tool: last.tool, summary: last.summary || last.file || (last.command || '').slice(0, 120), t: last.t } : null
  if (!working) return { state: 'idle', lastTool }
  const recent = last && (!last.doneAt || Date.now() - new Date(last.doneAt) < 120_000)
  return { state: last?.testing && recent ? 'testing' : 'active', lastTool }
}

// ─── files on disk ────────────────────────────────────────────────────────────

/** ~/.claude/projects folder for a cwd: every non-alphanumeric becomes '-'. */
export async function projectDirFor(cwd, base = CLAUDE_DIR) {
  const want = cwd.replace(/[^A-Za-z0-9]/g, '-').toLowerCase()
  let dirs = []
  try {
    dirs = await fs.readdir(path.join(base, 'projects'))
  } catch {
    return null
  }
  const hit = dirs.find(d => d.toLowerCase() === want)
  return hit ? path.join(base, 'projects', hit) : null
}

export async function transcriptFile(session) {
  const dir = await projectDirFor(session.cwd, session._claudeDir || CLAUDE_DIR)
  return dir ? path.join(dir, `${session.sessionId}.jsonl`) : null
}

export function subagentFile(sessionFile, agentId) {
  return path.join(sessionFile.replace(/\.jsonl$/, ''), 'subagents', `agent-${agentId}.jsonl`)
}

/**
 * id -> description for every subagent a session ever started, finished or
 * not, from the small .meta.json files only. A message to a subagent names it
 * by id, and that subagent may have dropped out of listSubagents long ago.
 * A description never changes, so each one is read once.
 */
const subNameCache = new Map()
export async function subagentNames(sessionFile) {
  const dir = path.join(sessionFile.replace(/\.jsonl$/, ''), 'subagents')
  const out = new Map()
  let names
  try {
    names = await fs.readdir(dir)
  } catch {
    return out
  }
  for (const n of names.filter(n => n.endsWith('.meta.json'))) {
    const key = path.join(dir, n)
    if (!subNameCache.has(key)) {
      try {
        const meta = JSON.parse(await fs.readFile(key, 'utf8'))
        subNameCache.set(key, meta.description || meta.agentType || 'subagent')
      } catch {
        continue
      }
    }
    out.set(n.slice('agent-'.length, -'.meta.json'.length), subNameCache.get(key))
  }
  return out
}

/** Subagents still running, or finished in the last 30 minutes. */
export async function listSubagents(sessionFile, knownTrees) {
  const dir = path.join(sessionFile.replace(/\.jsonl$/, ''), 'subagents')
  let names
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const out = []
  for (const n of names.filter(n => n.endsWith('.meta.json'))) {
    const id = n.slice('agent-'.length, -'.meta.json'.length)
    const file = path.join(dir, `agent-${id}.jsonl`)
    let meta
    let st
    let born
    try {
      meta = JSON.parse(await fs.readFile(path.join(dir, n), 'utf8'))
      st = await fs.stat(file)
      born = await fs.stat(path.join(dir, n)) // the meta file is written when the subagent starts
    } catch {
      continue
    }
    const ageMs = Date.now() - st.mtimeMs
    const running = !meta.finished && ageMs < 15 * 60_000
    if (!running && ageMs > 30 * 60_000) continue
    const scan = await scanTranscript(file, '', knownTrees)
    const working = running && ageMs < 3 * 60_000
    const { state, lastTool } = stateOf(scan, working)
    out.push({
      id,
      description: meta.description || meta.agentType || 'subagent',
      agentType: meta.agentType || '',
      model: meta.model || '',
      finished: Boolean(meta.finished),
      state: meta.finished ? 'done' : state,
      lastTool,
      startedAt: new Date(Math.min(born.birthtimeMs || born.mtimeMs, born.mtimeMs, st.mtimeMs)).toISOString(),
      updatedAt: st.mtime.toISOString(),
      worktree: newestKey(scan.worktrees),
      tickets: newestKeys(scan.tickets, 4),
    })
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/**
 * Every subagent of a session whose transcript changed at or after `sinceMs`,
 * finished or not, scanned: the Flow view draws all of them, not only the
 * recent ones the agent tree lists. `toolUseId` is the parent's Agent call.
 */
export async function subagentsSince(sessionFile, knownTrees, sinceMs) {
  const dir = path.join(sessionFile.replace(/\.jsonl$/, ''), 'subagents')
  let names
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const out = []
  for (const n of names.filter(n => n.endsWith('.meta.json'))) {
    const id = n.slice('agent-'.length, -'.meta.json'.length)
    const file = path.join(dir, `agent-${id}.jsonl`)
    try {
      const st = await fs.stat(file)
      if (st.mtimeMs < sinceMs) continue
      const meta = JSON.parse(await fs.readFile(path.join(dir, n), 'utf8'))
      out.push({
        id,
        description: meta.description || meta.agentType || 'subagent',
        agentType: meta.agentType || '',
        model: meta.model || '',
        finished: Boolean(meta.finished),
        toolUseId: meta.toolUseId || '',
        updatedAt: st.mtime.toISOString(),
        scan: await scanTranscript(file, '', knownTrees),
      })
    } catch {
      /* a subagent file mid-write; skip it this round */
    }
  }
  return out
}

export const newestKeys = (map, n) =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k)
export const newestKey = map => newestKeys(map, 1)[0] || ''
