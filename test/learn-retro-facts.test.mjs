// Tests for a flow's retrospective, the PURE half: the facts the server gathers (learn-retro-facts.mjs), the three
// lines the model writes and the server checks (learn-retro-text.mjs), and the stored shape flows.mjs validates.
// No model runs here: the run is learn-retro.mjs, tested with a stub in learn-retro.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_PIPELINE, pipelineGraph } from '../pipeline.mjs'
import { RETRO_FACTS_MAX, retroFacts, retroFactsText } from '../learn-retro-facts.mjs'
import { RETRO_LINE_MAX, RETRO_SOURCES, parseRetro, validateRetro } from '../learn-retro-text.mjs'

const CFG = {
  coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1' },
  pipeline: { ...DEFAULT_PIPELINE, security: 'Security' }, factory: { chat: { name: 'Independent' } },
}
const GRAPH = pipelineGraph(CFG)

/** A build flow: QA failed once (sent back to Agent 1), then passed, and Security passed it; one question, one by-hand step. */
function flow(over = {}) {
  return {
    id: 'agent-rules', title: 'Each agent gets rules', agent: 'Master', tickets: ['FLA-9'], status: 'done',
    why: 'The user wants rules per agent.', createdAt: '2026-11-24T10:00:00.000Z', updatedAt: '2026-11-24T14:00:00.000Z',
    route: { type: 'build', steps: ['request', 'master', 'qa', 'security', 'push', 'outcome'], at: '2026-11-24T10:00:00.000Z', by: 'Master' },
    nodes: [
      { id: 'q1', type: 'ask', kind: 'yesno', title: 'Push to main?', at: '2026-11-24T11:00:00.000Z', answer: 'yes', answeredAt: '2026-11-24T11:30:00.000Z' },
      { id: 'q2', type: 'ask', kind: 'yesno', title: 'Also dark mode?', at: '2026-11-24T12:00:00.000Z', answer: null },
    ],
    hand: { steps: [{ id: 'h1', do: 'Add the DNS record', done: true }] },
    qa: {
      status: 'passed', attempt: 2, by: 'QA', startedAt: '2026-11-24T13:00:00.000Z', at: '2026-11-24T13:30:00.000Z', summary: 'Attempt 2 passes.',
      report: 'agent-rules/qa-2-report.md',
      security: { status: 'passed', by: 'Security', at: '2026-11-24T13:50:00.000Z', summary: 'Nothing to fix.' },
      attempts: [{ status: 'failed', attempt: 1, by: 'QA', startedAt: '2026-11-24T12:00:00.000Z', at: '2026-11-24T12:20:00.000Z', summary: 'A long rule was cut without a word.', report: 'agent-rules/qa-1-report.md', rework: { to: 'Agent 1' } }],
    },
    output: { story: [{ id: 's1', who: 'Master', did: 'Built it and QA passed it the second time.', why: 'The user asked.' }] },
    ...over,
  }
}

test('the facts: the story, the route by label, each QA attempt with its verdict text, Security, reworks, questions, by-hand steps', () => {
  const f = retroFacts(flow(), GRAPH, { readReport: ref => (ref.endsWith('qa-1-report.md') ? '# QA attempt 1\nFAIL: the 301st character is dropped.' : null) })
  assert.equal(f.title, 'Each agent gets rules')
  assert.equal(f.request, 'The user wants rules per agent.')
  assert.deepEqual(f.story, ['Master: Built it and QA passed it the second time. (The user asked.)'])
  assert.deepEqual(f.route, ['Request', 'Master', 'QA', 'Security', 'Push', 'Output'])
  assert.equal(f.qa.length, 2)
  assert.equal(f.qa[0].status, 'failed')
  assert.equal(f.qa[0].text, 'A long rule was cut without a word.')
  assert.match(f.qa[0].report, /301st character/)
  assert.equal(f.qa[0].backTo, 'Agent 1')
  assert.equal(f.qa[1].status, 'passed')
  assert.equal(f.qa[1].report, '') // a report that could not be read is left out, never guessed
  assert.deepEqual(f.security, [{ attempt: 2, status: 'passed', text: 'Nothing to fix.' }])
  assert.equal(f.reworks, 1)
  assert.deepEqual(f.questions, [{ title: 'Push to main?', answer: 'yes' }, { title: 'Also dark mode?', answer: null }])
  assert.deepEqual(f.hand, { steps: 1, done: 1, items: ['Add the DNS record'] })
  assert.ok(f.stages.some(s => s.label === 'QA'), 'the stage times the flow file can date')
  assert.equal(f.tookMs, 4 * 3_600_000 - 10 * 60_000) // createdAt to Security's pass at 13:50
})

