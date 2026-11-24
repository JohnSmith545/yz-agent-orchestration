// Pinned agents (config.json `pinnedAgents`): name -> { sessionId, cwd, claudeDir }.
// A pinned agent whose session is closed is still listed, idle, from its saved
// transcript, so the Agents tree and the Flow diagrams keep drawing it. A live
// session with the same id wins and the pin adds nothing.

import path from 'node:path'

/** The extra session records for pins whose session is not in `liveIds`. Pure. */
export function pinnedSessions(pinned, liveIds) {
  const out = []
  for (const [name, p] of Object.entries(pinned || {})) {
    if (!p?.sessionId || !p?.cwd || liveIds.has(p.sessionId)) continue
    out.push({ name, sessionId: p.sessionId, cwd: p.cwd, status: 'idle', pinned: true, _claudeDir: p.claudeDir ? path.resolve(p.claudeDir) : undefined })
  }
  return out
}
