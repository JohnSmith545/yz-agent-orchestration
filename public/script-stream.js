// The SCRIPT page's side of POST /api/script/generate (script-routes.mjs): send the
// text, read the NDJSON answer as it arrives, hand each text delta on, and resolve the
// final line. Never rejects: a refused request, a network failure or a stream cut short
// resolves { type: 'error', error } with a calm message. test/script-stream.test.mjs
// runs it in a vm with a stub fetch.
//
//   ScriptStream.generate(text, { onDelta, onContext?, fetch?, signal? })
//       → { type: 'done', ok, stopReason, cost } | { type: 'error', error, cost? }
//       A `{ type: 'context', used, skipped }` line (what the Context panel sent, before the first
//       delta) goes to onContext({ used, skipped }), each list an array, never to onDelta.
//       `signal` aborts the fetch (Restart); the promise then resolves an error, which the page
//       drops because that run is over (script-state.js, run ids).
//   ScriptStream.splitLines(buffer) → { lines, rest }   pure: whole lines out, the tail kept
;(() => {
  const URL_PATH = '/api/script/generate'
  const CUT = 'The connection closed before the run finished. Try again.'
  const DOWN = 'Could not reach the dashboard. Check that it is still running, then try again.'

  function splitLines(buffer) {
    const parts = String(buffer ?? '').split('\n')
    const rest = parts.pop() ?? ''
    return { lines: parts.map(l => l.trim()).filter(Boolean), rest }
  }

  const parse = l => {
    try {
      return JSON.parse(l)
    } catch {
      return null
    }
  }

  async function generate(text, { onDelta = () => {}, onContext = () => {}, fetch = window.fetch?.bind(window), signal } = {}) {
    let res
    try {
      res = await fetch(URL_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal })
    } catch {
      return { type: 'error', error: DOWN }
    }
    if (!res.ok) {
      let j = {}
      try {
        j = await res.json()
      } catch {
        /* no JSON body */
      }
      return { type: 'error', error: j?.error || `The dashboard refused the request (${res.status}).` }
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let final = null
    const take = l => {
      const o = parse(l)
      if (!o) return
      if (o.type === 'delta' && typeof o.text === 'string') onDelta(o.text)
      else if (o.type === 'context') onContext({ used: Array.isArray(o.used) ? o.used : [], skipped: Array.isArray(o.skipped) ? o.skipped : [] })
      else if (o.type === 'done' || o.type === 'error') final = o
    }
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const { lines, rest } = splitLines(buf)
        buf = rest
        lines.forEach(take)
      }
      buf += decoder.decode()
      if (buf.trim()) take(buf.trim())
    } catch {
      return final || { type: 'error', error: CUT }
    }
    return final || { type: 'error', error: CUT }
  }

  window.ScriptStream = { generate, splitLines }
})()
