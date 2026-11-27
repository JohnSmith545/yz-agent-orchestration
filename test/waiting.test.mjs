// Sessions waiting on the user (waiting.mjs): what the Notification hook records, and when a recorded wait
// still stands. Pure parts run on plain values; the hook runs as a child process on a temp data folder.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { lastReplyText, nextWait, readWaits, resumedIn, standingWaits, waitKind, KEEP_DAYS } from '../waiting.mjs'

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

test('nextWait records where the transcript ended, and when', () => {
  const now = Date.parse('2026-11-26T10:00:00Z')
  const got = nextWait(null, { session_id: 's1', transcript_path: 'C:/t.jsonl', cwd: 'C:/repo' }, { kind: 'permission', reason: 'Bash' }, { size: 42, now, prevResumed: true })
  assert.deepEqual(got, { kind: 'permission', reason: 'Bash', at: '2026-11-26T10:00:00.000Z', size: 42, transcript: 'C:/t.jsonl', cwd: 'C:/repo' })
})

// review: Stop then an idle prompt (or PermissionRequest then a permission Notification) recorded one wait twice,
// with a new time, so the page raised a second sticky toast for the same question
test('nextWait keeps the same wait that still stands (no new time, no second alert); a resumed or different one is new', () => {
  const prev = { kind: 'question', reason: 'Ship it?', at: '2026-11-26T09:00:00.000Z', size: 10, transcript: 'T', cwd: '' }
  const input = { session_id: 's1', transcript_path: 'T' }
  const now = Date.parse('2026-11-26T09:01:00Z')
  assert.equal(nextWait(prev, input, { kind: 'question', reason: 'Ship it?' }, { size: 20, now, prevResumed: false }), null)
  assert.equal(nextWait(prev, input, { kind: 'question', reason: 'Ship it?' }, { size: 20, now, prevResumed: true }).at, '2026-11-26T09:01:00.000Z')
  assert.equal(nextWait(prev, input, { kind: 'permission', reason: 'Needs your OK to use Bash' }, { size: 20, now, prevResumed: false }).kind, 'permission')
})

// ═══ the hook itself ═══

function runHook(input, dataDir) {
  return spawnSync(process.execPath, [HOOK], { input: typeof input === 'string' ? input : JSON.stringify(input), env: { ...process.env, FACTORY_DATA_DIR: dataDir }, encoding: 'utf8' })
}

test('the hook records a permission wait in data/waiting/<session>.json, with the transcript size at that moment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waiting-'))
  const transcript = path.join(dir, 't.jsonl')
  fs.writeFileSync(transcript, said('Running the tests now.'))
  const r = runHook({ session_id: 'abc', transcript_path: transcript, cwd: 'C:/repo', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, dir)
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
  const saved = readWaits(path.join(dir, 'waiting'))
  assert.equal(saved.abc.kind, 'permission')
  assert.equal(saved.abc.size, fs.statSync(transcript).size)
})

test('the hook records nothing for an idle session whose last reply asked nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waiting-'))
  const transcript = path.join(dir, 't.jsonl')
  fs.writeFileSync(transcript, said('Merged and live.'))
  const r = runHook({ session_id: 'abc', transcript_path: transcript, notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }, dir)
  assert.equal(r.status, 0)
  assert.deepEqual(readWaits(path.join(dir, 'waiting')), {})
})

test('the hook fails open: bad input or a missing transcript exits 0 with no output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waiting-'))
  for (const input of ['not json', { session_id: 'x', transcript_path: path.join(dir, 'missing.jsonl'), notification_type: 'idle_prompt' }]) {
    const r = runHook(input, dir)
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
  }
})

// review: every hook read the one shared file, changed it and wrote it back, so two at once lost a wait
test('two sessions stopping at the same moment both keep their wait (one file per session)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waiting-'))
  const transcript = path.join(dir, 't.jsonl')
  fs.writeFileSync(transcript, said('Ready?'))
  const { spawn } = await import('node:child_process')
  const run = id => new Promise(res => {
    const c = spawn(process.execPath, [HOOK], { env: { ...process.env, FACTORY_DATA_DIR: dir } })
    c.on('exit', res)
    c.stdin.end(JSON.stringify({ session_id: id, transcript_path: transcript, hook_event_name: 'Stop', last_assistant_message: 'Ready?' }))
  })
  await Promise.all(['s-1', 's-2', 's-3', 's-4'].map(run))
  assert.deepEqual(Object.keys(readWaits(path.join(dir, 'waiting'))).sort(), ['s-1', 's-2', 's-3', 's-4'])
})

test('the hook keeps the first time of a wait that is recorded again while it still stands', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waiting-'))
  const transcript = path.join(dir, 't.jsonl')
  fs.writeFileSync(transcript, said('Ship it?'))
  const input = { session_id: 'abc', transcript_path: transcript, hook_event_name: 'Stop', last_assistant_message: 'Ship it?' }
  runHook(input, dir)
  const first = readWaits(path.join(dir, 'waiting')).abc.at
  fs.appendFileSync(transcript, hookNote())
  runHook({ ...input, hook_event_name: 'Notification', notification_type: 'idle_prompt', last_assistant_message: undefined }, dir)
  assert.equal(readWaits(path.join(dir, 'waiting')).abc.at, first)
})

test('a session id that is not a plain id is never used as a file name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waiting-'))
  const transcript = path.join(dir, 't.jsonl')
  fs.writeFileSync(transcript, said('Ready?'))
  runHook({ session_id: '../../evil', transcript_path: transcript, hook_event_name: 'Stop', last_assistant_message: 'Ready?' }, dir)
  assert.deepEqual(readWaits(path.join(dir, 'waiting')), {})
  assert.equal(fs.existsSync(path.join(dir, 'evil.json')), false)
})

