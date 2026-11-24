// Tests for public/script-state.js: the SCRIPT page as a pure state machine. Each
// event (start, delta, end) gives the next state, and view() says what to draw: the
// lit letters, the copyable code, the answers box, the error and the button label.
// script-page.js only paints what this returns. A browser script in a vm.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ctx = { window: {} }
for (const f of ['script-text.js', 'script-state.js']) vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8'), ctx)
const St = ctx.window.ScriptState
const plain = v => JSON.parse(JSON.stringify(v))

const PROMPT = '```\nSituation: a\nCharacter: b\nRequest: c\nIntent: d\nPresentation: e\nTone: f\n```\nAssumed: one thing.'
const QUESTIONS = 'Before I write it:\n1. Who is the audience?\n2. What should it achieve?'

/** Feed `text` in small pieces, as a stream would. */
function stream(s, text, size = 7) {
  for (let i = 0; i < text.length; i += size) s = St.reduce(s, { type: 'delta', text: text.slice(i, i + size) })
  return s
}

test('the first state is idle and empty, with Generate and nothing to copy', () => {
  const s = St.initial()
  assert.equal(s.phase, 'idle')
  const v = St.view(s)
  assert.deepEqual(plain(v.lit), [])
  assert.equal(v.canCopy, false)
  assert.equal(v.busy, false)
  assert.equal(v.showAnswers, false)
  assert.equal(v.button, 'Generate')
  assert.equal(v.error, '')
})

test('start clears the last output and error, remembers the request for Retry, and is busy', () => {
  let s = St.reduce(St.initial(), { type: 'start', text: 'idea' })
  s = St.reduce(s, { type: 'delta', text: 'partial' })
  s = St.reduce(s, { type: 'end', ok: false, error: 'Boom.' })
  s = St.reduce(s, { type: 'start', text: 'idea 2' })
  assert.equal(s.phase, 'running')
  assert.equal(s.output, '')
  assert.equal(s.error, '')
  assert.equal(s.request, 'idea 2')
  const v = St.view(s)
  assert.equal(v.busy, true)
  assert.equal(v.button, 'Generating…')
})

test('letters light as their sections start streaming, in order, and Copy turns on once a block exists', () => {
  let s = St.reduce(St.initial(), { type: 'start', text: 'idea' })
  s = St.reduce(s, { type: 'delta', text: 'Sure.\n' })
  assert.equal(St.view(s).canCopy, false)
  s = St.reduce(s, { type: 'delta', text: '```\nSituation: a\nChar' })
  assert.deepEqual(plain(St.view(s).lit), ['Situation'])
  assert.equal(St.view(s).canCopy, true)
  assert.equal(St.view(s).code, 'Situation: a\nChar')
  s = St.reduce(s, { type: 'delta', text: 'acter: b\n' })
  assert.deepEqual(plain(St.view(s).lit), ['Situation', 'Character'])
})

test('the completion moment fires ONCE, on the delta that closes the block after Tone, before the stream ends', () => {
  let s = St.reduce(St.initial(), { type: 'start', text: 'idea' })
  let fired = 0
  for (let i = 0; i < PROMPT.length; i += 5) {
    const next = St.reduce(s, { type: 'delta', text: PROMPT.slice(i, i + 5) })
    if (St.justCompleted(s, next)) fired++
    s = next
  }
  assert.equal(fired, 1)
  assert.equal(s.completed, true)
  assert.equal(s.phase, 'running', 'still streaming the assumptions line')
  const end = St.reduce(s, { type: 'end', ok: true })
  assert.equal(St.justCompleted(s, end), false, 'the end does not fire it again')
  assert.equal(end.phase, 'prompt')
  assert.equal(St.view(end).code, 'Situation: a\nCharacter: b\nRequest: c\nIntent: d\nPresentation: e\nTone: f')
})

test('a good end with all six seen and no closing fence completes at the end', () => {
  let s = stream(St.reduce(St.initial(), { type: 'start', text: 'idea' }), PROMPT.slice(0, PROMPT.lastIndexOf('```')))
  assert.equal(s.completed, false)
  const end = St.reduce(s, { type: 'end', ok: true })
  assert.equal(St.justCompleted(s, end), true)
  assert.equal(end.phase, 'prompt')
})

