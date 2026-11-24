// The SCRIPT Generator's context routes (#/script, the Context panel, public/script-context.js), and the
// gatherer the generate route (script-routes.mjs) calls when the user presses Generate.
//
//   GET    /api/script/context              { orchestration: { on, chars, text },
//                                              session: { on: <label or null>, choices: [{ label, state }], max },
//                                              notes: [{ id, title, text, on, chars, updatedAt }], total, limits }
//   PUT    /api/script/context              { orchestration?: boolean, session?: <label or null> } -> the GET view
//   POST   /api/script/context/notes        { title, text } -> 201 { note }
//   PUT    /api/script/context/notes/<id>   { title?, text?, on? } -> { note }
//   DELETE /api/script/context/notes/<id>   -> { ok: true }
//
// Rules this file keeps:
// - Every write checks the page's own Origin first (local-origin.mjs): 403 for another site, before anything is
//   read or written. Errors are { error: "<plain sentence>" } with 400, 404, 405, 413 or 403.
// - The store is script-context.mjs (validated, atomic). `file` is injected so tests never touch data/.
// - `total` is what would be attached now from the brief and the notes that are on. The live session is read only
//   at Generate time (it changes by the second), so it is not counted; `session.max` says how much it can add.
// - A chosen session that is not running stays in `choices` as "not running", so the panel can show the choice.
// - The brief and the session list are injected by server.mjs (`brief()`, `sessions()`), as other routes get
//   their deps. A failing session list answers no choices, never an error.

import { originAllowed } from './local-origin.mjs'
import { addNote, CONTEXT_FILE, editNote, LIMITS, readContext, removeNote, setOptions, updateContext } from './script-context.mjs'
import { sessionPart } from './script-session.mjs'

const BASE = '/api/script/context'
const NOTES = `${BASE}/notes`
const NOTE = /^\/api\/script\/context\/notes\/([a-z0-9-]{1,40})$/
const BODY_MAX = 256_000 // a 20,000-character note, JSON-escaped, with room to spare
export const BRIEF_TITLE = 'Your orchestration'

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

const noteView = n => ({ id: n.id, title: n.title, text: n.text, on: n.on, chars: n.text.length, updatedAt: n.updatedAt })

async function briefText(brief) {
  try {
    return { text: String((await brief()) ?? '') }
  } catch {
    return { error: 'It could not be written just now.' }
  }
}

/** The running sessions as [{ label, state }], once per label; [] when they cannot be listed. */
async function choicesOf(sessions) {
  try {
    const seen = new Set()
    const out = []
    for (const s of (await sessions()) || []) {
      if (typeof s?.label !== 'string' || seen.has(s.label)) continue
      seen.add(s.label)
      out.push({ label: s.label, state: String(s.state || 'idle') })
    }
    return out
  } catch {
    return []
  }
}

/**
 * `gather()` -> { parts: [{ title, text, keep? }], skipped: [{ title, why }] }: the brief when it is on, the chosen
 * session's latest talk, then the notes that are on, oldest first. It never throws.
 */
export function makeContextGatherer({ file = CONTEXT_FILE, brief = () => '', sessions = async () => [] } = {}) {
  return async function gather() {
    const ctx = readContext(file)
    const parts = []
    const skipped = []
    if (ctx.orchestration) {
      const b = await briefText(brief)
      if (b.error) skipped.push({ title: BRIEF_TITLE, why: b.error })
      else parts.push({ title: BRIEF_TITLE, text: b.text })
    }
    if (ctx.session) {
      const s = await sessionPart(ctx.session, { sessions })
      if (s.part) parts.push(s.part)
      else skipped.push(s.skipped)
    }
    for (const n of ctx.notes) if (n.on) parts.push({ title: n.title, text: n.text })
    return { parts, skipped }
  }
}

/** `route(req, res, url)` answers the context paths and resolves true, or false for anything else. */
export function makeScriptContextRoute({ port, file = CONTEXT_FILE, brief = () => '', sessions = async () => [] }) {
  async function view() {
    const ctx = readContext(file)
    const b = await briefText(brief)
    const text = b.text ?? ''
    const choices = await choicesOf(sessions)
    if (ctx.session && !choices.some(c => c.label === ctx.session)) choices.push({ label: ctx.session, state: 'not running' })
    const notes = ctx.notes.map(noteView)
    const total = (ctx.orchestration ? text.length : 0) + notes.filter(n => n.on).reduce((s, n) => s + n.chars, 0)
    const { titleMax, textMax, notesMax, totalMax, sessionMax } = LIMITS
    return {
      orchestration: { on: ctx.orchestration, chars: text.length, text },
      session: { on: ctx.session, choices, max: sessionMax },
      notes,
      total,
      limits: { titleMax, textMax, notesMax, totalMax, sessionMax },
    }
  }

  /** Run one change through the store: its error as a status, else `ok(result)`. */
  const change = (res, fn, ok) => {
    const out = updateContext(fn, file)
    if (out?.error) return json(res, out.status || 400, { error: out.error })
    return ok(out)
  }

  return async function scriptContextRoute(req, res, url) {
    const p = url.pathname
    const id = NOTE.exec(p)?.[1]
    if (p !== BASE && p !== NOTES && !id) return false
    const allowed = p === BASE ? ['GET', 'PUT'] : p === NOTES ? ['POST'] : ['PUT', 'DELETE']
    if (!allowed.includes(req.method)) return json(res, 405, { error: `Use ${allowed.join(' or ')} here.` }), true
    if (req.method === 'GET') return json(res, 200, await view()), true
    // Another site must not change what the user's own runs are told.
    if (req.headers.origin && !originAllowed(req.headers.origin, port)) return json(res, 403, { error: 'Cross-origin request refused.' }), true
    let body = {}
    if (req.method !== 'DELETE') {
      try {
        body = await readBody(req)
      } catch (e) {
        return json(res, e.status || 400, { error: e.message }), true
      }
    }
    try {
      if (p === BASE) await change(res, c => setOptions(c, body), async () => json(res, 200, await view()))
      else if (p === NOTES) change(res, c => addNote(c, body ?? {}), out => json(res, 201, { note: noteView(out.note) }))
      else if (req.method === 'PUT') change(res, c => editNote(c, id, body ?? {}), out => json(res, 200, { note: noteView(out.note) }))
      else change(res, c => removeNote(c, id), () => json(res, 200, { ok: true }))
    } catch {
      json(res, 500, { error: 'The context could not be saved. Try again.' })
    }
    return true
  }
}
