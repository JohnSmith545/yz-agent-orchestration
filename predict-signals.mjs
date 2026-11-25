// THE CONTRACT feat/smart-learn reads through an injected provider: what Predict and warn noticed in a window.
//
//   signals({ since, now })   [{ kind, text, flow?, agent? }]: the alerts RAISED since `since` (each once a day, from
//                             data/alerts-state.json, predict-state.mjs) and the ESTIMATE MISSES (a finished flow whose
//                             time or cost fell outside its stored estimate's range, predict-estimate.mjs misses),
//                             oldest first. `since` is a time in ms or an ISO string; left out, the last 7 days
//   signalsFrom({ raised, flows, graph, since, now, tokensOf })   the same, PURE, for the tests
//
// kind is one of stuck, spike, context, daily (an alert) or estimate-miss. Nothing here is a model's opinion: every
// signal is arithmetic on stored records, worded once, when it was raised.

import { CONFIG } from './config.mjs'
import { listFlows } from './flows.mjs'
import { pipelineGraph } from './pipeline.mjs'
import { misses } from './predict-estimate.mjs'
import { flowTokens } from './predict-flow-tokens.mjs'
import { ALERT_STATE_FILE, readAlertState } from './predict-state.mjs'

const WEEK = 7 * 86_400_000
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''
const msOf = v => (typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN)

export function signalsFrom({ raised = [], flows = [], graph, since, now = Date.now(), tokensOf = () => null }) {
  const from = Number.isFinite(msOf(since)) ? msOf(since) : now - WEEK
  const alerts = (Array.isArray(raised) ? raised : [])
    .filter(r => isObject(r) && isText(r.kind) && isText(r.text) && Date.parse(r.at) >= from && Date.parse(r.at) <= now)
    .map(r => ({ at: r.at, kind: r.kind, text: r.text, ...(isText(r.flow) ? { flow: r.flow } : {}), ...(isText(r.agent) ? { agent: r.agent } : {}) }))
  const missed = misses(flows, { graph, since: from, now, tokensOf })
  return [...alerts, ...missed]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map(({ at, kind, text, flow, agent }) => ({ kind, text, ...(flow ? { flow } : {}), ...(agent ? { agent } : {}) }))
}

export function signals({ since, now = Date.now(), file = ALERT_STATE_FILE, config = CONFIG } = {}) {
  return signalsFrom({ raised: readAlertState(file).raised, flows: listFlows({ archived: 'any' }).flows, graph: pipelineGraph(config), since, now, tokensOf: flowTokens })
}
