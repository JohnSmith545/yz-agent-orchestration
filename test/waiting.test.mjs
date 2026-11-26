// Sessions waiting on the user (waiting.mjs): what the Notification hook records, and when a recorded wait
// still stands. Pure parts run on plain values; the hook runs as a child process on a temp data folder.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { lastReplyText, recordWait, resumedIn, waitKind, KEEP_DAYS } from '../waiting.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOOK = path.join(HERE, '..', 'tools', 'waiting-hook.mjs')
const line = o => JSON.stringify(o) + '\n'
const said = text => line({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const typed = text => line({ type: 'user', message: { content: text } })
const toolResult = () => line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } })
const hookNote = () => line({ type: 'attachment', attachment: { type: 'hook_success' } })

// ═══ waitKind: which notifications mean the session waits on the user ═══

test('a permission prompt is a wait for permission, with the message as its reason', () => {
  assert.deepEqual(waitKind({ notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, ''), {
    kind: 'permission',
    reason: 'Claude needs your permission to use Bash',
  })
})

test('an idle prompt is a question only when the last reply ends with a question mark', () => {
  const idle = { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }
  assert.deepEqual(waitKind(idle, 'Shall I start?'), { kind: 'question', reason: 'Shall I start?' })
  assert.equal(waitKind(idle, 'All done, merged and live.'), null)
  assert.equal(waitKind(idle, ''), null)
})

test('a question reason is the last line of the reply, cut to 140 characters', () => {
  const long = 'Intro paragraph.\n\nWhich one ' + 'really '.repeat(40) + 'do you want?'
  const got = waitKind({ notification_type: 'idle_prompt' }, long)
  assert.ok(got.reason.startsWith('Which one'))
  assert.ok(got.reason.length <= 140)
})

test('an MCP input dialog is a question; auth and unknown notifications are not waits', () => {
  assert.equal(waitKind({ notification_type: 'elicitation_dialog', message: 'Pick a project' }, '').kind, 'question')
  assert.equal(waitKind({ notification_type: 'auth_success', message: 'Signed in' }, ''), null)
  assert.equal(waitKind({ message: 'something else' }, ''), null)
})

test('with no notification_type the message decides (older Claude Code)', () => {
  assert.equal(waitKind({ message: 'Claude needs your permission to use Edit' }, '').kind, 'permission')
  assert.equal(waitKind({ message: 'Claude is waiting for your input' }, 'Go ahead?').kind, 'question')
})

// ═══ lastReplyText: the newest reply, unless the user already answered it ═══

test('lastReplyText finds the newest assistant text past hook notes and tool calls', () => {
  const tail = typed('hi') + said('First?') + line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }) + toolResult() + said('Done. Want the PR?') + hookNote()
  assert.equal(lastReplyText(tail), 'Done. Want the PR?')
})

test('lastReplyText is empty when the user typed after the newest reply, or the tail is junk', () => {
  assert.equal(lastReplyText(said('Ready?') + typed('yes')), '')
  assert.equal(lastReplyText('not json\n{broken'), '')
})

// ═══ resumedIn: the bytes written after the wait show the session moved on ═══

test('resumedIn is true once the user replies or a tool result lands (approved or denied)', () => {
  assert.equal(resumedIn(typed('yes go')), true)
  assert.equal(resumedIn(hookNote() + toolResult()), true)
})

test('resumedIn ignores hook notes, meta lines and partial lines written while it waits', () => {
  assert.equal(resumedIn(hookNote() + line({ type: 'user', isMeta: true, message: { content: 'caveat' } }) + '{"type":"us'), false)
  assert.equal(resumedIn(''), false)
})

// ═══ recordWait: one entry per session, old ones pruned ═══

test('recordWait keeps one entry per session with where its transcript ended, and drops week-old ones', () => {
  const now = Date.parse('2026-11-26T10:00:00Z')
  const old = new Date(now - (KEEP_DAYS + 1) * 86_400_000).toISOString()
  const entries = { stale: { at: old, kind: 'question' }, s1: { at: old, kind: 'question' } }
  const next = recordWait(entries, { session_id: 's1', transcript_path: 'C:/t.jsonl', cwd: 'C:/repo' }, { kind: 'permission', reason: 'Bash' }, { size: 42, now })
  assert.deepEqual(Object.keys(next), ['s1'])
  assert.deepEqual(next.s1, { kind: 'permission', reason: 'Bash', at: '2026-11-26T10:00:00.000Z', size: 42, transcript: 'C:/t.jsonl', cwd: 'C:/repo' })
  assert.equal(entries.s1.kind, 'question', 'the input is not changed')
})

// ═══ the hook itself ═══

function runHook(input, dataDir) {
  return spawnSync(process.execPath, [HOOK], { input: typeof input === 'string' ? input : JSON.stringify(input), env: { ...process.env, FACTORY_DATA_DIR: dataDir }, encoding: 'utf8' })
}

test('the hook records a permission wait in data/waiting.json, with the transcript size at that moment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waiting-'))
  const transcript = path.join(dir, 't.jsonl')
  fs.writeFileSync(transcript, said('Running the tests now.'))
  const r = runHook({ session_id: 'abc', transcript_path: transcript, cwd: 'C:/repo', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, dir)
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'waiting.json'), 'utf8'))
  assert.equal(saved.abc.kind, 'permission')
  assert.equal(saved.abc.size, fs.statSync(transcript).size)
})

test('the hook records nothing for an idle session whose last reply asked nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waiting-'))
  const transcript = path.join(dir, 't.jsonl')
  fs.writeFileSync(transcript, said('Merged and live.'))
  const r = runHook({ session_id: 'abc', transcript_path: transcript, notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }, dir)
  assert.equal(r.status, 0)
  assert.equal(fs.existsSync(path.join(dir, 'waiting.json')), false)
})

test('the hook fails open: bad input or a missing transcript exits 0 with no output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waiting-'))
  for (const input of ['not json', { session_id: 'x', transcript_path: path.join(dir, 'missing.jsonl'), notification_type: 'idle_prompt' }]) {
    const r = runHook(input, dir)
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
  }
})
