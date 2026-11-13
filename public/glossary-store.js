// The glossary on the page: ONE client store over GET /api/glossary, shared by
// the hover card (term-card.js), the selection bubble (explain.js) and the
// Glossary page (glossary-page.js). The server merges the built-in words with
// the saved ones (learned, from the agent, yours) and keys each by terms.mjs
// normalise; Terms.normalise is its page copy, so any spelling finds its entry.
//
//   get(word) / has(word)  the entry ({ key, term, short, more, source, at, seenIn }) or null
//   all()                  every entry, sorted by key
//   stateOf(word)          '' (not loaded yet), 'known', 'learning' or 'unknown'
//   refresh()              load again; every onChange(fn) runs after it
//   save({ term, short })  your own wording (POST /api/glossary/term), then a refresh
//   remove(key)            a saved entry (POST /api/glossary/remove), then a refresh
//   autoLearn(flow)        learn the flow's unknown marked words, see below
//   paint(root?)           mark each chip still unknown (data-state), for the pulsing underline
//
// ═══ LEARNING AUTOMATICALLY ═══ When an opened flow has marked words the
// glossary does not know (flow.derived.terms, known: false), the page asks the
// server ONCE to learn them (POST /api/glossary/learn: one small tool-less
// model turn for every unknown word of the flow, a fraction of a cent, capped
// per day by the server). Debounced 1.5 s, never two calls at a time, and at
// most once per flow per 10 minutes for the life of the page, whatever the
// outcome; flows.js calls autoLearn on every draw of the opened flow, so a poll
// that brings new unknown words learns them too (after the 10 minutes). A poll
// that shows a word the server knows and this page does not (an agent answered
// Ask the agent with `term`) reloads the store once, a second later.
;(() => {
  const DEBOUNCE_MS = 1500
  const AGAIN_MS = 10 * 60_000
  const REFRESH_MS = 1000 // a word an agent defined: reload the store this long after the poll that shows it
  const N = s => (window.Terms ? window.Terms.normalise(s) : String(s ?? '').trim().toLowerCase())
  let entries = new Map()
  let loaded = false
  const listeners = []
  const learning = new Set() // keys waiting on a learn call
  const queue = new Map() // flowId -> its unknown keys, in the order asked
  const tried = new Map() // flowId -> when its last learn call started
  let timer = 0
  let refreshTimer = 0
  let running = false

  async function post(url, body) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const j = await r.json().catch(() => ({}))
      return r.ok ? j || {} : { error: j?.error || `Failed (${r.status})` }
    } catch (err) {
      return { error: err?.message || 'failed' }
    }
  }

  function changed() {
    paint()
    for (const fn of listeners) {
      try { fn() } catch {}
    }
  }

  async function refresh() {
    try {
      const r = await fetch('/api/glossary')
      const j = await r.json()
      if (r.ok && Array.isArray(j?.terms)) {
        entries = new Map(j.terms.filter(e => e && typeof e.key === 'string' && typeof e.short === 'string').map(e => [e.key, e]))
        loaded = true
      }
    } catch {}
    changed()
  }

  const get = word => entries.get(N(word)) || null
  const has = word => entries.has(N(word))
  const all = () => [...entries.values()].sort((a, b) => a.key.localeCompare(b.key))
  const stateOf = word => (has(word) ? 'known' : learning.has(N(word)) ? 'learning' : loaded ? 'unknown' : '')

  async function save({ term, short, more }) {
    const body = { term, short }
    if (more) body.more = more
    const r = await post('/api/glossary/term', body)
    if (r.error) return r
    if (r.entry?.key) entries.set(r.entry.key, r.entry)
    changed()
    await refresh()
    return r
  }

  async function remove(key) {
    const r = await post('/api/glossary/remove', { key })
    if (!r.error) await refresh()
    return r
  }

  /**
   * A word the server knows but this page does not (an agent answered Ask the agent with `term` since the last
   * load): reload once, debounced, so its chip and card catch up without a reload of the page.
   */
  function catchUp(flow) {
    if (!loaded || !(flow.derived?.terms || []).some(t => t && t.known === true && t.key && !has(t.key))) return
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => { refreshTimer = 0; void refresh() }, REFRESH_MS)
  }

  function autoLearn(flow) {
    const id = flow?.id
    if (!id) return false
    catchUp(flow)
    const keys = (flow.derived?.terms || []).filter(t => t && t.known === false && t.key && !has(t.key)).map(t => N(t.key))
    if (!keys.length || queue.has(id)) return false
    const last = tried.get(id)
    if (last != null && Date.now() - last < AGAIN_MS) return false
    queue.set(id, keys)
    for (const k of keys) learning.add(k)
    paint()
    clearTimeout(timer)
    timer = setTimeout(drain, DEBOUNCE_MS)
    return true
  }

  /** One learn call at a time, in the order asked; a call that fails or finds the server busy just ends. */
  async function drain() {
    timer = 0
    if (running) return // the running loop picks the queue up
    running = true
    try {
      while (queue.size) {
        const [id, keys] = queue.entries().next().value
        queue.delete(id)
        tried.set(id, Date.now())
        await post('/api/glossary/learn', { flowId: id })
        void window.Spend?.refresh?.() // the turn cost something: the rail chip catches up now
        await refresh()
        for (const k of keys) learning.delete(k)
        changed()
      }
    } finally {
      running = false
    }
  }

  /** Each chip still unknown carries data-state (learning pulses, unknown is a quiet dashed line); known ones none. */
  function paint(root = window.document) {
    if (!root?.querySelectorAll) return
    for (const d of root.querySelectorAll('dfn.t-chip')) {
      const s = stateOf(d.dataset.term)
      if (s === 'learning' || s === 'unknown') d.setAttribute('data-state', s)
      else d.removeAttribute('data-state')
    }
  }

  // New chips (a poll, a tab switch) are painted as they arrive; the tests have no observer.
  if (typeof MutationObserver === 'function' && window.document?.body) {
    let queued = false
    new MutationObserver(() => {
      if (queued) return
      queued = true
      setTimeout(() => { queued = false; paint() }, 0)
    }).observe(window.document.body, { childList: true, subtree: true })
  }

  window.Glossary = {
    get, has, all, stateOf, refresh, save, remove, autoLearn, paint,
    get loaded() { return loaded },
    onChange(fn) {
      listeners.push(fn)
      return () => listeners.splice(listeners.indexOf(fn) >>> 0, 1)
    },
  }
  if (typeof fetch === 'function') window.Glossary.ready = refresh()
})()
