// The Settings page routes (factory-routes.mjs mounts them):
//
//   GET  /api/settings        { setup, pr: { enabled, wanted, bases, remote, hasPin } }: a read-only summary of
//                             config.json and the send settings as they are NOW (never the PIN hash)
//   POST /api/settings/send   { enabled?, bases? }: turn sending on or off, the branches it may open pull requests into
//   POST /api/settings/pin    { next, current? | reset? }: set, change or reset the send PIN
//
// ═══ THE HUMAN-PRESENCE RULE ═══ The send PIN stops anything that drives the page. So a change that would
// let such a driver send is confirmed OUTSIDE the browser, in a system window (native-confirm.mjs): the
// FIRST PIN, a RESET of a forgotten one, turning sending ON, and changing the branches. Changing the PIN
// with the right current one, and turning sending OFF, need no window. Both POSTs need the page's own
// Origin, like Send itself. A wrong current PIN counts toward the same five-try lock as sending.
// Writes touch only config.json's "pr" block (config-write.mjs); the live reader (config.mjs prNow) picks
// them up without a restart.
//
// Each handler returns { status, body }. `deps` is { configFile, confirm, prNow, port }.

import { CONFIG } from './config.mjs'
import { writePrKeys } from './config-write.mjs'
import { isBranch } from './flow-merge.mjs'
import { originAllowed } from './local-origin.mjs'
import { CURRENT_PROJECT, PROJECTS_FILE } from './project-store.mjs'
import { hashPin, pinProblem, sharedLock, verifyPin } from './send-pin.mjs'

const TITLE = 'Yz Agent Orchestration'
const answer = (status, body) => ({ status, body })
const NO_WINDOW_PIN = 'Could not open a confirmation window here. Run this in a terminal instead: node tools/factory.mjs pr-pin'
const NO_WINDOW_SEND = 'Could not open a confirmation window here. Edit the pr block in config.json instead.'

/** The send settings for the page: never the hash, only whether there is one. */
function prSummary(pr) {
  return { enabled: pr.enabled, wanted: !!pr.wanted, bases: [...pr.bases], remote: pr.remote, hasPin: !!pr.pinHash }
}

/** What the page shows read-only: where things are and what the sessions are called. No secret. */
function setup(configFile) {
  const chat = CONFIG.factory?.chat || {}
  return {
    repo: CONFIG.repo,
    // a project other than the first keeps its repo, agents and pipeline in projects.json (project-store.mjs)
    configPath: CURRENT_PROJECT && !CURRENT_PROJECT.primary ? PROJECTS_FILE : configFile,
    coordinator: CONFIG.coordinator,
    coordinatorLabel: CONFIG.coordinatorLabel,
    codingAgents: [...new Set(Object.values(CONFIG.codingAgents || {}))],
    chat: { name: chat.name || '', model: chat.model || '', mode: chat.mode || 'brief' },
    ticketPrefixes: CONFIG.ticketPrefixes ?? null,
    reminders: (CONFIG.reminders || []).map(r => ({ at: r.at, days: r.days, text: r.text })),
  }
}

export function settingsGet(deps) {
  return answer(200, { setup: setup(deps.configFile), pr: prSummary(deps.prNow()) })
}

/** Ask the system window; null when it said Yes, else the refusal to send back. */
async function confirmed(deps, message, unavailable) {
  const said = await deps.confirm({ title: TITLE, message })
  if (said === 'yes') return null
  if (said === 'busy') return answer(409, { error: 'A confirmation is already open.' })
  if (said === 'no') return answer(409, { error: 'Declined.' })
  return answer(409, { error: unavailable })
}

const strict = (headers, deps) => originAllowed(headers.origin, deps.port) ? null
  : answer(403, { error: 'Settings are changed only from the dashboard page.' })

function saved(deps, changes) {
  writePrKeys(deps.configFile, changes)
  deps.prNow.invalidate?.()
  return answer(200, { ok: true, pr: prSummary(deps.prNow()) })
}

export async function settingsSend(b, headers, deps) {
  const refused = strict(headers, deps)
  if (refused) return refused
  const changes = {}
  if (b?.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') return answer(400, { error: 'enabled must be true or false.' })
    changes.enabled = b.enabled
  }
  if (b?.bases !== undefined) {
    if (!Array.isArray(b.bases) || !b.bases.length || b.bases.length > 10 || !b.bases.every(isBranch)) {
      return answer(400, { error: 'Branches must be simple branch names, such as dev, separated by commas.' })
    }
    changes.bases = [...new Set(b.bases)]
  }
  if (!Object.keys(changes).length) return answer(400, { error: 'Nothing to change.' })
  const now = deps.prNow()
  const bases = changes.bases || now.bases
  const turningOn = changes.enabled === true && !now.wanted
  const newBases = !!changes.bases && JSON.stringify(changes.bases) !== JSON.stringify(now.bases)
  if (turningOn || newBases) {
    const message = turningOn ? `Turn on sending pull requests into: ${bases.join(', ')}?` : `Let Yz Agent Orchestration open pull requests into: ${bases.join(', ')}?`
    const no = await confirmed(deps, message, NO_WINDOW_SEND)
    if (no) return no
  }
  return saved(deps, changes)
}

export async function settingsPin(b, headers, deps) {
  const refused = strict(headers, deps)
  if (refused) return refused
  const problem = pinProblem(b?.next)
  if (problem) return answer(400, { error: problem })
  const lock = sharedLock.get()
  const wait = lock.locked()
  if (wait) return answer(429, { error: `Too many wrong PINs: sending is locked for 10 minutes (${Math.ceil(wait / 60_000)} left).` })
  const { pinHash } = deps.prNow()
  if (pinHash) {
    if (typeof b.current === 'string' && b.current) {
      if (!verifyPin(b.current, pinHash)) {
        lock.fail()
        return answer(403, { error: 'Wrong current PIN.' })
      }
      lock.ok()
      return saved(deps, { pinHash: hashPin(b.next) })
    }
    if (b.reset !== true) return answer(400, { error: 'Type your current PIN, or reset it.' })
    const no = await confirmed(deps, 'Reset the send PIN for Yz Agent Orchestration? The old PIN stops working.', NO_WINDOW_PIN)
    return no || saved(deps, { pinHash: hashPin(b.next) })
  }
  const no = await confirmed(deps, 'Set a new send PIN for Yz Agent Orchestration?', NO_WINDOW_PIN)
  return no || saved(deps, { pinHash: hashPin(b.next) })
}
