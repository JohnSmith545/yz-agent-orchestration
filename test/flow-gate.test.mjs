// Tests for tools/flow-gate.mjs, the stop check for a Claude Code Stop or
// SubagentStop hook: an agent that committed is sent back until a flow of its
// own has a story and a visual, and anything else (already sent back once, no
// commit, any error) lets it stop. The script runs as a real process with the
// hook JSON on stdin, over the synthetic transcripts in test/fixtures/subagents
// and flows written to a temp data folder (FACTORY_DATA_DIR), never the real one.

import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const GATE = path.join(ROOT, 'tools', 'flow-gate.mjs')
const G = await import('../tools/flow-gate.mjs') // its pure parts; the check itself is run as a command below
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-gate-test-'))
const FLOWS = path.join(DATA, 'flows')
const PROJECT = path.join(HERE, 'fixtures', 'subagents', 'claude', 'projects', 'C--path-to-your-repo')
after(() => fs.rmSync(DATA, { recursive: true, force: true }))
beforeEach(() => {
  fs.rmSync(FLOWS, { recursive: true, force: true })
  fs.mkdirSync(FLOWS, { recursive: true })
})

// dark-mode.json has a story, a result shot and a diagram; the fixtures' transcripts start on 2026-11-12 at 09:00 UTC or later.
const DARK = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'dark-mode.json'), 'utf8'))
const LATER = '2026-11-12T23:00:00Z'
/** Stores the fixture flow (always as `dark-mode`, where its screenshot refs point) with the given changes. */
function flow(over = {}) {
  fs.writeFileSync(path.join(FLOWS, 'dark-mode.json'), JSON.stringify({ ...structuredClone(DARK), updatedAt: LATER, ...over }))
}

/** Runs the script with `input` on stdin: { code, out, err, decision }. */
function gate(input, env = {}) {
  const r = spawnSync(process.execPath, [GATE], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: { ...process.env, FACTORY_DATA_DIR: DATA, ...env } })
  let decision = null
  try {
    decision = JSON.parse(r.stdout)
  } catch {}
  return { code: r.status, out: r.stdout, err: r.stderr, decision }
}
const SESSION = path.join(PROJECT, 'sess-live.jsonl')
const subagent = (id, over = {}) => ({ session_id: 'sess-live', transcript_path: SESSION, stop_hook_active: false, agent_id: id, ...over })
const session = (over = {}) => ({ session_id: 'sess-gate', transcript_path: path.join(PROJECT, 'sess-gate.jsonl'), stop_hook_active: false, ...over })
const passes = r => {
  assert.equal(r.code, 0)
  assert.equal(r.out, '', 'nothing printed: the agent may stop')
}

// ═══ it blocks ═══

test('a subagent that committed and recorded no flow is sent back, with the commands and the path of this dashboard', () => {
  const r = gate(subagent('b1'))
  assert.equal(r.code, 0)
  assert.deepEqual(Object.keys(r.decision), ['decision', 'reason'])
  assert.equal(r.decision.decision, 'block')
  const abs = ROOT.replace(/\\/g, '/')
  assert.equal(r.decision.reason, `Record your flow before finishing: flow say, flow diagram or flow result, flow test-step (node ${abs}/tools/factory.mjs flow ... --by "Build ABC-101 dark mode toggle").`, 'it is told the exact name to sign with: its task name')
  assert.ok(path.isAbsolute(abs))
})

test('a session (no agent_id) that committed and whose flow has no story or picture yet is sent back', () => {
  flow({ id: 'dark-mode', agent: 'Agent 9', output: {} })
  const r = gate(session())
  assert.equal(r.decision?.decision, 'block')
  assert.ok(r.decision.reason.endsWith(' --by "Agent 9").'), 'with no session name on record, the name it already signed with')
})

// ═══ the name it is told to sign with ═══

