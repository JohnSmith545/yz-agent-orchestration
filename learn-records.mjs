// What Learn has recorded, for whoever reads it (the CONTRACT other features may call, as the evidence pack does):
//
//   listRetros({ since?, readFlows? })   every flow retrospective written at or after `since` (ms or ISO; left out or
//                                        unreadable: all of them), newest first, archived flows included:
//                                        [{ flowId, title, agent, at, right, wrong, next, source }]
//
// Rules this file keeps:
// - READ ONLY. The retrospectives live on the flows (flow.retro, learn-retro-text.mjs); this reads every flow file,
//   archived ones too (a flow is archived when the user completes it, which is when its retrospective is written).
// - It never throws: a store that cannot be read is an empty list.
// - `readFlows` is injected (tests pass their own); left out, flows.mjs listFlows over every flow file.

import { listFlows } from './flows.mjs'
import { validateRetro } from './learn-retro-text.mjs'

const allFlows = () => listFlows({ archived: 'any' }).flows

export function listRetros({ since = null, readFlows = allFlows } = {}) {
  const from = typeof since === 'number' ? since : typeof since === 'string' ? Date.parse(since) : NaN
  let flows
  try {
    flows = readFlows()
  } catch {
    return []
  }
  return (Array.isArray(flows) ? flows : [])
    .filter(f => f && typeof f.id === 'string' && f.retro && !validateRetro(f.retro).length)
    .filter(f => Number.isNaN(from) || Date.parse(f.retro.at) >= from)
    .map(f => ({ flowId: f.id, title: String(f.title || f.id), agent: String(f.agent || ''), at: f.retro.at, right: f.retro.right, wrong: f.retro.wrong, next: f.retro.next, source: f.retro.source }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}
