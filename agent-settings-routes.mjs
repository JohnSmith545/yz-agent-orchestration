// The agent settings routes, behind the agent window on the Agents page (public/agent-window.js); server.mjs mounts
// them with makeAgentSettingsRoute. The store is agent-settings.mjs.
//
//   GET    /api/agents/settings                  { agents: { "<label>": { role, model, effort, fixed, files: [{ id,
//                                                  title, kind, name, chars, on, addedAt }], chars, updatedAt } },
//                                                  changes: { "<label>": [{ at, text }] }, models, efforts, fixed,
//                                                  limits, chat: { model } } for every agent of the graph now
//   PUT    /api/agents/settings/<label>           { model?, effort? } (null clears one) -> { ok, label, agent, changes }
//   POST   /api/agents/files/<label>              { title, text, kind: file|note, name? } -> 201 { ok, label, agent,
//                                                  changes, file }
//   PUT    /api/agents/files/<label>/<id>         { on: boolean } -> { ok, label, agent, changes }
//   DELETE /api/agents/files/<label>/<id>         -> { ok, label, agent, changes }
//
// Rules this file keeps:
// - ⚠️ Every write needs the page's OWN Origin, never a missing one (local-origin.mjs): what is saved here is printed
//   to the agent at the start of its work, so only the dashboard page may write it. 403 before anything is read.
// - The label (URL-encoded in the path) must be an agent of the graph now: 404 otherwise; the id is checked against
//   its pattern before anything is looked up. Errors are { error: "<one plain sentence>" } with 400, 403, 404, 405
//   or 413. The planner and Security refuse a model change (always Opus at high effort), the chat agent too (config).
// - Every save that changed something adds one line to the change log, AFTER the store write succeeded.
// - `file`, `logFile` and `config` are injected, so tests never touch data/ or config.json.

import { originAllowed } from './local-origin.mjs'
import {
  addFile, appendSettingsLog, applyModel, checkFile, checkModel, EFFORTS, entryOf, entryView, FILE_LIMITS, FIXED, MODELS,
  readAgentSettings, readSettingsLog, removeFile, setFileOn, SETTINGS_FILE, SETTINGS_LOG, settingsChangesOf, writeAgentSettings,
} from './agent-settings.mjs'
import { CONFIG } from './config.mjs'
import { pipelineGraph } from './pipeline.mjs'

const SETTINGS = /^\/api\/agents\/settings(?:\/([^/]+))?$/
const FILES = /^\/api\/agents\/files\/([^/]+)(?:\/([^/]+))?$/
const FILE_ID = /^[A-Za-z0-9-]{1,40}$/
/** A 20,000-character text, JSON-escaped, with room to spare. */
const BODY_MAX = 256_000
const CHANGES_SHOWN = 10

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

const decode = s => {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

export function makeAgentSettingsRoute({ port = CONFIG.port, config = CONFIG, file = SETTINGS_FILE, logFile = SETTINGS_LOG, now } = {}) {
  const opts = now ? { now } : {}
  /** The agent nodes of the graph now, by label. */
  const agents = () => new Map(pipelineGraph(config).nodes.filter(n => n.kind === 'agent').map(n => [n.label, n]))
  const changesOf = label => settingsChangesOf(readSettingsLog(logFile), label, CHANGES_SHOWN)
  const answer = (label, role, store) => ({ ok: true, label, agent: { role, ...entryView(entryOf(store, label), role) }, changes: changesOf(label) })

  function view() {
    const store = readAgentSettings(file)
    const lines = readSettingsLog(logFile)
    const out = {}
    const changes = {}
    for (const [label, node] of agents()) {
      out[label] = { role: node.role, ...entryView(entryOf(store, label), node.role) }
      changes[label] = settingsChangesOf(lines, label, CHANGES_SHOWN)
    }
    return { agents: out, changes, models: MODELS, efforts: EFFORTS, fixed: FIXED, limits: FILE_LIMITS, chat: { model: String(config?.factory?.chat?.model || '') } }
  }

  /** Write the store and log the change (only when something changed). */
  function save(store, label, text) {
    if (!text) return
    writeAgentSettings(store, file)
    appendSettingsLog({ at: entryOf(store, label).updatedAt || new Date().toISOString(), label, text }, logFile)
  }

  return async function route(req, res, url) {
    const p = url.pathname
    const s = SETTINGS.exec(p)
    const f = s ? null : FILES.exec(p)
    if (!s && !f) return false
    try {
      if (s && s[1] === undefined) {
        if (req.method !== 'GET') return json(res, 405, { error: 'Read the settings with GET.' }), true
        return json(res, 200, view()), true
      }
      if (!originAllowed(req.headers.origin, port)) return json(res, 403, { error: 'Agent settings are changed only from the dashboard page.' }), true
      const label = decode((s || f)[1])
      const node = label === null ? null : agents().get(label)
      if (!node) return json(res, 404, { error: `There is no agent called ${label ?? 'that'}.` }), true
      const store = readAgentSettings(file)

      if (s) {
        if (req.method !== 'PUT') return json(res, 405, { error: 'Change the model with PUT.' }), true
        const change = checkModel(await readBody(req), node.role)
        if (change.error) return json(res, 400, { error: change.error }), true
        const r = applyModel(store, label, change, opts)
        save(r.store, label, r.text)
        return json(res, 200, answer(label, node.role, r.store)), true
      }

      const id = f[2]
      if (id === undefined) {
        if (req.method !== 'POST') return json(res, 405, { error: 'Add a file or a note with POST.' }), true
        const item = checkFile(await readBody(req), entryOf(store, label))
        if (item.error) return json(res, 400, { error: item.error }), true
        const r = addFile(store, label, item, opts)
        save(r.store, label, r.text)
        return json(res, 201, { ...answer(label, node.role, r.store), file: { ...r.file, text: undefined, chars: r.file.text.length } }), true
      }
      if (!FILE_ID.test(id)) return json(res, 404, { error: `There is no such file or note for ${label}.` }), true
      let r
      if (req.method === 'PUT') {
        const b = await readBody(req)
        if (typeof b?.on !== 'boolean') return json(res, 400, { error: 'Say whether it is on or off.' }), true
        r = setFileOn(store, label, id, b.on, opts)
      } else if (req.method === 'DELETE') r = removeFile(store, label, id, opts)
      else return json(res, 405, { error: 'Switch a file with PUT, or remove it with DELETE.' }), true
      if (r.error) return json(res, 404, { error: r.error }), true
      save(r.store, label, r.text)
      return json(res, 200, answer(label, node.role, r.store)), true
    } catch (err) {
      return json(res, err?.status || 500, { error: err?.status ? err.message : 'The settings could not be saved just now.' }), true
    }
  }
}
