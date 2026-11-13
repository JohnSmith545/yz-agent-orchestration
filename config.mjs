// Settings for one machine: which repo to watch and what the sessions are called.
//
// Read from config.json next to this file (kept out of git, see .gitignore).
// config.example.json is the committed template. Anything left out falls back
// to the defaults below, so a config only needs the lines that differ.

import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isBranch } from './flow-merge.mjs'
import { validPinHash } from './send-pin.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** A fresh config raises no reminders; config.example.json shows one to copy. */
export const DEFAULT_REMINDERS = Object.freeze([])

const REMINDER_DAYS = ['weekdays', 'daily']
/** A real time of day: 24:00, 25:99 and 17:60 would never fire, or fire at the wrong minute. */
export const REMINDER_TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * The reminders to keep from the config value `raw`: left out means the default, a non-list
 * turns them off, and each entry needs `at` as HH:MM, `days` 'weekdays' or 'daily' and a
 * non-empty `text`, and no two share an `at` (both would mark the one key reminder.<date>.<at>,
 * so the second would never show). A bad entry is dropped with a warning (`warn`), never a failed startup:
 * a typo in a reminder should not stop the dashboard. Only at, days and text are kept.
 */
export function reminderList(raw, warn = console.warn) {
  if (raw === undefined) return DEFAULT_REMINDERS.map(r => ({ ...r }))
  if (!Array.isArray(raw)) {
    warn('config.json: "reminders" should be a list; no reminders will show.')
    return []
  }
  const kept = []
  raw.forEach((r, i) => {
    const why = r == null || typeof r !== 'object' ? 'is not an object'
      : typeof r.at !== 'string' || !REMINDER_TIME.test(r.at) ? 'needs "at" as HH:MM, 00:00 to 23:59'
      : kept.some(k => k.at === r.at) ? `repeats the time ${r.at} (one reminder per time: the first is kept)`
      : !REMINDER_DAYS.includes(r.days) ? 'needs "days" as weekdays or daily'
      : typeof r.text !== 'string' || !r.text.trim() ? 'needs a "text"'
      : null
    if (why) warn(`config.json: reminders[${i}] ${why}; it is left out.`)
    else kept.push({ at: r.at, days: r.days, text: r.text })
  })
  return kept
}

/**
 * The ticket prefixes from the config value `raw`, upper-cased, in order: left out (or not a
 * list) is undefined, so ticket-ids.mjs takes them from the collections and the ticket sources;
 * [] asks for the generic shape. An entry that is not letters and digits starting with a letter
 * is dropped with a warning (`warn`).
 */
export function ticketPrefixList(raw, warn = console.warn) {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) {
    warn('config.json: "ticketPrefixes" should be a list such as ["ABC"]; it is ignored.')
    return undefined
  }
  const kept = []
  raw.forEach((p, i) => {
    if (typeof p === 'string' && /^[A-Za-z][A-Za-z0-9]*$/.test(p)) kept.push(p.toUpperCase())
    else warn(`config.json: ticketPrefixes[${i}] needs letters and digits, starting with a letter; it is left out.`)
  })
  return kept
}

