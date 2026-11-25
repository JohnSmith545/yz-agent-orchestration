// Tests for learn-retro.mjs: writing a flow's retrospective with ONE small model run (a STUB here, never Claude), the
// store's side of it (flows.mjs validates and keeps `retro`), the queue that runs one at a time, and the automatic
// retrospective on Completed with its two off switches. FACTORY_DATA_DIR points at a temp folder BEFORE the
// imports, so no flow file of data/ is ever read or written.

import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-retro-test-'))
process.env.FACTORY_DATA_DIR = TMP
const { mergeKeepingAnswers, readFlow, validateFlow, writeFlow, FLOWS_DIR } = await import('../flows.mjs')
const { DEFAULT_PIPELINE, pipelineGraph } = await import('../pipeline.mjs')
const { makeRetros, retroRefusal, retroTurn } = await import('../learn-retro.mjs')
const { LEARN_DEFAULTS } = await import('../learn-settings.mjs')
const { turnArgs } = await import('../script.mjs')
const { KINDS } = await import('../spend.mjs')
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const GRAPH = pipelineGraph({ coordinator: 'Master', coordinatorLabel: 'Master', codingAgents: { Master: 'Master' }, pipeline: { ...DEFAULT_PIPELINE }, factory: { chat: { name: 'Independent' } } })
const AT = new Date('2026-11-25T09:00:00.000Z')
const ANSWER = 'Right: QA caught the cut rule.\nWrong: The first attempt cut long rules silently.\nNext: Test every limit before QA.'

/** A stub of script.mjs generate: answers `text` in two deltas, costs `cost`; every call kept. */
function stub({ text = ANSWER, cost = 0.0123, error = null } = {}) {
  const calls = []
  const generate = (input, opts) => {
    calls.push({ input, opts })
    const done = (async () => {
      await new Promise(r => setTimeout(r, 5))
      if (error) return { error, cost }
      opts.onDelta(text.slice(0, 10))
      opts.onDelta(text.slice(10))
      return { ok: true, stopReason: 'end_turn', cost }
    })()
    return { done, cancel: () => {} }
  }
  return { generate, calls }
}

function put(id, over = {}) {
  const flow = { id, title: `Flow ${id}`, agent: 'Master', status: 'done', nodes: [], createdAt: '2026-11-24T10:00:00.000Z', ...over }
  fs.mkdirSync(FLOWS_DIR, { recursive: true })
  fs.writeFileSync(path.join(FLOWS_DIR, `${id}.json`), JSON.stringify({ updatedAt: '2026-11-24T12:00:00.000Z', ...flow }))
}

const make = (over = {}) => makeRetros({ graph: () => GRAPH, settings: () => ({ ...LEARN_DEFAULTS }), now: () => AT, readReport: () => null, ...over })

beforeEach(() => fs.rmSync(FLOWS_DIR, { recursive: true, force: true }))

test('the turn: Sonnet at low effort, its own prompt, session name and spend kind; script.mjs takes the model', () => {
  const t = retroTurn('claude-sonnet-5-5')
  assert.equal(t.kind, 'retro')
  assert.equal(t.effort, 'low')
  assert.equal(t.name, 'RETRO')
  assert.equal(t.model, 'claude-sonnet-5-5')
  const args = turnArgs(t)
  assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-5-5')
  assert.equal(args[args.indexOf('--effort') + 1], 'low')
  assert.equal(turnArgs({ system: 'x' })[turnArgs({ system: 'x' }).indexOf('--model') + 1], 'claude-opus-5-5') // the others as before
  assert.ok(KINDS.includes('retro') && KINDS.includes('learn'))
})

test('Write: three lines on the flow with when, the cost and the source; the flow keeps its updatedAt', async () => {
  put('a1')
  const s = stub()
  const r = await make({ generate: s.generate }).write('a1', 'button')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.retro, { at: AT.toISOString(), right: 'QA caught the cut rule.', wrong: 'The first attempt cut long rules silently.', next: 'Test every limit before QA.', cost: 0.0123, source: 'button' })
  const stored = readFlow('a1')
  assert.deepEqual(stored.retro, r.body.retro)
  assert.equal(stored.updatedAt, '2026-11-24T12:00:00.000Z') // a retrospective is no change to the work: the score and time stay
  assert.equal(s.calls.length, 1)
  assert.match(s.calls[0].input, /^Flow: Flow a1/) // the facts, on stdin
  assert.equal(s.calls[0].opts.turn.kind, 'retro')
})

test('never for a dropped flow, nor one still on its way: no run, a plain sentence', async () => {
  put('d1', { status: 'dropped' })
  put('o1', { status: 'open' })
  const s = stub()
  const R = make({ generate: s.generate })
  const d = await R.write('d1', 'button')
  assert.equal(d.status, 400)
  assert.equal(d.body.error, 'A dropped flow gets no retrospective.')
  const o = await R.write('o1', 'button')
  assert.equal(o.status, 400)
  assert.match(o.body.error, /^Only a finished flow gets a retrospective/)
  assert.equal(s.calls.length, 0)
  assert.equal((await R.write('nope', 'button')).status, 404)
  assert.equal(retroRefusal(null, GRAPH), 'There is no such flow.')
})

