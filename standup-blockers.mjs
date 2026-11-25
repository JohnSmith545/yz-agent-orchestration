// What waits on someone, written for the team before the model sees it (standup-text.mjs puts these lines under
// BLOCKERS). The Human review items (human.mjs) are written for the dashboard's user: they name the agents, flows
// and by-hand steps, and a stand-up is read by a team that knows none of that (QA A-F1, 2026-11-25: a Daily said
// "Master must read the Cloud Armor plan" and "steps still to be asked of the agent").
//
//   neutral(text, agentNames)        the text with every agent label and dashboard word replaced by plain words
//   blockerLines(items, agentNames)  [{ tickets, text }]: one line per ticket set, its items merged, in neutral words;
//                                    an item that only says the steps are not written yet (or are all done) is no
//                                    blocker and is left out
//
// Rules this file keeps:
// - The agent labels come from the config (standup-wiring.mjs: the pipeline's agents, codingAgents, aliases, the
//   coordinator and the chat agent), never a hard-coded list. They are matched as whole names, case and all, so a
//   label such as Independent never eats the word independent.
// - Pure: strings in, strings out. The model still words the blocker; this only keeps the dashboard out of it.

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Reasons that only say the steps are not written yet, or are all done: no one else is waited on. */
const NOT_BLOCKER = /^Steps asked for\b|with no steps yet|waiting on the agent to write them|^All \d+ steps are done by you/i

export function neutral(text, agentNames = []) {
  let t = String(text ?? '')
  const names = [...new Set(agentNames.filter(n => typeof n === 'string' && n.trim().length > 1).map(n => n.trim()))].sort((a, b) => b.length - a.length)
  for (const n of names) t = t.replace(new RegExp(`(?<![\\w-])${escapeRe(n)}(?![\\w-])`, 'g'), 'someone')
  return t
    .replace(/\s*\b(?:in|from|on)?\s*Human review\b/gi, '')
    .replace(/\bby-hand (steps?)\b/gi, 'manual $1')
    .replace(/\bClaude Code\b|\bClaude\b/g, 'the tooling')
    .replace(/\b(?:an?|the) agents?\b/gi, 'someone')
    .replace(/\bagents?\b/gi, 'someone')
    .replace(/\b(this|that|the|a|its|their) flow\b/gi, '$1 work')
    .replace(/\bflows?\b/gi, 'work')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** One item's words: an open question says what it asks; anything else its reason. '' when it is no blocker. */
function itemText(i) {
  const reason = String(i.reason || '').trim()
  if (i.kind === 'ask' && i.question) return `waits on an answer to: ${i.question}${reason && !/^Part of /.test(reason) ? `; ${reason}` : ''}`
  return NOT_BLOCKER.test(reason) ? '' : reason
}

export function blockerLines(items = [], agentNames = []) {
  const by = new Map()
  for (const i of items) {
    const raw = itemText(i)
    if (!raw) continue
    const text = neutral(raw, agentNames).replace(/[.\s]+$/, '')
    const key = (i.tickets || []).join(', ')
    const line = by.get(key) || { tickets: [...(i.tickets || [])], parts: [] }
    if (text && !line.parts.includes(text)) line.parts.push(text)
    by.set(key, line)
  }
  return [...by.values()].filter(l => l.parts.length).map(l => ({ tickets: l.tickets, text: l.parts.join('; ') }))
}
