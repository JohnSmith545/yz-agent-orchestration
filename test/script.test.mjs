// Tests for the model turn of the Brainstorming page (script.mjs), with its system prompt
// (script-prompt.mjs). Nothing here spawns Claude: generate() takes an injected
// spawn that returns a fake child, and an injected cost recorder.
// FACTORY_DATA_DIR points at a fresh temp folder BEFORE the import, so spend.mjs
// never resolves to the real data/ folder.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'script-test-'))
const { SCRIPT_SYSTEM_PROMPT } = await import('../script-prompt.mjs')
const S = await import('../script.mjs')
after(() => fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true }))

// The system prompt: its rules and its exact text are pinned in test/script-prompt.test.mjs.

// ═══ the argv ═══

test('scriptArgs: headless Opus 5.5 at high effort, the prompt as the system prompt, streamed, and a clean run', () => {
  assert.deepEqual(S.scriptArgs(), [
    '-p', '--model', 'claude-opus-5-5', '--effort', 'high', '--system-prompt', SCRIPT_SYSTEM_PROMPT,
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence', '--name', 'SCRIPT',
  ])
})

test('scriptArgs never carries the user text: it goes on stdin', () => {
  assert.ok(!S.scriptArgs().some(a => a.includes('my idea')))
  assert.ok(!S.scriptArgs().includes('--append-system-prompt'), 'the default system prompt is replaced, not added to')
  assert.ok(!S.scriptArgs().includes('--allowedTools') && !S.scriptArgs().includes('--add-dir'))
})

// ═══ the text check ═══

test('checkText: 1 to 8000 characters of real text, else a plain reason', () => {
  assert.equal(S.checkText('a rough idea'), '')
  assert.equal(S.checkText('x'.repeat(8000)), '')
  assert.match(S.checkText('x'.repeat(8001)), /8000/)
  assert.match(S.checkText(''), /Write/)
  assert.match(S.checkText('   \n '), /Write/)
  assert.match(S.checkText(undefined), /Write/)
  assert.match(S.checkText(42), /Write/)
})

// ═══ reading the stream ═══

const delta = text => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })
const result = (over = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: 'done', stop_reason: 'end_turn', total_cost_usd: 0.21, ...over })

test('readEvent: a text delta, a stop reason, the result; everything else is nothing', () => {
  assert.deepEqual(S.readEvent(delta('Sit')), { delta: 'Sit' })
  assert.deepEqual(S.readEvent({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'refusal' } } }), { stop: 'refusal' })
  assert.deepEqual(S.readEvent(result()), { result: { cost: 0.21, isError: false, stopReason: 'end_turn', text: 'done' } })
  assert.equal(S.readEvent({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hm' } } }), null)
  assert.equal(S.readEvent({ type: 'system', subtype: 'init' }), null)
  assert.equal(S.readEvent(null), null)
  assert.equal(S.readEvent('x'), null)
  assert.deepEqual(S.readEvent(result({ total_cost_usd: undefined })).result.cost, null)
})

// ═══ one generation, with a fake child ═══

/** A fake child process: emits what the test writes, records stdin and kills. */
function fakeChild() {
  const c = new EventEmitter()
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  c.stdin = { text: null, end(t) { c.stdin.text = t } }
  c.killed = 0
  c.kill = () => {
    c.killed++
    setImmediate(() => c.emit('close', null, 'SIGTERM'))
    return true
  }
  c.line = obj => c.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'))
  return c
}

function harness({ binFails = false, spawnThrows = false } = {}) {
  const h = { spawned: [], recorded: [], made: [], removed: [], child: fakeChild() }
  h.opts = {
    bin: async () => {
      if (binFails) throw new Error('nope')
      return 'C:/claude.exe'
    },
    spawn: (bin, args, options) => {
      if (spawnThrows) throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
      h.spawned.push({ bin, args, options })
      return h.child
    },
    record: (kind, usd) => h.recorded.push([kind, usd]),
    makeDir: () => (h.made.push('d'), 'C:/tmp/script-x'),
    removeDir: d => h.removed.push(d),
  }
  return h
}

const tick = () => new Promise(r => setImmediate(r))

test('a good run: deltas stream in order, stdin carries the text, the cost is recorded once as script spend', async () => {
  const h = harness()
  const got = []
  const run = S.generate('my idea', { ...h.opts, onDelta: t => got.push(t) })
  await tick()
  assert.equal(h.spawned.length, 1)
  assert.equal(h.spawned[0].bin, 'C:/claude.exe')
  assert.deepEqual(h.spawned[0].args, S.scriptArgs())
  assert.equal(h.spawned[0].options.cwd, 'C:/tmp/script-x', 'a fresh empty folder, never the repo')
  assert.equal(h.spawned[0].options.windowsHide, true)
  assert.equal(h.child.stdin.text, 'my idea')
  h.child.line(delta('```\nSituation: a'))
  h.child.line(delta(' shop\n```'))
  h.child.line(result())
  h.child.emit('close', 0, null)
  assert.deepEqual(await run.done, { ok: true, stopReason: 'end_turn', cost: 0.21 })
  assert.deepEqual(got, ['```\nSituation: a', ' shop\n```'])
  assert.deepEqual(h.recorded, [['script', 0.21]])
  assert.deepEqual(h.removed, ['C:/tmp/script-x'], 'the temp folder is removed')
})

test('a line split across chunks is joined before parsing; a non-JSON line is skipped', async () => {
  const h = harness()
  const got = []
  const run = S.generate('idea', { ...h.opts, onDelta: t => got.push(t) })
  await tick()
  const raw = JSON.stringify(delta('Hello')) + '\n'
  h.child.stdout.emit('data', Buffer.from('a warning line\n' + raw.slice(0, 10)))
  h.child.stdout.emit('data', Buffer.from(raw.slice(10)))
  h.child.line(result())
  h.child.emit('close', 0, null)
  await run.done
  assert.deepEqual(got, ['Hello'])
})

test('with no deltas at all (an older CLI), the assistant message text is streamed once', async () => {
  const h = harness()
  const got = []
  const run = S.generate('idea', { ...h.opts, onDelta: t => got.push(t) })
  await tick()
  h.child.line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Whole answer' }] } })
  h.child.line(result())
  h.child.emit('close', 0, null)
  await run.done
  assert.deepEqual(got, ['Whole answer'])
})

test('after deltas, the assistant message is not streamed a second time', async () => {
  const h = harness()
  const got = []
  const run = S.generate('idea', { ...h.opts, onDelta: t => got.push(t) })
  await tick()
  h.child.line(delta('Part'))
  h.child.line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Part' }] } })
  h.child.line(result())
  h.child.emit('close', 0, null)
  await run.done
  assert.deepEqual(got, ['Part'])
})

test('a missing binary is a calm message, and nothing is recorded', async () => {
  for (const opts of [{ binFails: true }, { spawnThrows: true }]) {
    const h = harness(opts)
    const out = await S.generate('idea', { ...h.opts, onDelta: () => {} }).done
    assert.equal(out.error, S.MESSAGES.missing)
    assert.deepEqual(h.recorded, [])
  }
})

test('a spawn error event (ENOENT after start) is the missing message too', async () => {
  const h = harness()
  const run = S.generate('idea', { ...h.opts, onDelta: () => {} })
  await tick()
  h.child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }))
  h.child.emit('close', -4058, null)
  assert.equal((await run.done).error, S.MESSAGES.missing)
})

