// HTTP routes for the Factory page, its chat, and the flows notebook. Kept out
// of server.mjs, which is already long. Returns true when it answered the request.
//
//   GET  /api/factory?c=<collection>   tickets, marks, refresh status
//   POST /api/factory/refresh?c=<id>   refresh that collection's ticket source now (default: the first)
//   POST /api/factory/mark             { id, review?, verdict?, note? }
//   GET  /api/chat                     status + transcript
//   GET  /api/chat/events              Server-Sent Events
//   POST /api/chat/send                { text }
//   POST /api/chat/stop
//   POST /api/chat/new                 { fork?: true }: true starts the next chat from forkFrom, once
//   GET  /api/flows[?open=1&waiting=1&agent=X&ticket=T&archived=1]   { flows, invalid, counts: { archived, deleted } }:
//                                      archived flows left out, or with archived=1 only them
//   GET  /api/flows/<id>               the flow with `derived` (an archived one too: a direct link keeps working)
//                                      Both carry each flow's `route` (stored, or inferred: true) and `progress`, its
//                                      steps' states (flow-route.mjs withRoute), as /api/pipeline and /api/qa do
//   POST /api/flows/<id>/archive       { archived }; POST /api/flows/<id>/delete { confirm? }: trash-routes.mjs
//   GET  /api/archive; POST /api/trash/<id>/restore; POST /api/trash/<id>/purge: the flow archive (trash-routes.mjs)
//   GET /api/flows/<id> on a deleted id: the flow, read-only, with deletedAt; any other flow route on it: 404
//   { error: '<id> was deleted: it is in the flow archive.' }
//   POST /api/flows/<id>/answer        { node, answer, note? }, then relay.queue
//   POST /api/flows/<id>/verify        { node, verified }, the user's tick
//   POST /api/flows/<id>/status        { node, status } (after an ask: then relay.queueStatus), or { status } for the flow
//   POST /api/flows/<id>/drop          flow status `dropped`
//   POST /api/flows/<id>/deliver       { node }: relay.deliverNow, returns { ok, error? }
//   GET  /api/human; POST /api/flows/<id>/hand { step, done }; POST /api/flows/<id>/request-hand { note? };
//   POST /api/tickets/<id>/request-hand { note? }: Human review and the by-hand steps (human-routes.mjs)
//   POST /api/flows/<id>/senior-release: the user finishes a flow Senior holds without its review (human-routes.mjs)
//   POST /api/flows/<id>/request-tests { note? ≤ 500 }: stamps output.requestedAt, then relay.queueRequest,
//                                      { ok, via: 'relay', requestedAt }; the chat agent's own flow: { ok, via: 'chat', text }
//   GET  /api/flows/<id>/pr            { merge, pr, ready, facts }: what Send would do (pr-routes.mjs)
//   POST /api/flows/<id>/pr            { pin, confirm: { head, sha, digest } }: push the reviewed commit and open the
//                                      pull request; needs the send PIN and the page's own Origin (pr-routes.mjs prSend)
//   POST /api/flows/<id>/pr/refresh    the pull request's state and checks, stored on the flow
//   GET  /api/settings                 the Settings page: a read-only summary and the send settings now (settings-routes.mjs)
//   POST /api/settings/send            { enabled?, bases? }; POST /api/settings/pin { next, current? | reset? }: the page's
//                                      own Origin, and a system window confirms anything that could let a page driver send
//   GET  /api/pipeline                 { graph, tickets, builtAt }: the orchestration and where each flow stands (pipeline-routes.mjs)
//   GET  /api/qa[?status=passed]       { qa, flows, remotes, builtAt }: what QA recorded, with report text and links (pipeline-routes.mjs)
//   GET  /api/score[?days=7|30|all]    the pipeline scorecard: precision, recall, F-score, accuracy, correctness (score-routes.mjs)
//   GET  /api/log[?days&cell&kind]     { events, total, window, builtAt }: the orchestration log, each event with its score cell (score-routes.mjs)
//   POST /api/flows/<id>/rework        send a QA failure back to its producer again after it was not delivered (qa-rework.mjs)
//   GET  /api/agents/rules             { agents, limits }: the user's specification and rules for each agent (agent-rules-routes.mjs)
//   PUT  /api/agents/rules/<label>     { spec?, rules? }: the page's own Origin only; 404 a label not in the graph, 400 a limit
//   GET  /api/commit?sha=<sha>         one commit, see commit-diff.mjs
//   GET  /evidence/<flow>/<file>       a screenshot or log an agent attached; a QA report (qa-<n>-report.md) as plain text
//   POST /api/explain                  { text }: the glossary first ({ text, cost: 0, from: 'glossary', entry }), else one cheap
//                                      headless turn ({ text, cost, from: 'model', saved }) or 502 { error } (glossary-routes.mjs)
//   GET  /api/glossary                 { terms }: the shipped and saved words, merged (glossary-routes.mjs)
//   POST /api/glossary/learn           { flowId }: explain the flow's unknown marked words with one turn, or { busy: true }
//   POST /api/glossary/term            { term, short, more? }: the user's own wording
//   POST /api/glossary/remove          { key }: a saved word (a built-in one is 400)
//   POST /api/flows/<id>/ask-term      { term, sentence? ≤ 300 }: { ok, via: 'relay' } (relay.queueQuestion), or the chat
//                                      agent's own flow: { ok, via: 'chat', text }
//   GET  /api/since?t=<ISO>            Home's Since you were away digest (since.mjs); a future or bad t is empty
//   GET  /api/spend                    { today, byKind, recent }: what the dashboard's own turns cost today (spend.mjs), unrounded
//
// `deps` is { git, gh?, push?, pr?, port?, fetched?, relay, explain?, learn?, getStatus }: server.mjs's
// git, gh and push runners, the Send settings and the port (config.mjs, by default) and when the server
// last fetched a remote, the answer relay, the explainer and the glossary learner (explain.mjs's and
// learn.mjs's by default; tests pass stubs) and the cached /api/status build (for the Since
// digest's commits).
// Every route that changes a flow re-reads the file first and writes it through
// writeFlow, so it never works on a copy from an earlier request. A mutator that
// throws (bad answer, unknown node) becomes a 400 { error } and nothing is written.

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import { rulesGet, rulesPut } from './agent-rules-routes.mjs'
import { chatEvents, chatLog, chatNew, chatSend, chatStop } from './chat.mjs'
import { commitDiff } from './commit-diff.mjs'
import { CONFIG, CONFIG_FILE, prNow } from './config.mjs'
import { confirmNative } from './native-confirm.mjs'
import { settingsGet, settingsPin, settingsSend } from './settings-routes.mjs'
import { explain as explainTurn } from './explain.mjs'
import { buildFactory, collections, readSource, refreshSource } from './factory.mjs'
import { setMark, updateState } from './factory-state.mjs'
import { handRequestRoute, handTickRoute, humanGet, seniorReleaseRoute, ticketHandRoute } from './human-routes.mjs'
import { askTermRoute, explainRoute, learnRoute, listGlossary, removeRoute, termRoute } from './glossary-routes.mjs'
import { learnTerms } from './learn.mjs'
import { originAllowed } from './local-origin.mjs'
import { prGet, prRefresh, prSend } from './pr-routes.mjs'
import { applyAnswer, applyVerify, derive, EVIDENCE_DIR, FLOW_STATUS, followsAnAsk, listFlows, readFlow, setNodeStatus, validateFlow, writeFlow } from './flows.mjs'
import { withRoute } from './flow-route.mjs'
import { pipelineGraph } from './pipeline.mjs'
import { pipelineGet, qaGet } from './pipeline-routes.mjs'
import { reworkRetry } from './qa-rework.mjs'
import { logGet, scoreGet } from './score-routes.mjs'
import { requestText } from './relay.mjs'
import { sinceRoute } from './since.mjs'
import { readSpend } from './spend.mjs'
import { listTrash } from './trash.mjs'
import { archiveList, archiveRoute, deleteRoute, purgeRoute, restoreRoute, trashedFlow } from './trash-routes.mjs'

