// Where an open flow stands NOW, and since when: the stuck alert's half of the picture (predict-alerts.mjs). It reads
// pipeline.mjs stageOf (where the diagram draws the flow) and dates the moment the flow got there from the times the
// flow file stores, like Pipeline time's stages (time-stages.mjs). A stage it cannot date is no stage: null, never a
// guess, so a flow with no time to go by raises nothing.
//
//   currentStage(flow, graph)   { key, since (ms), onYou, who } or null
//
// THE KEYS: the Pipeline time stage keys where there is a history to compare with (planning, producing, qa, security,
// human, senior, rework), and a few of its own that wait on the user or on a step with no history (push):
//   ask       an agent asked a question that has no answer yet: on you, since the oldest open question was asked
//   blocked   its agent marked it blocked: on you, since its last update (human.mjs counts it as waiting on you)
//   stopped   QA, Security or Senior stopped it after too many failures: on you (only you move it on), since then
//   human     by-hand steps written for you, not all ticked: on you, since the first step was written
//   push      QA passed it and the push waits (or was refused): since the pass
//   rework    sent back for a fix: with whoever it went back to, since the failure
//   planning, producing, qa, security, senior: with that agent, since the stage began
// `who` is the agent's label, or 'you'. A flow done, dropped, at the Output or past it is nowhere: null.
// ⚠️ PURE: no file, no clock, no config.

import { stageOf } from './pipeline.mjs'
import { handSteps } from './pipeline-hand.mjs'

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''
const timeOf = v => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isNaN(t) ? null : t
}
const earliest = list => {
  const times = list.filter(t => t !== null)
  return times.length ? Math.min(...times) : null
}
const YOU = 'you'

/** The planner's first hand-out (time-stages.mjs firstHandOut), or null. */
function handOut(plan) {
  if (!isObject(plan)) return null
  return earliest([...(Array.isArray(plan.history) ? plan.history.filter(isObject) : []), ...(plan.status === 'handed' ? [plan] : [])].map(h => timeOf(h.at)))
}

export function currentStage(flow, graph) {
  if (!isObject(flow) || !(flow.status === 'open' || flow.status === 'blocked')) return null
  const at = (key, since, who, onYou = false) => (since === null ? null : { key, since, onYou, who })

  // a question waits on you whatever else is going on
  const asks = (Array.isArray(flow.nodes) ? flow.nodes : []).filter(n => isObject(n) && n.type === 'ask' && n.answer == null)
  if (asks.length) return at('ask', earliest(asks.map(n => timeOf(n.at))), YOU, true)
  if (flow.status === 'blocked') return at('blocked', timeOf(flow.updatedAt), YOU, true)

  let st
  try {
    st = stageOf(flow, graph)
  } catch {
    return null
  }
  const node = (graph?.nodes || []).find(n => n.id === st.node)
  if (!node || node.role === 'outcome') return null
  const qa = isObject(flow.qa) ? flow.qa : null
  const sec = isObject(qa?.security) ? qa.security : null
  const owner = isText(flow.agent) ? flow.agent : node.label

  switch (node.role) {
    case 'qa':
      if (st.status === 'failed') return at('stopped', timeOf(qa?.at), YOU, true)
      if (st.status === 'testing') return at('qa', timeOf(qa?.startedAt), node.label)
      if (st.status === 'pending') return at('qa', timeOf(qa?.at) ?? timeOf(qa?.startedAt), node.label)
      return at('qa', timeOf(flow.updatedAt), node.label) // done with code and no QA record: waiting for QA to pick it up
    case 'security':
      if (st.status === 'failed') return at('stopped', timeOf(sec?.at), YOU, true)
      if (st.status === 'reviewing') return at('security', timeOf(sec?.startedAt) ?? timeOf(qa?.at), node.label)
      return at('security', timeOf(qa?.at), node.label)
    case 'push':
      return at('push', timeOf(sec?.at) ?? timeOf(qa?.at), node.label)
    case 'human': {
      const steps = handSteps(flow)
      if (!steps.length) return at('producing', timeOf(flow.hand?.requestedAt), owner) // steps asked for: the agent writes them
      return at('human', earliest(steps.map(s => timeOf(s.at))), YOU, true)
    }
    case 'senior': {
      const s = isObject(flow.senior) ? flow.senior : null
      if (st.status === 'failed') return at('stopped', timeOf(s?.at), YOU, true)
      if (st.status === 'reviewing') return at('senior', timeOf(s?.startedAt), node.label)
      const ticks = handSteps(flow).map(x => (isObject(x.done) ? timeOf(x.done.at) : null))
      return at('senior', timeOf(s?.at) ?? (ticks.length && ticks.every(t => t !== null) ? Math.max(...ticks) : null), node.label)
    }
    case 'planner':
      return at('planning', timeOf(flow.createdAt), node.label)
    default: {
      // the owner's box: back for a fix, or at work since the hand-out (or the start)
      if (st.status === 'rework') {
        const failed = [...(Array.isArray(qa?.attempts) ? qa.attempts : []), qa].filter(isObject).at(-1)
        const when = failed?.status === 'passed' ? timeOf(failed.security?.at) : timeOf(failed?.at)
        return at('rework', when, node.label)
      }
      const plan = isObject(flow.plan) ? flow.plan : null
      if (plan && node.role === 'coordinator') return at('planning', timeOf(flow.createdAt), node.label)
      return at('producing', (plan ? handOut(plan) : null) ?? timeOf(flow.createdAt), node.label)
    }
  }
}
