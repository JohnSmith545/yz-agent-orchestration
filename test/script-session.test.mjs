// Tests for the live-session context (script-session.mjs): transcript records become plain "User:" and
// "Assistant:" turns, text only (no tools, no thinking, no injected blocks), the newest that fit in 12,000
// characters; the tail of a big transcript is read from its end; and a session that is not running, or
// whose transcript cannot be read, is skipped with a plain reason, never an error.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { sessionText, readTail, sessionPart, SESSION_MAX } = await import('../script-session.mjs')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'script-session-test-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const human = text => ({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text }] } })
const said = (...content) => ({ type: 'assistant', message: { role: 'assistant', content } })
const txt = text => ({ type: 'text', text })

test('user and assistant text become plain turns, oldest first, with a blank line between', () => {
  const out = sessionText([human('Add a dark mode.'), said(txt('On it.')), human('Thanks'), said(txt('Done.'))])
  assert.equal(out, 'User: Add a dark mode.\n\nAssistant: On it.\n\nUser: Thanks\n\nAssistant: Done.')
  assert.equal(SESSION_MAX, 12_000)
})

test('a user turn as a plain string, and an older record with no origin, both count', () => {
  const out = sessionText([{ type: 'user', message: { content: 'Typed long ago.' } }, said(txt('Yes.'))])
  assert.equal(out, 'User: Typed long ago.\n\nAssistant: Yes.')
})

test('no tool calls, no tool results, no thinking: text parts only', () => {
  const out = sessionText([
    human('Run the tests.'),
    said({ type: 'thinking', thinking: 'secret reasoning' }, txt('Running them.'), { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ALL OUTPUT' }] } },
    said(txt('All green.')),
  ])
  assert.equal(out, 'User: Run the tests.\n\nAssistant: Running them.\n\nAll green.')
  assert.doesNotMatch(out, /secret reasoning|npm test|ALL OUTPUT/)
})

test('injected blocks are left out: system reminders, commands, peer messages, task notices, meta, side chains and summaries', () => {
  const out = sessionText([
    human('Fix it<system-reminder>hidden rules</system-reminder>'),
    human('<command-name>/clear</command-name>'),
    { type: 'user', isMeta: true, origin: { kind: 'peer' }, message: { content: 'Another Claude session sent a message: do X' } },
    { type: 'user', origin: { kind: 'task-notification' }, message: { content: '<task-notification>done</task-notification>' } },
    { type: 'user', isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation' } },
    { type: 'user', isSidechain: true, message: { content: 'subagent prompt' } },
    said(txt('Fixed.')),
    { type: 'assistant', isSidechain: true, message: { content: [txt('subagent words')] } },
    { type: 'attachment', rendered: [{ content: 'attached' }] },
    { type: 'system', content: 'system note' },
    human('[Request interrupted by user]'),
  ])
  assert.equal(out, 'User: Fix it\n\nAssistant: Fixed.')
})

test('the newest turns that fit in the cap are kept; the oldest go first', () => {
  const entries = []
  for (let i = 0; i < 10; i++) entries.push(human(`question ${i} ` + 'q'.repeat(2_000)), said(txt(`answer ${i}`)))
  const out = sessionText(entries)
  assert.ok(out.length <= SESSION_MAX)
  assert.match(out, /answer 9$/)
  assert.doesNotMatch(out, /question 0 /)
  assert.ok(out.startsWith('User: question') || out.startsWith('Assistant: answer'))
})

test('a newest turn bigger than the cap on its own keeps its end, marked as cut', () => {
  const out = sessionText([human('old'), said(txt('x'.repeat(20_000) + 'THE END'))], 1_000)
  assert.ok(out.length <= 1_000)
  assert.ok(out.startsWith('Assistant: [earlier part cut] '))
  assert.ok(out.endsWith('THE END'))
})

test('nothing said yet is empty text', () => {
  assert.equal(sessionText([]), '')
  assert.equal(sessionText([said({ type: 'tool_use', name: 'Read', input: {} })]), '')
})

test('readTail reads the last bytes of a transcript, drops the cut first line, and skips lines that are not JSON', async () => {
  const file = path.join(TMP, 'big.jsonl')
  const lines = [JSON.stringify(human('first ' + 'a'.repeat(500))), 'not json', JSON.stringify(said(txt('second'))), JSON.stringify(human('third'))]
  fs.writeFileSync(file, lines.join('\n') + '\n')
  assert.deepEqual((await readTail(file)).map(r => r.type), ['user', 'assistant', 'user'])
  const tail = await readTail(file, lines[2].length + lines[3].length + 2 + 3) // starts 3 bytes into the 'not json' line
  assert.deepEqual(tail.map(r => r.message.content[0].text), ['second', 'third'])
})

test('sessionPart: the chosen running session becomes a part titled by its label, kept by its end when cut', async () => {
  const file = path.join(TMP, 'master.jsonl')
  fs.writeFileSync(file, [human('Plan the release.'), said(txt('Here is the plan.'))].map(r => JSON.stringify(r)).join('\n'))
  const sessions = async () => [{ label: 'Master', state: 'working', transcript: async () => file }]
  assert.deepEqual(await sessionPart('Master', { sessions }), {
    part: { title: 'Live session: Master', text: 'User: Plan the release.\n\nAssistant: Here is the plan.', keep: 'end' },
  })
})

test('sessionPart skips with a plain reason, never throws', async () => {
  const none = async () => []
  assert.deepEqual(await sessionPart('Agent 1', { sessions: none }), { skipped: { title: 'Live session: Agent 1', why: 'Agent 1 is not running now.' } })
  const gone = async () => [{ label: 'Agent 1', state: 'idle', transcript: async () => path.join(TMP, 'missing.jsonl') }]
  assert.deepEqual(await sessionPart('Agent 1', { sessions: gone }), { skipped: { title: 'Live session: Agent 1', why: 'Its conversation could not be read.' } })
  const noFile = async () => [{ label: 'Agent 1', state: 'idle', transcript: async () => null }]
  assert.equal((await sessionPart('Agent 1', { sessions: noFile })).skipped.why, 'Its conversation could not be read.')
  const boom = async () => {
    throw new Error('registry broke')
  }
  assert.equal((await sessionPart('Agent 1', { sessions: boom })).skipped.why, 'The running sessions could not be listed.')
  const empty = path.join(TMP, 'empty.jsonl')
  fs.writeFileSync(empty, JSON.stringify(said({ type: 'tool_use', name: 'Read', input: {} })))
  const quiet = async () => [{ label: 'Agent 1', state: 'idle', transcript: async () => empty }]
  assert.equal((await sessionPart('Agent 1', { sessions: quiet })).skipped.why, 'It has no conversation to share yet.')
})
