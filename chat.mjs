// The Factory chat: a real Claude Code session (by default "Independent", on
// Opus) that the user talks to from the page instead of a terminal.
//
// Each message runs one headless turn, `claude -p --resume <session>`, in the
// repo, so the agent keeps its memory between messages and loads the repo's
// CLAUDE.md, settings and hooks (the Terraform block included).
//
// How a chat STARTS is its mode (`factory.chat.mode`):
// - `brief` (the default, shown as "light"): the first message starts a FRESH
//   session whose system prompt is chatBrief(), which already carries the
//   drawer, the factory CLI and the tools. Well under $1 a turn (a first
//   message measured $0.44 on 2026-11-13).
// - `fork`: the first message forks `factory.chat.forkFrom` (`--resume <it>
//   --fork-session`), so the chat starts with that session's whole context.
//   The first message is the expensive one, once (about $7 measured on
//   2026-11-12); later turns cost only their own delta (a few tenths). A light
//   chat measured $0.46 then $0.04 on 2026-11-13.
// "Start from my session" in the drawer (chatNew({ fork: true })) runs the NEXT
// chat in fork mode once. Either way, once a chat has a session id every later
// message resumes THAT id, so a forked chat stays forked until "New chat".
// ⚠️ The chat is the one headless turn WITHOUT --no-session-persistence: it
// needs its session on disk to resume it.
//
// The turn streams as stream-json; this module turns it into small events
// (text deltas, tool calls, tool results, cost) and fans them out to every open
// page over Server-Sent Events. The transcript the page shows is kept in
// data/chat-log.json (git-ignored).
//
// What the agent may do is the allow list below: read the code, read
// Switchboard, list and message other agents, drive a browser (Playwright),
// and set review marks and write flows through tools/factory.mjs. Anything
// else is denied in headless mode. See chatArgs for how the two flags split:
// ⚠️ a built-in tool exists in the turn only when `--tools` names it (`--tools ""`
// would remove ListAgents and SendMessage too); `--allowedTools` only
// pre-approves, and is enough on its own for MCP tools. Bash is in `--tools`
// but runs only what the `Bash(...)` rules allow.
//
// There is NO write rule: a `Write(<path>)` allow rule never grants a write in
// a headless turn, and `--permission-mode acceptEdits` would let the agent edit
// repo files. A screenshot is the file the Playwright screenshot tool saves;
// `flow evidence --shot <that file>` copies it into the evidence folder.
// Every factory CLI call is stamped with the chat's name through FACTORY_BY.
//
// ⚠️ `mcp__playwright__*` would also pre-approve browser_run_code_unsafe, which
// runs arbitrary JavaScript in the Playwright server PROCESS (not the page):
// that is a shell by another name, able to edit repo files, commit, or run
// Terraform around every rule above. So it is in `--disallowedTools`, and a
// deny beats an allow. The other browser tools only act inside the page.
//
// Each turn's cost is recorded once as `chat` spend (spend.mjs) for the rail's
// chip, and shown in the drawer's `done` line. ⚠️ The `result` event's
// total_cost_usd is the SESSION's running total, not the turn's (a resumed
// session restores its saved cost first), so the turn's cost is the rise over
// `chat.costTotal` in factory-state, which New chat and a new session reset.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeAtomic } from './atomic-write.mjs'
import { claudeBin } from './claude-cli.mjs'
import { CONFIG } from './config.mjs'
import { DATA_DIR, readState, updateState } from './factory-state.mjs'
import { listFlows } from './flows.mjs'
import { recordCost } from './spend.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LOG_FILE = path.join(DATA_DIR, 'chat-log.json')
const CHAT = CONFIG.factory.chat
const CLI = path.join(HERE, 'tools', 'factory.mjs').replace(/\\/g, '/')
/** The saved glossary (glossary.mjs), which the chat agent may Read to reuse the user's wording. */
const GLOSSARY = path.join(DATA_DIR, 'glossary.json').replace(/\\/g, '/')
const MAX_LOG = 600

/** The built-in tools the turn has at all. */
const BUILTINS = ['Read', 'Grep', 'Glob', 'Bash', 'ListAgents', 'SendMessage']