test('a completed flow counts as finished, even when it is not done (finished at the Output)', async () => {
  put('c1', { status: 'open', completedAt: '2026-11-24T13:00:00.000Z', archivedAt: '2026-11-24T13:00:00.000Z', completedBy: 'you' })
  const r = await make({ generate: stub().generate }).write('c1', 'completed')
  assert.equal(r.status, 200)
})

test('an answer without the three lines stores nothing and says so, with the cost it still had', async () => {
  put('b1')
  const r = await make({ generate: stub({ text: 'Right: fine.' }).generate }).write('b1', 'button')
  assert.equal(r.status, 502)
  assert.equal(r.body.error, 'The model did not write the three lines (Right, Wrong, Next).')
  assert.equal(r.body.cost, 0.0123)
  assert.equal(readFlow('b1').retro, undefined)
})

test('a failed run stores nothing and passes on its plain message', async () => {
  put('f1')
  const r = await make({ generate: stub({ error: 'Claude Code was not found on this machine, so nothing was sent.', cost: null }).generate }).write('f1', 'button')
  assert.equal(r.status, 502)
  assert.match(r.body.error, /not found/)
  assert.equal(readFlow('f1').retro, undefined)
})

test('the off switch: with learn.enabled false nothing runs, by the button or by itself', async () => {
  put('e1')
  const s = stub()
  const R = make({ generate: s.generate, settings: () => ({ ...LEARN_DEFAULTS, enabled: false }) })
  const r = await R.write('e1', 'button')
  assert.equal(r.status, 403)
  assert.match(r.body.error, /switched off/)
  R.completed('e1')
  await R.idle()
  assert.equal(s.calls.length, 0)
})

test('Completed writes it by itself; autoRetro false does not, and a flow that has one keeps it', async () => {
  put('g1')
  put('g2', { retro: { at: '2026-11-24T13:00:00.000Z', right: 'r', wrong: 'w', next: 'n', cost: null, source: 'button' } })
  const s = stub()
  const R = make({ generate: s.generate })
  R.completed('g1')
  R.completed('g2')
  await R.idle()
  assert.equal(s.calls.length, 1)
  assert.equal(readFlow('g1').retro.source, 'completed')
  assert.equal(readFlow('g2').retro.right, 'r')
  const off = stub()
  put('g3')
  const Q = make({ generate: off.generate, settings: () => ({ ...LEARN_DEFAULTS, autoRetro: false }) })
  Q.completed('g3')
  await Q.idle()
  assert.equal(off.calls.length, 0)
  assert.equal(readFlow('g3').retro, undefined)
})

test('one at a time: Completed on several flows queues them; the button meanwhile is a 409', async () => {
  for (const id of ['q1', 'q2', 'q3']) put(id)
  let running = 0
  let most = 0
  const generate = (input, opts) => {
    running++
    most = Math.max(most, running)
    const done = new Promise(r => setTimeout(() => {
      running--
      opts.onDelta(ANSWER)
      r({ ok: true, cost: 0.01 })
    }, 15))
    return { done, cancel: () => {} }
  }
  const R = make({ generate })
  R.completed('q1')
  R.completed('q2')
  assert.equal(R.busy(), true)
  const refused = await R.write('q3', 'button')
  assert.equal(refused.status, 409)
  assert.match(refused.body.error, /already being written/)
  await R.idle()
  assert.equal(most, 1)
  assert.ok(readFlow('q1').retro && readFlow('q2').retro)
  assert.equal(R.busy(), false)
})

test('the store: a bad retro is refused by validateFlow, and an agent rewrite keeps the stored one', () => {
  const retro = { at: '2026-11-24T13:00:00.000Z', right: 'r', wrong: 'w', next: 'n', cost: 0.01, source: 'completed' }
  const base = { id: 'k1', title: 'K', agent: 'Master', status: 'done', nodes: [] }
  assert.deepEqual(validateFlow({ ...base, retro }), [])
  assert.ok(validateFlow({ ...base, retro: { ...retro, right: '' } }).some(p => p.startsWith('retro right')))
  writeFlow({ ...base, retro })
  const rewritten = mergeKeepingAnswers({ ...base, title: 'K again' }, readFlow('k1'))
  assert.deepEqual(rewritten.retro, retro)
  const forged = mergeKeepingAnswers({ ...base, retro: { ...retro, right: 'forged' } }, { ...base })
  assert.equal(forged.retro, undefined) // an agent cannot write one
})

test('a Completed that comes while the button runs is written right after it, never left in the queue', async () => {
  put('w1')
  put('w2')
  const s = stub()
  const R = make({ generate: s.generate })
  const pressed = R.write('w1', 'button')
  R.completed('w2')
  await pressed
  await R.idle()
  assert.ok(readFlow('w2').retro, 'the queued one ran once the button was done')
  assert.equal(readFlow('w2').retro.source, 'completed')
})

// QA 2026-11-26: a retrospective line named a folder (docs/operations). The three lines are for one person, in plain
// words: the prompt forbids file and folder paths, file names and commands.
test('the retrospective prompt asks for plain words, never a file or folder path', async () => {
  const { RETRO_SYSTEM } = await import('../learn-prompts.mjs')
  assert.match(RETRO_SYSTEM, /Never write a file or folder path, a file name or a command/)
  assert.match(RETRO_SYSTEM, /the operations docs, not docs\/operations/)
})
