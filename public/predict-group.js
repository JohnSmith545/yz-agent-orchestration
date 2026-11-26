// How the alerts are grouped, counted and put in words: ONE file for the desktop and the phone. The page loads it
// before predict-view.js (the Alerts line and its rows); the server imports it in phone-orchestration.mjs (the
// phone's Agents tab). ⚠️ Why one file: the phone said 10 alerts where the desktop said 3 for the same data, because
// only the desktop grouped an agent's Taking long alerts (QA, 2026-11-26). Same function, same count, same words.
//
// It is a plain script, not a module, so the page can load it with a <script> tag; on the server `import` runs it
// once and it puts the same object on globalThis (there is no window there). Pure: no DOM, no I/O.
//
//   groupAlerts(list)   GROUP_MIN or more Taking long alerts of ONE agent become one group item
//                       { kind: 'group', key, agent, alerts }, in the place of its first member
//   groupText(g)        `Master holds 8 flows longer than usual`
//   lineOf(item)        an item in one line, as its row begins: a group's words, or the alert's own text
//   kindsText(items)    what kinds there are, in words: `1 flow waiting on you · 2 sessions re-reading a large history`
;(root => {
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

  /**
   * One agent holding many flows past their usual time is one fact, not many: GROUP_MIN or more Taking long alerts
   * (never Waiting on you, which is the user's own, one by one) of the same agent become one group item, placed where
   * its first member was. Each member keeps its own buttons inside the group (predict-view.js).
   */
  const GROUP_MIN = 3
  function groupAlerts(list) {
    const items = Array.isArray(list) ? list.filter(a => a && typeof a === 'object') : []
    const by = new Map()
    for (const a of items) if (a.kind === 'stuck' && !a.onYou && a.agent) by.set(a.agent, [...(by.get(a.agent) || []), a])
    const out = []
    const placed = new Set()
    for (const a of items) {
      const members = a.kind === 'stuck' && !a.onYou && a.agent ? by.get(a.agent) : null
      if (!members || members.length < GROUP_MIN) {
        out.push(a)
        continue
      }
      if (placed.has(a.agent)) continue
      placed.add(a.agent)
      out.push({ kind: 'group', key: `group:${a.agent}`, agent: a.agent, alerts: members })
    }
    return out
  }
  const groupText = g => `${g.agent} holds ${g.alerts.length} flows longer than usual`
  const lineOf = a => (a?.kind === 'group' ? `${groupText(a)} for their step.` : String(a?.text ?? ''))

  /** What kinds of alert there are, in words: `1 flow waiting on you · 2 sessions re-reading a large history`. */
  function kindsText(items) {
    const all = Array.isArray(items) ? items : []
    const list = all.filter(a => a.kind !== 'group')
    const n = pred => list.filter(pred).length
    const parts = all.filter(a => a.kind === 'group').map(groupText)
    const you = n(a => a.kind === 'stuck' && a.onYou)
    const slow = n(a => a.kind === 'stuck' && !a.onYou)
    const spike = n(a => a.kind === 'spike')
    const ctx = n(a => a.kind === 'context')
    const daily = n(a => a.kind === 'daily')
    if (you) parts.push(`${plural(you, 'flow')} waiting on you`)
    if (slow) parts.push(`${plural(slow, 'flow')} far past ${slow === 1 ? 'its' : 'their'} usual time`)
    if (spike) parts.push(`${plural(spike, 'session')} using tokens much faster than usual`)
    if (ctx) parts.push(`${plural(ctx, 'session')} re-reading a large history`)
    if (daily) parts.push(daily === 1 ? 'a daily limit passed' : `${daily} daily limits passed`)
    return parts.join(' · ')
  }

  root.PredictGroup = Object.freeze({ GROUP_MIN, groupAlerts, groupText, lineOf, kindsText })
})(typeof window !== 'undefined' ? window : globalThis)