/** What runs without a prompt (anything else is denied headless). */
export const ALLOWED = [
  'Read', 'Grep', 'Glob', 'ListAgents', 'SendMessage',
  'mcp__switchboard-claude__get_story_details', 'mcp__switchboard-claude__list_stories', 'mcp__switchboard-claude__list_projects',
  'mcp__playwright__*',
  // No `git fetch` or `git grep`: --upload-pack and -O (open-files-in-pager) run a program. Grep and Read
  // search the code, and fetching is the server's job. diff, log and show still take --output=<file>.
  ...['log', 'show', 'diff', 'status', 'rev-list', 'rev-parse', 'branch --list', 'branch -a --list', 'worktree list', 'merge-base', 'blame', 'ls-files', 'cat-file']
    .map(c => `Bash(git ${c}:*)`),
  // read-only forms only: a bare `git branch x` creates a branch, and a prefix rule on `-a` would pass `-a -d x`
  'Bash(git branch -a)',
  'Bash(git branch --show-current)',
  `Bash(node ${CLI}:*)`,
]

/** Denied even though `mcp__playwright__*` allows it: it runs code in the Playwright server (see the header). */
const DENIED = ['mcp__playwright__browser_run_code_unsafe']

/** The two ways a chat starts (see the header). Anything else in the config counts as `brief`. */
export const MODES = ['brief', 'fork']

/**
 * One chat turn's argv. `resume` is `['--resume', <session id>]` for a chat
 * that has one, else `[]`; only then does the mode matter: `fork` with a
 * `forkFrom` forks it, and `brief` (the default) starts fresh with the brief.
 * `--allowedTools` takes every word after it, so it goes last and the message
 * goes on stdin.
 */
export function chatArgs(model, resume, systemPrompt, { mode = 'brief', forkFrom = '' } = {}) {
  const start = resume.length ? resume : mode === 'fork' && forkFrom ? ['--resume', forkFrom, '--fork-session'] : []
  return [
    '-p', '--model', model, '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    ...start, '--append-system-prompt', systemPrompt, '--tools', BUILTINS.join(','),
    '--disallowedTools', ...DENIED, '--allowedTools', ...ALLOWED,
  ]
}

