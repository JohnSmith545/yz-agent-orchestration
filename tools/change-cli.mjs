// The before and after command agents run, behind `node tools/factory.mjs flow …`:
//
//   change <flow> --before "<how it was>" --after "<how it is now>"   one plain line each, at most 140 characters
//   change <flow> --clear                                              removes it
//
// The before screenshot and the diagram of how it worked before are flags of the
// existing commands (`result --before`, `diagram --before`, tools/flow-cli.mjs).
// The shape and limits are flow-change.mjs's; flows.mjs validates them on every
// write. Like the other Output commands, these return { out, code } and never print.

import { CHANGE_MAX } from '../flow-change.mjs'
import { readFlow, sayShorter, validateFlow, writeFlow } from '../flows.mjs'

const fail = out => ({ out, code: 1 })
const ok = out => ({ out, code: 0 })
const isText = v => typeof v === 'string' && v.trim() !== ''

function load(id) {
  const flow = readFlow(id)
  if (!flow) throw new Error(`No flow ${id}`)
  return flow
}

/** The before and after part of `flow show`'s Output block (stderr). */
export function changeBlock(flow) {
  const out = flow.output || {}
  const before = (out.result || []).filter(r => r?.when === 'before').length
  const lines = [`  before: ${before ? `${before} shot${before === 1 ? '' : 's'}` : 'no shot (take one with result --before before you change anything visible)'}`]
  lines.push(out.change ? `  change: ${out.change.before} -> ${out.change.after}` : '  change: none yet (say how it was and how it is now with flow change)')
  if (out.diagramBefore?.nodes?.length) lines.push(`  diagram before: ${out.diagramBefore.nodes.length} boxes`)
  return lines
}

/** The commands, given the CLI's refusal for a missing name (tools/flow-cli.mjs NO_NAME). */
export function changeCommands(noName) {
  function change(f, { by }) {
    if (!by) return fail(noName)
    const [id] = f._
    const flow = load(id)
    if (f.clear) {
      if (f.before !== undefined || f.after !== undefined) return fail('change takes the two lines or --clear, not both')
      if (flow.output) delete (flow.output = { ...flow.output }).change
      writeFlow(flow)
      return ok(`${flow.id}: change cleared`)
    }
    if (!isText(f.before) || !isText(f.after)) return fail('change needs both lines: change <flow> --before "<how it was>" --after "<how it is now>"')
    for (const key of ['before', 'after']) {
      const v = String(f[key]).trim()
      if (/[\r\n]/.test(v)) return fail(`--${key}: say it in one line`)
      if (v.length > CHANGE_MAX) return fail(`--${key}: ${sayShorter(CHANGE_MAX, v.length)}`)
    }
    flow.output = { ...flow.output, change: { before: String(f.before).trim(), after: String(f.after).trim(), at: new Date().toISOString() } }
    const problems = validateFlow(flow)
    if (problems.length) return fail(problems.join('\n'))
    writeFlow(flow)
    return ok(`${flow.id}: change set: ${flow.output.change.before} -> ${flow.output.change.after}`)
  }
  return { change }
}