const SLUG = /^[a-z0-9-]+$/
/** /api/trash/<id>/restore and /api/trash/<id>/purge; the id is checked against SLUG before any disk access. */
const TRASH_PATH = /^\/api\/trash\/([^/]+)\/(restore|purge)$/
const SHA = /^[0-9a-f]{7,40}$/
/** /api/agents/rules and /api/agents/rules/<label> (the label URL-encoded; agent-rules-routes.mjs checks it against the graph). */
const RULES_PATH = /^\/api\/agents\/rules(?:\/([^/]+))?$/
/** /api/flows/<id> and /api/flows/<id>/<action> (`pr/refresh` has two parts); the id is checked against SLUG before any disk access. */
const FLOW_PATH = /^\/api\/flows\/([^/]+)(?:\/([a-z-]+(?:\/[a-z-]+)?))?$/
/** The longest note the user may add to a request for test steps (it goes into a relay prompt). */
const NOTE_MAX = 500
/** The only files /evidence/ serves (the same list `flow evidence` accepts). */
const EVIDENCE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.pdf': 'application/pdf', '.txt': 'text/plain',
}
/**
 * The ONE Markdown file /evidence/ serves: a QA report as `flow qa` names it (tools/qa-cli.mjs), as plain text with
 * nosniff, so nothing in it is ever rendered or run. Any other .md, and every .html, stays a 404.
 */