export const chatBrief = () => `You are ${CHAT.name}. The user is talking to you through the Ask drawer of their Yz Agent Orchestration
(http://127.0.0.1:${CONFIG.port}/), which opens beside every page, not through VS Code. They see your text as markdown, plus a
row per tool call. The Tickets page is at /#/tickets and the Flows page at /#/flows.

What the Tickets page is: their ticket factory. It lists a ticket collection in Switchboard board order with each ticket's
board state, the plan's verdict, and a review mark. Review marks: reviewed (with a verdict: now = deliver now,
check = deliver after a dev check, docfix = after a doc fix, notyet = not yet), needs-review (code exists but nobody
independent reviewed it), no-code (codebase work not built yet), not-codebase (a person, console or process task).

Tools you have here: read the code (Read, Grep, Glob, read-only git), read Switchboard (get_story_details,
list_stories), ListAgents and SendMessage to brief or command other sessions, a browser (the Playwright tools),
and the factory CLI:
  node ${CLI} mark ABC-123 reviewed --verdict check --note "what is left"
  node ${CLI} mark ABC-123 needs-review|no-code|not-codebase [--note "..."]
  node ${CLI} flow new <id> "<title>" [--tickets ABC-123]
  node ${CLI} flow step|check <flow> "<title>"
  node ${CLI} flow ask <flow> "<question>" --yes "what yes means" --no "what no means"
  node ${CLI} flow status <flow> <node> doing|done|blocked
  node ${CLI} flow evidence <flow> <node> --commit <sha> | --test "<line>" | --shot <file>
  node ${CLI} flow result <flow> --shot <file> [--caption "..."] [--before]
  node ${CLI} flow diagram <flow> "[actor] User -> Page: clicks; Page -> [store] Storage: saves" [--before]
  node ${CLI} flow change <flow> --before "<how it was>" --after "<how it is now>"
  node ${CLI} flow summary <flow> "<markdown>" --commit <sha> [--commit <sha>]
  node ${CLI} flow test-step <flow> "<do this>" --expect "<you should see>" --shot <file>
  node ${CLI} flow show <flow>
  node ${CLI} flow say <flow> "<what was done>" [--why "<the reason>"]
  node ${CLI} flow say-clear <flow>
  node ${CLI} flow pr <flow> --head <branch> --base <branch> --title "<title>" --body-file <file>
  node ${CLI} term "<word>" "<plain explanation, 1 or 2 sentences>" [--flow <flow>]
  node ${CLI} show ABC-123
  (node ${CLI} flow, with no command, prints every flow command)
Narrate your work on the dashboard as a flow: \`node ${CLI} flow …\`. Start with \`flow new\` or \`flow write\` before you change anything, keep statuses current with \`flow status\`, attach proof with \`flow evidence\` (the commit sha, a test line, a screenshot), and put any choice that is the user's as \`flow ask\` instead of asking in prose, then stop at that step: the answer arrives as a message. Never act on another system (a tracker, a live site, a deploy) before the ask is answered Yes.
Record review marks with mark; when you check something for the user, put it in a flow as a check node with evidence. Screenshots: take them with the Playwright screenshot tool, then flow evidence --shot <the file it saved>.
For any request that is work, not a one-line answer, narrate it as a flow with evidence, including screenshots (\`node ${CLI} flow evidence <flow> <node> --shot <file>\`), so the user can follow it visually: under your reply the drawer shows an Open flow button for each flow you wrote in that turn.
When a piece of work is finished, record its output: a result screenshot (\`flow result\`), a short summary with the commits (\`flow summary\`), and manual test steps with a screenshot each (\`flow test-step\`). The flow opens on that storyboard. Record test steps one command at a time, never in parallel: each one rewrites the flow file. A \`flow write\` file with no \`output\` keeps the stored one; \`"output": {}\` clears it.
Every flow needs a visual; a flow with neither is unfinished: for UI work a result screenshot (\`flow result --shot\`), for anything else (an API, a job, a deploy, an investigation) a diagram of how it works (\`flow diagram\`), the big picture only, at most 8 boxes named the way you would to a colleague, for example \`flow diagram <flow> "[actor] Scheduler -> Report job: every night; Report job -> [store] Reports: saves"\`.
Show what changed as a before and after: before you change anything visible, take a screenshot with \`flow result <flow> --shot <file> --before\` (for work with no screen, draw how it worked with \`flow diagram <flow> "…" --before\`), and when done say how it was and how it is now in one plain line each with \`flow change <flow> --before "<how it was>" --after "<how it is now>"\`.
A message asking for manual test steps means: drive the app with Playwright, capture a screenshot at each step, and record each one with \`flow test-step\`.
Tell the story of each flow in a few lines with \`flow say\` (at most 8; the page shows them first). Write for a reader who was not there. Say who did what in one short plain sentence, then why. Not a commit message: no file names, no flags, no ticket ids in the sentence. Use the right technical word, and put it in square brackets the first time, like [idempotency], so the dashboard can explain it. If the word is unusual, define it yourself with \`term\`. For example:
  node ${CLI} flow say acme-pay "Ran the checkout with [Playwright]"
  node ${CLI} flow say acme-pay "Made the payment call [idempotent]" --why "A double click could charge twice"
  node ${CLI} term "idempotent" "Doing it twice has the same effect as doing it once, so a retry is safe." --flow acme-pay
(\`flow say <flow> "..." --id s2 --replace\` rewrites a line; \`flow say-clear\` starts again.) The words the dashboard has explained so far, with the user's own wording where they corrected one, are in ${GLOSSARY} (read it to reuse their words).
A message asking what a word means: answer it with \`term\`, in plain words, saying why it mattered for this work.
When the work is ready to go to the base branch, record the pull request with \`flow pr\` (the branch, the base, a plain-English title, and a body file that follows the repo's own pull request template). Never push or open the pull request yourself: when your work is ready, record \`flow pr\` and hand the flow to QA (send QA a message naming the flow). QA tests it, pushes the branch on a pass, and sends a failure back to you with its report: fix it and ask QA to test it again. The user then sends the pull request. The pull request text must not credit an AI tool (no Co-Authored-By line, no Generated with line).
After you review a ticket's code, ALWAYS record the result with the mark command.
When the user asks you to pass a task to an agent, send it with SendMessage (ListAgents first for the exact name)
and say what you sent. You cannot edit files, commit, push, change Switchboard, or run Terraform here.
Keep replies short and scannable. Today is ${new Date().toISOString().slice(0, 10)}.`

// ─── log + listeners ───────────────────────────────────────────────────────────

