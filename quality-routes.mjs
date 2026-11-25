// The quality routes (server.mjs mounts them through quality-wiring.mjs):
//
//   GET  /api/lessons                          the Lessons page (#/lessons, public/quality-lessons-page.js): { lessons (every
//                                              one, most hit first), candidates (each with its flow's title), failures
//                                              (waiting to be extracted, or whose run could not be read: retry), areas,
//                                              settings: { autoLessons, critic }, busy, limits, startedAt }
//   POST /api/lessons                          { text, area }: a lesson the user typed, active at once
//   POST /api/lessons/<id>/retire | restore    take a lesson out of the briefs, or bring it back
//   POST /api/lessons/candidates/<id>/accept   { text?, area? }: the user accepts a candidate, with their edit
//   POST /api/lessons/candidates/<id>/reject
//   POST /api/lessons/extract                  { key }: Extract lessons for one failure (ONE run at a time: 409 while one
//                                              runs), { ok, candidates, cost } or 502 { error, cost? }
//   POST /api/quality/critic/<flow>            Second opinion on the flow's plan (ONE at a time: 409), { ok, critic }; 400
//                                              when the critic is off or there is no plan
//   GET  /api/quality/flow/<flow>              the flow page's quality panel: { risk, missing, missingLine, selfcheck, critic,
//                                              criticCurrent, criticMode, lessons }
//
// Rules: every POST is the USER'S, so the page's own Origin must be PRESENT and its own (local-origin.mjs), 403 else;
// a flow id or a lesson id is checked before anything is read; a limit is refused with one plain sentence (400); the
// library is read, changed and written whole (quality-lessons.mjs, atomic). The two runners are injected (the real
// ones in quality-wiring.mjs), so tests never run a model. `config()` gives the settings now.

import { CONFIG } from './config.mjs'
import { listFlows, readFlow } from './flows.mjs'
import { originAllowed } from './local-origin.mjs'
import { pipelineGraph } from './pipeline.mjs'
import { qualityOf } from './quality-config.mjs'
import { pendingFailures } from './quality-extract.mjs'
import { riskFacts, taskOf } from './quality-facts.mjs'
import { acceptCandidate, addLesson, LESSON_MAX, lessonsFor, listLessons, readLessons, rejectCandidate, setStatus, writeLessons } from './quality-lessons.mjs'
import { NEED_WORDS, riskOf, riskRoute } from './quality-risk.mjs'

const SLUG = /^[a-z0-9-]+$/
const LESSON_PATH = /^\/api\/lessons\/(L\d{1,6})\/(retire|restore)$/
const CANDIDATE_PATH = /^\/api\/lessons\/candidates\/([a-z0-9]{1,20})\/(accept|reject)$/
const CRITIC_PATH = /^\/api\/quality\/critic\/([^/]{1,100})$/
const FLOW_PATH = /^\/api\/quality\/flow\/([^/]{1,100})$/
const BODY_MAX = 4_000
const FAILURES_MAX = 60
const GATE_LABEL = { security: 'Security', senior: 'Senior' }

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

/** Each flow's title by id, for the page's lines. */
const titlesOf = flows => new Map(flows.map(f => [f.id, f.title]))

/** The Lessons page's data. */
function lessonsData(config, busy) {
  const q = qualityOf(config)
  const store = readLessons()
  const flows = listFlows({ archived: 'any' }).flows
  const titles = titlesOf(flows)
  const retry = Object.entries(store.done).filter(([, v]) => v.result === 'error').map(([key]) => key)
  const all = flows.flatMap(f => pendingFailures([f], { ...store, done: Object.fromEntries(Object.entries(store.done).filter(([k]) => !retry.includes(k))) }))
  const failures = all.sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, FAILURES_MAX)
    .map(f => ({ key: f.key, flow: f.flow, title: f.title, gate: f.gate, at: f.at, summary: f.summary, auto: f.auto, retry: retry.includes(f.key) }))
  return {
    lessons: listLessons({}, null, store),
    candidates: store.candidates.map(c => ({ ...c, title: titles.get(c.source.flow) || c.source.flow })),
    failures,
    areas: q.areas,
    settings: { autoLessons: q.autoLessons, critic: q.critic },
    busy,
    limits: { text: LESSON_MAX.text, brief: LESSON_MAX.brief },
    startedAt: store.startedAt,
  }
}