const QA_REPORT = /^qa-\d+-report(?:-\d+)?\.md$/

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Send a glossary-routes.mjs handler's { status, body }. */
const send = (res, { status, body }) => json(res, status, body)

async function body(req) {
  let raw = ''
  for await (const c of req) {
    raw += c
    if (raw.length > 200_000) throw Object.assign(new Error('Body too large.'), { status: 413 })
  }
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    throw Object.assign(new Error('Bad JSON.'), { status: 400 })
  }
}

/**
 * A page on another site must not drive the local agents: a POST's Origin, when it has one, must be the
 * dashboard's own, compared with the fixed 127.0.0.1 and localhost names (local-origin.mjs), never with
 * the request's own Host header, which a rebinding site controls.
 */
const sameOrigin = (req, port) => !req.headers.origin || originAllowed(req.headers.origin, port)
/**
 * THE USER'S OWN ROUTES (QA round two B-F1): the by-hand tick (`hand`) and Finish without Senior (`senior-release`) are
 * what the user does on the page, and a browser always sends Origin on a POST. So these need the header PRESENT and
 * the page's own: curl or a script with none is refused, where every other route still takes a missing Origin (agent
 * tools call some of them). This stops an accident, not a determined process on the same machine: such a process can
 * forge the header. That is why a release is always scored as slipped through (score.mjs): nobody reviewed the work,
 * whoever pressed it.
 */
const USER_ONLY = new Set(['hand', 'senior-release'])
const pageOrigin = (req, port) => !!req.headers.origin && originAllowed(req.headers.origin, port)

