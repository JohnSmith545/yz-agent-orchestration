// The self-check before QA: a short checklist the producer answers before it hands a flow to QA, made from the house
// rules (CORE_CHECKS) and the lessons that match this task (quality-lessons.mjs lessonsFor). Right first time is about
// a third today, so most rework is the same few findings again; a builder that checks them itself first saves a round
// trip. Recorded on the flow as `flow.selfcheck` (quality-flow.mjs) by `flow self-check <flow> --done …`
// (tools/quality-cli.mjs), printed to QA at `flow qa-start` so QA can test the claims, and shown on the flow page.
//
// - Every item needs an answer: `<id>=ok`, or `<id>=no:<what is missing>`. A `no` with no note is refused: QA needs
//   to know what to look at. A self-check is a claim, not a proof: QA still tests everything.
// - The screenshots item is on the list only for work with a screen (the task touches the ui area, or the flow has
//   result shots): asking a back-end job for screenshots teaches the builder to answer ok without reading.
// - pipeline.requireSelfCheck (quality-config.mjs): when true, QA may not start testing a CODE flow (a code change on
//   record, or a build route) that has no self-check; selfCheckRefusal says so in one sentence. Off by default.
// Pure: no file, no config.

import { isCodeProducing } from './pipeline.mjs'

export const CORE_CHECKS = Object.freeze([
  Object.freeze({ id: 'tests-first', text: 'I wrote the failing test first, and every test passes now.' }),
  Object.freeze({ id: 'checks-run', text: 'I ran the check and the whole test suite on my last commit.' }),
  Object.freeze({ id: 'no-stray-process', text: 'I stopped every server or background process I started.' }),
  Object.freeze({ id: 'no-debug', text: 'I left no debug output, temporary code or stray files behind.' }),
  Object.freeze({ id: 'docs', text: 'I updated the docs and the help where the behaviour changed.' }),
  Object.freeze({ id: 'screens', text: 'I took screenshots of every screen I changed and looked at them.', ui: true }),
])

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)

/** A flow QA tests as code: a code change on record, or a build route. */
export const isCodeFlow = flow => isCodeProducing(flow) || flow?.route?.type === 'build'

/**
 * This flow's checklist: the core checks (the screenshots one only when `ui`), then the picked lessons, each
 * { id, text, kind: core | lesson, area? }.
 */
export function checklistFor(lessons = [], { ui = false } = {}) {
  return [
    ...CORE_CHECKS.filter(c => ui || !c.ui).map(c => ({ id: c.id, text: c.text, kind: 'core' })),
    ...(Array.isArray(lessons) ? lessons : []).map(l => ({ id: l.id, text: l.text, kind: 'lesson', area: l.area })),
  ]
}

const SHAPE = 'Each answer is --done "<id>=ok" or --done "<id>=no:<what is missing>".'

/** The `--done` values from the raw argv, in order; throws one line for a --done with no value. */
export function doneValues(argv = []) {
  const out = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--done') continue
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`--done needs a value. ${SHAPE}`)
    out.push(v)
    i++
  }
  return out
}

/**
 * The answers to `items`: { items: [{ lesson, text, ok, note }] } in checklist order, or { error } in one plain
 * sentence: a malformed answer, an id not on the list, a `no` with no note, an item left unanswered.
 */
export function answerChecklist(items, values) {
  const given = new Map()
  for (const v of values) {
    const m = /^([A-Za-z0-9-]{1,40})=(ok|no)(?::([\s\S]*))?$/.exec(String(v).trim())
    if (!m) return { error: `${v} is not an answer: write <id>=ok or <id>=no:<note>.` }
    const [, id, word, note = ''] = m
    if (!items.some(it => it.id === id)) return { error: `${id} is not on this checklist. Run flow self-check without --done to see it.` }
    if (word === 'no' && !note.trim()) return { error: `${id}=no needs a note: say what is missing, as ${id}=no:<what is missing>.` }
    given.set(id, { ok: word === 'ok', note: word === 'no' ? note.trim().slice(0, 300) : '' })
  }
  const left = items.filter(it => !given.has(it.id)).map(it => it.id)
  if (left.length) return { error: `Answer every item: ${left.join(', ')} ${left.length === 1 ? 'has' : 'have'} no answer yet.` }
  return { items: items.map(it => ({ lesson: it.id, text: it.text.slice(0, 300), ok: given.get(it.id).ok, note: given.get(it.id).note })) }
}

/** The checklist as the producer reads it, ids lined up, then how to answer. */
export function checklistText(flowId, items, cli) {
  const width = Math.max(...items.map(it => it.id.length)) + 2
  return [
    `Self-check for flow ${flowId}, before you hand it to QA. Check each item yourself, then answer every one:`,
    ...items.map(it => `  ${it.id.padEnd(width)}${it.text}${it.kind === 'lesson' ? ` (a lesson, ${it.area})` : ''}`),
    // ⚠️ no ready-made all-ok line: one to copy would be copied without checking anything
    `Answer all ${items.length} in one command, one --done each: "<id>=ok" when it is true, "<id>=no:<what is missing>" when it is not:`,
    `  node ${cli} flow self-check ${flowId} --done "${items[0]?.id}=ok" --done "<id>=no:<what is missing>" ...`,
    'Be honest: QA reads your answers when it starts testing, and tests the claims.',
  ].join('\n')
}

/** What QA is shown at `flow qa-start`: the producer's answers, the noes first; or that there is none. */
export function selfCheckBlock(flow) {
  const s = flow?.selfcheck
  if (!isObject(s) || !Array.isArray(s.items)) return `No self-check was recorded on ${flow?.id}: test it with no claims to lean on.`
  const no = s.items.filter(it => it.ok === false)
  return [
    `Self-check by ${s.by} at ${s.at}: ${s.items.length - no.length} ok, ${no.length} no. Test the claims, not only the code:`,
    ...no.map(it => `  no: ${it.lesson} (${it.text ?? ''}): ${it.note}`),
    ...s.items.filter(it => it.ok === true).map(it => `  ok: ${it.lesson} (${it.text ?? ''})`),
  ].join('\n')
}

/** Why QA may not start this flow yet: one sentence, or '' (the switch off, no code, or a self-check on record). */
export function selfCheckRefusal(flow, quality) {
  if (!quality?.requireSelfCheck || !isCodeFlow(flow) || isObject(flow?.selfcheck)) return ''
  return `${flow.id} has no self-check yet: ${flow.agent} runs flow self-check ${flow.id} before handing it to QA.`
}