test('the questions path: no code block, no letters, no moment, the answers box and Generate again', () => {
  let s = stream(St.reduce(St.initial(), { type: 'start', text: 'idea' }), QUESTIONS)
  const end = St.reduce(s, { type: 'end', ok: true })
  assert.equal(end.phase, 'questions')
  assert.equal(end.questions, QUESTIONS)
  assert.equal(St.justCompleted(s, end), false)
  const v = St.view(end)
  assert.deepEqual(plain(v.lit), [])
  assert.equal(v.canCopy, false)
  assert.equal(v.showAnswers, true)
  assert.equal(v.button, 'Generate again')
})

test('Generate again keeps the answers box while it runs, and closes it once a prompt arrives', () => {
  let s = St.reduce(stream(St.reduce(St.initial(), { type: 'start', text: 'idea' }), QUESTIONS), { type: 'end', ok: true })
  s = St.reduce(s, { type: 'start', text: 'idea\n\nAnswers to your questions:\n...', followUp: true })
  assert.equal(St.view(s).showAnswers, true)
  assert.equal(St.view(s).button, 'Generating…')
  s = St.reduce(stream(s, PROMPT), { type: 'end', ok: true })
  assert.equal(s.phase, 'prompt')
  assert.equal(St.view(s).showAnswers, false)
})

test('a failure keeps the partial text, marks it incomplete, shows the calm error with Retry, and never completes', () => {
  let s = stream(St.reduce(St.initial(), { type: 'start', text: 'idea' }), '```\nSituation: a\n')
  const end = St.reduce(s, { type: 'end', ok: false, error: 'No reply for 2 minutes, so the run was stopped. Try again.' })
  assert.equal(end.phase, 'error')
  assert.equal(St.justCompleted(s, end), false)
  const v = St.view(end)
  assert.equal(v.error, 'No reply for 2 minutes, so the run was stopped. Try again.')
  assert.equal(v.incomplete, true)
  assert.equal(v.canRetry, true)
  assert.equal(v.busy, false)
  assert.deepEqual(plain(v.lit), ['Situation'], 'what streamed stays visible')
})

test('a failure with nothing streamed is not marked incomplete', () => {
  const s = St.reduce(St.reduce(St.initial(), { type: 'start', text: 'idea' }), { type: 'end', ok: false, error: 'Nope.' })
  assert.equal(St.view(s).incomplete, false)
  assert.equal(St.view(s).error, 'Nope.')
})

test('an empty good answer is an error, not questions', () => {
  const s = St.reduce(St.reduce(St.initial(), { type: 'start', text: 'idea' }), { type: 'end', ok: true })
  assert.equal(s.phase, 'error')
  assert.match(St.view(s).error, /no answer/i)
})

test('a failure after questions keeps the answers box, so Retry and the answers stay together', () => {
  let s = St.reduce(stream(St.reduce(St.initial(), { type: 'start', text: 'idea' }), QUESTIONS), { type: 'end', ok: true })
  s = St.reduce(s, { type: 'start', text: 'follow', followUp: true })
  s = St.reduce(s, { type: 'end', ok: false, error: 'Boom.' })
  assert.equal(St.view(s).showAnswers, true)
  assert.equal(s.request, 'follow')
})

test('deltas or ends that arrive when nothing runs change nothing', () => {
  const s = St.initial()
  assert.equal(St.reduce(s, { type: 'delta', text: 'x' }), s)
  assert.equal(St.reduce(s, { type: 'end', ok: true }), s)
  assert.equal(St.reduce(s, { type: 'nonsense' }), s)
})

test('the status line under the letters says how many sections have started', () => {
  let s = St.reduce(St.initial(), { type: 'start', text: 'idea' })
  assert.equal(St.view(s).progress, 'Thinking…', 'before the first text: the model is thinking')
  s = St.reduce(s, { type: 'delta', text: 'Sure.\n' })
  assert.equal(St.view(s).progress, 'Writing…')
  s = St.reduce(s, { type: 'delta', text: '```\nSituation: a\nCharacter: b\n' })
  assert.equal(St.view(s).progress, '2 of 6 sections')
  s = St.reduce(stream(s, 'Request: c\nIntent: d\nPresentation: e\nTone: f\n```'), { type: 'end', ok: true })
  assert.equal(St.view(s).progress, 'All 6 sections')
  assert.equal(St.view(St.initial()).progress, '')
})