let log = existsSync(LOG_FILE) ? safeJson(readFileSync(LOG_FILE, 'utf8'), []) : []
const listeners = new Set()
let child = null
let turnCost = 0
/** Whether this turn's cost is already counted (spend.jsonl and chat.costTotal): once per turn, however many result events arrive. */
let turnRecorded = false
/** The running turn's result error text (`result` and `errors` of an is_error result), for STALE_SESSION. */
let turnError = ''
/** True after chatNew({ fork: true }) until the next turn starts: that one chat forks. In memory only. */
let nextFork = false
/** The mode the running turn started in, saved with its session id when the session begins. */
let turnMode = ''

function safeJson(s, d) {
  try {
    return JSON.parse(s)
  } catch {
    return d
  }
}

function saveLog() {
  if (log.length > MAX_LOG) log = log.slice(-MAX_LOG)
  writeAtomic(LOG_FILE, JSON.stringify(log))
}

function emit(ev, persist = true) {
  if (persist) {
    log.push(ev)
    saveLog()
  }
  const line = `data: ${JSON.stringify(ev)}\n\n`
  for (const res of listeners) res.write(line)
}

/** The configured start mode; an unknown value is `brief`, so a typo never costs a fork. */
const MODE = MODES.includes(CHAT.mode) ? CHAT.mode : 'brief'

/**
 * The mode of the chat as it stands: the one its session started in, or, with
 * no session yet, how the next one starts (`fork` only when there is a
 * forkFrom to fork). A session saved before the modes existed has no mode;
 * every chat forked then, so it counts as `fork` when forkFrom is set.
 */
function currentMode(chat = readState().chat) {
  if (chat.sessionId) return MODES.includes(chat.mode) ? chat.mode : CHAT.forkFrom ? 'fork' : 'brief'
  return MODE === 'fork' && CHAT.forkFrom ? 'fork' : 'brief'
}

/** A meta line that starts a chat over (chatNew): nothing before it belongs to the chat as it stands. */
const isNewChat = e => e.role === 'meta' && /^New chat\b/.test(e.text || '')

/**
 * The chat's last exchange, read back from the transcript: `asked` is true
 * when its newest message is a reply that ends with a question (it waits on
 * the user), `lastAt` is when the newest user or assistant message was ('' for
 * a chat with none). Both stop at the last New chat.
 */
function lastExchange() {
  let asked = null
  let lastAt = ''
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]
    if (isNewChat(e)) break
    if ((e.role === 'user' || e.role === 'assistant') && !lastAt) lastAt = e.at || ''
    if (asked === null && e.role === 'assistant') asked = /\?\s*$/.test(e.text || '')
    if (asked === null && e.role === 'user') asked = false
    if (asked !== null && lastAt) break
  }
  return { asked: asked === true, lastAt }
}

export function chatStatus() {
  const chat = readState().chat
  return {
    busy: Boolean(child), name: CHAT.name, model: CHAT.model, sessionId: chat.sessionId || '', forkFrom: CHAT.forkFrom,
    mode: currentMode(chat), nextFork, ...lastExchange(),
  }
}

export const chatLog = () => ({ ...chatStatus(), log })

export function chatEvents(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
  res.write(`data: ${JSON.stringify({ role: 'status', ...chatStatus() })}\n\n`)
  listeners.add(res)
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
  req.on('close', () => {
    clearInterval(ping)
    listeners.delete(res)
  })
}

// ─── one turn ──────────────────────────────────────────────────────────────────

const short = (s, n = 220) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function toolSummary(name, input = {}) {
  if (name === 'Bash') return input.command
  if (name === 'Read') return input.file_path
  if (name === 'Grep') return `${input.pattern}${input.path ? '  in ' + input.path : ''}`
  if (name === 'Glob') return input.pattern
  if (name === 'SendMessage') return `to ${input.to}: ${short(input.message, 160)}`
  if (name.startsWith('mcp__switchboard')) return `${name.replace('mcp__switchboard-claude__', 'switchboard ')} ${input.storyId || input.projectId || ''}`
  return short(JSON.stringify(input))
}

function resultText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(c => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n')
  return ''
}