export async function factoryRoute(req, res, url, { git, gh, push, pr, port = CONFIG.port, fetched, relay, explain = explainTurn, learn = learnTerms, getStatus, settings, pipelineConfig = null } = {}) {
  const p = url.pathname
  const q = url.searchParams
  const post = req.method === 'POST'
  if (post && !sameOrigin(req, port)) return json(res, 403, { error: 'Cross-origin request refused.' }), true
  // the send settings as config.json says NOW (config.mjs prNow), unless a test passes its own
  const send$ = { git, gh, push, pr: pr ?? prNow(), port, fetched, config: pipelineConfig } // the server's: Send waits for Security too (pr-routes.mjs)
  const settings$ = { configFile: CONFIG_FILE, confirm: confirmNative, prNow, port, ...settings }
  const flowPath = FLOW_PATH.exec(p)
  const [, id, action] = flowPath || []
  try {
    if (p === '/api/factory' && !post) return json(res, 200, await buildFactory(q.get('c'))), true
    if (p === '/api/factory/refresh' && post) return json(res, 200, await refreshSource(q.get('c') || collections()[0]?.id || '')), true
    if (p === '/api/factory/mark' && post) {
      const b = await body(req)
      return json(res, 200, updateState(s => setMark(s, b.id, { review: b.review, verdict: b.verdict, note: b.note, by: 'you' }))), true
    }
    if (p === '/api/chat' && !post) return json(res, 200, chatLog()), true
    if (p === '/api/chat/events' && !post) return chatEvents(req, res), true
    if (p === '/api/chat/send' && post) return json(res, 200, await chatSend((await body(req)).text)), true
    if (p === '/api/chat/stop' && post) return json(res, 200, chatStop()), true
    if (p === '/api/chat/new' && post) return json(res, 200, chatNew({ fork: (await body(req))?.fork === true })), true

    if (p === '/api/flows' && !post) return json(res, 200, flowList(q)), true
    if (flowPath && !SLUG.test(id)) return json(res, 400, { error: 'Flow id must match /^[a-z0-9-]+$/.' }), true
    const trashed = flowPath && trashedFlow(id, !action && !post)
    if (trashed) return send(res, trashed), true
    if (action === 'archive' && post) return send(res, archiveRoute(id, await body(req))), true
    if (action === 'delete' && post) return send(res, deleteRoute(id, await body(req), relay)), true
    if (p === '/api/archive' && !post) return send(res, archiveList()), true
    const [, trashId, trashAction] = TRASH_PATH.exec(p) || []
    if (trashId && !SLUG.test(trashId)) return json(res, 400, { error: 'Flow id must match /^[a-z0-9-]+$/.' }), true
    if (trashAction === 'restore' && post) return send(res, restoreRoute(trashId, relay)), true
    if (trashAction === 'purge' && post) return send(res, purgeRoute(trashId)), true
    if (flowPath && !action && !post) return showFlow(res, id), true
    if (action === 'answer' && post) return answer(res, id, await body(req), relay), true
    if (action === 'verify' && post) return verify(res, id, await body(req)), true
    if (action === 'status' && post) return status(res, id, await body(req), relay), true
    if (action === 'drop' && post) return changeFlow(res, id, f => ((f.status = 'dropped'), f)), true
    if (action === 'deliver' && post) return await deliver(res, id, await body(req), relay), true
    if (action === 'request-tests' && post) return requestTests(res, id, await body(req), relay), true
    if (post && USER_ONLY.has(action) && !pageOrigin(req, port)) return json(res, 403, { error: 'The user does this, only from the dashboard page.' }), true
    if (action === 'hand' && post) return send(res, handTickRoute(id, await body(req))), true
    if (action === 'senior-release' && post) return send(res, seniorReleaseRoute(id)), true
    if (action === 'request-hand' && post) return send(res, handRequestRoute(id, await body(req), relay)), true
    if (p === '/api/human' && !post) return send(res, humanGet()), true
    const ticketHand = /^\/api\/tickets\/([^/]+)\/request-hand$/.exec(p)
    if (ticketHand && post) return send(res, ticketHandRoute(decodeURIComponent(ticketHand[1]), await body(req), relay)), true
    if (action === 'ask-term' && post) return send(res, askTermRoute(id, await body(req), relay)), true
    if (action === 'pr' && !post) return send(res, await prGet(id, send$)), true
    if (action === 'pr' && post) return send(res, await prSend(id, await body(req), req.headers, send$)), true
    if (action === 'pr/refresh' && post) return send(res, await prRefresh(id, send$)), true
    if (action === 'rework' && post) return send(res, reworkRetry(id, relay)), true
    if (p === '/api/pipeline' && !post) return send(res, pipelineGet()), true
    const rules = RULES_PATH.exec(p)
    if (rules && rules[1] === undefined && req.method === 'GET') return send(res, rulesGet()), true
    if (rules && rules[1] !== undefined && req.method === 'PUT') return send(res, rulesPut(labelOf(rules[1]), await body(req), req.headers, { port })), true
    if (p === '/api/qa' && !post) return send(res, await qaGet(q.get('status') || '', { git })), true
    if (p === '/api/score' && !post) return send(res, scoreGet(q.get('days'))), true
    if (p === '/api/log' && !post) return send(res, logGet({ days: q.get('days'), cell: q.get('cell'), kind: q.get('kind') })), true
    if (p === '/api/commit' && !post) return await commit(res, q.get('sha'), git), true
    if (p.startsWith('/evidence/') && !post) return await evidence(res, p), true
    if (p === '/api/explain' && post) return send(res, await explainRoute(await body(req), explain)), true
    if (p === '/api/glossary' && !post) return send(res, listGlossary()), true
    if (p === '/api/glossary/learn' && post) return send(res, await learnRoute(await body(req), learn)), true
    if (p === '/api/glossary/term' && post) return send(res, termRoute(await body(req))), true
    if (p === '/api/glossary/remove' && post) return send(res, removeRoute(await body(req))), true
    if (p === '/api/settings' && !post) return send(res, settingsGet(settings$)), true
    if (p === '/api/settings/send' && post) return send(res, await settingsSend(await body(req), req.headers, settings$)), true
    if (p === '/api/settings/pin' && post) return send(res, await settingsPin(await body(req), req.headers, settings$)), true
    if (p === '/api/since' && !post) return json(res, 200, await sinceRoute(q.get('t'), { git, getStatus, listFlows, collections, readSource })), true
    if (p === '/api/spend' && !post) return json(res, 200, readSpend()), true
  } catch (e) {
    return json(res, e.status || 400, { error: e.message }), true
  }
  return false
}

