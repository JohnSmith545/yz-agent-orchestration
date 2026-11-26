// The Learn page's routes (#/learn, public/learn-page.js), made by makeLearnRoute and mounted by server.mjs through
// learn-wiring.mjs, which binds the real readers:
//
//   GET  /api/learn                  { settings, running, lastRunAt, remind, runs (newest first), verdicts: { due,
//                                    changes }, retroBusy }: the page's whole state
//   POST /api/learn/run              start ONE Learn run in the background: 202 { ok, running }; 409 while one runs;
//                                    403 when learn.enabled is false. The page polls GET until `running` is null.
//   POST /api/learn/weekly           the weekly run on page open: starts one only when learn.weekly is true and the newest
//                                    run (good or not) is 7 days old or more: { started, why? }
//   POST /api/learn/runs/<id>/<n>    { do: accept | reject, text?, reason? } one proposal. Accept writes an agent rule
//                                    through the rules path (agent-rules-routes.mjs rulesPut, marked `learn`, linked to
//                                    the proposal); `text` is Edit then accept. A settings proposal is only marked: the
//                                    user applies it by hand. Reject keeps the optional reason for the next pack.
//   POST /api/learn/retro/<flow>     Write the retrospective of one finished flow (learn-retro.mjs)
//   POST /api/learn/changes/<id>     { do: keep | wait | revert } a rule change's verdict (learn-verdicts.mjs); Revert
//                                    saves through the rules path, marked `revert`
//
// Rules this file keeps:
// - ⚠️ Every POST needs the page's OWN Origin, PRESENT (local-origin.mjs), like the user's own routes in
//   factory-routes.mjs: what Accept and Revert save is printed to every agent at the start of every request.
// - Ids are checked before any path is built: a run id (learn-runs.mjs isRunId), a flow slug, a change id.
// - ONE Learn run at a time (409), its own busy flag: a retrospective may run beside it (its own queue).
// - A model never writes a rule, a flow or a setting by itself: the run only proposes; the user's Accept saves.
//   Learn never writes config.json: a settings proposal is text.
// - The run: script.mjs's clean run with the LEARN turn (learn.model, Opus by default, at high effort), spend kind
//   `learn`. The pack (learn-pack.mjs) goes on stdin; the answer is checked (learn-proposals.mjs); the whole run is
//   kept (learn-runs.mjs), a failed one too, with its error and cost.

import { originAllowed } from './local-origin.mjs'
import { LEARN_SYSTEM } from './learn-prompts.mjs'
import { parseProposals } from './learn-proposals.mjs'
import { runOnce } from './learn-retro.mjs'
import { appendRun, findRun, isRunId, lastRunAt, listRuns, newRunId, rejectedIdeas, setProposal } from './learn-runs.mjs'
import { revertBody } from './learn-verdicts.mjs'
import { generate as realGenerate } from './script.mjs'

const DAY = 86_400_000
const REMIND_DAYS = 7
const BODY_MAX = 20_000
const RULE_MAX = 300
const REASON_MAX = 300
const RUNS_SHOWN = 12
const SLUG = /^[a-z0-9-]+$/
const CHANGE_ID = /^v[0-9a-f]{1,20}$/
const RUN_PATH = /^\/api\/learn\/runs\/([^/]{1,40})\/(\d{1,2})$/
const RETRO_PATH = /^\/api\/learn\/retro\/([^/]{1,120})$/
const CHANGE_PATH = /^\/api\/learn\/changes\/([^/]{1,40})$/
const BUSY = 'Learn is already running. Wait for it to finish; this page shows the result.'
const OFF = 'Learn is switched off (learn.enabled is false in config.json).'
const HAND = 'Apply it by hand: Learn never changes config.json.'

/** The Learn run's model turn: Opus 5.5 by default at high effort, its own prompt, session name and spend kind. */
export const learnTurn = model => ({
  system: LEARN_SYSTEM, effort: 'high', name: 'LEARN', kind: 'learn', model,
  messages: { refusal: 'The model chose not to review this week. Try again later.' },
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
    const b = raw ? JSON.parse(raw) : {}
    return b && typeof b === 'object' && !Array.isArray(b) ? b : {}
  } catch {
    throw Object.assign(new Error('The request was not valid JSON.'), { status: 400 })
  }
}

