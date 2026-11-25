// The Standup creator's side of POST /api/standup/generate (standup-routes.mjs): send the mode, read the NDJSON
// answer as it arrives, and resolve the final line. The same shape as the prompt generator's stream
// (script-stream.js, whose splitLines it uses), plus the facts line that comes first. Never rejects.
//
//   StandupStream.generate(mode, { onFacts?, onDelta?, fetch?, signal? })
//       → { type: 'done', ok, stopReason?, cost, run } | { type: 'error', error, cost?, run? }
//       `onFacts({ mode, window, read, left, counts, ticketListAt, skipped })` hears the facts line once.
;(() => {
  const URL_PATH = '/api/standup/generate'
  const CUT = 'The connection closed before the stand-up was finished. Try again.'
  const DOWN = 'Could not reach the dashboard. Check that it is still running, then try again.'

  const parse = l => {
    try {
      return JSON.parse(l)
    } catch {
      return null
    }
  }

  async function generate(mode, { onFacts = () => {}, onDelta = () => {}, fetch = window.fetch?.bind(window), signal } = {}) {
    let res
    try {
      res = await fetch(URL_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }), signal })
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
      if (o.type === 'facts') onFacts(o)
      else if (o.type === 'delta' && typeof o.text === 'string') onDelta(o.text)
      else if (o.type === 'done' || o.type === 'error') final = o
    }
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const { lines, rest } = window.ScriptStream.splitLines(buf)
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

  window.StandupStream = { generate }
})()