test('a non-zero exit is a calm failure with the first line of what the CLI said', async () => {
  const h = harness()
  const run = S.generate('idea', { ...h.opts, onDelta: () => {} })
  await tick()
  h.child.stderr.emit('data', Buffer.from('\nSomething broke badly\nstack...'))
  h.child.emit('close', 1, null)
  const out = await run.done
  assert.equal(out.error, `${S.MESSAGES.failed} (Something broke badly)`)
  assert.equal(out.ok, undefined)
})

test('an error result (a usage limit, an API error) is a failure, and its cost is still recorded', async () => {
  const h = harness()
  const run = S.generate('idea', { ...h.opts, onDelta: () => {} })
  await tick()
  h.child.line(result({ is_error: true, result: 'API Error: 529 overloaded', total_cost_usd: 0.03 }))
  h.child.emit('close', 1, null)
  const out = await run.done
  assert.equal(out.error, `${S.MESSAGES.failed} (API Error: 529 overloaded)`)
  assert.equal(out.cost, 0.03)
  assert.deepEqual(h.recorded, [['script', 0.03]])
})

test('a refusal is its own calm message, from the stream or the result', async () => {
  for (const how of ['stream', 'result']) {
    const h = harness()
    const run = S.generate('idea', { ...h.opts, onDelta: () => {} })
    await tick()
    if (how === 'stream') h.child.line({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'refusal' } } })
    h.child.line(result({ stop_reason: how === 'result' ? 'refusal' : null }))
    h.child.emit('close', 0, null)
    const out = await run.done
    assert.equal(out.error, S.MESSAGES.refusal, how)
    assert.equal(out.stopReason, 'refusal')
  }
})

test('no output for the idle time kills the child and ends with the timeout message', async () => {
  const h = harness()
  const run = S.generate('idea', { ...h.opts, onDelta: () => {}, idleMs: 30 })
  await tick()
  h.child.line(delta('a'))
  const out = await run.done
  assert.equal(h.child.killed, 1)
  assert.equal(out.error, S.MESSAGES.timeout)
})

test('output keeps the idle timer from firing', async () => {
  // Four gaps of half the idle time: together they outlast it, so only a reset timer survives, and each
  // gap keeps 200 ms of slack. With 60 ms and 30 ms gaps a busy parallel run once stretched a gap past
  // the limit (QA, 1 failure in 8 full runs).
  const IDLE = 400
  const h = harness()
  const run = S.generate('idea', { ...h.opts, onDelta: () => {}, idleMs: IDLE })
  await tick()
  for (let i = 0; i < 4; i++) {
    await new Promise(r => setTimeout(r, IDLE / 2))
    h.child.line(delta('x'))
  }
  h.child.line(result())
  h.child.emit('close', 0, null)
  assert.equal((await run.done).ok, true)
  assert.equal(h.child.killed, 0)
})

test('cancel kills the child once and ends as cancelled; the temp folder is still removed', async () => {
  const h = harness()
  const run = S.generate('idea', { ...h.opts, onDelta: () => {} })
  await tick()
  run.cancel()
  run.cancel()
  const out = await run.done
  assert.equal(h.child.killed, 1)
  assert.equal(out.cancelled, true)
  assert.deepEqual(h.removed, ['C:/tmp/script-x'])
})

test('cancel before the child has spawned still ends the run and never spawns', async () => {
  const h = harness()
  const run = S.generate('idea', { ...h.opts, onDelta: () => {} })
  run.cancel()
  const out = await run.done
  assert.equal(out.cancelled, true)
  assert.equal(h.spawned.length, 0)
})

test('a throwing onDelta never breaks the run', async () => {
  const h = harness()
  const run = S.generate('idea', { ...h.opts, onDelta: () => { throw new Error('gone') } })
  await tick()
  h.child.line(delta('x'))
  h.child.line(result())
  h.child.emit('close', 0, null)
  assert.equal((await run.done).ok, true)
})
