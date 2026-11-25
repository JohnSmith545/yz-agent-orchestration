// The Standup creator's routes (#/generators?tool=standup, public/standup-page.js):
//
//   POST /api/standup/generate   { mode: "daily" | "week" }: gather the facts (standup-facts.mjs), then ONE model run
//       (script.mjs, the same clean run as the prompt generator, with the stand-up turn), streamed back as NDJSON,
//       exactly like POST /api/script/generate, one JSON object per line:
//         { "type": "facts", "mode", "window": { from, to, label, heading }, "read": "Read: …", "left": "Left out: …" | "",
//           "counts": { commits, merges, unmerged, tickets, flows, waiting }, "ticketListAt", "skipped": [{ title, why }] }
//             FIRST, once the facts are in, before any delta
//         { "type": "delta", "text": "..." }                                    as each text delta arrives
//         { "type": "done", "ok": true, "stopReason", "cost", "run" }           the last line of a good run
//         { "type": "error", "error": "<plain message>", "cost"?, "run"? }      the last line of a failed one
//       Exactly ONE of done or error ends the stream. 403 { error } for another site's Origin, 400 { error } for a bad
//       body or mode, 405 for another method, and 409 { error } while a stand-up is being written: ONE at a time.
//   GET  /api/standup/log        today's state: { runs (today's, newest first), today: { day, daily, week } (the id of
//       today's stand-up of each mode, or null), windows: { daily, week } (what each covers now, for the page's
//       Covers line before any run), ticketListAt (how old the saved ticket list is), limits }
//   GET  /api/standup/days       the Date archive: { days: [{ day, runs: [{ id, mode, ok, at, cost, first }], tickets }] },
//       newest first, every day kept (standup-archive.mjs)
//   GET  /api/standup/day/<YYYY-MM-DD>   { day, runs } that day's stand-ups in full; 400 for a day that is not one
//   GET  /api/standup/ticket/<ID>        { id, title, link, days: [{ day, entries: [{ id, mode, at, lines }] }] }:
//       every day a ticket appeared, newest first; 400 for a string that is not a ticket id
//   The day and the id are checked BEFORE any path is built (standup-archive.mjs isDay, ticketId).
//
// Rules this file keeps:
// - The run's id is written into the end line and the archive, AFTER the response ends and never able to fail it, as
//   script-routes.mjs does. A browser that goes away cancels the run, which kills the child.
// - The window comes from the injected clock (`now`), so "daily" on a Monday covers Friday in the tests too.
// - Its busy flag is its own: a stand-up and a prompt can be written at the same time, but never two stand-ups.

import { originAllowed } from './local-origin.mjs'
import { generate as realGenerate } from './script.mjs'
import { leftLine, readLine, factsText } from './standup-text.mjs'
import { ARCHIVE_DIR, ARCHIVE_LIMITS, isDay, listDays, newRunId, readDay, ticketHistory, ticketId, ticketsMentioned, todayRuns } from './standup-archive.mjs'
import { DEFAULT_TICKET_URL, ticketLink } from './standup-facts.mjs'
import { systemPrompt } from './standup-prompt.mjs'
import { MODES, standupWindow } from './standup-window.mjs'

const GENERATE = '/api/standup/generate'
const LOG = '/api/standup/log'
const DAYS = '/api/standup/days'
const ONE_DAY = /^\/api\/standup\/day\/([^/]{1,40})$/
const ONE_TICKET = /^\/api\/standup\/ticket\/([^/]{1,40})$/
const BODY_MAX = 2_000
const BUSY = 'A stand-up is already being written. Wait for it to finish, then try again.'
const BAD_MODE = 'Choose Daily or This week.'
const NO_FACTS = 'The facts for the stand-up could not be read, so nothing was sent. Try again.'

/** The stand-up's model turn: Opus 5.5 at medium effort, its own prompt, session name and spend kind. */
export const standupTurn = mode => ({
  system: systemPrompt(mode), effort: 'medium', name: 'STANDUP', kind: 'standup',
  messages: { refusal: 'The model chose not to write this stand-up. Try again.' },
})

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  let raw = ''
  for await (const c of req) {
    raw += c
    if (raw.length > BODY_MAX) throw Object.assign(new Error('That is too long to send.'), { status: 413 })
  }
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    throw Object.assign(new Error('The request was not valid JSON.'), { status: 400 })
  }
}

/** A path part decoded, or '' for a malformed escape (which is then refused like any bad day or id). */
const decode = s => {
  try {
    return decodeURIComponent(s)
  } catch {
    return ''
  }
}

const windowPart = w => ({ from: w.from, to: w.to, label: w.label, heading: w.heading })

/**
 * `route(req, res, url)` answers the two paths and resolves true, or false for anything else. `facts(window)` gathers
 * the facts (standup-facts.mjs gatherFacts, bound in standup-wiring.mjs); `generate` is script.mjs's; `log(entry)`
 * saves each run that started (standup-archive.mjs appendRun; none by default, so tests write nothing unless they
 * ask); `dir` is the archive the GETs read; `now()` the clock; `ticketListAt()` the saved ticket list's date, for the
 * page before any run; `prefixes()` and `linkOf(id)` find and link the ticket ids in an output for the ticket log.
 */