test('reasonFor: the name goes in as --by, a name with double quotes is still one argument, and no name leaves the line as it was', () => {
  assert.equal(G.reasonFor(''), G.REASON)
  assert.equal(G.reasonFor(null), G.REASON)
  assert.ok(G.REASON.endsWith('flow ...).'))
  assert.ok(G.reasonFor('Build the export').endsWith('flow ... --by "Build the export").'))
  assert.ok(G.reasonFor('Fix the "Join" button').endsWith(` --by "Fix the 'Join' button").`))
  assert.ok(G.reasonFor('  Line one\nline two  ').endsWith(' --by "Line one line two").'))
})

test('sessionName: a session is named by the registry next to its transcripts; unknown, unnamed or unreadable is no name', () => {
  const claude = path.join(DATA, 'claude-names')
  const project = path.join(claude, 'projects', 'C--path-to-your-repo')
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(path.join(claude, 'sessions'), { recursive: true })
  fs.writeFileSync(path.join(claude, 'sessions', '101.json'), JSON.stringify({ pid: 101, sessionId: 'sess-a', cwd: 'C:/path/to/your-repo', name: 'Coordinator' }))
  fs.writeFileSync(path.join(claude, 'sessions', '102.json'), JSON.stringify({ pid: 102, sessionId: 'sess-b', cwd: 'C:/path/to/your-repo' }))
  fs.writeFileSync(path.join(claude, 'sessions', '103.json'), 'not json')
  fs.writeFileSync(path.join(claude, 'sessions', '101.key'), 'never read')
  assert.equal(G.sessionName(path.join(project, 'sess-a.jsonl'), 'sess-a'), 'Coordinator')
  assert.equal(G.sessionName(path.join(project, 'sess-b.jsonl'), 'sess-b'), '')
  assert.equal(G.sessionName(path.join(project, 'sess-z.jsonl'), 'sess-z'), '')
  assert.equal(G.sessionName(path.join(project, 'sess-a.jsonl'), ''), '')
  assert.equal(G.sessionName('', 'sess-a'), '')
})

test('a flow with a story but no picture, or a picture but no story, is not enough', () => {
  flow({ agent: 'Build ABC-101 dark mode toggle', output: { story: DARK.output.story } })
  assert.equal(gate(subagent('b1')).decision?.decision, 'block')
  flow({ agent: 'Build ABC-101 dark mode toggle', output: { diagram: DARK.output.diagram } })
  assert.equal(gate(subagent('b1')).decision?.decision, 'block')
})

test('a complete flow by another agent, a dropped one, or one last written before this work began, does not count', () => {
  flow({ agent: 'Agent 3' })
  assert.equal(gate(subagent('b1')).decision?.decision, 'block', 'someone else wrote it')
  flow({ agent: 'Build ABC-101 dark mode toggle', status: 'dropped' })
  assert.equal(gate(subagent('b1')).decision?.decision, 'block', 'dropped')
  flow({ agent: 'Build ABC-101 dark mode toggle', updatedAt: '2026-11-01T09:00:00Z' })
  assert.equal(gate(subagent('b1')).decision?.decision, 'block', 'older than the work')
})

// ═══ it lets the agent stop ═══

test('a subagent whose flow, written under its task name, has a story and a picture may stop', () => {
  flow({ agent: 'Build ABC-101 dark mode toggle' })
  passes(gate(subagent('b1')))
})

test('a session whose flow is by the name it gave its flow commands may stop, whatever the case of the name', () => {
  flow({ agent: 'Agent 9' })
  passes(gate(session()))
  flow({ agent: 'agent 9' })
  passes(gate(session()))
})

test('a session may stop on the flow its own flow commands wrote, even under another name', () => {
  // the fixture session ran `flow new gate-flow` and `flow say gate-flow`; no screenshots here, so no refs to another folder
  const nodes = DARK.nodes.map(n => (n.evidence ? { ...n, evidence: n.evidence.filter(e => e.kind !== 'shot') } : n))
  const own = { ...structuredClone(DARK), id: 'gate-flow', agent: 'Someone else', updatedAt: LATER, nodes, output: { story: DARK.output.story, diagram: DARK.output.diagram } }
  fs.writeFileSync(path.join(FLOWS, 'gate-flow.json'), JSON.stringify(own))
  passes(gate(session()))
})

