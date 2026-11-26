// Tests for routing-intake-run.mjs, the ONE cheap model run of ticket intake, with the model stubbed: the clean run's
// turn (low effort, the chosen model, spend kind intake), the parsed answers saved, one run at a time, a failed run
// saving nothing; and script.mjs turnArgs taking the model.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { makeIntakeRunner } = await import('../routing-intake-run.mjs')
const { turnArgs, SCRIPT_MODEL } = await import('../script.mjs')

const tickets = [{ id: 'A-1', title: 'Things', labels: [], type: 'chore' }, { id: 'A-2', title: 'Other', labels: [], type: 'chore' }]

/** A stub generate: records its call, streams `reply`, resolves `result`. */
function stub(reply, result = { ok: true, cost: 0.004 }) {
  const calls = []
  let release
  const gate = new Promise(r => (release = r))
  const generate = (text, opts) => {
    calls.push({ text, opts })
    const done = gate.then(() => {
      opts.onDelta(reply)
      return result
    })
    return { done, cancel() {} }
  }
  return { generate, calls, release }
}

test('one run: the turn is cheap and named, the answers are parsed and saved, the cost comes back', async () => {
  const s = stub('[{"id":"A-1","kind":"no-code","reason":"A console setting."},{"id":"A-2","kind":"code","reason":"A page change."}]')
  const saved = []
  const runner = makeIntakeRunner({ generate: s.generate, save: (a, at) => (saved.push({ a, at }), Object.keys(a).length), now: () => 'T' })
  const p = runner.run(tickets, 'claude-haiku-5-5')
  assert.equal(runner.running(), true)
  s.release()
  const r = await p
  assert.deepEqual(r, { ok: true, sorted: 2, asked: 2, cost: 0.004 })
  const turn = s.calls[0].opts.turn
  assert.equal(turn.effort, 'low')
  assert.equal(turn.kind, 'intake')
  assert.equal(turn.name, 'INTAKE')
  assert.equal(turn.model, 'claude-haiku-5-5')
  assert.match(s.calls[0].text, /A-1 \| Things/)
  assert.deepEqual(saved[0], { a: { 'A-1': { kind: 'no-code', reason: 'A console setting.' }, 'A-2': { kind: 'code', reason: 'A page change.' } }, at: 'T' })
  assert.equal(runner.running(), false)
})

test('a second press while one runs is busy: never a second paid turn', async () => {
  const s = stub('[]')
  const runner = makeIntakeRunner({ generate: s.generate, save: () => 0 })
  const first = runner.run(tickets, 'claude-haiku-5-5')
  assert.deepEqual(await runner.run(tickets, 'claude-haiku-5-5'), { busy: true })
  s.release()
  await first
  assert.equal(s.calls.length, 1)
})

test('a failed run saves nothing and says why; no tickets is no run', async () => {
  const s = stub('', { error: 'The sorting run stopped before it finished.', cost: 0.001 })
  let saves = 0
  const runner = makeIntakeRunner({ generate: s.generate, save: () => ++saves })
  s.release()
  assert.deepEqual(await runner.run(tickets, 'claude-haiku-5-5'), { error: 'The sorting run stopped before it finished.', cost: 0.001 })
  assert.equal(saves, 0)
  assert.deepEqual(await runner.run([], 'claude-haiku-5-5'), { ok: true, sorted: 0, asked: 0, cost: 0 })
  assert.equal(s.calls.length, 1)
})

test('a reply with nothing usable saves nothing', async () => {
  const s = stub('I cannot help with that.')
  let saves = 0
  const runner = makeIntakeRunner({ generate: s.generate, save: () => ++saves })
  s.release()
  assert.deepEqual(await runner.run(tickets, 'claude-haiku-5-5'), { ok: true, sorted: 0, asked: 2, cost: 0.004 })
  assert.equal(saves, 0)
})

test('turnArgs takes a model, and keeps Opus without one', () => {
  const args = turnArgs({ system: 's', model: 'claude-haiku-5-5' })
  assert.equal(args[args.indexOf('--model') + 1], 'claude-haiku-5-5')
  const plain = turnArgs({ system: 's' })
  assert.equal(plain[plain.indexOf('--model') + 1], SCRIPT_MODEL)
})
