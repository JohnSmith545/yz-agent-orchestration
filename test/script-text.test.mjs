// Tests for public/script-text.js: the pure functions behind the SCRIPT page. Which
// sections have started (the letters), the code block (Copy, mid-stream too), when the
// last section has finished (the completion moment), whether a finished answer is a
// prompt or questions, and the text Generate again sends. A browser script in a vm.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ctx = { window: {} }
vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', 'script-text.js'), 'utf8'), ctx)
const T = ctx.window.ScriptText
const plain = v => JSON.parse(JSON.stringify(v))

const FULL = [
  'Here is your prompt.',
  '',
  '```markdown',
  'Situation: A small bakery wants more weekday orders.',
  'Character: Senior local-marketing copywriter for food shops.',
  'Request: Write three Instagram captions, under 40 words each.',
  'Intent: Fill the quiet Tuesday to Thursday slots.',
  'Presentation: A numbered list, one caption per item.',
  'Tone: Warm and plain. No hashtags walls, no emoji.',
  '```',
  'Assumptions: the bakery posts on Instagram only.',
].join('\n')

// ═══ the sections ═══

test('SECTIONS are the six SCRIPT labels in order, one per letter', () => {
  assert.deepEqual(plain(T.SECTIONS), ['Situation', 'Character', 'Request', 'Intent', 'Presentation', 'Tone'])
})

test('sectionsStarted: nothing before the code block opens, even when a label appears in prose', () => {
  assert.deepEqual(plain(T.sectionsStarted('')), [])
  assert.deepEqual(plain(T.sectionsStarted('Situation: I will write it now.\n')), [])
  assert.deepEqual(plain(T.sectionsStarted('Intro\n```')), [], 'the fence line is not finished yet')
})

test('sectionsStarted: a section starts once its label and colon have streamed', () => {
  assert.deepEqual(plain(T.sectionsStarted('```\nSitua')), [])
  assert.deepEqual(plain(T.sectionsStarted('```\nSituation')), [])
  assert.deepEqual(plain(T.sectionsStarted('```\nSituation:')), ['Situation'])
  assert.deepEqual(plain(T.sectionsStarted('```\nSituation: x\nCharacter: y\nReq')), ['Situation', 'Character'])
})

test('sectionsStarted: markdown bold and leading spaces are tolerated, in either bold style', () => {
  const t = '```\n**Situation:** a\n  **Character**: b\n   Request : c\n'
  assert.deepEqual(plain(T.sectionsStarted(t)), ['Situation', 'Character', 'Request'])
})

test('sectionsStarted: the label must start the line; a word mid-sentence is not a section', () => {
  assert.deepEqual(plain(T.sectionsStarted('```\nSituation: the Tone: of it\n')), ['Situation'])
})

test('sectionsStarted: always in SCRIPT order, each once, whatever order they streamed in', () => {
  assert.deepEqual(plain(T.sectionsStarted('```\nTone: a\nSituation: b\nTone: c\n')), ['Situation', 'Tone'])
  assert.deepEqual(plain(T.sectionsStarted(FULL)), plain(T.SECTIONS))
})

test('sectionsStarted: labels after the closing fence do not count', () => {
  assert.deepEqual(plain(T.sectionsStarted('```\nSituation: a\n```\nTone: outside\n')), ['Situation'])
})

// ═══ the code block ═══

test('codeBlock: the contents only, no fences, no language tag, nothing after it', () => {
  const b = T.codeBlock(FULL)
  assert.equal(b.closed, true)
  assert.equal(b.lang, 'markdown')
  assert.equal(b.code, FULL.split('\n').slice(3, 9).join('\n'))
  assert.ok(!b.code.includes('```') && !b.code.includes('Assumptions'))
})