/** One stream-json event of the running turn. Exported for the tests only. */
export function onEvent(e) {
  if (e.type === 'system' && e.subtype === 'init' && e.session_id) {
    if (readState().chat.sessionId !== e.session_id) {
      updateState(s => {
        s.chat.sessionId = e.session_id
        s.chat.mode = turnMode
        s.chat.costTotal = 0 // a new session's running total starts at 0
      })
      emit({ role: 'status', ...chatStatus() }, false)
    }
    return
  }
  if (e.type === 'stream_event') {
    const d = e.event?.delta
    if (e.event?.type === 'content_block_delta' && d?.type === 'text_delta') emit({ role: 'delta', text: d.text }, false)
    return
  }
  if (e.type === 'assistant') {
    for (const c of e.message?.content || []) {
      if (c.type === 'text' && c.text.trim()) emit({ role: 'assistant', text: c.text, at: new Date().toISOString() })
      if (c.type === 'tool_use') emit({ role: 'tool', id: c.id, name: c.name, summary: short(toolSummary(c.name, c.input), 400), at: new Date().toISOString() })
    }
    return
  }
  if (e.type === 'user') {
    for (const c of e.message?.content || []) {
      if (c.type === 'tool_result') emit({ role: 'tool_result', id: c.tool_use_id, ok: !c.is_error, preview: short(resultText(c.content), 600) })
    }
    return
  }
  if (e.type === 'result') {
    if (e.is_error) turnError = [e.result, ...(Array.isArray(e.errors) ? e.errors : [])].filter(x => typeof x === 'string').join('\n')
    // ⚠️ total_cost_usd is the SESSION's running total: a resumed session restores
    // its saved cost before the turn runs. The turn's own cost is the rise over the
    // total saved after the last turn (chat.costTotal); a total below that base
    // (the saved cost was not restored) is the turn's whole cost.
    const total = e.total_cost_usd
    if (turnRecorded || typeof total !== 'number' || !Number.isFinite(total)) return
    const base = Number(readState().chat.costTotal) || 0
    turnCost = total >= base ? total - base : total
    updateState(s => {
      s.chat.costTotal = total
    })
    recordCost('chat', turnCost)
    turnRecorded = true
  }
}

/** Reset the per-turn cost state; chatSend calls it as a turn starts. Exported for the tests. */
export function beginTurn() {
  turnCost = 0
  turnRecorded = false
  turnError = ''
}

/**
 * How the next turn starts, for chatSend: resume the chat's own session when it
 * has one, else start in the configured mode, or in `fork` once after
 * chatNew({ fork: true }). Calling it SPENDS that one-shot fork. `fork` says
 * whether the turn really forks (a session to resume, or no forkFrom, never does).
 */
export function turnPlan() {
  const sid = readState().chat.sessionId || ''
  const mode = nextFork ? 'fork' : MODE
  nextFork = false
  return { resume: sid ? ['--resume', sid] : [], mode, fork: !sid && mode === 'fork' && Boolean(CHAT.forkFrom) }
}

// ═══ the flows a turn wrote ═══
// A turn that runs `tools/factory.mjs flow new|step|ask|evidence|set|write`
// changes flow files. Rather than parse its tool output, the chat compares the
// flows list (id + updatedAt) from before the turn with the one at its end, and
// the `done` event carries each flow that is new or changed as { id, title }.
// The drawer draws an "Open flow: <title>" button for each (factory-chat.js);
// it NEVER navigates by itself, even for one flow: the user may be typing.

/**
 * Every live flow as { id, title, updatedAt }, for changedFlows: the archived ones too (listFlows leaves them out by
 * default), so a turn that writes into an archived flow still hands the drawer its Open flow button. Never throws:
 * a broken flows folder is no flows.
 */
export function flowSnapshot() {
  try {
    return listFlows({ archived: 'any' }).flows.map(f => ({ id: f.id, title: f.title || '', updatedAt: f.updatedAt || '' }))
  } catch {
    return []
  }
}

/** Pure: the flows in `after` that are not in `before` or whose updatedAt moved, as { id, title }, in `after`'s order. */
export function changedFlows(before = [], after = []) {
  const was = new Map((before || []).map(f => [f.id, f.updatedAt]))
  return (after || []).filter(f => !was.has(f.id) || was.get(f.id) !== f.updatedAt).map(f => ({ id: f.id, title: f.title }))
}