test('a flow with no QA, no story and no questions still has facts: empty lists, never made-up ones', () => {
  const f = retroFacts({ id: 'ask-1', title: 'Explain X', agent: 'Master', status: 'done', nodes: [], createdAt: '2026-11-24T10:00:00.000Z', updatedAt: '2026-11-24T10:05:00.000Z' }, GRAPH)
  assert.deepEqual(f.qa, [])
  assert.deepEqual(f.security, [])
  assert.deepEqual(f.story, [])
  assert.deepEqual(f.questions, [])
  assert.equal(f.reworks, 0)
  assert.equal(f.senior, null)
  const text = retroFactsText(f)
  assert.match(text, /QA ATTEMPTS\n- None\./)
})

test('Senior verdicts are facts too: the earlier failures and the final one, each with its text', () => {
  const f = retroFacts(flow({ qa: undefined, senior: { status: 'passed', by: 'Senior', at: '2026-11-24T13:00:00.000Z', summary: 'The steps are right now.', history: [{ status: 'failed', at: '2026-11-24T12:00:00.000Z', summary: 'Step 2 is missing.' }] } }), GRAPH)
  assert.deepEqual(f.senior, [{ status: 'failed', text: 'Step 2 is missing.' }, { status: 'passed', text: 'The steps are right now.' }])
})

test('the facts text is capped, and says so when it was cut', () => {
  const long = 'x'.repeat(400)
  const many = flow({ output: { story: Array.from({ length: 8 }, (_, i) => ({ id: `s${i + 1}`, who: 'Master', did: long, why: long })) }, nodes: Array.from({ length: 60 }, (_, i) => ({ id: `q${i}`, type: 'ask', title: long, answer: long })) })
  const text = retroFactsText(retroFacts(many, GRAPH))
  assert.ok(text.length <= RETRO_FACTS_MAX)
  assert.match(text, /Cut here/)
})

test('each verdict text is cut to 600 characters and a report to 1,500, so one long report cannot crowd the rest out', () => {
  const f = retroFacts(flow({ qa: { ...flow().qa, attempts: [{ ...flow().qa.attempts[0], summary: 'y'.repeat(900) }] } }), GRAPH, { readReport: () => 'z'.repeat(5000) })
  assert.ok(f.qa[0].text.length <= 600)
  assert.ok(f.qa[0].report.length <= 1500)
})

test('the three lines: Right, Wrong and Next, decoration and order forgiven', () => {
  const r = parseRetro('Here you go:\n**Right:** QA caught the cut rule.\n- Next: Test limits before handing to QA.\nWrong: The first attempt cut long rules silently.')
  assert.deepEqual(r, { right: 'QA caught the cut rule.', wrong: 'The first attempt cut long rules silently.', next: 'Test limits before handing to QA.' })
})

test('a line over 200 characters is cut at a word with an ellipsis, never dropped', () => {
  const r = parseRetro(`Right: ${'word '.repeat(80)}\nWrong: Nothing.\nNext: Keep it.`)
  assert.ok(r.right.length <= RETRO_LINE_MAX)
  assert.ok(r.right.endsWith('…'))
})

test('a missing or empty line is an error, not a guess', () => {
  assert.deepEqual(parseRetro('Right: Good.\nWrong: Bad.'), { error: 'The model did not write the three lines (Right, Wrong, Next).' })
  assert.deepEqual(parseRetro('Right: Good.\nWrong:\nNext: More.'), { error: 'The model did not write the three lines (Right, Wrong, Next).' })
  assert.deepEqual(parseRetro(''), { error: 'The model did not write the three lines (Right, Wrong, Next).' })
  assert.deepEqual(parseRetro(null), { error: 'The model did not write the three lines (Right, Wrong, Next).' })
})

test('the stored shape: three lines of 1 to 200 characters, a time, a cost or null, a known source', () => {
  const good = { at: '2026-11-24T14:00:00.000Z', right: 'a', wrong: 'b', next: 'c', cost: 0.012, source: 'completed' }
  assert.deepEqual(validateRetro(good), [])
  assert.deepEqual(validateRetro({ ...good, cost: null, source: 'button' }), [])
  assert.deepEqual(RETRO_SOURCES, ['completed', 'button'])
  assert.ok(validateRetro({ ...good, right: '' }).some(p => p.includes('retro right')))
  assert.ok(validateRetro({ ...good, wrong: 'w'.repeat(201) }).some(p => p.includes('retro wrong')))
  assert.ok(validateRetro({ ...good, at: 'soon' }).some(p => p.includes('retro at')))
  assert.ok(validateRetro({ ...good, cost: -1 }).some(p => p.includes('retro cost')))
  assert.ok(validateRetro({ ...good, source: 'agent' }).some(p => p.includes('retro source')))
  assert.deepEqual(validateRetro('x'), ['retro must be a JSON object'])
})