/** A URL-encoded label, or '' when it does not decode (agent-rules-routes.mjs then answers 404). */
function labelOf(raw) {
  try {
    return decodeURIComponent(raw)
  } catch {
    return ''
  }
}

// ═══ Flow handlers ═══

function filterOf(q) {
  return { open: q.get('open') === '1', waiting: q.get('waiting') === '1', agent: q.get('agent') || undefined, ticket: q.get('ticket') || undefined, archived: q.get('archived') === '1' }
}

/**
 * The list, plus the counts behind the page's `Flow archive · N` link (archived and deleted), so it needs no second
 * request. ⚠️ The deleted count never turns the list into an error: deleted flows that cannot be read leave it out.
 */
function flowList(q) {
  const tally = {}
  const { flows, invalid } = listFlows(filterOf(q), tally)
  const counts = { archived: tally.archived }
  try {
    counts.deleted = listTrash().length
  } catch (err) {
    console.error(`archive: could not count the deleted flows: ${err?.message || err}`)
  }
  const graph = pipelineGraph(CONFIG)
  return { flows: flows.map(f => ({ ...f, ...withRoute(f, graph) })), invalid, counts }
}

const noFlow = (res, id) => json(res, 404, { error: `No flow ${id}.` })

function showFlow(res, id) {
  const flow = readFlow(id)
  if (!flow) return noFlow(res, id)
  const problems = validateFlow(flow)
  if (problems.length) return json(res, 400, { error: problems.join('\n') })
  json(res, 200, { ...flow, derived: derive(flow), ...withRoute(flow, pipelineGraph(CONFIG)) })
}

/**
 * Re-read the flow NOW, apply `change` (it may throw, and then nothing is
 * written), write it, answer with what `change` returned. True when written.
 */
function changeFlow(res, id, change) {
  const flow = readFlow(id)
  if (!flow) return noFlow(res, id), false
  const result = change(flow)
  writeFlow(flow)
  json(res, 200, result)
  return true
}

/** The user's answer; a real one (not a reopen to null) is queued for the agent. */
function answer(res, id, b, relay) {
  if (changeFlow(res, id, f => applyAnswer(f, b.node, b.answer, b.note ?? undefined)) && b.answer !== null) relay.queue(id, b.node)
}

