// The SCRIPT Generator's one route (the #/script page, public/script-page.js):
//
//   POST /api/script/generate   { text } (1 to 8000 characters): one model run (script.mjs),
//       streamed back as NDJSON (application/x-ndjson), one JSON object per line:
//         { "type": "delta", "text": "..." }                          as each text delta arrives
//         { "type": "done", "ok": true, "stopReason": "...", "cost": 0.2 }   the last line of a good run
//         { "type": "error", "error": "<plain message>", "cost"?: 0.05 }    the last line of a failed one
//         { "type": "context", "used": [{ "title", "chars" }], "skipped": [{ "title", "why" }] }
//             at most ONE, before the first delta, when context was attached or left out (below)
//       Exactly ONE of done or error ends the stream. With the run log on (server.mjs), it carries
//       "run": "<id>", the run's entry in GET /api/script/log (script-log.mjs, script-log-routes.mjs),
//       written AFTER the response ends and never able to fail it.
//       403 { error } for another site's Origin, 400 { error } for a bad body, and
//       409 { error } while another run is going: ONE run at a time, across every tab.
//
// Why NDJSON over the POST and not the chat's EventSource: a run belongs to the one request
// that started it (nothing is broadcast to other tabs), and EventSource cannot POST a body.
// A browser that goes away (the tab closed, the fetch aborted) closes the response before the
// end line was written; the route then cancels the run, which kills the child process.
//
// Context (the page's Context panel, script-context-routes.mjs): after the checks, `gather()` reads what the
// user attached (the orchestration brief, a live session's latest talk, their notes) and composeInput
// (script-compose.mjs) wraps the text in it. The text alone keeps its 8,000 limit and checkText. With nothing
// attached the text goes exactly as before, and no context line is written. A gatherer that fails never stops
// the run: it goes with the plain text, and the context line says why.
//
// The brainstorming skill (script-skill.mjs): `skill()`, when given, reads the installed skill once per run.
// What it found goes to generate(), which then carries the skill (script.mjs). When it finds nothing, the skill is
// too long, or the finder throws, the run still goes on the built-in rules, and a Brainstorming skill entry with
// the plain reason is added to the context line's `skipped`, so the page says it in one line and the run log
// keeps it. When it was found, a Brainstorming skill entry goes FIRST in the line's `used`, so the page says
// "Sent with: Brainstorming skill, …" and a run restored from History says it too (an older run logged nothing
// about the skill and says nothing). With no finder (the tests' default) nothing is checked.

import { originAllowed } from './local-origin.mjs'
import { composeInput } from './script-compose.mjs'
import { LOG_LIMITS, newRunId } from './script-log.mjs'
import { SKILL_MISSING } from './script-skill.mjs'
import { checkText, generate as realGenerate } from './script.mjs'

const PATH = '/api/script/generate'
const BODY_MAX = 64_000 // the 8000-character text, JSON-escaped, with room to spare
const BUSY = 'A prompt is already being written. Wait for it to finish, then try again.'
const NO_CONTEXT = async () => ({ parts: [], skipped: [] })
const UNREAD = { title: 'Context', why: 'It could not be read, so none was sent.' }

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

/**
 * `route(req, res, url)` answers POST /api/script/generate and resolves true, or false for anything
 * else. `generate` is script.mjs's (tests pass a stub); `port` is the dashboard's, for the Origin rule;
 * `gather` reads the attached context (script-context-routes.mjs makeContextGatherer; none by default);
 * `log(entry)` records each run that started (script-log.mjs appendRun; none by default, so tests write nothing).
 * `skill()` finds the brainstorming skill (script-skill.mjs findSkill; none by default, so tests check nothing).
 */
export function makeScriptRoute({ generate = realGenerate, port, gather = NO_CONTEXT, log = null, skill = null }) {
  let busy = false

  return async function scriptRoute(req, res, url) {
    if (url.pathname !== PATH || req.method !== 'POST') return false
    // Another site must not spend the user's money: a POST's Origin, when it has one, must be the page's own.
    if (req.headers.origin && !originAllowed(req.headers.origin, port)) return json(res, 403, { error: 'Cross-origin request refused.' }), true
    let body
    try {
      body = await readBody(req)
    } catch (e) {
      return json(res, e.status || 400, { error: e.message }), true
    }
    const text = body?.text
    const why = checkText(text)
    if (why) return json(res, 400, { error: why }), true
    if (busy) return json(res, 409, { error: BUSY }), true
    busy = true

    let composed
    try {
      const got = await gather()
      const c = composeInput(text, got?.parts || [])
      composed = { input: c.input, used: c.used, skipped: [...(got?.skipped || []), ...c.skipped] }
    } catch {
      composed = { input: text, used: [], skipped: [UNREAD] }
    }
    let found = null
    if (skill) {
      let got = null
      try {
        got = await skill()
      } catch {
        got = null // a finder that fails is the same as not found: the run still goes
      }
      if (typeof got?.text === 'string' && got.text) {
        found = got
        composed.used.unshift({ title: SKILL_MISSING.title, chars: got.text.length })
      } else composed.skipped.push({ title: SKILL_MISSING.title, why: typeof got?.error === 'string' ? got.error : SKILL_MISSING.why })
    }

    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    let ended = false
    const write = obj => {
      if (!ended && !res.destroyed) res.write(JSON.stringify(obj) + '\n')
    }
    let run = null
    res.on('close', () => {
      if (!ended) run?.cancel() // the browser left before the end line: stop the child
    })
    if (composed.used.length || composed.skipped.length) write({ type: 'context', used: composed.used, skipped: composed.skipped })
    let out
    let output = '' // a copy of what was streamed, for the run log, capped as the log keeps it
    const at = new Date()
    let started = false
    try {
      run = generate(composed.input, {
        skill: found,
        onDelta: t => {
          if (output.length < LOG_LIMITS.outputMax) output += String(t).slice(0, LOG_LIMITS.outputMax - output.length)
          write({ type: 'delta', text: t })
        },
      })
      started = true
      if (res.destroyed) run.cancel() // it left while the run was starting
      out = await run.done
    } catch {
      out = { error: 'The model run could not start. Try again in a moment.' }
    } finally {
      busy = false
    }
    // a run that started is logged, good, failed or stopped alike; the end line names it
    const runId = log && started ? newRunId() : null
    const named = runId ? { run: runId } : {}
    if (out?.ok) write({ type: 'done', ok: true, stopReason: out.stopReason ?? null, cost: out.cost ?? null, ...named })
    else write({ type: 'error', error: out?.error || 'The model run stopped before it finished.', ...(typeof out?.cost === 'number' ? { cost: out.cost } : {}), ...named })
    ended = true
    res.end()
    if (runId) {
      const entry = {
        id: runId, at: at.toISOString(), ms: Date.now() - at.getTime(), text, output,
        ok: !!out?.ok, error: out?.ok ? null : out?.error || 'The model run stopped before it finished.',
        cancelled: out?.cancelled === true, cost: typeof out?.cost === 'number' ? out.cost : null,
        context: { used: composed.used, skipped: composed.skipped },
      }
      // after the answer is out, and never able to fail it: the log is a side note
      setImmediate(() => {
        try {
          log(entry)
        } catch (err) {
          console.error(`script: the run log could not be written: ${err?.message || err}`)
        }
      })
    }
    return true
  }
}