/** Branches a flow may never be sent FROM: a push there would move a shared branch. `*` matches anything. */
export const DEFAULT_PROTECT = Object.freeze(['main', 'master', 'stage', 'prod', 'production', 'release/*', 'release-*'])
/** Send to the base branch is off until the user turns it on AND sets a send PIN (send-pin.mjs). */
export const DEFAULT_PR = Object.freeze({ enabled: false, remote: 'origin', bases: Object.freeze(['dev']), gh: 'gh', protect: DEFAULT_PROTECT, pinHash: '' })
const REMOTE = /^[A-Za-z0-9._-]{1,100}$/
const PATTERN = /^[A-Za-z0-9._/*-]{1,100}$/
const OFF = 'Sending is off: turn it on in Settings.'
const NO_PIN = 'Sending is off: set a send PIN in Settings.'

/**
 * The Send settings from the config value `raw` (pr-routes.mjs): `enabled` (only `true` turns it on, and
 * only with a valid `pinHash`, set by `factory.mjs pr-pin`), the `remote` to push to (a simple name), the
 * `bases` a branch may be sent into, the `protect` patterns a branch may never be sent from, and the `gh`
 * command. `off` says why it is off, for the page. Any bad value turns the feature OFF with a warning
 * (`warn`): a typo must never send to the wrong place, and must not stop the dashboard either.
 */
export function prSettings(raw, warn = console.warn) {
  const base = { ...DEFAULT_PR, wanted: false, bases: [...DEFAULT_PR.bases], protect: [...DEFAULT_PR.protect] }
  const off = why => {
    warn(`config.json: ${why}; Send to dev is turned off.`)
    return { ...base, enabled: false, off: OFF }
  }
  if (raw === undefined) return { ...base, off: OFF }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return off('"pr" should be an object such as { "enabled": true, "bases": ["dev"] }')
  const s = { ...base, ...raw }
  if (typeof s.remote !== 'string' || !REMOTE.test(s.remote) || s.remote.startsWith('-') || /^\.+$/.test(s.remote)) return off('pr.remote needs a simple remote name such as origin')
  if (!Array.isArray(s.bases) || !s.bases.length || !s.bases.every(isBranch)) return off('pr.bases needs a list of branch names such as ["dev"]')
  if (!Array.isArray(s.protect) || !s.protect.every(p => typeof p === 'string' && PATTERN.test(p))) return off('pr.protect needs a list of branch names or patterns such as ["main", "release/*"]')
  if (typeof s.gh !== 'string' || !s.gh.trim()) return off('pr.gh needs the GitHub CLI command, such as gh')
  const pinHash = validPinHash(s.pinHash) ? s.pinHash : ''
  const enabled = s.enabled === true && !!pinHash
  return { enabled, wanted: s.enabled === true, off: enabled ? null : s.enabled === true ? NO_PIN : OFF, remote: s.remote, bases: [...s.bases], gh: s.gh, protect: [...s.protect], pinHash }
}

/**
 * The send settings as config.json says NOW: re-read (only the "pr" block) whenever the file's time or size
 * changes, so the Settings page and `factory.mjs pr-pin` take effect without a restart. Everything else in
 * CONFIG stays as it was at start. A file that does not parse (half written) keeps the last good settings.
 * `.invalidate()` makes the next call read again (after a write of our own).
 */
export function makePrReader(file, { warn = console.warn } = {}) {
  let key = null
  let value = null
  const read = () => {
    let st
    try { st = statSync(file) } catch { return value ?? prSettings(undefined, warn) }
    const k = `${st.mtimeMs}:${st.size}`
    if (k !== key || !value) {
      try {
        value = prSettings(JSON.parse(readFileSync(file, 'utf8')).pr, warn)
        key = k
      } catch {
        value ??= prSettings(undefined, warn)
      }
    }
    return value
  }
  return Object.assign(read, { invalidate() { key = null } })
}

/** The branches the grid compares (server.mjs), with their old fixed names as the defaults. */
export const DEFAULT_LEVELS = Object.freeze({ work: 'followup', dev: 'origin/dev', stage: 'origin/stage', prod: 'origin/main' })

/** The `levels` from the config value `raw`: each key a simple branch or remote branch name; a bad one warns and keeps its default. */
export function levelSettings(raw, warn = console.warn) {
  const out = { ...DEFAULT_LEVELS }
  if (raw === undefined) return out
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warn('config.json: "levels" should be an object such as { "dev": "origin/dev" }; the defaults are used.')
    return out
  }
  for (const key of Object.keys(DEFAULT_LEVELS)) {
    if (raw[key] === undefined) continue
    if (isBranch(raw[key])) out[key] = raw[key]
    else warn(`config.json: levels.${key} needs a branch name such as ${DEFAULT_LEVELS[key]}; the default is used.`)
  }
  return out
}