/** The user's tick: the only way `verified` is ever set ({ by: 'you' }, see applyVerify). */
function verify(res, id, b) {
  if (typeof b.verified !== 'boolean') throw new Error('verified must be true or false')
  changeFlow(res, id, f => applyVerify(f, b.node, b.verified))
}

/**
 * A node status or the flow's. A node status the user sets on a step or check
 * after an ask is pushed to the agent like an answer (spec 7.4a): it batches
 * with any answer queued for that agent. Nothing else the page sets is pushed.
 */
function status(res, id, b, relay) {
  if (b.node !== undefined) {
    let flow
    const written = changeFlow(res, id, f => ((flow = f), setNodeStatus(f, b.node, b.status)))
    if (written && followsAnAsk(flow, b.node)) relay.queueStatus(id, b.node)
    return
  }
  if (!FLOW_STATUS.includes(b.status)) throw new Error(`status must be one of ${FLOW_STATUS.join(', ')}`)
  // done while Senior holds the flow is refused by the store itself (flows.mjs writeFlow, the Senior gate)
  changeFlow(res, id, f => ((f.status = b.status), f))
}

async function deliver(res, id, b, relay) {
  if (!readFlow(id)) return noFlow(res, id)
  json(res, 200, await relay.deliverNow(id, b.node))
}

/**
 * The user asks the flow's agent for manual test steps, each with a screenshot (the Output view's
 * Request test steps). Stamps output.requestedAt (the user's, like an answer) and queues ONE relay
 * line, batched with any answers for that agent. When the agent IS the chat agent, nothing is
 * stamped or relayed: the text goes back for the page to put in the Ask drawer, and the user sends
 * it, so no paid turn ever starts without them.
 */
function requestTests(res, id, b, relay) {
  const note = b?.note ?? ''
  if (typeof note !== 'string') throw new Error('note must be text')
  if (note.length > NOTE_MAX) throw new Error(`note must be at most ${NOTE_MAX} characters`)
  const flow = readFlow(id)
  if (!flow) return noFlow(res, id)
  if (flow.agent === CONFIG.factory.chat.name) return json(res, 200, { ok: true, via: 'chat', text: requestText(flow, note.trim()) })
  const requestedAt = new Date().toISOString()
  // A new request clears what the relay made of the last one (relay.mjs stamps the outcome).
  const stampRequest = f => ((f.output = { ...f.output, requestedAt, requestSentAt: null, requestError: null }), { ok: true, via: 'relay', requestedAt })
  if (changeFlow(res, id, stampRequest)) relay.queueRequest(id, note.trim())
}

// ═══ Commit and evidence ═══

async function commit(res, sha, git) {
  if (!SHA.test(sha || '')) return json(res, 400, { error: 'sha must be 7 to 40 hex characters.' })
  const data = await commitDiff(git, sha)
  json(res, data ? 200 : 404, data ?? { error: `No commit ${sha}.` })
}

/** A file from EVIDENCE_DIR: decoded, resolved, then held inside the folder (403) and to the allowed types (404). */
async function evidence(res, pathname) {
  const root = path.resolve(EVIDENCE_DIR)
  let rel
  try {
    rel = decodeURIComponent(pathname.slice('/evidence/'.length))
  } catch {
    return json(res, 404, { error: 'No such evidence file.' })
  }
  const full = path.resolve(root, rel)
  if (!full.startsWith(root + path.sep)) return json(res, 403, { error: 'Outside the evidence folder.' })
  const type = EVIDENCE_TYPES[path.extname(full).toLowerCase()] ?? (QA_REPORT.test(path.basename(full)) ? 'text/plain; charset=utf-8' : undefined)
  try {
    if (type && (await stat(full)).isFile()) {
      const data = await readFile(full)
      // nosniff: an agent-written .txt or .png must never be read as HTML or script.
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      return res.end(data)
    }
  } catch {
    // missing or unreadable: the 404 below
  }
  json(res, 404, { error: 'No such evidence file.' })
}
