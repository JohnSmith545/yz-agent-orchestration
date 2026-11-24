// The planner, the data half: what a flow's `plan` block holds (flows.mjs validates it on every write) and that it
// is the planner's alone. The planner (config pipeline.planner, pipeline.mjs) sits between the coordinator and the
// producers: it only plans and hands out tasks, and writes no code. This is the SMALLEST record that lets
// pipeline.mjs stageOf (and so flow-route.mjs routeProgress) say where a flow stands: with the coordinator (no
// plan), with the planner (planning), or with the producer the planner handed it to (handed, and then the flow's
// agent is that producer, so its answers and any QA or Security failure go to it).
//
//   flow.plan = {
//     status     planning | handed
//     by         the planner's label
//     startedAt  when the planner took it (flow plan-start, or the hand-out itself when it never said)
//     at         when its status last changed
//     to         handed: the producer that got the task (a dashboard label)
//     file       handed: '<flow>/plan-<n>.md' (or .txt), the plan copied into the flow's evidence folder
//     history    the earlier hand-outs, oldest first, at most PLAN_HISTORY, each { by, at, to, file }: a task
//                handed to another producer keeps the first hand-out visible
//   }
//
// ⚠️ The planner's alone, like `qa` is QA's: only the plan commands (tools/plan-cli.mjs) write it, and a producer's
// `flow write` takes it from the stored file only (keepPlan, called by mergeKeepingAnswers). A plan file is Markdown
// or text, never HTML: the evidence route serves it as text. Pure: no file access.

export const PLAN_STATUS = Object.freeze(['planning', 'handed'])
export const PLAN_HISTORY = 20
/** What a plan file may be: Markdown or plain text (MUST CHANGE IN LOCKSTEP with flow-qa.mjs REPORT_EXT). */
export const PLAN_EXT = Object.freeze(['md', 'txt'])

/** MUST CHANGE IN LOCKSTEP with flows.mjs AGENT_LABEL. */
const LABEL = /^[A-Za-z0-9 ._-]{1,40}$/
const SLUG = /^[a-z0-9-]+$/
/** MUST CHANGE IN LOCKSTEP with flows.mjs ISO_TIME. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/
const isTime = v => typeof v === 'string' && ISO_TIME.test(v) && !Number.isNaN(Date.parse(v))
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isLabel = v => typeof v === 'string' && LABEL.test(v)

/** `<flow id>/<name>.md|txt` in this flow's evidence folder (like flow-qa.mjs fileRef). */
function planRef(ref, flowId) {
  const m = /^([a-z0-9-]+)\/([^/\\]{1,200})$/.exec(typeof ref === 'string' ? ref : '')
  if (!m || !(m[1] === flowId || !SLUG.test(String(flowId))) || m[2] === '.' || m[2] === '..') return false
  return PLAN_EXT.includes(m[2].split('.').pop().toLowerCase())
}

/** The problems of one hand-out (`plan` itself or a history entry), each line starting with `at`. */
function handoutProblems(h, flowId, at) {
  const problems = []
  if (!isLabel(h.by)) problems.push(`${at} by must be the planner's label`)
  if (!isTime(h.at)) problems.push(`${at} at must be a time`)
  if (!isLabel(h.to)) problems.push(`${at} to must be the label of the producer that got the task`)
  if (!planRef(h.file, flowId)) problems.push(`${at} file must be ${flowId}/<file>.md or .txt (a plan is never HTML)`)
  return problems
}

/** The problems of a flow's optional `plan` block, one plain line each; [] when it is valid. */
export function validatePlan(plan, flowId) {
  if (!isObject(plan)) return ['plan must be a JSON object']
  const problems = []
  if (!PLAN_STATUS.includes(plan.status)) problems.push(`plan status must be one of ${PLAN_STATUS.join(', ')}`)
  if (!isLabel(plan.by)) problems.push("plan by must be the planner's label")
  for (const key of ['startedAt', 'at']) if (!isTime(plan[key])) problems.push(`plan ${key} must be a time`)
  if (plan.status === 'handed') problems.push(...handoutProblems(plan, flowId, 'plan'))
  else {
    if (plan.to !== undefined) problems.push('plan to is set only once the plan is handed out')
    if (plan.file !== undefined) problems.push('plan file is set only once the plan is handed out')
  }
  if (plan.history !== undefined) {
    if (!Array.isArray(plan.history)) problems.push('plan history must be a list of the earlier hand-outs')
    else if (plan.history.length > PLAN_HISTORY) problems.push(`plan history has ${plan.history.length}, at most ${PLAN_HISTORY}`)
    else plan.history.forEach((h, i) => (isObject(h) ? problems.push(...handoutProblems(h, flowId, `plan history #${i + 1}`)) : problems.push(`plan history #${i + 1} must be a JSON object`)))
  }
  return [...new Set(problems)]
}

/** For `flow write` (mergeKeepingAnswers): the `plan` block only ever comes from the stored file. Returns `incoming`. */
export function keepPlan(incoming, existing) {
  if (existing?.plan !== undefined) incoming.plan = existing.plan
  else delete incoming.plan
  return incoming
}

/** A hand-out as kept in history: who, when, to whom, which file. */
export const asHandout = p => ({ by: p.by, at: p.at, to: p.to, file: p.file })