test('codeBlock: null when there is none, or the fence line has not finished streaming', () => {
  assert.equal(T.codeBlock(''), null)
  assert.equal(T.codeBlock('Just questions?\n1. Who reads it?'), null)
  assert.equal(T.codeBlock('Here:\n``'), null)
  assert.equal(T.codeBlock('Here:\n```mark'), null)
})

test('codeBlock: an unclosed block mid-stream gives what has streamed so far', () => {
  const b = T.codeBlock('Intro\n```\nSituation: a\nChar')
  assert.equal(b.closed, false)
  assert.equal(b.code, 'Situation: a\nChar')
  assert.equal(T.codeBlock('```\n').code, '')
})

test('codeBlock: a closing fence still streaming in is never part of the code', () => {
  assert.equal(T.codeBlock('```\nTone: calm\n`').code, 'Tone: calm')
  assert.equal(T.codeBlock('```\nTone: calm\n``').code, 'Tone: calm')
  assert.equal(T.codeBlock('```\nTone: calm\n```').closed, true)
})

test('codeBlock: a longer fence holds a shorter one inside it, and tildes work', () => {
  const t = '````\nPresentation: use\n```json\n{}\n```\nTone: x\n````\nafter'
  const b = T.codeBlock(t)
  assert.equal(b.closed, true)
  assert.equal(b.code, 'Presentation: use\n```json\n{}\n```\nTone: x')
  assert.equal(T.codeBlock('~~~\nSituation: a\n~~~').code, 'Situation: a')
})

test('codeBlock: CRLF line ends are handled', () => {
  const b = T.codeBlock('x\r\n```\r\nSituation: a\r\n```\r\n')
  assert.equal(b.closed, true)
  assert.equal(b.code, 'Situation: a')
})

test('codeBlock: a fence may sit after a few leading spaces', () => {
  assert.equal(T.codeBlock('  ```\nSituation: a\n  ```').code, 'Situation: a')
})

// ═══ the completion moment ═══

test('finished: Tone followed by the closing fence, while still streaming', () => {
  assert.equal(T.finished(FULL.split('```\nAssumptions')[0]), false, 'Tone seen, fence not closed yet')
  assert.equal(T.finished(FULL.slice(0, FULL.indexOf('Assumptions'))), true)
  assert.equal(T.finished('```\nTone: a\n```'), true, 'the rule is Tone, then the closing fence')
  assert.equal(T.finished('```\nSituation: a\n```'), false, 'a closed block without Tone has not finished')
})

test('finished: or the stream ended well with all six seen, even with no closing fence', () => {
  const unclosed = FULL.slice(0, FULL.lastIndexOf('```'))
  assert.equal(T.finished(unclosed), false)
  assert.equal(T.finished(unclosed, true), true)
  assert.equal(T.finished('```\nSituation: a\n', true), false)
})

// ═══ prompt or questions ═══

test('classify: a code block is a prompt; no code block is questions; nothing is empty', () => {
  assert.equal(T.classify(FULL), 'prompt')
  assert.equal(T.classify('```\nSituation: a\n'), 'prompt', 'an unclosed block still is one')
  assert.equal(T.classify('Before I write it:\n1. Who is the audience?\n2. What is the goal?'), 'questions')
  assert.equal(T.classify('   \n'), 'empty')
  assert.equal(T.classify(undefined), 'empty')
})

// ═══ Generate again ═══

test('followUp: the original text, then the questions and the answers, under one fixed heading', () => {
  const out = T.followUp('Write a launch email', '1. Who reads it?\n2. Why now?', 'Existing customers. A price change.')
  assert.equal(out, 'Write a launch email\n\nAnswers to your questions:\n1. Who reads it?\n2. Why now?\n\nExisting customers. A price change.')
})

test('followUp trims the outer blank lines of each part and never changes the original wording', () => {
  const out = T.followUp('  keep  my spacing  ', '\n\nQ1?\n\n', '\nA1\n')
  assert.equal(out, '  keep  my spacing  \n\nAnswers to your questions:\nQ1?\n\nA1')
})
