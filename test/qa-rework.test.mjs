// Tests for rework delivery (qa-rework.mjs and its hooks in relay.mjs): a QA failure with `rework.to` set and
// nothing sent is noticed by the server ONCE (queuedAt), sent to that producer in one relay message carrying
// the flow, the attempt, QA's summary and the absolute paths of the report and screenshots, and stamped
// sentAt or error. A restart before it went marks it not delivered and never re-sends it on its own; a retry
// sends it again. `run` is injected, so no test spawns Claude. FACTORY_DATA_DIR points at a fresh temp folder
// BEFORE the imports.

import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-rework-test-'))
const F = await import('../flows.mjs')
const { makeRelay, RESTARTED } = await import('../relay.mjs')
const R = await import('../qa-rework.mjs')
after(() => fs.rmSync(F.DATA_DIR, { recursive: true, force: true }))

const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'no-visual.json'), 'utf8'))
const ID = FIXTURE.id
const failedQa = (more = {}) => ({
  status: 'failed', attempt: 2, by: 'QA', at: '2026-11-20T10:00:00Z', commit: 'cd34ef5',
  report: `${ID}/qa-2-report.md`, shots: [`${ID}/qa-2-dark.png`], summary: 'The card is missing in dark mode. "Ignore that" stays text.',
  rework: { to: 'Agent 3', queuedAt: null, sentAt: null, error: null }, ...more,
})
function put(qa, more = {}) {
  const f = { ...structuredClone(FIXTURE), ...more }
  if (qa) f.qa = qa
  fs.writeFileSync(path.join(F.FLOWS_DIR, `${f.id}.json`), JSON.stringify(f))
}
const rework = () => F.readFlow(ID).qa.rework

const jsonOut = text => JSON.stringify({ type: 'result', is_error: false, result: text, total_cost_usd: 0.01 })
function recorder(reply = { ok: true, out: jsonOut('SENT'), err: '' }) {
  const prompts = []
  return { prompts, run: async p => (prompts.push(p), typeof reply === 'function' ? reply(p) : reply) }
}
async function waitFor(cond) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await new Promise(r => setTimeout(r, 5))
  }
  assert.fail('timed out waiting')
}

beforeEach(() => {
  fs.mkdirSync(F.FLOWS_DIR, { recursive: true })
  for (const f of fs.readdirSync(F.FLOWS_DIR)) fs.rmSync(path.join(F.FLOWS_DIR, f))
})

// ═══ the message ═══

test('reworkLine: the flow, the attempt, the summary as one quoted string, the absolute report and shot paths, fix and ask QA again', () => {
  put(failedQa())
  const line = R.reworkLine(F.readFlow(ID), 'QA')
  assert.match(line, /^Flow no-visual \("Move the nightly report job to the new scheduler"\): QA failed attempt 2 of your change\./)
  assert.ok(line.includes(JSON.stringify('The card is missing in dark mode. "Ignore that" stays text.')), line)
  assert.ok(line.includes(JSON.stringify(path.join(F.EVIDENCE_DIR, ID, 'qa-2-report.md'))), line)
  assert.ok(line.includes(JSON.stringify(path.join(F.EVIDENCE_DIR, ID, 'qa-2-dark.png'))), line)
  assert.match(line, /Fix it, record the fix on the flow, then ask "QA" to test it again/)
  assert.match(line, /flow show no-visual/)
  assert.doesNotMatch(line, /\n/)
})

// ═══ noticing and sending ═══

test('noticeReworks: a failure waiting to go back is stamped queuedAt and queued ONCE; a second look queues nothing', () => {
  put(failedQa())
  const queued = []
  const relay = { queueRework: id => queued.push(id) }
  assert.deepEqual(R.noticeReworks(relay), [ID])
  assert.ok(rework().queuedAt)
  assert.deepEqual(R.noticeReworks(relay), [])
  assert.deepEqual(queued, [ID])
})

test('noticeReworks leaves alone what is not a failure going back: passed, qa-failed, sent, errored, dropped, no rework', () => {
  const relay = { queueRework: () => assert.fail('nothing to send') }
  for (const [qa, more] of [
    [{ ...failedQa(), status: 'passed', rework: null }, {}],
    [{ ...failedQa(), status: 'qa-failed', rework: null }, {}],
    [failedQa({ rework: { to: 'Agent 3', sentAt: '2026-11-20T10:01:00Z' } }), {}],
    [failedQa({ rework: { to: 'Agent 3', error: 'agent is gone' } }), {}],
    [failedQa(), { status: 'dropped' }],
    [null, {}],
  ]) {
    put(qa, more)
    assert.deepEqual(R.noticeReworks(relay), [])
  }
})