// ═══ thinking, the letter being written, and the questions path ═══

test('thinking: a run with no text yet is thinking; the first text ends it', () => {
  let s = St.reduce(St.initial(), { type: 'start', text: 'idea' })
  assert.equal(St.view(s).thinking, true)
  s = St.reduce(s, { type: 'delta', text: '\n' })
  assert.equal(St.view(s).thinking, true, 'a bare line break is not text yet')
  s = St.reduce(s, { type: 'delta', text: 'Sure' })
  assert.equal(St.view(s).thinking, false)
  assert.equal(St.view(St.initial()).thinking, false)
  const failed = St.reduce(St.reduce(St.initial(), { type: 'start', text: 'x' }), { type: 'end', ok: false, error: 'No.' })
  assert.equal(St.view(failed).thinking, false, 'a failed run is not thinking')
})

test('current: the section being written right now, until the block closes', () => {
  let s = St.reduce(St.initial(), { type: 'start', text: 'idea' })
  assert.equal(St.view(s).current, null)
  s = St.reduce(s, { type: 'delta', text: '```\nSituation: a\n' })
  assert.equal(St.view(s).current, 'Situation')
  s = St.reduce(s, { type: 'delta', text: 'Character: b\n' })
  assert.equal(St.view(s).current, 'Character')
  s = stream(s, 'Request: c\nIntent: d\nPresentation: e\nTone: f\n')
  assert.equal(St.view(s).current, 'Tone')
  s = St.reduce(s, { type: 'delta', text: '```\n' })
  assert.equal(St.view(s).current, null, 'the block closed: nothing is being written')
  assert.equal(St.view(St.reduce(s, { type: 'end', ok: true })).current, null)
})

test('the questions path says Questions first', () => {
  const s = St.reduce(stream(St.reduce(St.initial(), { type: 'start', text: 'idea' }), QUESTIONS), { type: 'end', ok: true })
  assert.equal(St.view(s).progress, 'Questions first')
})

// ═══ Restart ═══

test('reset: back to idle and empty from any phase, with nothing lit and nothing to copy', () => {
  const running = stream(St.reduce(St.initial(), { type: 'start', text: 'idea' }), '```\nSituation: a\n')
  const asked = St.reduce(stream(St.reduce(St.initial(), { type: 'start', text: 'idea' }), QUESTIONS), { type: 'end', ok: true })
  const failed = St.reduce(running, { type: 'end', ok: false, error: 'Boom.' })
  const done = St.reduce(stream(St.reduce(St.initial(), { type: 'start', text: 'idea' }), PROMPT), { type: 'end', ok: true })
  for (const s of [running, asked, failed, done]) {
    const r = St.reduce(s, { type: 'reset' })
    assert.equal(r.phase, 'idle')
    assert.equal(r.output, '')
    assert.equal(r.error, '')
    assert.equal(r.questions, '')
    assert.equal(r.request, '')
    assert.equal(r.completed, false)
    assert.equal(r.context, null)
    const v = St.view(r)
    assert.deepEqual(plain(v.lit), [])
    assert.equal(v.canCopy, false)
    assert.equal(v.showAnswers, false)
    assert.equal(v.busy, false)
    assert.equal(v.button, 'Generate')
    assert.equal(v.canRestart, false)
    assert.equal(St.justCompleted(s, r), false, 'a reset never fires the completion moment')
  }
})

test('canRestart: on for anything but a fresh idle page', () => {
  assert.equal(St.view(St.initial()).canRestart, false)
  const s = St.reduce(St.initial(), { type: 'start', text: 'idea' })
  assert.equal(St.view(s).canRestart, true, 'a run can be stopped')
  assert.equal(St.view(St.reduce(s, { type: 'end', ok: false, error: 'x' })).canRestart, true)
})

