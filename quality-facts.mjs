// What the quality features read about a task beyond the flow file itself: its tickets' labels (the ticket source
// files, data/sources/<collection>.json, factory.mjs), the planner's plan (its copy in the flow's evidence folder,
// flow-plan.mjs) and the files that plan names. Read-only, and each read is allowed to fail: a missing source or plan
// file means fewer facts, never an error, so a lesson or a risk label is still worked out from what there is.
//
//   ticketLabels(tickets)      every label of those tickets in any ticket source, once each
//   planTextOf(flow)           the handed-out plan's text (at most PLAN_MAX characters), or ''
//   filesNamed(text)           the file paths a text names: `public/a.js`, `test/a.test.mjs`, `db/091_x.sql`
//   taskOf(flow, { files })    what lessonsFor reads: { title, text, labels, files } (files: the plan's and the change's)
//   riskFacts(flow, { files }) what riskOf reads: { labels, planText, files }

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { DATA_DIR } from './factory-state.mjs'
import { EVIDENCE_DIR } from './flows.mjs'

export const SOURCES_DIR = path.join(DATA_DIR, 'sources')
const PLAN_MAX = 20_000
const isText = v => typeof v === 'string' && v.trim() !== ''

const sourceCache = new Map() // file -> { key, labels: Map<ticket id, string[]> }

/** Ticket id -> labels from one source file, cached by its time and size. */
function labelsIn(file) {
  let st
  try {
    st = statSync(file)
  } catch {
    return new Map()
  }
  const key = `${st.mtimeMs}:${st.size}`
  const hit = sourceCache.get(file)
  if (hit?.key === key) return hit.labels
  const labels = new Map()
  try {
    const tickets = JSON.parse(readFileSync(file, 'utf8'))?.tickets
    for (const t of Object.values(tickets && typeof tickets === 'object' ? tickets : {})) {
      if (isText(t?.id) && Array.isArray(t.labels)) labels.set(t.id.toUpperCase(), t.labels.filter(isText))
    }
  } catch {
    // a half-written source: no labels from it this time
  }
  sourceCache.set(file, { key, labels })
  return labels
}

/** Every label of `tickets` found in any ticket source in `dir`, once each. */
export function ticketLabels(tickets, dir = SOURCES_DIR) {
  const ids = (Array.isArray(tickets) ? tickets : []).filter(isText).map(t => t.toUpperCase())
  if (!ids.length || !existsSync(dir)) return []
  const out = []
  let files = []
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json'))
  } catch {
    return []
  }
  for (const f of files) {
    const map = labelsIn(path.join(dir, f))
    for (const id of ids) for (const l of map.get(id) || []) if (!out.includes(l)) out.push(l)
  }
  return out
}

/** The handed-out plan's text, or '' (no plan, not handed out yet, or the file is gone). */
export function planTextOf(flow) {
  const ref = flow?.plan?.status === 'handed' ? flow.plan.file : null
  if (!isText(ref) || !/^[a-z0-9-]+\/[^/\\]+\.(md|txt)$/i.test(ref)) return ''
  try {
    return readFileSync(path.join(EVIDENCE_DIR, ...ref.split('/')), 'utf8').slice(0, PLAN_MAX)
  } catch {
    return ''
  }
}

const PATHISH = /(?:^|[\s`'"(\[])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+|[A-Za-z0-9_-]+\.(?:mjs|cjs|js|ts|tsx|jsx|css|html|json|md|sql|dart|ya?ml|tf|py|sh))(?=$|[\s`'"),:;\]])/g

/** The file paths `text` names, once each, without a trailing full stop. */
export function filesNamed(text) {
  const out = []
  for (const m of String(text ?? '').matchAll(PATHISH)) {
    const p = m[1].replace(/\.+$/, '')
    if (p && !/^https?:/i.test(p) && !out.includes(p)) out.push(p)
  }
  return out.slice(0, 100)
}

/** What lessonsFor reads about `flow`: its title, its why, its tickets' labels, the files of its plan and its change. */
export function taskOf(flow, { files = [] } = {}) {
  const plan = planTextOf(flow)
  return { title: flow?.title || '', text: flow?.why || '', labels: ticketLabels(flow?.tickets), files: [...new Set([...filesNamed(plan), ...files])] }
}

/** What riskOf reads about `flow` beyond the flow itself. */
export function riskFacts(flow, { files = [] } = {}) {
  return { labels: ticketLabels(flow?.tickets), planText: planTextOf(flow), files }
}
