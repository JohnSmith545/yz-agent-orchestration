// The Standup creator's dated archive (#/generators?tool=standup: today's stand-ups, the Date archive and the
// ticket filter). Kept for good, one file per local day, so the archive never rewrites one huge file:
//
//   data/standup/<YYYY-MM-DD>.json   { runs: [entry, …] }   every run made that day, newest first, at most 20
//   data/standup/index.json          { days: { "<YYYY-MM-DD>": { runs: [{ id, mode, ok, at, cost, first }], tickets: [ids] } } }
//   entry = { id, at, day, mode, ms, output, ok, error, cancelled, cost, window: { from, to, label, heading },
//             read: { line, left }, tickets: [{ id, title, link }] }
//
// Its own folder: the prompt generator's log (script-log.mjs) is never mixed with it.
//
// Rules this file keeps:
// - `day` is the LOCAL calendar day the run was made on (standup-window.mjs localDay). "Resets every day" is only
//   todayRuns over today's file: a reload keeps today's stand-up, and a new day starts both views empty. Nothing is
//   deleted for it; earlier days stay in the archive.
// - ⚠️ Every path is built AFTER the check: isDay for a day file, ticketId for a ticket. A string that fails reads
//   as nothing and never reaches the disk.
// - The index is a cache. It is rebuilt from the day files whenever it is missing, broken, or names a different
//   set of days than the folder holds (a day file copied in by hand, a write that stopped half way).
// - `tickets` are the ticket ids the stand-up mentions (ticketsMentioned): the facts' tickets the output names,
//   then any other id in the output with the dashboard's prefixes. The ticket filter reads them through the index.
// - Writes go through writeAtomic; the folder follows FACTORY_DATA_DIR (factory-state.mjs DATA_DIR), so tests never
//   write data/. A missing or broken day file reads as no runs; an entry of the wrong shape is left out.

import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { writeAtomic } from './atomic-write.mjs'
import { DATA_DIR } from './factory-state.mjs'
import { idsInText } from './ticket-ids.mjs'
import { MODES } from './standup-window.mjs'

export const ARCHIVE_DIR = path.join(DATA_DIR, 'standup')
export const ARCHIVE_LIMITS = Object.freeze({ perDay: 20, outputMax: 40_000, ticketsMax: 100 })
const ID = /^s-[a-z0-9]{1,40}$/
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const TICKET = /^[A-Z][A-Z0-9]{0,19}-\d{1,7}$/
const INDEX = 'index.json'

/** A short id, roughly time ordered, safe in a URL path. */
export const newRunId = () => `s-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`

/** A real calendar day written YYYY-MM-DD (2026-02-30 is not one). */
export function isDay(s) {
  const m = typeof s === 'string' ? DAY.exec(s) : null
  if (!m) return false
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]
}

/** A ticket id as the archive keeps it (FLA-886), or '' for anything else. */
export function ticketId(s) {
  const t = typeof s === 'string' ? s.trim().toUpperCase() : ''
  return TICKET.test(t) ? t : ''
}

const str = (v, max = 2_000) => (typeof v === 'string' ? v.slice(0, max) : '')
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)

/** One run as stored: exactly the agreed fields, the output capped. */
export function entryOf(r = {}) {
  const w = isObject(r.window) ? r.window : {}
  const read = isObject(r.read) ? r.read : {}
  return {
    id: String(r.id), at: String(r.at), day: String(r.day), mode: String(r.mode),
    ms: Number.isFinite(r.ms) ? Math.max(0, Math.round(r.ms)) : 0,
    output: str(r.output, ARCHIVE_LIMITS.outputMax),
    ok: r.ok === true,
    error: typeof r.error === 'string' && r.error ? r.error.slice(0, 1_000) : null,
    cancelled: r.cancelled === true,
    cost: typeof r.cost === 'number' && Number.isFinite(r.cost) ? r.cost : null,
    window: { from: str(w.from, 40), to: str(w.to, 40), label: str(w.label, 200), heading: str(w.heading, 200) },
    read: { line: str(read.line, 500), left: str(read.left, 500) },
    tickets: (Array.isArray(r.tickets) ? r.tickets : []).filter(t => isObject(t) && ticketId(t.id)).slice(0, ARCHIVE_LIMITS.ticketsMax)
      .map(t => ({ id: ticketId(t.id), title: str(t.title, 300), link: str(t.link, 500) })),
  }
}

const valid = e => isObject(e) && typeof e.id === 'string' && ID.test(e.id) && typeof e.at === 'string' && !Number.isNaN(Date.parse(e.at))
  && isDay(e.day) && MODES.includes(e.mode) && typeof e.output === 'string' && typeof e.ok === 'boolean'

const dayFile = (day, dir) => path.join(dir, `${day}.json`) // only ever called with a day isDay passed

function readJson(file) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
  } catch {
    return null
  }
}

/** One day's runs, newest first; [] for a bad day string, a day with nothing, or a broken file. */
export function readDay(day, dir = ARCHIVE_DIR) {
  if (!isDay(day)) return []
  const raw = readJson(dayFile(day, dir))
  return Array.isArray(raw?.runs) ? raw.runs.filter(valid).map(entryOf) : []
}