test('a late delta or end from the stopped run, after a reset, changes nothing and never completes', () => {
  let s = stream(St.reduce(St.initial(), { type: 'start', text: 'idea' }), '```\nSituation: a\n')
  const old = s.run
  s = St.reduce(s, { type: 'reset' })
  assert.equal(St.reduce(s, { type: 'delta', text: 'Tone: x\n```', run: old }), s)
  assert.equal(St.reduce(s, { type: 'delta', text: 'late' }), s, 'even with no run id: nothing is running')
  assert.equal(St.reduce(s, { type: 'end', ok: true, run: old }), s)
  assert.equal(St.reduce(s, { type: 'end', ok: false, error: 'The connection closed.', run: old }), s, 'an aborted run shows no error')
})

test('a late delta or end from the stopped run cannot reach the NEXT run', () => {
  let s = stream(St.reduce(St.initial(), { type: 'start', text: 'idea' }), '```\nSituation: a\n')
  const old = s.run
  s = St.reduce(St.reduce(s, { type: 'reset' }), { type: 'start', text: 'idea 2' })
  const now = s.run
  assert.notEqual(now, old)
  assert.equal(St.reduce(s, { type: 'delta', text: 'stale', run: old }), s)
  assert.equal(St.reduce(s, { type: 'end', ok: false, error: 'cut', run: old }), s)
  s = St.reduce(s, { type: 'delta', text: 'fresh', run: now })
  assert.equal(s.output, 'fresh')
  s = St.reduce(s, { type: 'end', ok: true, run: now })
  assert.equal(s.phase, 'questions')
})

test('every start gets a new run id', () => {
  const a = St.reduce(St.initial(), { type: 'start', text: 'x' })
  const b = St.reduce(St.reduce(a, { type: 'end', ok: false, error: 'e' }), { type: 'start', text: 'x' })
  assert.notEqual(a.run, b.run)
})

// ═══ what was sent with the run (the Context panel's line) ═══

test('context: kept from the stream line and shown as one quiet line; cleared by a new run and by reset', () => {
  let s = St.reduce(St.initial(), { type: 'start', text: 'idea' })
  assert.equal(St.view(s).context, null, 'no line when the run had none')
  s = St.reduce(s, { type: 'context', used: [{ title: 'Brand voice', chars: 120 }, { title: 'Audience', chars: 80 }], skipped: [{ title: 'Old notes', why: 'too long' }], run: s.run })
  assert.deepEqual(plain(St.view(s).context), { sent: 'Sent with: Brand voice, Audience', left: 'Left out: Old notes (too long)' })
  s = St.reduce(stream(s, PROMPT), { type: 'end', ok: true })
  assert.ok(St.view(s).context, 'it stays once the run is over')
  assert.equal(St.view(St.reduce(s, { type: 'start', text: 'again' })).context, null)
  assert.equal(St.view(St.reduce(s, { type: 'reset' })).context, null)
})

test('context: only what was left out, or only what was sent, or nothing at all', () => {
  const go = c => St.view(St.reduce(St.reduce(St.initial(), { type: 'start', text: 'x' }), { type: 'context', ...c })).context
  assert.deepEqual(plain(go({ used: [], skipped: [{ title: 'Big file', why: '' }] })), { sent: '', left: 'Left out: Big file' })
  assert.deepEqual(plain(go({ used: [{ title: 'A' }], skipped: [] })), { sent: 'Sent with: A', left: '' })
  assert.equal(go({ used: [], skipped: [] }), null)
  assert.equal(go({ used: 'nope', skipped: null }), null)
  assert.equal(go({ used: [{ chars: 4 }, null, { title: '' }] }), null, 'entries with no title are dropped')
})

test('context: a line from a stopped run is ignored', () => {
  const s = St.reduce(St.reduce(St.initial(), { type: 'start', text: 'x' }), { type: 'reset' })
  assert.equal(St.reduce(s, { type: 'context', used: [{ title: 'A' }], skipped: [] }), s)
})

// ═══ History: restore a logged run ═══