test('a flow the user ARCHIVED still counts: archiving hides it from the board, it does not undo the telling', () => {
  flow({ agent: 'Build ABC-101 dark mode toggle', archivedAt: '2026-11-14T09:00:00.000Z' })
  passes(gate(subagent('b1')))
})

test('an agent whose own flow the user DELETED is not sent back to record it again: the flow is in the Trash', () => {
  // the fixture session ran its flow commands on gate-flow; the user then deleted that flow
  const trash = path.join(DATA, 'trash')
  fs.mkdirSync(trash, { recursive: true })
  fs.writeFileSync(path.join(trash, 'gate-flow.json'), JSON.stringify({ deletedAt: new Date().toISOString(), flow: { ...structuredClone(DARK), id: 'gate-flow' } }))
  try {
    passes(gate(session()))
  } finally {
    fs.rmSync(trash, { recursive: true, force: true })
  }
  assert.equal(gate(session()).decision?.decision, 'block', 'with no Trash entry the same session is sent back')
})

test('never when stop_hook_active is true: an agent already sent back once is let go', () => {
  passes(gate(subagent('b1', { stop_hook_active: true })))
  passes(gate(session({ stop_hook_active: true })))
})

test('never when nothing was committed: a lookup, a failed commit, a commit still running', () => {
  for (const id of ['l1', 'f1', 'w1', 's1']) passes(gate(subagent(id)))
})

test('a subagent is read from its own transcript: agent_transcript_path when the hook gives it, else next to the session', () => {
  const own = path.join(PROJECT, 'sess-live', 'subagents', 'agent-l1.jsonl')
  passes(gate(subagent('b1', { agent_transcript_path: own })))
  assert.equal(gate(subagent('zz', { agent_transcript_path: path.join(PROJECT, 'sess-live', 'subagents', 'agent-b1.jsonl') })).decision?.decision, 'block')
})

// ═══ it fails open ═══

test('any error lets the agent stop: no input, input that is not JSON, not an object, no transcript, a transcript that is not there', () => {
  for (const input of ['', 'not json', '[]', 'null', '42', '{}', JSON.stringify({ transcript_path: 12 }), JSON.stringify({ transcript_path: path.join(PROJECT, 'nope.jsonl') }), JSON.stringify(subagent('nope'))]) {
    const r = gate(input)
    passes(r)
    assert.equal(r.err, '', 'and it says nothing on stderr')
  }
})

test('a data folder with no flows at all reads as no flow: the agent that committed is sent back', () => {
  assert.equal(gate(subagent('b1'), { FACTORY_DATA_DIR: path.join(DATA, 'empty') }).decision?.decision, 'block')
})

test('a broken flow file next to a good one does not break the check', () => {
  flow({ agent: 'Build ABC-101 dark mode toggle' })
  fs.writeFileSync(path.join(FLOWS, 'broken.json'), '{ not json')
  passes(gate(subagent('b1')))
})

// ═══ it only reads, and the repo knows about it ═══

test('the script writes nothing and starts no process', () => {
  const src = fs.readFileSync(GATE, 'utf8')
  assert.doesNotMatch(src, /writeFile|appendFile|mkdir|unlink|rmSync|child_process|spawn|exec\(/)
})

test('npm run check covers it, and the README says how to wire it without installing it', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.ok(pkg.scripts.check.includes('node --check tools/flow-gate.mjs'))
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  assert.match(readme, /### The stop check/)
  assert.match(readme, /"SubagentStop"/)
  assert.match(readme, /tools\/flow-gate\.mjs/)
  assert.match(readme, /stop_hook_active/)
})