// The header lines a stand-up starts with, skipped for the line that says what it is about.
const HEADER = /^(Stand up,|Name:|Project:|This week — done:|Done .*:$)/
/** The first line of a run worth showing in a list: its first ticket or news line, else its error. */
export function firstLine(e) {
  const lines = String(e.output || '').split('\n').map(l => l.trim()).filter(Boolean)
  return (lines.find(l => !HEADER.test(l)) || lines[0] || e.error || '').slice(0, 300)
}

const brief = e => ({ id: e.id, mode: e.mode, ok: e.ok, at: e.at, cost: e.cost, first: firstLine(e) })
const dayIndex = runs => ({ runs: runs.map(brief), tickets: [...new Set(runs.flatMap(r => r.tickets.map(t => t.id)))] })

function dayNames(dir) {
  try {
    return readdirSync(dir).filter(f => f.endsWith('.json') && isDay(f.slice(0, -5))).map(f => f.slice(0, -5))
  } catch {
    return []
  }
}

function rebuildIndex(dir) {
  const days = {}
  for (const day of dayNames(dir)) days[day] = dayIndex(readDay(day, dir))
  try {
    writeAtomic(path.join(dir, INDEX), JSON.stringify({ days }))
  } catch {
    /* a read-only folder still answers from what it read */
  }
  return days
}

/** The index's days, rebuilt from the day files when it is missing, broken or out of step with the folder. */
function indexDays(dir) {
  const names = dayNames(dir)
  if (!names.length) return {}
  const raw = readJson(path.join(dir, INDEX))
  const days = isObject(raw?.days) ? raw.days : null
  const same = days && Object.keys(days).length === names.length && names.every(d => isObject(days[d]) && Array.isArray(days[d].runs) && Array.isArray(days[d].tickets))
  return same ? days : rebuildIndex(dir)
}

/** Add one run to the top of its day (at most 20 a day) and to the index. Throws when it is not a run or cannot be written. */
export function appendRun(run, dir = ARCHIVE_DIR) {
  const e = entryOf(run)
  if (!valid(e)) throw new Error('Not a stand-up archive entry.')
  const runs = [e, ...readDay(e.day, dir).filter(r => r.id !== e.id)].slice(0, ARCHIVE_LIMITS.perDay)
  writeAtomic(dayFile(e.day, dir), JSON.stringify({ runs }, null, 1))
  const days = indexDays(dir)
  days[e.day] = dayIndex(runs)
  writeAtomic(path.join(dir, INDEX), JSON.stringify({ days }))
  return e
}

/** Every day in the archive, newest first: { day, runs (in brief), tickets }. */
export function listDays(dir = ARCHIVE_DIR) {
  const days = indexDays(dir)
  return Object.keys(days).sort().reverse().map(day => ({ day, runs: days[day].runs, tickets: days[day].tickets }))
}

/** The id of the newest good run of each mode among one day's runs, or null: what each view shows after a reload. */
export function todayRuns(runs) {
  const pick = mode => runs.find(r => r.mode === mode && r.ok)?.id || null
  return { daily: pick('daily'), week: pick('week') }
}

const names = (text, id) => new RegExp(`(^|[^A-Za-z0-9-])${id}(?![0-9])`, 'i').test(text)

/**
 * The tickets a stand-up mentions: the facts' tickets ({ id, title, link }) its output names, in the facts' order,
 * then any other id in the output with `prefixes`, linked with `linkOf(id)` and no title.
 */
export function ticketsMentioned(output, factsTickets = [], prefixes = [], linkOf = () => '') {
  const text = String(output || '')
  if (!text) return []
  const out = factsTickets.filter(t => ticketId(t.id) && names(text, t.id)).map(t => ({ id: t.id, title: t.title || '', link: t.link || '' }))
  for (const id of idsInText(text, prefixes)) if (!out.some(t => t.id === id)) out.push({ id, title: '', link: linkOf(id) })
  return out.slice(0, ARCHIVE_LIMITS.ticketsMax)
}

/** The lines of `output` that name ticket `id`, each with the more indented bullets under it. */
export function linesAbout(output, id) {
  const lines = String(output || '').split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (!names(lines[i], id)) continue
    out.push(lines[i])
    const indent = lines[i].match(/^\s*/)[0].length
    while (i + 1 < lines.length && lines[i + 1].trim() && lines[i + 1].match(/^\s*/)[0].length > indent) out.push(lines[++i])
  }
  return out
}

/**
 * Every day ticket `raw` appeared, newest first: { id, title, link, days: [{ day, entries: [{ id, mode, at, lines }] }] }.
 * The title and link are the newest stand-up's. null for a string that is not a ticket id.
 */
export function ticketHistory(raw, dir = ARCHIVE_DIR) {
  const id = ticketId(raw)
  if (!id) return null
  const days = listDays(dir).filter(d => d.tickets.includes(id))
  let title = ''
  let link = ''
  const found = days.map(d => {
    const entries = readDay(d.day, dir).filter(r => r.tickets.some(t => t.id === id)).map(r => {
      const t = r.tickets.find(x => x.id === id)
      if (!title && t.title) title = t.title
      if (!link && t.link) link = t.link
      return { id: r.id, mode: r.mode, at: r.at, lines: linesAbout(r.output, id) }
    })
    return { day: d.day, entries }
  }).filter(d => d.entries.length)
  return { id, title, link, days: found }
}
