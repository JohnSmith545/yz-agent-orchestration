// The story commands agents run, behind `node tools/factory.mjs flow …`:
//
//   say <flow> "<what was done>" [--why "<the reason>"] [--who "<label>"] [--id s2 --replace]
//   say-clear <flow>
//
// A story line is one short plain sentence of who did what, then why, for a
// reader who was not there ("Agent 1: Checked the code for [idempotency]. Why?
// An attacker could send the same payment twice."). Words in square brackets
// are marked for the dashboard to explain (terms.mjs). The shape and limits
// are flow-story.mjs's; flows.mjs validates them on every write.
//
// Like the other Output commands, these return { out, code } and never print:
// tools/flow-cli.mjs registers them (sayCommands) and tools/factory.mjs prints.

import { AGENT_LABEL, AGENT_RULE, readFlow, sayShorter, STORY_MAX, validateFlow, writeFlow } from '../flows.mjs'
import { STORY_ID } from '../flow-story.mjs'

const fail = out => ({ out, code: 1 })
const ok = out => ({ out, code: 0 })
const isText = v => typeof v === 'string' && v.trim() !== ''
/** s<highest s-number + 1>. */
const nextId = lines => 's' + (Math.max(0, ...lines.map(l => /^s(\d+)$/.exec(l.id)?.[1]).filter(Boolean).map(Number)) + 1)

function load(id) {
  const flow = readFlow(id)
  if (!flow) throw new Error(`No flow ${id}`)
  return flow
}

/** `did`, then ` Why? why` when there is one: how a line reads on the page and in `flow show`. */
export function storyText(l) {
  const did = String(l.did ?? '')
  if (!isText(l.why)) return `${l.who}: ${did}`
  return `${l.who}: ${/[.!?]$/.test(did) ? did : did + '.'} Why? ${l.why}`
}

/** The story part of `flow show`'s Output block (stderr). */
export function storyBlock(flow) {
  const lines = flow.output?.story || []
  if (!lines.length) return ['  story: none yet (the page shows one made from the steps; add yours with flow say)']
  return [`  story: ${lines.length} line${lines.length === 1 ? '' : 's'}`, ...lines.map(l => `    [${l.id}] ${storyText(l)}`)]
}

/** The commands, given the CLI's refusal for a missing name (tools/flow-cli.mjs NO_NAME). */
export function sayCommands(noName) {
  function say(f, { by }) {
    const [id, did] = f._
    const who = f.who ?? by
    if (!who) return fail(noName)
    if (!AGENT_LABEL.test(who)) return fail(`who must be ${AGENT_RULE}`)
    if (!isText(did)) return fail('say needs what was done: say <flow> "<one short plain sentence>"')
    const text = did.trim()
    if (/[\r\n]/.test(text)) return fail('say it in one line')
    if (text.length > STORY_MAX.did) return fail(sayShorter(STORY_MAX.did, text.length))
    const why = f.why === undefined ? '' : String(f.why).trim()
    if (why.length > STORY_MAX.why) return fail(`--why: ${sayShorter(STORY_MAX.why, why.length)}`)

    const flow = load(id)
    const lines = flow.output?.story || []
    if (f.replace && f.id === undefined) return fail('--replace needs --id <the line to rewrite>')
    if (f.id !== undefined && !STORY_ID.test(f.id)) return fail('--id must be s1, s2, s3 and so on')
    const at = f.id === undefined ? -1 : lines.findIndex(l => l.id === f.id)
    if (f.replace && at < 0) return fail(`${flow.id} has no story line ${f.id} to replace`)
    if (!f.replace && at >= 0) return fail(`${flow.id} already has a story line ${f.id}: add --replace to rewrite it`)
    if (at < 0 && lines.length >= STORY_MAX.lines) {
      return fail(`the story has at most ${STORY_MAX.lines} lines and is full: rewrite one with --id s<n> --replace, or start again with say-clear`)
    }
    // A replaced line is rewritten whole: a why the new line does not give is gone.
    const line = { id: f.id ?? nextId(lines), who, did: text }
    if (why) line.why = why
    line.at = new Date().toISOString()
    const story = at >= 0 ? lines.map((l, i) => (i === at ? line : l)) : [...lines, line]
    flow.output = { ...flow.output, story }
    const problems = validateFlow(flow)
    if (problems.length) return fail(problems.join('\n'))
    writeFlow(flow)
    return ok(`${flow.id} ${line.id}: ${storyText(line)}`)
  }

  function sayClear(f, { by }) {
    if (!by) return fail(noName)
    const flow = load(f._[0])
    flow.output = { ...flow.output, story: [] }
    writeFlow(flow)
    return ok(`${flow.id}: story cleared`)
  }

  return { say, 'say-clear': sayClear }
}