const decode = s => {
  try {
    return decodeURIComponent(s)
  } catch {
    return ''
  }
}
const line = s => String(s ?? '').replace(/\s+/g, ' ').trim()
const daysAgo = (at, now) => Math.floor((now - Date.parse(at)) / DAY)

/** The reminder line, or null when the last good run is under 7 days old. */
function remindLine(last, now) {
  if (!last) return 'Learn has not run yet. Run it to review the work and propose rule changes.'
  const d = daysAgo(last, now)
  return d >= REMIND_DAYS ? `The last Learn run was ${d} days ago. Run it to review the week.` : null
}

/**
 * `deps`: { port, settings(), generate?, now(), dir(), pack({ now, lastRunAt }), labels(), rulesNow() -> { label: [text] },
 * entryOf?(label) -> { spec, rules }, putRules(label, body, headers, { by, link }) -> { status, body }, retros (learn-retro.mjs
 * makeRetros), verdicts: { view(now), decide(id, what, { revert }) } }.
 */
export function makeLearnRoute({
  port, settings, generate = realGenerate, now = () => new Date(), dir, pack, labels, rulesNow, putRules, retros, verdicts,
  entryOf = label => ({ spec: '', rules: rulesNow()[label] || [] }), log = console.error,
}) {
  let running = null

  async function runLearn() {
    const at = now()
    running = { startedAt: at.toISOString() }
    const id = newRunId(at)
    const s = settings()
    let p
    try {
      p = pack({ now: at.getTime(), lastRunAt: lastRunAt(dir()) })
    } catch (err) {
      log(`learn: the evidence pack could not be built: ${err?.message || err}`)
      appendRun({ id, at: at.toISOString(), ok: false, error: 'The evidence could not be read, so nothing was sent.', cost: null, ms: 0, proposals: [], dropped: [] }, dir())
      running = null
      return
    }
    const out = await runOnce(generate, p.text, learnTurn(s.model))
    const parsed = out.ok ? parseProposals(out.text, { labels: labels(), flowIds: p.flowIds, rules: rulesNow(), rejected: rejectedIdeas(dir()) }) : null
    const error = !out.ok ? out.error : parsed.error || null
    try {
      appendRun({
        id, at: at.toISOString(), ok: !error, ...(error ? { error } : {}), cost: out.cost, ms: Math.max(0, now().getTime() - at.getTime()),
        window: p.window, read: p.read, left: p.left, nothing: parsed?.nothing ?? null, proposals: parsed?.proposals || [], dropped: parsed?.dropped || [],
      }, dir())
    } catch (err) {
      log(`learn: the run could not be saved: ${err?.message || err}`)
    }
    running = null
  }

  function start() {
    running = { startedAt: now().toISOString() }
    setImmediate(() => runLearn().catch(err => {
      log(`learn: the run failed: ${err?.message || err}`)
      running = null
    }))
  }

  function stateGet() {
    const at = now().getTime()
    const last = lastRunAt(dir())
    const s = settings()
    let v
    try {
      v = verdicts.view(at)
    } catch (err) {
      log(`learn: the verdicts could not be read: ${err?.message || err}`)
      v = { due: [], changes: [], error: 'The rule changes could not be read.' }
    }
    return {
      settings: { enabled: s.enabled, autoRetro: s.autoRetro, weekly: s.weekly, verdictAfterDays: s.verdictAfterDays, model: s.model, retroModel: s.retroModel },
      running, lastRunAt: last, remind: remindLine(last, at), runs: listRuns(dir(), RUNS_SHOWN), verdicts: v, retroBusy: !!retros.busy?.(),
    }
  }

  /** Accept or reject proposal `n` of run `id`. */
  function proposalPost(id, n, b, headers) {
    const found = isRunId(id) ? findRun(id, dir()) : null
    const p = found?.run.proposals?.find(x => x.n === n)
    if (!p) return [404, { error: 'There is no such proposal.' }]
    if (p.state !== 'open') return [409, { error: `That proposal was ${p.state} already.` }]
    const decidedAt = now().toISOString()
    if (b.do === 'reject') {
      const reason = line(b.reason)
      if (reason.length > REASON_MAX) return [400, { error: `Keep the reason to ${REASON_MAX} characters.` }]
      setProposal(id, n, { state: 'rejected', reason, decidedAt }, dir())
      return [200, { ok: true, state: 'rejected' }]
    }
    if (b.do !== 'accept') return [400, { error: 'Choose Accept or Reject.' }]
    const text = b.text === undefined ? p.rule : line(b.text)
    if (p.action !== 'remove' && (!text || text.length > RULE_MAX)) return [400, { error: `A rule is 1 to ${RULE_MAX} characters.` }]
    if (p.target === 'settings') {
      setProposal(id, n, { state: 'accepted', text, decidedAt, note: HAND }, dir())
      return [200, { ok: true, state: 'accepted', note: HAND }]
    }
    const current = [...(rulesNow()[p.target] || [])]
    let rules
    if (p.action === 'add') {
      if (current.includes(text)) return [409, { error: `${p.target} already has that rule.` }]
      rules = [...current, text]
    } else {
      const i = current.indexOf(p.old)
      if (i < 0) return [409, { error: `${p.target} no longer has the rule this changes: it was edited since. Nothing was saved.` }]
      rules = p.action === 'remove' ? current.filter((_, j) => j !== i) : current.map((r, j) => (j === i ? text : r))
    }
    const r = putRules(p.target, { rules }, headers, { by: 'learn', link: { run: id, n } })
    if (r.status !== 200) return [r.status, r.body]
    setProposal(id, n, { state: 'accepted', text: p.action === 'remove' ? p.old : text, decidedAt }, dir())
    return [200, { ok: true, state: 'accepted' }]
  }

  function changePost(id, b, headers) {
    if (!CHANGE_ID.test(id)) return [404, { error: 'There is no such rule change.' }]
    const revert = entry => {
      const rb = revertBody(entry, entryOf(entry.label))
      if (rb.error) return { status: 409, body: { error: rb.error } }
      const r = putRules(entry.label, rb.body, headers, { by: 'revert' })
      return r.status === 200 ? { status: 200, body: { ok: true, notes: rb.notes } } : r
    }
    const r = verdicts.decide(id, b.do, { revert })
    return [r.status, r.body]
  }

  return async function learnRoute(req, res, url) {
    const p = url.pathname
    if (p === '/api/learn') {
      if (req.method !== 'GET') return json(res, 405, { error: 'Use GET here.' }), true
      return json(res, 200, stateGet()), true
    }
    const run = RUN_PATH.exec(p)
    const retro = RETRO_PATH.exec(p)
    const change = CHANGE_PATH.exec(p)
    if (p !== '/api/learn/run' && p !== '/api/learn/weekly' && !run && !retro && !change) return false
    if (req.method !== 'POST') return json(res, 405, { error: 'Use POST here.' }), true
    if (!req.headers.origin || !originAllowed(req.headers.origin, port)) return json(res, 403, { error: 'This is done only from the dashboard page.' }), true
    let b
    try {
      b = await readBody(req)
    } catch (e) {
      return json(res, e.status || 400, { error: e.message }), true
    }
    if (p === '/api/learn/run') {
      if (!settings().enabled) return json(res, 403, { error: OFF }), true
      if (running) return json(res, 409, { error: BUSY }), true
      start()
      return json(res, 202, { ok: true, running }), true
    }
    if (p === '/api/learn/weekly') {
      const s = settings()
      const newest = listRuns(dir(), 1)[0]
      const why = !s.enabled ? 'off' : !s.weekly ? 'weekly is off' : running ? 'running' : newest && daysAgo(newest.at, now().getTime()) < REMIND_DAYS ? 'ran in the last 7 days' : ''
      if (why) return json(res, 200, { started: false, why }), true
      start()
      return json(res, 200, { started: true, running }), true
    }
    if (run) {
      const [status, body] = proposalPost(decode(run[1]), Number(run[2]), b, req.headers)
      return json(res, status, body), true
    }
    if (retro) {
      const id = decode(retro[1])
      if (!SLUG.test(id)) return json(res, 400, { error: 'Flow id must match /^[a-z0-9-]+$/.' }), true
      if (!settings().enabled) return json(res, 403, { error: OFF }), true
      const r = await retros.write(id, 'button')
      return json(res, r.status, r.body), true
    }
    const [status, body] = changePost(decode(change[1]), b, req.headers)
    return json(res, status, body), true
  }
}
