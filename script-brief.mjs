// The orchestration, live: a plain-text brief of the user's own agent setup that the dashboard writes from
// facts it already has, so the Brainstorming page knows the system when an idea is about it (#/brainstorming, the
// Context panel's Orchestration switch).
//
//   orchestrationBrief({ config, graph, extras }) -> text, at most 8,000 characters
//     config   the dashboard config (config.mjs CONFIG): only labels and the pipeline settings are read
//     graph    pipeline.mjs pipelineGraph(config): the agents and their roles
//     extras   [{ title, text }] appended as further sections (the agents' rules, the scorecard: wired later)
//
// Rules this file keeps (PURE: no file, no config.json, no git):
// - ⚠️ NOTHING PRIVATE. Only dashboard labels, the pipeline settings (rework count, branch names) and fixed
//   wording go in: never the repo path, session ids, the account, the PIN hash, folders or tokens. As a second
//   guard the whole text goes through scrub(), which removes absolute paths, emails, ids and token-like strings
//   (extras are free text from elsewhere, so this matters most for them).
// - The role lines are the Agents page's (public/pipeline-details.js ROLE), word for word: MUST CHANGE IN
//   LOCKSTEP; test/script-brief.test.mjs compares the two.
// - The build and review routes are the ones flow-route.mjs planRoute plans, read off the graph, so a config
//   change shows here as it does on the Flows page.
// - Over 8,000 characters, the end is cut with a line saying so.

import { planRoute } from './flow-route.mjs'
import { DEFAULT_PIPELINE } from './pipeline.mjs'

export const BRIEF_MAX = 8_000
const CUT_NOTE = '\n[The rest was cut to fit 8,000 characters.]'

/** MUST CHANGE IN LOCKSTEP with public/pipeline-details.js ROLE (test/script-brief.test.mjs checks it). */
export const ROLE = Object.freeze({
  request: 'Where work starts: a request you give the coordinator, who hands it out.',
  coordinator: 'Hands each request to a producer (through the planner when there is one), or does it itself. Its own code changes go to QA too.',
  planner: 'Plans each task the coordinator hands it and gives it to a producer. It writes no code. Always on Opus at high effort.',
  producer: 'Writes the code. Finished code goes to QA; work with no code changes goes to Human task.',
  chat: 'The chat agent in the Ask drawer: answers questions, explains tickets and reviews code. It changes no code, so its work goes straight to the Output.',
  qa: 'Tests every code change. A pass goes on to Push (through Security when there is one); a failure goes back to the producer that made it.',
  security: 'Reviews every change QA passed, at the same commit. A pass lets QA push it; a failure goes back to the producer that made it. Always on Opus at high effort.',
  human: 'You. Work with no code changes passes through here; a flow with steps only you can do (CI/CD, a cloud console, an account setting) waits here until you tick them all.',
  senior: 'Reviews work done by hand that has no code to test: CI/CD, cloud console changes, commands run in a terminal. A pass goes to the Output; a failure goes back to Human task. Always on Opus at high effort.',
  push: 'QA pushes the branch at the exact commit it tested (and Security passed, when there is Security): never forced, never a protected branch.',
  outcome: 'Where work ends: pushed after a QA pass (and a Security pass, when there is Security), or done with no code changes past Human task (and Senior, when there is one). You open the pull request with Send.',
})
const ROLE_NAME = { coordinator: 'coordinator', planner: 'planner', producer: 'producer', chat: 'chat agent', qa: 'tester', security: 'security reviewer', senior: 'reviewer of work done by hand' }

/** The dashboard's pages, one line each (README "A quick tour"). */
const PAGES = [
  ['Flows', 'the first page. Every request as a flow, with its route from Request to Output, what was built, how to test it, and questions from agents to answer.'],
  ['Home', 'what changed since you last looked, open questions from agents, and a card per agent.'],
  ['QA', 'every ticket that passed QA, with its report, its screenshots and the steps to test it yourself.'],
  ['Brainstorming', 'turns a rough idea into a ready-to-paste prompt in six labelled parts.'],
  ['Tickets', 'a ticket collection from the tracker, which agent took which ticket how far, and every worktree.'],
  ['Timeline', 'what each agent did on each task, as a zoomable chart.'],
  ['Agents', 'the orchestration as a pipeline diagram, and a live view of one agent.'],
  ['Subagents', 'every subagent the sessions started, with its pull request and its final report.'],
  ['Glossary', 'the technical words the dashboard explains, learned as agents use them.'],
  ['Settings', 'the dashboard settings, such as sending pull requests.'],
]

const BUILT_WITH = 'A local web dashboard on zero-dependency Node.js 20: plain HTML, CSS and JavaScript with no framework and no build step, tests with node:test. The agents are Claude Code sessions. The dashboard reads their transcripts and git, and the agents record their work through its command line tool.'

