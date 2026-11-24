// A saved orchestration style (orchestration-parts.mjs) in plain words, for the Orchestration bank page:
//
//   summaryOf(snapshot)        one line: "Master hands to 3 agents through Planner, QA tests, Security checks, 5 rules"
//   routeWords(graph)          the route with EVERY agent in it, the Planner and Security included
//   styleView(snapshot)        { graph, agents: [{ label, role, roleWords, spec, rules, model, effort, fixed, modelWords }],
//                              summary, route }
//   modelWords(entry, role)    "Haiku 5.5, low effort"; the planner and Security: "Opus 5.5, high effort (fixed)"
//   styleChanges(now, next)    exactly what using `next` changes from `now`, one plain sentence each: agents added or
//                              removed, rules added or removed by count per agent, a specification that changes, a
//                              model or effort that changes, the rework limit and the protected branches. [] when none.
//
// PURE: snapshots in, words out. A part a snapshot does not have (an entry saved before the part existed) is never
// reported as a change: using that entry leaves that part as it is (orchestration-parts.mjs applySnapshot).

import { FIXED, FIXED_ROLES, MODELS } from './agent-settings.mjs'
import { graphOf } from './orchestration-parts.mjs'

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const andList = a => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`)
const modelName = id => MODELS.find(m => m.id === id)?.name || id
const agentsOf = graph => (graph?.nodes || []).filter(n => n.kind === 'agent')
const has = (graph, role) => agentsOf(graph).some(n => n.role === role)

/** What each role does, in words a person uses (never the raw role names). QA's words depend on Security being there. */
export function roleWords(role, graph) {
  if (role === 'qa') return has(graph, 'security') ? 'tests every code change' : 'tests every code change, then pushes it'
  return {
    coordinator: 'hands out the work',
    planner: 'plans the work and hands it out',
    producer: 'writes code',
    security: 'checks for security problems before the push',
    chat: 'answers questions in Ask',
  }[role] || 'works in the pipeline'
}

export function modelWords(entry, role) {
  if (FIXED_ROLES.includes(role)) return `${modelName(FIXED.model)}, ${FIXED.effort} effort (fixed)`
  const m = entry?.model ? modelName(entry.model) : null
  const e = entry?.effort ? `${entry.effort} effort` : null
  if (!m && !e) return 'Model and effort not chosen'
  return `${m || 'Model not chosen'}, ${e || 'effort not chosen'}`
}

/** "Haiku 5.5 at low effort", for a sentence about a change. */
function atWords(entry) {
  const m = entry?.model ? modelName(entry.model) : 'no chosen model'
  return entry?.effort ? `${m} at ${entry.effort} effort` : m
}

export function routeWords(graph) {
  const nodes = agentsOf(graph)
  const one = role => nodes.find(n => n.role === role)?.label
  const coord = one('coordinator') || 'The coordinator'
  const planner = one('planner')
  const qa = one('qa')
  const security = one('security')
  const chat = one('chat')
  const workers = nodes.filter(n => n.role === 'producer').map(n => n.label)
  const to = workers.length ? andList(workers) : 'no other agent'
  const parts = [planner ? `${coord} hands each request to ${planner}, who plans it and hands it to ${to}` : `${coord} hands each request to ${to}`]
  if (qa) parts.push(security ? `${qa} tests every code change, then ${security} checks it for security problems before it is pushed` : `${qa} tests every code change and pushes it`)
  if (chat) parts.push(`${chat} answers questions in Ask`)
  return `${parts.join('; ')}.`
}

export function summaryOf(snapshot) {
  const graph = graphOf(snapshot?.parts?.agents)
  const nodes = agentsOf(graph)
  const one = role => nodes.find(n => n.role === role)?.label
  const coord = one('coordinator') || 'The coordinator'
  const planner = one('planner')
  const producers = nodes.filter(n => n.role === 'producer').length
  const rules = Object.values(snapshot?.parts?.rules?.agents || {}).reduce((sum, e) => sum + (Array.isArray(e?.rules) ? e.rules.length : 0), 0)
  return [
    `${coord} hands to ${plural(producers, 'agent')}${planner ? ` through ${planner}` : ''}`,
    ...(one('qa') ? [`${one('qa')} tests`] : []),
    ...(one('security') ? [`${one('security')} checks`] : []),
    rules ? plural(rules, 'rule') : 'no rules',
  ].join(', ')
}

export function styleView(snapshot) {
  const graph = graphOf(snapshot?.parts?.agents)
  const rules = snapshot?.parts?.rules?.agents || {}
  const settings = snapshot?.parts?.settings?.agents || {}
  const agents = agentsOf(graph).map(n => {
    const s = isObj(settings[n.label]) ? settings[n.label] : {}
    const fixed = FIXED_ROLES.includes(n.role)
    return {
      label: n.label,
      role: n.role,
      roleWords: roleWords(n.role, graph),
      spec: typeof rules[n.label]?.spec === 'string' ? rules[n.label].spec : '',
      rules: Array.isArray(rules[n.label]?.rules) ? rules[n.label].rules.filter(r => typeof r === 'string') : [],
      model: fixed ? FIXED.model : s.model ?? null,
      effort: fixed ? FIXED.effort : s.effort ?? null,
      fixed,
      modelWords: modelWords(s, n.role),
    }
  })
  return { graph, agents, summary: summaryOf(snapshot), route: routeWords(graph) }
}

/** Each text of `a` not matched by one in `b`, one for one. */
function minus(a, b) {
  const left = [...b]
  return a.filter(t => {
    const i = left.indexOf(t)
    if (i < 0) return true
    left.splice(i, 1)
    return false
  })
}

export function styleChanges(now, next) {
  const before = graphOf(now?.parts?.agents)
  const after = graphOf(next?.parts?.agents)
  const was = new Map(agentsOf(before).map(n => [n.label, n]))
  const will = agentsOf(after)
  const out = []
  for (const n of will) {
    if (!was.has(n.label)) out.push(`${n.label} is added: ${roleWords(n.role, after)}.`)
    else if (was.get(n.label).role !== n.role) out.push(`${n.label} now ${roleWords(n.role, after)}, instead of: ${roleWords(was.get(n.label).role, before)}.`)
  }
  const kept = new Set(will.map(n => n.label))
  for (const n of agentsOf(before)) if (!kept.has(n.label)) out.push(`${n.label} is removed.`)

  if (next?.parts?.rules) {
    const r0 = now?.parts?.rules?.agents || {}
    const r1 = next.parts.rules.agents || {}
    for (const n of will) {
      const a = r0[n.label] || {}
      const b = r1[n.label] || {}
      const added = minus(b.rules || [], a.rules || []).length
      const removed = minus(a.rules || [], b.rules || []).length
      const bits = [...(added ? [`${plural(added, 'rule')} added`] : []), ...(removed ? [`${plural(removed, 'rule')} removed`] : [])]
      if ((a.spec || '') !== (b.spec || '')) bits.push(bits.length ? 'and its specification changes' : 'its specification changes')
      if (bits.length) out.push(`${n.label}: ${bits.join(', ')}.`)
    }
  }

  if (next?.parts?.settings) {
    const s0 = now?.parts?.settings?.agents || {}
    const s1 = next.parts.settings.agents || {}
    for (const n of will) {
      if (FIXED_ROLES.includes(n.role)) continue
      const a = s0[n.label] || {}
      const b = s1[n.label] || {}
      if ((a.model ?? null) !== (b.model ?? null) || (a.effort ?? null) !== (b.effort ?? null)) out.push(`${n.label} runs on ${atWords(b)} instead of ${atWords(a)}.`)
    }
  }

  const p0 = isObj(now?.parts?.agents?.pipeline) ? now.parts.agents.pipeline : {}
  const p1 = isObj(next?.parts?.agents?.pipeline) ? next.parts.agents.pipeline : {}
  if (p1.maxReworks !== undefined && p0.maxReworks !== undefined && p1.maxReworks !== p0.maxReworks) {
    out.push(`A failed test goes back to its producer at most ${plural(p1.maxReworks, 'time')} instead of ${p0.maxReworks}.`)
  }
  if (Array.isArray(p1.protectedBranches) && Array.isArray(p0.protectedBranches) && p1.protectedBranches.join() !== p0.protectedBranches.join()) {
    out.push(`QA never pushes to ${andList(p1.protectedBranches)} (now: ${andList(p0.protectedBranches)}).`)
  }
  return out
}
