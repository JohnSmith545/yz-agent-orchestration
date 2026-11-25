// Tests for public/script-questions.js: the pure side of the questions pop-up. It splits
// the model's questions into items (numbered or bulleted), with any lead-in and closing
// sentences kept apart as quiet text, falls back to the whole text with ONE answer field
// when there are no items, and writes the answers as the numbered list Generate again
// sends. A browser script in a vm, no DOM.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ctx = { window: {} }
for (const f of ['script-text.js', 'script-render.js', 'script-questions.js']) vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8'), ctx)
const Q = ctx.window.ScriptQuestions
const T = ctx.window.ScriptText
const plain = v => JSON.parse(JSON.stringify(v))
const flat = spans => spans.map(s => s.text).join('')

// The real answer the user got on 2026-11-24 (the screenshot in the brief).
const REAL = [
  "I'll write this as a prompt you can hand to a coding AI, since I only write prompts. I don't have the earlier conversation, the orchestration code, or your animation spec, so I need three answers first:",
  '',
  '1. **What is the orchestration?** What do the agents do, what is the UI built with (e.g., React + Tailwind, Streamlit, plain HTML), and what counts as a correct outcome for a run?',
  '2. **Which animations, and what\'s misaligned?** Paste or describe the animations you asked for (e.g., fade-in on generated sections, loading spinner, typing effect).',
  '3. **"F4"**: did you mean F1 or F-beta with β=4? F1 weights precision and recall equally.',
  '',
  "Once you answer, I'll give you the full prompt.",
].join('\n')

test('the real answer: a lead-in, three questions in order, and the closing sentence apart', () => {
  const s = Q.split(REAL)
  assert.equal(s.items.length, 3)
  assert.match(flat(s.lead[0].spans), /^I'll write this as a prompt/)
  assert.equal(s.tail.length, 1)
  assert.equal(flat(s.tail[0].spans), "Once you answer, I'll give you the full prompt.")
  assert.deepEqual(plain(s.items.map(i => i.n)), [1, 2, 3])
  assert.equal(s.items[0].spans[0].style, 'strong')
  assert.equal(s.items[0].spans[0].text, 'What is the orchestration?')
  assert.match(flat(s.items[2].spans), /^"F4": did you mean F1/)
  assert.doesNotMatch(JSON.stringify(plain(s)), /\*\*/, 'no raw marks')
})

test('bullets are questions too, numbered 1, 2, 3 for the answers', () => {
  const s = Q.split('Two things:\n- Who reads it?\n- Why now?')
  assert.deepEqual(plain(s.items.map(i => [i.n, flat(i.spans)])), [[1, 'Who reads it?'], [2, 'Why now?']])
  assert.equal(s.tail.length, 0)
})

test('a numbered list keeps its own numbers, so the answers match the questions', () => {
  const s = Q.split('2. Second?\n3. Third?')
  assert.deepEqual(plain(s.items.map(i => i.n)), [2, 3])
})

test('text with no items cannot be split: null, and the pop-up shows it whole with one field', () => {
  assert.equal(Q.split('Who is the audience, and what should it achieve?'), null)
  assert.equal(Q.split(''), null)
})

test('the head says how many questions there are', () => {
  assert.equal(Q.title(Q.split(REAL)), 'The Prompt generator has 3 questions')
  assert.equal(Q.title(Q.split('1. Only one?')), 'The Prompt generator has 1 question')
  assert.equal(Q.title(null), 'The Prompt generator has a question')
})

test('answers: a numbered list matching the questions, an empty one as (no answer)', () => {
  const s = Q.split(REAL)
  assert.equal(Q.answersText(s, ['Agents that build tickets.', '  ', 'F1.\nBoth equally.']), '1. Agents that build tickets.\n2. (no answer)\n3. F1.\nBoth equally.')
  assert.equal(Q.answersText(Q.split('2. B?\n3. C?'), ['b', 'c']), '2. b\n3. c')
})

test('answers with no items: the one answer as typed, trimmed', () => {
  assert.equal(Q.answersText(null, ['  my answer \n']), 'my answer')
})

test('hasAnswer: at least one field has words', () => {
  assert.equal(Q.hasAnswer(['', '  ']), false)
  assert.equal(Q.hasAnswer(['', 'x']), true)
  assert.equal(Q.hasAnswer([]), false)
})

test('what Answer and generate sends is exactly what Generate again sends with those answers', () => {
  const s = Q.split(REAL)
  const answers = Q.answersText(s, ['a', 'b', 'c'])
  const sent = T.followUp('my idea', REAL, answers)
  assert.ok(sent.startsWith('my idea\n\nAnswers to your questions:\n'))
  assert.ok(sent.endsWith('\n\n1. a\n2. b\n3. c'))
})

// A real reply (2026-11-25, the brainstorming skill on): choices as sub-bullets under question 1. The pop-up once
// counted 8 questions here and gave each choice its own answer field.
const CHOICES = [
  'Your context covers the agent setup but not who writes what. Answer briefly, in any order, or skip any.',
  '',
  '1. **What to build:** Which of these do you want?',
  '   - a) A reusable prompt for an AI editor (my recommendation)',
  '   - b) A team writing style guide',
  '   - c) A dashboard feature. This is code work and a larger job.',
  '2. **Who writes:** Is it the people on your team, or the agents?',
  '3. **What kind of writing:** Which writing matters most?',
].join('\n')

test('regression: sub-bullets under a question are its choices, not questions: one field per real question', () => {
  const s = Q.split(CHOICES)
  assert.deepEqual(plain(s.items.map(i => i.n)), [1, 2, 3])
  assert.equal(Q.title(s), 'The Prompt generator has 3 questions')
  assert.deepEqual(plain(s.items[0].choices.map(flat)), ['a) A reusable prompt for an AI editor (my recommendation)', 'b) A team writing style guide', 'c) A dashboard feature. This is code work and a larger job.'])
  assert.equal(s.items[1].choices, undefined, 'a question with no choices has none')
  assert.equal(Q.answersText(s, ['a', '', 'emails']), '1. a\n2. (no answer)\n3. emails')
  assert.equal(s.tail.length, 0, 'the choices are not quiet text either')
})

test('the pop-up draws a question choices as a small list under it, as text', () => {
  const ask = fs.readFileSync(path.join(HERE, '..', 'public', 'script-ask.js'), 'utf8')
  assert.match(ask, /it\.choices/)
  assert.match(ask, /'sc-ask-choices'/)
  assert.match(fs.readFileSync(path.join(HERE, '..', 'public', 'script.css'), 'utf8'), /\.sc-ask-choices \{/)
})
