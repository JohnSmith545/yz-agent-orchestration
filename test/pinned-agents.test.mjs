// Tests for pinned-agents.mjs: a pinned agent whose session is closed is still listed, idle,
// so the Agents tree and the Flow diagrams keep drawing it from its saved history.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

const { pinnedSessions } = await import('../pinned-agents.mjs')

const A1 = { sessionId: 'aaa', cwd: 'C:/repo', claudeDir: 'C:/Users/me/.claude-second' }

test('no pins, no extra sessions', () => {
  assert.deepEqual(pinnedSessions(undefined, new Set()), [])
  assert.deepEqual(pinnedSessions({}, new Set()), [])
})

test('a closed pinned session is listed idle, with its Claude folder resolved', () => {
  assert.deepEqual(pinnedSessions({ 'Agent 1': A1 }, new Set()), [
    { name: 'Agent 1', sessionId: 'aaa', cwd: 'C:/repo', status: 'idle', pinned: true, _claudeDir: path.resolve(A1.claudeDir) },
  ])
})

test('a pinned session that is live is not listed twice', () => {
  assert.deepEqual(pinnedSessions({ 'Agent 1': A1 }, new Set(['aaa'])), [])
})

test('a pin without a session id or a cwd is skipped, and no claudeDir leaves it undefined', () => {
  const out = pinnedSessions({ a: { cwd: 'x' }, b: { sessionId: 's' }, c: null, d: { sessionId: 'd1', cwd: 'y' } }, new Set())
  assert.deepEqual(out, [{ name: 'd', sessionId: 'd1', cwd: 'y', status: 'idle', pinned: true, _claudeDir: undefined }])
})
