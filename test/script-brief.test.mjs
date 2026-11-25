// Tests for orchestrationBrief (script-brief.mjs): the plain-text brief of the user's orchestration that the
// SCRIPT run can be given. It names each agent and its role (in the Agents page's own wording), the three flow
// types with their routes as planRoute plans them, the QA rules, the pages and what the dashboard is built with;
// it appends extras; it carries nothing private (no paths, ids, emails or tokens); and it stays under 8,000.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const { orchestrationBrief, ROLE, BRIEF_MAX, scrub } = await import('../script-brief.mjs')
const { pipelineGraph } = await import('../pipeline.mjs')
const { planRoute } = await import('../flow-route.mjs')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const config = {
  repo: 'C:/Users/someone/secret-repo',
  coordinator: 'Master',
  coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', 'Agent 2': 'Agent 2', 'flinki-a9': 'Agent 3' },
  pipeline: { qa: 'QA', producers: null, protectedBranches: ['dev', 'stage', 'main', 'release/*'], maxReworks: 2 },
  factory: { me: 'uid-0DyNNJSHFeSDwPGW', chat: { name: 'Independent', forkFrom: 'd75abf38-b19d-4351-9d1e-b0322eabc80f' } },
  pr: { pinHash: 'scrypt$abcdef0123456789abcdef0123456789$deadbeef' },
  claudeDirs: ['C:/Users/someone/.claude-account2'],
  pinnedAgents: { 'Agent 1': { sessionId: 'af7d2f74-759a-41c0-8c6a-231e7584d3c2', cwd: 'C:/Users/someone/secret-repo' } },
}
const graph = pipelineGraph(config)
const brief = orchestrationBrief({ config, graph })

test('the role lines are the Agents page wording, word for word (MUST CHANGE IN LOCKSTEP)', () => {
  const window = {}
  vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', 'pipeline-details.js'), 'utf8'), { window })
  assert.deepEqual({ ...ROLE }, { ...window.PipelineDetails.ROLE })
})

test('it says what the system is: a coordinator hands work out, QA tests every change and is the only one that pushes', () => {
  assert.match(brief, /Master/)
  assert.match(brief, /coordinator/i)
  assert.match(brief, /QA[^.]*only one that pushes/)
  assert.match(brief, /back to the producer/)
})

test('every agent is named with its role line', () => {
  for (const n of graph.nodes) {
    assert.ok(brief.includes(n.label), n.label)
    assert.ok(brief.includes(ROLE[n.role]), `${n.label}: ${n.role}`)
  }
})

test('the three flow types, with the build and review routes in planRoute order', () => {
  const label = id => graph.nodes.find(n => n.id === id).label
  const build = planRoute('build', 'Agent 1', graph).steps.map(label)
  const line = brief.split('\n').find(l => l.startsWith('- build'))
  assert.ok(line, 'a build line')
  let at = 0
  for (const step of build.map(s => (s === 'Agent 1' ? 'the producer' : s))) {
    const i = line.indexOf(step, at)
    assert.ok(i >= at, `${step} in order in: ${line}`)
    at = i + step.length
  }
  assert.match(line, /Agent 1, Agent 2 or Agent 3/)
  assert.match(brief, /^- review[^\n]*Request, Independent, Output/m)
  assert.match(brief, /^- ask[^\n]*Request, the agent asked, Output/m)
})

test('the QA rules come from the pipeline settings', () => {
  assert.match(brief, /at most 2 times/)
  assert.match(brief, /dev, stage, main, release\/\*/)
})

test('the pages, one line each, and what the dashboard is built with', () => {
  for (const page of ['Flows', 'Home', 'QA', 'Generators', 'Tickets', 'Timeline', 'Agents', 'Subagents', 'Glossary', 'Settings']) {
    assert.match(brief, new RegExp(`^- ${page}: `, 'm'), page)
  }
  assert.match(brief, /Node(\.js)? 20/)
  assert.match(brief, /no framework and no build step/)
  assert.match(brief, /node:test/)
})

test('nothing private: no paths, no ids, no PIN hash, no account', () => {
  for (const secret of ['C:/', 'someone', 'secret-repo', 'af7d2f74', 'd75abf38', '0DyNNJSHFeSDwPGW', 'scrypt', 'deadbeef', 'claude-account2', 'flinki-a9']) {
    assert.ok(!brief.includes(secret), secret)
  }
})

test('extras are appended as their own sections, scrubbed of anything private', () => {
  const out = orchestrationBrief({ config, graph, extras: [
    { title: 'Agent rules', text: 'Agent 1 owns the web app. Logs are in C:\\Users\\someone\\logs and /home/someone/x.' },
    { title: 'Scorecard', text: 'Mail me at someone@example.com, key sk-ant-abcdefghijklmnop0123456789.' },
  ] })
  assert.ok(out.startsWith(brief))
  assert.match(out, /### Agent rules\nAgent 1 owns the web app\./)
  assert.match(out, /### Scorecard\n/)
  for (const bad of ['C:\\Users', '/home/someone', 'someone@example.com', 'sk-ant-abcdefghijklmnop']) assert.ok(!out.includes(bad), bad)
  assert.match(out, /\[removed\]/)
})

test('scrub keeps ordinary words, labels and branch patterns', () => {
  assert.equal(scrub('Agent 1 pushes release/* and dev, about 3/4 done.'), 'Agent 1 pushes release/* and dev, about 3/4 done.')
})

test('it stays at most 8,000 characters, and says when it was cut', () => {
  assert.equal(BRIEF_MAX, 8_000)
  assert.ok(brief.length < BRIEF_MAX)
  const long = orchestrationBrief({ config, graph, extras: [{ title: 'Long', text: 'word '.repeat(4_000) }] })
  assert.ok(long.length <= BRIEF_MAX)
  assert.match(long, /\[The rest was cut to fit 8,000 characters\.\]$/)
})

test('a small config (no producers, no chat agent) still reads sensibly', () => {
  const small = { coordinator: 'Lead', coordinatorLabel: 'Lead', codingAgents: { Lead: 'Lead' } }
  const out = orchestrationBrief({ config: small, graph: pipelineGraph(small) })
  assert.match(out, /^- build[^\n]*Request, Lead, QA, Push, Output/m)
  assert.match(out, /^- review[^\n]*no chat agent/m)
  assert.match(out, /at most 3 times/)
})
