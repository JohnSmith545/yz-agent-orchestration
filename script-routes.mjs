// The SCRIPT Generator's one route (the #/script page, public/script-page.js):
//
//   POST /api/script/generate   { text } (1 to 8000 characters): one model run (script.mjs),
//       streamed back as NDJSON (application/x-ndjson), one JSON object per line:
//         { "type": "delta", "text": "..." }                          as each text delta arrives
//         { "type": "done", "ok": true, "stopReason": "...", "cost": 0.2 }   the last line of a good run
//         { "type": "error", "error": "<plain message>", "cost"?: 0.05 }    the last line of a failed one
//       Exactly ONE of done or error ends the stream.
//       403 { error } for another site's Origin, 400 { error } for a bad body, and
//       409 { error } while another run is going: ONE run at a time, across every tab.
//
// Why NDJSON over the POST and not the chat's EventSource: a run belongs to the one request
// that started it (nothing is broadcast to other tabs), and EventSource cannot POST a body.
// A browser that goes away (the tab closed, the fetch aborted) closes the response before the
// end line was written; the route then cancels the run, which kills the child process.

import { originAllowed } from './local-origin.mjs'
import { checkText, generate as realGenerate } from './script.mjs'

const PATH = '/api/script/generate'
const BODY_MAX = 64_000 // the 8000-character text, JSON-escaped, with room to spare
const BUSY = 'A prompt is already being written. Wait for it to finish, then try again.'

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
 * else. `generate` is script.mjs's (tests pass a stub); `port` is the dashboard's, for the Origin rule.
 */
export function makeScriptRoute({ generate = realGenerate, port }) {
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

    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    let ended = false
    const write = obj => {
      if (!ended && !res.destroyed) res.write(JSON.stringify(obj) + '\n')
    }
    let run = null
    res.on('close', () => {
      if (!ended) run?.cancel() // the browser left before the end line: stop the child
    })
    let out
    try {
      run = generate(text, { onDelta: t => write({ type: 'delta', text: t }) })
      if (res.destroyed) run.cancel() // it left while the run was starting
      out = await run.done
    } catch {
      out = { error: 'The model run could not start. Try again in a moment.' }
    } finally {
      busy = false
    }
    if (out?.ok) write({ type: 'done', ok: true, stopReason: out.stopReason ?? null, cost: out.cost ?? null })
    else write({ type: 'error', error: out?.error || 'The model run stopped before it finished.', ...(typeof out?.cost === 'number' ? { cost: out.cost } : {}) })
    ended = true
    res.end()
    return true
  }
}
