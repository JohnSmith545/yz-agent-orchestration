// The send command agents run, behind `node tools/factory.mjs flow …`:
//
//   pr <flow> --head <branch> --base <branch> --title "<title>" --body-file <path>   record it, ready for the user
//   pr <flow> --clear                                                                 removes the record
//
// It only RECORDS the pull request the work becomes (output.merge, flow-merge.mjs):
// the agent never pushes or opens one. The user reviews the flow's Output and
// presses Send, and the server does both (pr-routes.mjs). The server's own record
// of what it opened (output.pr) has no flag here, so no command can set it. Like
// the other Output commands, these return { out, code } and never print.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { mergeReady } from '../flow-merge.mjs'
import { readFlow, validateFlow, writeFlow } from '../flows.mjs'

const fail = out => ({ out, code: 1 })
const ok = out => ({ out, code: 0 })

function load(id) {
  const flow = readFlow(id)
  if (!flow) throw new Error(`No flow ${id}`)
  return flow
}

/** The send line of `flow show`'s Output block (stderr): what is recorded, and what became of it. */
export function prBlock(flow) {
  const out = flow.output || {}
  const { merge, pr } = out
  if (pr?.url && !mergeReady(out)) {
    const checks = pr.checks === 'none' ? 'no checks' : `checks ${pr.checks || 'pending'}`
    return [`  send: PR #${pr.number ?? '?'} ${pr.state || 'open'}${pr.state === 'open' ? `, ${checks}` : ''}`]
  }
  if (!merge) return ['  send: none yet (when the work is ready for the base branch, record it with flow pr: the user sends it)']
  return [`  send: ${merge.head} -> ${merge.base}, not sent${pr?.error ? ` (the last try failed: ${pr.error})` : ''}`]
}

/** The commands, given the CLI's refusal for a missing name (tools/flow-cli.mjs NO_NAME). */
export function prCommands(noName) {
  function pr(f, { by, cwd }) {
    if (!by) return fail(noName)
    const flow = load(f._[0])
    const given = ['head', 'base', 'title', 'body-file'].filter(k => f[k] !== undefined)
    if (f.clear) {
      if (given.length) return fail('pr takes the record or --clear, not both')
      if (flow.output) delete (flow.output = { ...flow.output }).merge
      writeFlow(flow)
      return ok(`${flow.id}: send record cleared`)
    }
    const missing = ['head', 'base', 'title', 'body-file'].filter(k => !given.includes(k))
    if (missing.length) return fail(`pr needs ${missing.map(k => `--${k}`).join(', ')}: pr <flow> --head <branch> --base <branch> --title "<title>" --body-file <path>`)
    const file = path.resolve(cwd, String(f['body-file']))
    let body
    try {
      body = readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n')
    } catch (err) {
      return fail(`Cannot read ${file}: ${err.message}`)
    }
    const merge = { head: String(f.head), base: String(f.base), title: String(f.title).trim(), body, at: new Date().toISOString() }
    flow.output = { ...flow.output, merge }
    const problems = validateFlow(flow)
    if (problems.length) return fail(problems.join('\n'))
    writeFlow(flow)
    return ok(`${flow.id}: ready to send ${merge.head} -> ${merge.base}; the user reviews the Output and sends it`)
  }
  return { pr }
}
