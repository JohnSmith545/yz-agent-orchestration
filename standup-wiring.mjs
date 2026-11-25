// The Standup creator's route bound to this machine (server.mjs mounts it with one line): the real readers for
// standup-facts.mjs, from the current project's config. Kept out of server.mjs so that file only gains a call.
//
//   git          server.mjs's git(args): an argv, run in CONFIG.repo, read only
//   prefixes()   the dashboard's ticket prefixes (transcripts.mjs ticketPrefixes), read at each run
//   The ticket list is every collection's SAVED source (factory.mjs readSource: no refresh, no paid turn), the
//   flows are every flow, archived ones too (a flow finished and archived this week is still this week's work),
//   and the waiting items are Human review's (human-routes.mjs humanGet).
//
// Every stand-up is saved in the dated archive, data/standup/<YYYY-MM-DD>.json (standup-archive.mjs).
//
// The `standup` block of config.json (all optional) is read once at startup, like the rest of CONFIG.

import path from 'node:path'

import { CONFIG } from './config.mjs'
import { pipelineGraph } from './pipeline.mjs'
import { collections, readSource } from './factory.mjs'
import { listFlows } from './flows.mjs'
import { humanGet } from './human-routes.mjs'
import { appendRun } from './standup-archive.mjs'
import { gatherFacts, savedTicketList, standupSettings, ticketLink } from './standup-facts.mjs'
import { makeStandupRoute } from './standup-routes.mjs'

export function makeStandupServerRoute({ port, git, prefixes }) {
  const settings = standupSettings(CONFIG.standup)
  const readTickets = () => savedTicketList({ collections: collections(), readSource })
  // every name an agent goes by in this project, kept out of the blockers the team reads (standup-blockers.mjs)
  const agentNames = () => {
    let graph = []
    try {
      graph = pipelineGraph(CONFIG).nodes.filter(n => n.kind === 'agent').map(n => n.label)
    } catch {
      graph = []
    }
    return [...graph, CONFIG.coordinator, CONFIG.coordinatorLabel, CONFIG.factory?.chat?.name, ...Object.keys(CONFIG.codingAgents || {}), ...Object.values(CONFIG.codingAgents || {}),
      ...Object.keys(CONFIG.aliases || {}), ...Object.values(CONFIG.aliases || {}), ...Object.keys(CONFIG.pinnedAgents || {})]
  }
  return makeStandupRoute({
    port, log: e => appendRun(e), prefixes, linkOf: id => ticketLink(settings.ticketUrl, id),
    ticketListAt: () => readTickets().fetchedAt,
    facts: window => gatherFacts({
      window, now: new Date(), git: args => git(args), settings, prefixes: prefixes(),
      repoName: path.basename(CONFIG.repo), fallbackBase: CONFIG.levels.dev,
      readTickets, agentNames: agentNames(), readFlows: () => listFlows({ archived: 'any' }).flows, readHuman: () => humanGet().body.items,
    }),
  })
}
