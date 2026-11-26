// The Learn page's route bound to this machine (server.mjs mounts it with one line, as standup-wiring.mjs does for
// the Standup creator): the real readers for learn-routes.mjs, the retrospective writer, and the listener that records
// a verdict baseline for EVERY rule change (agent-rules-routes.mjs onRuleChange), the user's own typed edits included.
//
//   makeLearnServerRoute({ port, tokens?, lessons?, signals? })   -> route, with route.completed(id) for
//                                                                    factory-routes.mjs onCompleted
//     tokens()    the Pipeline tokens index snapshot (token-routes.mjs route.snapshot): { files, building }. While the
//                 first build runs, or with none, the cost is left out (usd null), never guessed.
//     lessons     CONTRACT, optional: lessons({ since }) -> [{ id, text, area, count }] (feat/smart-quality, listLessons)
//     signals     CONTRACT, optional: signals({ since }) -> [{ kind, text }] (feat/smart-predict)
//     Left out, the pack has no such section and everything else works.
//
// Rules this file keeps:
// - The `learn` block of config.json is read ONCE, at startup, like the rest of CONFIG (learn-settings.mjs). Nothing
//   here writes config.json.
// - A QA report is read only when its path is one `flow qa` writes (<flow>/qa-<n>-report.md), under data/evidence.
// - Accept and Revert save through agent-rules-routes.mjs rulesPut with this server's port, so the Origin check and
//   the change log are exactly the user's own. The Learn proposal an Accept came from is linked to its verdict entry.

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { agentLabels, readLog, readRules, rulesOf } from './agent-rules.mjs'
import { onRuleChange, rulesPut } from './agent-rules-routes.mjs'
import { CONFIG } from './config.mjs'
import { EVIDENCE_DIR, listFlows } from './flows.mjs'
import { windowNumbers } from './learn-numbers.mjs'
import { buildPack } from './learn-pack.mjs'
import { makeRetros } from './learn-retro.mjs'
import { makeLearnRoute } from './learn-routes.mjs'
import { RUNS_DIR, rejectedIdeas } from './learn-runs.mjs'
import { learnSettings } from './learn-settings.mjs'
import { backfillChanges, decideChange, readVerdicts, recordChange, verdictView } from './learn-verdicts.mjs'
import { pipelineGraph } from './pipeline.mjs'
import { priceTable, tokenStats } from './token-usage.mjs'

const DAY = 86_400_000
const REPORT = /^[a-z0-9-]+\/qa-\d+-report(?:-\d+)?\.md$/

/** A QA report's text by its ref as `flow qa` stores it, or null (another path, or not readable). */
export function readReport(ref, dir = EVIDENCE_DIR) {
  if (typeof ref !== 'string' || !REPORT.test(ref)) return null
  try {
    return readFileSync(path.join(dir, ref), 'utf8')
  } catch {
    return null
  }
}

/** ({ from, to }) -> { usd }: Pipeline tokens' estimate for those whole local days, or usd null while it cannot say. */
export function tokenCost(snapshot, prices) {
  return ({ from, to }) => {
    const snap = typeof snapshot === 'function' ? snapshot() : null
    if (!snap || snap.building || !Array.isArray(snap.files)) return { usd: null }
    const days = Math.max(1, Math.round((to - from) / DAY))
    return { usd: tokenStats({ files: snap.files, now: to, days, prices }).cost.usd }
  }
}

export function makeLearnServerRoute({ port, tokens = () => null, lessons = null, signals = null }) {
  const settings = learnSettings(CONFIG.learn)
  const settingsNow = () => settings
  const graph = () => pipelineGraph(CONFIG)
  const flows = () => listFlows({ archived: 'any' }).flows
  const cost = tokenCost(tokens, priceTable(CONFIG.tokens).prices)
  const numbersOver = list => (from, to) => windowNumbers({ flows: list, graph: graph(), from, to, tokens: cost })
  const retros = makeRetros({ graph, settings: settingsNow, readReport })

  // the baseline of every rule change, at the moment it is saved; `link` is the Learn proposal an Accept came from
  let link = null
  onRuleChange(change => recordChange(change, { numbers: numbersOver(flows()), afterDays: settings.verdictAfterDays, link }))

  const route = makeLearnRoute({
    port, settings: settingsNow, dir: () => RUNS_DIR,
    pack: ({ now, lastRunAt }) => buildPack({
      now, lastRunAt, graph: graph(), flows, rules: () => readRules(), tokens: cost, verdicts: () => readVerdicts().changes,
      rejected: () => rejectedIdeas(), readReport, lessons, signals,
    }),
    labels: () => agentLabels(graph()),
    rulesNow: () => Object.fromEntries(agentLabels(graph()).map(l => [l, rulesOf(readRules(), l).rules.map(r => r.text)])),
    entryOf: label => rulesOf(readRules(), label),
    putRules: (label, body, headers, { by, link: from } = {}) => {
      link = from || null
      try {
        return rulesPut(label, body, headers, { port, by })
      } finally {
        link = null
      }
    },
    retros,
    verdicts: {
      view: now => {
        const numbers = numbersOver(flows())
        backfillChanges(readLog(), { numbers, afterDays: settings.verdictAfterDays })
        return verdictView({ now, numbers })
      },
      decide: (id, what, { revert }) => decideChange(id, what, { now: Date.now(), numbers: numbersOver(flows()), revert }),
    },
  })
  route.completed = id => retros.completed(id)
  return route
}
