// The SCRIPT run log routes (#/script, the page's History list). The store is script-log.mjs; the generate
// route (script-routes.mjs) writes each run.
//
//   GET    /api/script/log         { runs: [{ id, at, ms, text, output, ok, error, cancelled, cost,
//                                     context: { used: [{ title, chars }], skipped: [{ title, why }] } }], newest first,
//                                    limits: { runsMax: 50, outputMax: 40000 } }
//   DELETE /api/script/log/<id>    { ok: true }, or 404 { error } when it is not there
//   DELETE /api/script/log         { ok: true, removed: <how many> }
//
// The deletes check the page's own Origin first (local-origin.mjs): 403 for another site. `file` is injected so
// tests never touch data/. Errors are { error: "<plain sentence>" }.

import { originAllowed } from './local-origin.mjs'
import { clearLog, LOG_FILE, LOG_LIMITS, readLog, removeRun } from './script-log.mjs'

const BASE = '/api/script/log'
const ONE = /^\/api\/script\/log\/([a-z0-9-]{1,40})$/

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** `route(req, res, url)` answers the log paths and resolves true, or false for anything else. */
export function makeScriptLogRoute({ port, file = LOG_FILE }) {
  return async function scriptLogRoute(req, res, url) {
    const id = ONE.exec(url.pathname)?.[1]
    if (url.pathname !== BASE && !id) return false
    const allowed = id ? ['DELETE'] : ['GET', 'DELETE']
    if (!allowed.includes(req.method)) return json(res, 405, { error: `Use ${allowed.join(' or ')} here.` }), true
    if (req.method === 'GET') return json(res, 200, { runs: readLog(file), limits: { ...LOG_LIMITS } }), true
    if (req.headers.origin && !originAllowed(req.headers.origin, port)) return json(res, 403, { error: 'Cross-origin request refused.' }), true
    try {
      if (!id) return json(res, 200, clearLog(file)), true
      const out = removeRun(id, file)
      return json(res, out.error ? out.status : 200, out.error ? { error: out.error } : out), true
    } catch {
      return json(res, 500, { error: 'The log could not be changed. Try again.' }), true
    }
  }
}