// ⚠️ A stored session id can outlive its transcript (Claude's files cleaned up,
// another machine, a moved repo): `--resume` then fails at once with this text,
// on stderr or as the result's error. The chat drops the id and runs the SAME
// message again as a fresh light turn, ONCE (never a fork: that costs dollars
// the user did not choose). A second failure is shown like any other.
const STALE_SESSION = /No conversation found with session ID/i

/** How a turn starts its process and finds the binary. Swapped by the tests only (setRunner). */
let runner = { spawn, bin: claudeBin }
/** Tests only: replace the process spawner and/or the binary lookup. */
export function setRunner({ spawn: s, bin } = {}) {
  runner = { spawn: s || runner.spawn, bin: bin || runner.bin }
}

export async function chatSend(text) {
  text = String(text || '').trim()
  if (!text) throw Object.assign(new Error('Empty message.'), { status: 400 })
  if (child) throw Object.assign(new Error(`${CHAT.name} is still answering. Stop it or wait.`), { status: 409 })

  const bin = await runner.bin()
  const plan = turnPlan()
  emit({ role: 'user', text, at: new Date().toISOString(), fork: plan.fork })
  runTurn(bin, text, plan, { retried: false, started: Date.now(), flowsBefore: flowSnapshot() })
  return chatStatus()
}

/**
 * Spawn one turn for `text`. On a stale session (STALE_SESSION) that has not
 * been retried yet, the stored id and cost base are cleared and the same text
 * runs once more as a fresh brief turn; the failed attempt shows no error and
 * no done line, only a meta line saying what happened.
 */
function runTurn(bin, text, plan, { retried, started, flowsBefore }) {
  const args = chatArgs(CHAT.model, plan.resume, chatBrief(), { mode: plan.mode, forkFrom: CHAT.forkFrom })
  // a resumed session keeps its mode; a new one is `fork` only when it really forks
  turnMode = plan.resume.length ? currentMode() : plan.fork ? 'fork' : 'brief'
  beginTurn()
  child = runner.spawn(bin, args, { cwd: CONFIG.repo, windowsHide: true, env: { ...process.env, FACTORY_BY: CHAT.name } })
  emit({ role: 'status', ...chatStatus() }, false)

  let buf = ''
  let errText = ''
  child.stdout.on('data', d => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      try {
        onEvent(JSON.parse(line))
      } catch {
        /* a non-JSON line (a warning); ignore */
      }
    }
  })
  child.stderr.on('data', d => (errText += d))
  child.on('close', (code, signal) => {
    child = null
    const failed = !signal && code !== null && code !== 0
    if (failed && !retried && plan.resume.length && STALE_SESSION.test(`${errText}\n${turnError}`)) {
      updateState(s => {
        s.chat.sessionId = ''
        s.chat.mode = ''
        s.chat.costTotal = 0
      })
      emit({ role: 'meta', text: 'The old conversation was gone, so this is a new one.', at: new Date().toISOString() })
      runTurn(bin, text, { resume: [], mode: 'brief', fork: false }, { retried: true, started, flowsBefore })
      return
    }
    if (signal || code === null) emit({ role: 'meta', text: 'Stopped.' })
    else if (code !== 0) emit({ role: 'error', text: short(errText || turnError || `exited with ${code}`, 600) })
    const flows = changedFlows(flowsBefore, flowSnapshot())
    emit({ role: 'done', cost: turnCost, seconds: Math.round((Date.now() - started) / 1000), at: new Date().toISOString(), ...(flows.length ? { flows } : {}) })
    emit({ role: 'status', ...chatStatus() }, false)
  })
  child.stdin.end(text)
}

export function chatStop() {
  if (child) child.kill()
  return chatStatus()
}

/**
 * Start over. The next message starts in the configured mode, or, with
 * `{ fork: true }` (only a real true), forks `forkFrom` once ("Start from my
 * session" in the drawer). A plain New chat drops a fork chosen but not used.
 * The old transcript stays in Claude's own files.
 */
export function chatNew({ fork = false } = {}) {
  if (child) throw Object.assign(new Error('Stop the current answer first.'), { status: 409 })
  nextFork = fork === true
  updateState(s => {
    s.chat.sessionId = ''
    s.chat.mode = ''
    s.chat.costTotal = 0
  })
  emit({ role: 'meta', text: nextFork ? 'New chat, from your session (costs more).' : 'New chat.', at: new Date().toISOString() })
  emit({ role: 'status', ...chatStatus() }, false)
  return chatStatus()
}