const DEFAULTS = {
  /** Absolute path of the git repo the sessions work in. Required. */
  repo: '',
  /**
   * Ticket prefixes (["ABC", "XYZ"]): only these count as ticket ids, in this order on the
   * ticket list. Left out: the collection filters plus the prefixes in the ticket sources;
   * none there either: a generic guess (ticket-ids.mjs).
   */
  ticketPrefixes: undefined,
  /** Port for the dashboard, on 127.0.0.1 only. */
  port: 4317,
  /** A session counts when its working directory contains this text. Defaults to the repo's folder name. */
  sessionCwdMatch: '',
  /** The coordinating session that merges everyone's work. */
  coordinator: 'Master',
  /** Session name -> the name shown on the page, for the sessions that write code. */
  codingAgents: { Master: 'Master' },
  /** Session name -> a nicer label, for any other session. */
  aliases: {},
  /** Local hour (0-23) at which the server stops itself, or null to keep running. */
  stopHour: null,
  /** More Claude config folders to find sessions in (e.g. a second account's ~/.claude-second). ~/.claude is always read. */
  claudeDirs: [],
  /** Path of the Claude Code binary for headless turns; empty = newest one bundled with an IDE extension. */
  claudeBin: '',
  /**
   * Reminders the page raises at a local time, once a day: a sticky toast and a desktop alert
   * (public/reminders.js). Each is { at: 'HH:MM', days: 'weekdays' | 'daily', text }; [] for none.
   */
  reminders: DEFAULT_REMINDERS,
  /**
   * Send to the base branch (pr-routes.mjs): on the user's click, push the work branch (never forced)
   * and open a pull request with the GitHub CLI. Off by default; see prSettings.
   */
  pr: DEFAULT_PR,
  /** The branches the grid compares: the coordinator's working branch and the remote dev, stage and prod (levelSettings). */
  levels: DEFAULT_LEVELS,
  /** The Factory page: ticket collections, the chat agent, the answer relay and the explainer. */
  factory: {
    /**
     * Each collection is a ticket set the page can show, read from data/sources/<id>.json
     * (checked at startup by validateCollection in factory.mjs):
     *   { id, name, kind: 'switchboard' | 'agent', project?, ask?, tools: string[],
     *     filter?: { prefix, range: [first, last], extras?: number[] }, plan?, refreshMinutes }
     * `switchboard` needs `project` and one tool; `agent` needs `ask` and at least one tool.
     * `refreshMinutes` is per collection (0 = only the button) and must be 0 when a tool can act.
     * Without `filter` the collection is every ticket in its source; `plan` is an optional
     * markdown plan with ticket tables.
     */
    collections: [],
    /** The user's id in the tracker (for "Mine"). */
    me: '',
    /**
     * The chat agent: its display name, the model, and how a chat starts. `mode` 'brief' (the
     * default, "light") starts a fresh session with the chat brief as its system prompt, well under
     * $1 a turn; 'fork' forks the session `forkFrom` on the first message, which costs about $7 once
     * (later turns cost their own few-tenths delta). The drawer's
     * "Start from my session" forks `forkFrom` once, whatever the mode.
     */
    chat: { name: 'Independent', forkFrom: '', model: 'claude-opus-5-5', mode: 'brief' },
    /** Model for the short headless turn that pushes an answered ask to the agent that asked (relay.mjs). */
    relayModel: 'claude-sonnet-5-5',
    /** Model for the one-off turn that explains a selected phrase the glossary lacks (explain.mjs). Keep it cheap. */
    explainModel: 'claude-haiku-5-5',
  },
}

function load() {
  const file = path.join(HERE, 'config.json')
  if (!existsSync(file)) {
    throw new Error('config.json is missing. Copy config.example.json to config.json and set "repo".')
  }
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  const config = { ...DEFAULTS, ...raw }
  config.factory = { ...DEFAULTS.factory, ...(raw.factory || {}) }
  config.factory.chat = { ...DEFAULTS.factory.chat, ...(raw.factory?.chat || {}) }
  config.reminders = reminderList(raw.reminders)
  config.ticketPrefixes = ticketPrefixList(raw.ticketPrefixes)
  config.pr = prSettings(raw.pr)
  config.levels = levelSettings(raw.levels)
  if (!config.repo) throw new Error('config.json needs "repo": the absolute path of the git repo to watch.')
  config.repo = config.repo.replace(/\\/g, '/')
  if (!config.sessionCwdMatch) config.sessionCwdMatch = path.basename(config.repo)
  config.port = Number(process.env.PORT || config.port)
  return config
}

export const CONFIG = load()
/** config.json, where the Settings page and pr-pin write the "pr" block. */
export const CONFIG_FILE = path.join(HERE, 'config.json')
/** The send settings as config.json says now (makePrReader): what every send and the Settings page use. */
export const prNow = makePrReader(CONFIG_FILE)
