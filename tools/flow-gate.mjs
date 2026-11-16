#!/usr/bin/env node
// A stop check for a Claude Code Stop or SubagentStop hook: an agent that made a
// git commit may not finish until its work is told as a flow with a story and a
// visual. The hook runs this with its JSON on stdin:
//
//   { "transcript_path": "<the session's .jsonl>", "stop_hook_active": false, "agent_id": "<a subagent's id>" }
//
// When the agent committed in that transcript and no flow of its own has both a
// story (`flow say`) and a visual (`flow result` or `flow diagram`), it prints
//
//   {"decision":"block","reason":"Record your flow before finishing: ..."}
//
// which makes Claude Code hand the reason back to the agent instead of stopping.
// Otherwise it prints nothing. A flow is the agent's own when its agent (`--by`)
// is a name the agent used in its flow commands (for a subagent, also its task
// name), or when the agent ran a flow command on it; a dropped flow, and one last
// written before the work in the transcript began, do not count.
//
// It FAILS OPEN: `stop_hook_active` (the agent was already sent back once), no
// commit, a transcript it cannot read, bad input or any error at all ends with
// exit code 0 and no output, so a broken check never traps an agent. It reads
// only: the transcript's tail, a subagent's meta file and data/flows. It is not
// installed anywhere by this repo; see "The stop check" in README.md.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))).replace(/\\/g, '/')
const TELL = `Record your flow before finishing: flow say, flow diagram or flow result, flow test-step (node ${ROOT}/tools/factory.mjs flow ...`
/** What the agent is told when it is sent back and its name is not known: the commands, with this dashboard's own path. */
export const REASON = `${TELL}).`

/**
 * What the agent is told when it is sent back. With a name, the line ends with the exact `--by` to sign
 * its flow with, so the dashboard can link the flow to its card; the name is one line, in double quotes.
 */
export function reasonFor(name) {
  const by = String(name ?? '').replace(/\s+/g, ' ').trim().replace(/"/g, "'")
  return by ? `${TELL} --by "${by}").` : REASON
}

/**
 * The name of a session, from the harness's registry next to its transcripts
 * (<claude>/sessions/<pid>.json, { sessionId, name }); '' when it has none or nothing can be read.
 */
export function sessionName(transcript, sessionId) {
  if (!transcript || !sessionId) return ''
  try {
    const dir = path.join(path.dirname(path.dirname(path.dirname(transcript))), 'sessions')
    for (const f of readdirSync(dir)) {
      if (!/^\d+\.json$/.test(f)) continue // never the .key files
      try {
        const s = JSON.parse(readFileSync(path.join(dir, f), 'utf8'))
        if (s?.sessionId === sessionId) return typeof s.name === 'string' ? s.name : ''
      } catch {
        /* a session file mid-write */
      }
    }
  } catch {
    /* no registry there */
  }
  return ''
}

/** The transcript to read for a hook event: a subagent's own when `agent_id` is there, else the session's. */
export function transcriptOf(hook) {
  const session = typeof hook?.transcript_path === 'string' ? hook.transcript_path : ''
  if (!hook?.agent_id) return session
  if (typeof hook.agent_transcript_path === 'string' && hook.agent_transcript_path) return hook.agent_transcript_path
  return session ? path.join(session.replace(/\.jsonl$/, ''), 'subagents', `agent-${hook.agent_id}.jsonl`) : ''
}

/** A subagent's task name from its meta file next to its transcript; '' when there is none. */
function taskName(file) {
  try {
    return String(JSON.parse(readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')).description || '')
  } catch {
    return ''
  }
}

/** The hook's answer for its JSON: the block decision, or null to let the agent stop. Throws on anything it cannot read. */
export async function decide(hook) {
  if (!hook || hook.stop_hook_active) return null
  const file = transcriptOf(hook)
  if (!file) return null
  // Imported here, not at the top: a missing config.json must fail open like any other error.
  const { scanSubagent, toldBy } = await import('../subagents.mjs')
  const scan = await scanSubagent(file)
  if (!scan.committed) return null
  const { listFlows } = await import('../flows.mjs')
  // The name its card goes by: a subagent's task name, a session's own name, else one it already signed with.
  const own = hook.agent_id ? taskName(file) : sessionName(hook.transcript_path, hook.session_id)
  const names = [...scan.flowBy, hook.agent_id ? own : ''].filter(Boolean)
  const told = toldBy(listFlows().flows, { names, ids: [...scan.flowIds], since: scan.firstAt })
  return told ? null : { decision: 'block', reason: reasonFor(own || [...scan.flowBy].pop()) }
}

/** Everything on stdin, as text. */
async function stdin() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text
}

/** Runs the check for the hook JSON on stdin. Always exit code 0; prints only a block decision. */
async function main() {
  try {
    const decision = await decide(JSON.parse(await stdin()))
    if (decision) process.stdout.write(JSON.stringify(decision) + '\n')
  } catch {
    /* fail open: say nothing, block nothing */
  }
  process.exitCode = 0
}

// Run only as a command, so a test can import decide() without reading stdin. Compared without case:
// Windows hands a hook the same path with either drive letter.
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) await main()
