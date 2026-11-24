// Tests that the status data carries what the agent window needs from a session's transcript, cheaply: the model its
// newest reply ran on (transcripts.mjs scanTranscript, scan.model) and when each subagent started (listSubagents,
// startedAt). Temp files only.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { listSubagents, scanTranscript } = await import('../transcripts.mjs')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'session-model-test-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const line = r => JSON.stringify(r)
const reply = (model, text = 'ok') => line({ type: 'assistant', message: { model, content: [{ type: 'text', text }] } })

test('scan.model is the model of the newest reply; a synthetic reply does not count; none is null', async () => {
  const file = path.join(TMP, 's.jsonl')
  fs.writeFileSync(file, [reply('claude-sonnet-5-5'), reply('claude-opus-5-5'), reply('<synthetic>')].join('\n') + '\n')
  assert.equal((await scanTranscript(file, '', null)).model, 'claude-opus-5-5')
  fs.appendFileSync(file, reply('claude-haiku-5-5') + '\n')
  assert.equal((await scanTranscript(file, '', null)).model, 'claude-haiku-5-5', 'read again as it grows')
  const none = path.join(TMP, 'none.jsonl')
  fs.writeFileSync(none, line({ type: 'user', message: { content: 'hi' } }) + '\n')
  assert.equal((await scanTranscript(none, '', null)).model, null)
})

test('a running subagent carries startedAt, never after its last write', async () => {
  const session = path.join(TMP, 'sess.jsonl')
  fs.writeFileSync(session, '')
  const dir = path.join(TMP, 'sess', 'subagents')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'agent-a1.meta.json'), JSON.stringify({ description: 'Write the tests', agentType: 'general-purpose' }))
  fs.writeFileSync(path.join(dir, 'agent-a1.jsonl'), reply('claude-opus-5-5') + '\n')
  const [sub] = await listSubagents(session, null)
  assert.equal(sub.description, 'Write the tests')
  assert.ok(!Number.isNaN(Date.parse(sub.startedAt)), sub.startedAt)
  assert.ok(Date.parse(sub.startedAt) <= Date.parse(sub.updatedAt))
})