// review: one assistant message with two tool calls writes a line per block, and a later block cleared a
// permission wait while its dialog was still open
test('a permission wait clears only on a user line (the tool result after Approve or Deny), never on an assistant line', () => {
  const block = line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', name: 'Edit' }] } })
  assert.equal(resumedIn(block, 'permission'), false)
  assert.equal(resumedIn(block + toolResult(), 'permission'), true)
  assert.equal(resumedIn(said('Got it.'), 'question'), true)
})

test('standingWaits keeps a permission wait while later blocks of the same message are written', () => {
  const entries = { a: { kind: 'permission', reason: 'Needs your OK to use Bash', at: '2026-11-26T09:00:00.000Z', size: 1, transcript: 'A' } }
  const block = line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', name: 'Edit' }] } })
  assert.equal(standingWaits(entries, [{ sessionId: 'a', label: 'A' }], () => block).length, 1)
})

// review: common endings were missed: a bold question, or one in quotes or brackets
test('a reply ending in a bold, quoted or bracketed question still counts as a question', () => {
  for (const reply of ['**Want me to open the PR?**', 'Ship it?"', 'Ship it? )', 'Merge _now?_']) assert.equal(waitKind({ hook_event_name: 'Stop' }, reply)?.kind, 'question', reply)
  assert.equal(waitKind({ hook_event_name: 'Stop' }, 'Done. Merged.'), null)
})

// ═══ standingWaits: the waits the pages show ═══

test('standingWaits keeps a live session whose transcript did not move on, newest first, with its label', () => {
  const entries = {
    a: { kind: 'permission', reason: 'Claude needs your permission to use Bash', at: '2026-11-26T09:00:00.000Z', size: 10, transcript: 'A' },
    b: { kind: 'question', reason: 'Shall I start?', at: '2026-11-26T10:00:00.000Z', size: 20, transcript: 'B' },
  }
  const tails = { A: hookNote(), B: '' }
  const got = standingWaits(entries, [{ sessionId: 'a', label: 'Coordinator' }, { sessionId: 'b', label: 'Retesting' }], (file, size) => tails[file])
  assert.deepEqual(got.map(w => [w.sessionId, w.label, w.kind]), [['b', 'Retesting', 'question'], ['a', 'Coordinator', 'permission']])
  assert.equal(got[0].reason, 'Shall I start?')
  assert.equal(got[0].at, '2026-11-26T10:00:00.000Z')
})

test('standingWaits drops a wait once the session moved on, a closed session, and an unreadable transcript', () => {
  const entries = { a: { kind: 'question', at: '2026-11-26T09:00:00.000Z', size: 1, transcript: 'A' }, b: { kind: 'question', at: '2026-11-26T09:00:00.000Z', size: 1, transcript: 'B' }, gone: { kind: 'question', at: '2026-11-26T09:00:00.000Z', size: 1, transcript: 'G' } }
  const tails = { A: typed('yes'), B: null, G: '' }
  assert.deepEqual(standingWaits(entries, [{ sessionId: 'a', label: 'A' }, { sessionId: 'b', label: 'B' }], f => tails[f]), [])
})

test('standingWaits reads each transcript from where it ended when the hook ran', () => {
  const seen = []
  standingWaits({ a: { kind: 'question', at: '2026-11-26T09:00:00.000Z', size: 77, transcript: 'A' } }, [{ sessionId: 'a', label: 'A' }], (f, size) => (seen.push([f, size]), ''))
  assert.deepEqual(seen, [['A', 77]])
})

// ═══ Stop and PermissionRequest: the events the VS Code extension fires (it sends no Notification) ═══

test('a Stop after a reply that ends with a question is a question wait; any other Stop is none', () => {
  assert.deepEqual(waitKind({ hook_event_name: 'Stop' }, 'Done.\n\nShall I merge it?'), { kind: 'question', reason: 'Shall I merge it?' })
  assert.equal(waitKind({ hook_event_name: 'Stop' }, 'Merged and live.'), null)
})

test('a Stop prefers the reply the hook was handed over the transcript tail (the last line may not be written yet)', () => {
  assert.equal(waitKind({ hook_event_name: 'Stop', last_assistant_message: 'Go ahead?' }, 'Older text.').kind, 'question')
  assert.equal(waitKind({ hook_event_name: 'Stop', last_assistant_message: 'All done.' }, 'Older question?'), null)
})

test('a PermissionRequest is a permission wait naming the tool', () => {
  assert.deepEqual(waitKind({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' }, ''), { kind: 'permission', reason: 'Needs your OK to use Bash' })
  assert.deepEqual(waitKind({ hook_event_name: 'PermissionRequest' }, ''), { kind: 'permission', reason: 'Needs your OK to go on' })
})

test('the hook records a question on Stop from the reply it was handed, and prints nothing so the stop goes ahead', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waiting-'))
  const transcript = path.join(dir, 't.jsonl')
  fs.writeFileSync(transcript, typed('hi'))
  const r = runHook({ session_id: 's9', transcript_path: transcript, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Shall I start?' }, dir)
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
  assert.equal(readWaits(path.join(dir, 'waiting')).s9.reason, 'Shall I start?')
})

test('resumedIn is true once the session writes a new reply of its own after the wait (a message answered without tools)', () => {
  assert.equal(resumedIn(said('Got it, building now.')), true)
})