test('restore a prompt: finished, letters lit, Copy on, and NO completion moment', () => {
  const s0 = St.initial()
  const r = St.reduce(s0, { type: 'restore', text: 'idea', output: PROMPT, ok: true, cancelled: false, context: { used: [{ title: 'A' }], skipped: [] } })
  assert.equal(r.phase, 'prompt')
  const v = St.view(r)
  assert.deepEqual(plain(v.lit), ['Situation', 'Character', 'Request', 'Intent', 'Presentation', 'Tone'])
  assert.equal(v.canCopy, true)
  assert.equal(v.busy, false)
  assert.equal(v.current, null)
  assert.equal(v.progress, 'All 6 sections')
  assert.deepEqual(plain(v.context), { sent: 'Sent with: A', left: '' })
  assert.equal(St.justCompleted(s0, r), false, 'no settle, no glow, no pop on a restore')
  assert.equal(r.restored, true)
  assert.equal(r.request, 'idea', 'Retry and a later run start from the restored text')
})

test('restore questions: the answers box opens, NOT the pop-up', () => {
  const r = St.reduce(St.initial(), { type: 'restore', text: 'idea', output: QUESTIONS, ok: true })
  assert.equal(r.phase, 'questions')
  assert.equal(r.questions, QUESTIONS)
  const v = St.view(r)
  assert.equal(v.showAnswers, true)
  assert.equal(v.asking, false)
  assert.equal(v.button, 'Generate again')
})

test('restore a failed or stopped run: its text is shown as it was, with a calm line and Retry', () => {
  const failed = St.view(St.reduce(St.initial(), { type: 'restore', text: 'idea', output: '```\nSituation: a\n', ok: false, error: 'Boom.' }))
  assert.equal(failed.error, 'Boom.')
  assert.equal(failed.incomplete, true)
  assert.equal(failed.canRetry, true)
  const stopped = St.view(St.reduce(St.initial(), { type: 'restore', text: 'idea', output: '', ok: false, cancelled: true }))
  assert.match(stopped.error, /stopped/i)
})

test('a restore is refused while a run is going', () => {
  const s = St.reduce(St.initial(), { type: 'start', text: 'idea' })
  assert.equal(St.reduce(s, { type: 'restore', text: 'x', output: PROMPT, ok: true }), s)
})

test('a restored page is cleared by Restart, and a new run after it completes normally with its moment', () => {
  const r = St.reduce(St.initial(), { type: 'restore', text: 'idea', output: PROMPT, ok: true })
  const reset = St.reduce(r, { type: 'reset' })
  assert.equal(reset.phase, 'idle')
  assert.equal(reset.restored, false)
  const started = St.reduce(r, { type: 'start', text: 'idea' })
  assert.equal(started.restored, false)
  let s = started
  let fired = 0
  for (let i = 0; i < PROMPT.length; i += 5) {
    const next = St.reduce(s, { type: 'delta', text: PROMPT.slice(i, i + 5) })
    if (St.justCompleted(s, next)) fired++
    s = next
  }
  assert.equal(fired, 1)
})

// ═══ the questions pop-up ═══

test('a run that ends on questions opens the pop-up; a prompt does not', () => {
  const q = St.reduce(stream(St.reduce(St.initial(), { type: 'start', text: 'idea' }), QUESTIONS), { type: 'end', ok: true })
  assert.equal(St.view(q).asking, true)
  const p = St.reduce(stream(St.reduce(St.initial(), { type: 'start', text: 'idea' }), PROMPT), { type: 'end', ok: true })
  assert.equal(St.view(p).asking, false)
})

test('close (Later, Escape) and reopen (Show the questions); only on the questions path', () => {
  const q = St.reduce(stream(St.reduce(St.initial(), { type: 'start', text: 'idea' }), QUESTIONS), { type: 'end', ok: true })
  const closed = St.reduce(q, { type: 'unask' })
  assert.equal(St.view(closed).asking, false)
  assert.equal(St.view(closed).showAnswers, true, 'the answers box stays')
  assert.equal(St.view(St.reduce(closed, { type: 'ask' })).asking, true)
  const idle = St.initial()
  assert.equal(St.view(St.reduce(idle, { type: 'ask' })).asking, false, 'no questions, no pop-up')
})

test('Restart and a new run close the pop-up', () => {
  const q = St.reduce(stream(St.reduce(St.initial(), { type: 'start', text: 'idea' }), QUESTIONS), { type: 'end', ok: true })
  assert.equal(St.view(St.reduce(q, { type: 'reset' })).asking, false)
  assert.equal(St.view(St.reduce(q, { type: 'start', text: 'again', followUp: true })).asking, false)
})