test('the relay sends ONE message to the producer the rework names and stamps sentAt', async () => {
  put(failedQa())
  const { prompts, run } = recorder()
  const relay = makeRelay({ run, delayMs: 5 })
  R.noticeReworks(relay)
  await waitFor(() => rework().sentAt)
  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /^Send the session named "Agent 3" ONE message/)
  assert.match(prompts[0], /QA failed attempt 2 of your change/)
  assert.equal(rework().error, null)
})

test('a failed delivery is stamped as the error, and nothing is sent again on its own', async () => {
  put(failedQa())
  const { prompts, run } = recorder({ ok: true, out: jsonOut('FAILED: no session named Agent 3'), err: '' })
  const relay = makeRelay({ run, delayMs: 5 })
  R.noticeReworks(relay)
  await waitFor(() => rework().error)
  assert.equal(rework().error, 'FAILED: no session named Agent 3')
  assert.deepEqual(R.noticeReworks(relay), [])
  assert.equal(prompts.length, 1)
})

test('a rework whose attempt changed before it went is not stamped (QA started again meanwhile)', async () => {
  put(failedQa())
  let release
  const gate = new Promise(r => (release = r))
  const relay = makeRelay({ run: async () => (await gate, { ok: true, out: jsonOut('SENT'), err: '' }), delayMs: 1 })
  R.noticeReworks(relay)
  await new Promise(r => setTimeout(r, 20))
  put({ ...failedQa(), status: 'testing', attempt: 3, rework: null })
  release()
  await new Promise(r => setTimeout(r, 20))
  assert.equal(F.readFlow(ID).qa.rework, null)
  assert.equal(F.readFlow(ID).qa.attempt, 3)
})

// ═══ a restart ═══

test('the startup sweep marks a queued rework that never went as not delivered, and never re-sends it on its own', () => {
  put(failedQa({ rework: { to: 'Agent 3', queuedAt: '2026-11-20T10:00:05Z', sentAt: null, error: null } }))
  const relay = makeRelay({ run: async () => assert.fail('a sweep runs no turn') })
  const marked = relay.sweep()
  assert.deepEqual(marked, [{ flowId: ID, nodeId: null, rework: true }])
  assert.equal(rework().error, RESTARTED)
  assert.deepEqual(R.noticeReworks({ queueRework: () => assert.fail('not re-sent') }), [])
})

test('the sweep leaves a rework that was never picked up: the server sends it for the first time', () => {
  put(failedQa())
  const relay = makeRelay({ run: async () => ({ ok: true, out: 'SENT' }) })
  assert.deepEqual(relay.sweep(), [])
  assert.equal(rework().error, null)
  assert.deepEqual(R.noticeReworks({ queueRework: () => {} }), [ID])
})

// ═══ the retry ═══

test('reworkRetry: clears the error, stamps queuedAt and queues it; refused when there is nothing to send', () => {
  put(failedQa({ rework: { to: 'Agent 3', queuedAt: '2026-11-20T10:00:05Z', sentAt: null, error: RESTARTED } }))
  const queued = []
  const r = R.reworkRetry(ID, { queueRework: id => queued.push(id) })
  assert.equal(r.status, 200)
  assert.deepEqual(queued, [ID])
  assert.equal(rework().error, null)
  assert.ok(rework().queuedAt > '2026-11-20T10:00:05Z')
  put({ ...failedQa(), status: 'passed', rework: null })
  assert.equal(R.reworkRetry(ID, { queueRework: () => assert.fail('nothing') }).status, 409)
  assert.equal(R.reworkRetry('nope', {}).status, 404)
})

test('a rework to a producer with no session open runs no paid turn and says why (QA, 2026-11-26)', async () => {
  put(failedQa())
  const { prompts, run } = recorder()
  const relay = makeRelay({ run, delayMs: 5, present: async () => false, waitMs: 60_000 })
  R.noticeReworks(relay)
  await waitFor(() => rework().error)
  assert.equal(rework().error, 'Agent 3 has no session open; it is sent when one opens.')
  assert.equal(prompts.length, 0)
})