export function makeStandupRoute({
  port, facts, generate = realGenerate, log = null, dir = ARCHIVE_DIR, now = () => new Date(), ticketListAt = () => null,
  prefixes = () => [], linkOf = id => ticketLink(DEFAULT_TICKET_URL, id),
}) {
  let busy = false

  async function generateRoute(req, res) {
    if (req.headers.origin && !originAllowed(req.headers.origin, port)) return json(res, 403, { error: 'Cross-origin request refused.' })
    let body
    try {
      body = await readBody(req)
    } catch (e) {
      return json(res, e.status || 400, { error: e.message })
    }
    const mode = body?.mode
    if (!MODES.includes(mode)) return json(res, 400, { error: BAD_MODE })
    if (busy) return json(res, 409, { error: BUSY })
    busy = true

    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    let ended = false
    let run = null
    const write = obj => {
      if (!ended && !res.destroyed) res.write(JSON.stringify(obj) + '\n')
    }
    const end = () => {
      ended = true
      res.end()
    }
    res.on('close', () => {
      if (!ended) run?.cancel() // the browser left before the end line: stop the child
    })

    const at = now()
    const window = standupWindow(mode, at)
    let f
    try {
      f = await facts(window)
    } catch {
      busy = false
      write({ type: 'error', error: NO_FACTS })
      return end()
    }
    const read = { line: readLine(f), left: leftLine(f) }
    write({
      type: 'facts', mode, window: windowPart(window), read: read.line, left: read.left, ticketListAt: f.ticketListAt, skipped: f.skipped,
      counts: { commits: f.commits.length, merges: f.merges.length, unmerged: f.unmerged.length, tickets: f.tickets.length, flows: f.flows.length, waiting: f.waiting.length },
    })

    let out
    let output = '' // a copy of what was streamed, for the archive, capped as the archive keeps it
    let started = false
    try {
      run = generate(factsText(f, at), {
        turn: standupTurn(mode),
        onDelta: t => {
          if (output.length < ARCHIVE_LIMITS.outputMax) output += String(t).slice(0, ARCHIVE_LIMITS.outputMax - output.length)
          write({ type: 'delta', text: t })
        },
      })
      started = true
      if (res.destroyed) run.cancel() // it left while the facts were being read
      out = await run.done
    } catch {
      out = { error: 'The model run could not start. Try again in a moment.' }
    } finally {
      busy = false
    }
    const runId = log && started ? newRunId() : null
    const named = runId ? { run: runId } : {}
    if (out?.ok) write({ type: 'done', ok: true, stopReason: out.stopReason ?? null, cost: out.cost ?? null, ...named })
    else write({ type: 'error', error: out?.error || 'The model run stopped before it finished.', ...(typeof out?.cost === 'number' ? { cost: out.cost } : {}), ...named })
    end()
    if (runId) {
      const entry = {
        id: runId, at: at.toISOString(), day: window.today, mode, ms: Date.now() - at.getTime(), output,
        ok: !!out?.ok, error: out?.ok ? null : out?.error || 'The model run stopped before it finished.',
        cancelled: out?.cancelled === true, cost: typeof out?.cost === 'number' ? out.cost : null,
        window: windowPart(window), read,
      }
      try {
        entry.tickets = ticketsMentioned(output, f.tickets, prefixes(), linkOf)
      } catch {
        entry.tickets = [] // the stand-up is still saved, without its ticket log
      }
      setImmediate(() => {
        try {
          log(entry)
        } catch (err) {
          console.error(`standup: the archive could not be written: ${err?.message || err}`)
        }
      })
    }
  }

  function logRoute(res) {
    const at = now()
    const daily = standupWindow('daily', at)
    const runs = readDay(daily.today, dir)
    let listAt = null
    try {
      listAt = ticketListAt()
    } catch {
      listAt = null
    }
    json(res, 200, {
      runs, today: { day: daily.today, ...todayRuns(runs) },
      windows: { daily: windowPart(daily), week: windowPart(standupWindow('week', at)) },
      ticketListAt: listAt, limits: { ...ARCHIVE_LIMITS },
    })
  }

  return async function standupRoute(req, res, url) {
    if (url.pathname === GENERATE) {
      if (req.method !== 'POST') return json(res, 405, { error: 'Use POST here.' }), true
      return await generateRoute(req, res), true
    }
    const day = ONE_DAY.exec(url.pathname)?.[1]
    const ticket = ONE_TICKET.exec(url.pathname)?.[1]
    if (url.pathname !== LOG && url.pathname !== DAYS && day === undefined && ticket === undefined) return false
    if (req.method !== 'GET') return json(res, 405, { error: 'Use GET here.' }), true
    if (url.pathname === LOG) return logRoute(res), true
    if (url.pathname === DAYS) return json(res, 200, { days: listDays(dir) }), true
    if (day !== undefined) {
      const d = decode(day)
      if (!isDay(d)) return json(res, 400, { error: 'A day looks like 2026-11-25.' }), true
      return json(res, 200, { day: d, runs: readDay(d, dir) }), true
    }
    const id = ticketId(decode(ticket))
    if (!id) return json(res, 400, { error: 'A ticket id looks like FLA-886.' }), true
    return json(res, 200, ticketHistory(id, dir)), true
  }
}
