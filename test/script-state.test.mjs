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
  assert.equal(St.view(s).progress, 'Writing…')
  s = St.reduce(s, { type: 'delta', text: '```\nSituation: a\nCharacter: b\n' })
  assert.equal(St.view(s).progress, '2 of 6 sections')
  s = St.reduce(stream(s, 'Request: c\nIntent: d\nPresentation: e\nTone: f\n```'), { type: 'end', ok: true })
  assert.equal(St.view(s).progress, 'All 6 sections')
  assert.equal(St.view(St.initial()).progress, '')
})