/** The flow page's quality panel for one flow. */
function flowData(flow, config) {
  const q = qualityOf(config)
  const graph = pipelineGraph(config)
  const risk = flow.risk || riskOf(flow, { ...riskFacts(flow), rules: q.riskRules })
  const missing = riskRoute(flow.route || { type: 'ask', steps: [] }, risk, graph).missing.map(n => GATE_LABEL[n])
  const missingLine = missing.length
    ? `This task asks for ${missing.map(m => NEED_WORDS[m.toLowerCase()]).join(' and ')}, but there is no ${missing.join(' or ')} agent on the pipeline (config.json pipeline).`
    : ''
  const critic = flow.critic || null
  return {
    risk, missing, missingLine,
    selfcheck: flow.selfcheck || null,
    critic,
    criticCurrent: !!critic && critic.plan === flow.plan?.file,
    criticMode: q.critic,
    hasPlan: flow.plan?.status === 'handed',
    lessons: lessonsFor(taskOf(flow), { store: readLessons(), areas: q.areas }),
  }
}

/**
 * `route(req, res, url)` answers the paths above and resolves true, or false for anything else. `extractor` and
 * `critic` are quality-extract.mjs makeExtractor and quality-critic.mjs makeCritic (stubs in tests).
 */
export function makeQualityRoute({ port, extractor, critic, config = () => CONFIG }) {
  /** One change to the library: read, change with `fn(store)` -> { error?, … }, write when it worked. */
  function change(res, fn, notFound = /^No /) {
    const store = readLessons()
    const out = fn(store)
    if (out.error) return json(res, notFound.test(out.error) ? 404 : 400, { error: out.error })
    writeLessons(store)
    return json(res, 200, { ok: true, ...(out.lesson ? { lesson: out.lesson } : {}) })
  }

  async function post(req, res, url) {
    if (!originAllowed(req.headers.origin, port)) return json(res, 403, { error: 'Cross-origin request refused.' })
    let body
    try {
      body = await readBody(req)
    } catch (e) {
      return json(res, e.status || 400, { error: e.message })
    }
    const q = qualityOf(config())
    if (url.pathname === '/api/lessons') return change(res, s => addLesson(s, { text: body.text, area: body.area, by: 'you' }, { areas: q.areas }))
    const lesson = LESSON_PATH.exec(url.pathname)
    if (lesson) return change(res, s => setStatus(s, lesson[1], lesson[2] === 'retire' ? 'retired' : 'active'))
    const cand = CANDIDATE_PATH.exec(url.pathname)
    if (cand) {
      const edits = { ...(typeof body.text === 'string' ? { text: body.text } : {}), ...(typeof body.area === 'string' ? { area: body.area } : {}) }
      return change(res, s => (cand[2] === 'accept' ? acceptCandidate(s, cand[1], edits, { areas: q.areas }) : rejectCandidate(s, cand[1])))
    }
    if (url.pathname === '/api/lessons/extract') {
      if (typeof body.key !== 'string' || !body.key) return json(res, 400, { error: 'Say which failure to extract lessons from.' })
      const store = readLessons()
      const retry = Object.fromEntries(Object.entries(store.done).filter(([, v]) => v.result !== 'error'))
      const failure = pendingFailures(listFlows({ archived: 'any' }).flows, { ...store, done: retry }).find(f => f.key === body.key)
      if (!failure) return json(res, 404, { error: 'That failure is not waiting for lessons: it may have been extracted already.' })
      const out = await extractor.extract(failure)
      if (out.busy) return json(res, 409, { error: out.error })
      return out.ok ? json(res, 200, { ok: true, candidates: out.candidates, cost: out.cost ?? null }) : json(res, 502, { error: out.error, ...(out.cost != null ? { cost: out.cost } : {}) })
    }
    const crit = CRITIC_PATH.exec(url.pathname)
    if (crit) {
      const id = decode(crit[1])
      if (!SLUG.test(id)) return json(res, 400, { error: 'That is not a flow id.' })
      const out = await critic.run(id)
      if (out.ok) return json(res, 200, { ok: true, critic: out.critic })
      if (out.busy) return json(res, 409, { error: out.error })
      if (/^No flow /.test(out.error)) return json(res, 404, { error: out.error })
      return json(res, /switched off|no plan/.test(out.error) ? 400 : 502, { error: out.error })
    }
    return json(res, 404, { error: 'No such route.' })
  }

  return async function qualityRoute(req, res, url) {
    const p = url.pathname
    const ours = p === '/api/lessons' || p.startsWith('/api/lessons/') || p.startsWith('/api/quality/')
    if (!ours) return false
    if (req.method === 'POST') return await post(req, res, url), true
    if (req.method !== 'GET') return json(res, 405, { error: 'Use GET or POST here.' }), true
    if (p === '/api/lessons') return json(res, 200, lessonsData(config(), !!extractor.busy())), true
    const one = FLOW_PATH.exec(p)
    if (one) {
      const id = decode(one[1])
      if (!SLUG.test(id)) return json(res, 400, { error: 'That is not a flow id.' }), true
      const flow = readFlow(id)
      if (!flow) return json(res, 404, { error: `No flow ${id}.` }), true
      return json(res, 200, flowData(flow, config())), true
    }
    return json(res, 404, { error: 'No such route.' }), true
  }
}