/** A label as one short line. */
const one = s => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
/** "A", "A or B", "A, B or C". */
const orList = xs => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs.at(-1)}`)

const PRIVATE = [
  /\b[A-Za-z]:[\\/][^\s"'`<>|]*/g, // C:\Users\… or C:/…
  /\\\\[^\s"'`<>|]+/g, // \\server\share
  /(?<![\w.])\/(?:Users|home|root|tmp|var|etc|opt|mnt|private)\/[^\s"'`<>]*/g,
  /(?<![\w])~[\\/][^\s"'`<>]*/g,
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, // an email
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})/g,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // a session or account id
  /\b[0-9a-f]{32,}\b/gi, // a long hex secret or hash
]

/** `text` with absolute paths, emails, ids and token-like strings replaced by [removed]. */
export const scrub = text => PRIVATE.reduce((t, re) => t.replace(re, '[removed]'), String(text ?? ''))

function routes(graph) {
  const nodes = graph?.nodes || []
  const label = id => one(nodes.find(n => n.id === id)?.label || id)
  const role = r => nodes.find(n => n.role === r)
  const producers = nodes.filter(n => n.role === 'producer').map(n => one(n.label))
  const coordinator = role('coordinator')
  const chat = role('chat')
  const lines = []
  const viaProducer = producers.length ? planRoute('build', producers[0], graph).steps : null
  const own = planRoute('build', coordinator?.label, graph).steps
  const name = ids => ids.map(id => (producers.length && label(id) === producers[0] ? `the producer (${orList(producers)})` : label(id))).join(', ')
  lines.push(viaProducer
    ? `- build, a code change: ${name(viaProducer)}. When ${one(coordinator.label)} builds the change itself: ${name(own)}.`
    : `- build, a code change: ${name(own)}.`)
  lines.push(chat
    ? `- review, a code review of a tracker ticket: ${name(planRoute('review', chat.label, graph).steps)}.`
    : '- review, a code review of a tracker ticket: not set up, as there is no chat agent.')
  const hand = ['human', 'senior'].map(r => role(r)).filter(Boolean).map(n => one(n.label))
  lines.push(`- ask, a question, an explanation or an investigation: Request, the agent asked, ${hand.length ? `${hand.join(', ')}, ` : ''}Output${producers.length ? ` (a producer is reached through ${one(coordinator?.label)})` : ''}. No QA, no push. It stops at ${hand[0] || 'the Human task'} only when it has steps only the user can do.`)
  return lines
}

export function orchestrationBrief({ config = {}, graph, extras = [] } = {}) {
  const nodes = graph?.nodes || []
  const s = { ...DEFAULT_PIPELINE, ...(config?.pipeline || {}) }
  const coordinator = one(nodes.find(n => n.role === 'coordinator')?.label || 'the coordinator')
  const qa = one(nodes.find(n => n.role === 'qa')?.label || 'QA')
  const agents = nodes.filter(n => n.kind === 'agent')
  const steps = nodes.filter(n => n.kind !== 'agent')
  const branches = (Array.isArray(s.protectedBranches) ? s.protectedBranches : []).map(one).join(', ') || 'none'

  const sections = [
    ['What it is', [
      `A team of Claude Code agents working in one code repository, watched and steered from a local dashboard. A coordinator (${coordinator}) takes each request and hands it to a producer agent, or does it itself. Every code change goes to ${qa}, which tests it in a browser and is the only one that pushes. A failure goes back to the producer that made the change. Every request is written down as a flow, so the user can follow it, answer the agents' questions and see the result.`,
    ]],
    ['Agents', agents.map(n => `- ${one(n.label)} (${ROLE_NAME[n.role] || n.role}): ${ROLE[n.role] || ''}`)],
    ['Steps that are not agents', steps.map(n => `- ${one(n.label)}: ${ROLE[n.role] || ''}`)],
    ['Flow types and their routes', ['Every request is one flow with one type, which sets its route:', ...routes(graph)]],
    ['QA rules', [
      `- ${qa} sends a failed change back to its producer at most ${s.maxReworks} times. After that the flow stops and waits for the user.`,
      `- ${qa} pushes only a change it passed, exactly the commit it tested, never forced and never to a protected branch (${branches}).`,
      '- No other agent pushes. The user opens the pull request from the dashboard with Send.',
    ]],
    ['The dashboard pages', PAGES.map(([p, line]) => `- ${p}: ${line}`)],
    ['Built with', [BUILT_WITH]],
  ]
  for (const x of Array.isArray(extras) ? extras : []) {
    const title = one(x?.title)
    const text = String(x?.text ?? '').trim()
    if (title && text) sections.push([title, [text]])
  }
  const text = scrub(sections.map(([h, lines]) => `### ${h}\n${lines.join('\n')}`).join('\n\n'))
  return text.length <= BRIEF_MAX ? text : text.slice(0, BRIEF_MAX - CUT_NOTE.length).trimEnd() + CUT_NOTE
}
