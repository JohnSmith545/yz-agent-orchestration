// Tests for public/script-render.js: the SCRIPT answer as a list of parts, so the page
// can draw clean text instead of raw model marks. Prose becomes paragraphs and real
// lists with bold and code spans; the code block becomes a prompt card with one row per
// section; text after the block is a quiet note. Mid-stream, anything that could still
// turn into a mark (half a fence, half a `**`, a label still arriving) is held back, so
// the page never flashes raw marks. A browser script in a vm, no DOM.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ctx = { window: {} }
for (const f of ['script-text.js', 'script-render.js']) vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8'), ctx)
const R = ctx.window.ScriptRender
const T = ctx.window.ScriptText
const plain = v => JSON.parse(JSON.stringify(v))
const parts = (t, live = false) => plain(R.parts(t, { live }))
const txt = (text, style = 'text') => ({ style, text })

const FULL = [
  'Here is your prompt.',
  '',
  '```markdown',
  'Situation: A small bakery wants more weekday orders.',
  'Character: Senior local copywriter.',
  'Request: Write three captions.',
  'Continue on a second line.',
  'Intent: Fill quiet slots.',
  'Presentation: A numbered list.',
  'Tone: Warm and plain.',
  '```',
  'Assumptions: the bakery posts on Instagram only.',
].join('\n')

const QUESTIONS = [
  "I'll need a little more first:",
  '',
  '1. **What is the orchestration?** What do the agents do?',
  '2. **Which animations?** Name the `fade-in` you want.',
  '3. **"F4"**: did you mean F1?',
  '',
  'Once you answer, I will write it.',
].join('\n')

// ═══ prose ═══

test('empty text is no parts', () => {
  assert.deepEqual(parts(''), [])
  assert.deepEqual(parts('   \n\n'), [])
  assert.deepEqual(parts(undefined), [])
})

test('questions become a paragraph, a real numbered list with bold and code spans, and a paragraph', () => {
  const p = parts(QUESTIONS)
  assert.deepEqual(p.map(x => x.kind), ['para', 'list', 'para'])
  assert.deepEqual(p[0], { kind: 'para', note: false, spans: [txt("I'll need a little more first:")] })
  assert.equal(p[1].ordered, true)
  assert.equal(p[1].start, 1)
  assert.deepEqual(p[1].items[0], [txt('What is the orchestration?', 'strong'), txt(' What do the agents do?')])
  assert.deepEqual(p[1].items[1], [txt('Which animations?', 'strong'), txt(' Name the '), txt('fade-in', 'code'), txt(' you want.')])
  assert.deepEqual(p[1].items[2], [txt('"F4"', 'strong'), txt(': did you mean F1?')])
  assert.equal(p[2].spans[0].text, 'Once you answer, I will write it.')
})

test('no raw marks survive in finished prose: no ** and no backticks around code', () => {
  for (const part of parts(QUESTIONS)) {
    const spans = part.kind === 'list' ? part.items.flat() : part.spans
    for (const s of spans) assert.doesNotMatch(s.text, /\*\*/, s.text)
    for (const s of spans.filter(x => x.style === 'code')) assert.doesNotMatch(s.text, /`/)
  }
})

test('a list that starts right under a line of text, with no blank line, is still a list', () => {
  const p = parts('Three questions:\n1. Who?\n2. Why?')
  assert.deepEqual(p.map(x => x.kind), ['para', 'list'])
  assert.equal(p[1].items.length, 2)
})

test('bullets make an unordered list; an indented line continues the item above it', () => {
  const p = parts('- one\n  more of one\n* two\n• three')
  assert.equal(p.length, 1)
  assert.equal(p[0].ordered, false)
  assert.deepEqual(p[0].items.map(i => i.map(s => s.text).join('')), ['one more of one', 'two', 'three'])
})

test('a numbered list keeps its first number', () => {
  assert.equal(parts('3. third\n4. fourth')[0].start, 3)
})

test('lines inside one paragraph keep their line break', () => {
  assert.deepEqual(parts('one\ntwo')[0].spans, [txt('one\ntwo')])
})

test('a lone ** in finished text stays as written; a half pair of backticks too', () => {
  assert.deepEqual(parts('5 ** 2 is 25')[0].spans, [txt('5 ** 2 is 25')])
  assert.deepEqual(parts('a ` b')[0].spans, [txt('a ` b')])
})

test('bold may span the line break inside a paragraph, and code inside bold is code', () => {
  assert.deepEqual(parts('**a\nb** c')[0].spans, [txt('a\nb', 'strong'), txt(' c')])
  assert.deepEqual(parts('**x `y` z**')[0].spans, [txt('x ', 'strong'), txt('y', 'code'), txt(' z', 'strong')])
})

// ═══ the code block ═══

test('a full answer: the lead-in, a prompt card with six rows and no fences, then the assumptions as a quiet note', () => {
  const p = parts(FULL)
  assert.deepEqual(p.map(x => x.kind), ['para', 'prompt', 'para'])
  assert.equal(p[0].note, false)
  const card = p[1]
  assert.equal(card.closed, true)
  assert.equal(card.lead, '')
  assert.deepEqual(card.sections.map(s => [s.letter, s.name]), [['S', 'Situation'], ['C', 'Character'], ['R', 'Request'], ['I', 'Intent'], ['P', 'Presentation'], ['T', 'Tone']])
  assert.equal(card.sections[0].text, 'A small bakery wants more weekday orders.')
  assert.equal(card.sections[2].text, 'Write three captions.\nContinue on a second line.')
  assert.equal(p[2].note, true)
  assert.deepEqual(p[2].spans, [txt('Assumptions: the bakery posts on Instagram only.')])
  assert.doesNotMatch(JSON.stringify(p), /```/)
})

test('bold labels lose their marks; text in the block before the first label stays plain lead text', () => {
  const p = parts('```\nWrite to me as **you**.\n\n**Situation:** a\n**Tone**: b\n```')
  assert.equal(p[0].lead, 'Write to me as **you**.')
  assert.deepEqual(p[0].sections.map(s => [s.name, s.text]), [['Situation', 'a'], ['Tone', 'b']])
})

test('the card never changes what Copy copies: section text is the block text, label lines aside', () => {
  const code = T.codeBlock(FULL).code
  const card = parts(FULL)[1]
  for (const s of card.sections) assert.ok(code.includes(s.text), s.name)
})

// ═══ mid-stream: no raw marks ever flash ═══

test('mid-stream: a fence still being typed is held back, so ``` never shows', () => {
  for (const t of ['Here it is:\n`', 'Here it is:\n``', 'Here it is:\n```', 'Here it is:\n```mark']) {
    assert.deepEqual(parts(t, true).map(x => x.kind), ['para'], t)
    assert.doesNotMatch(JSON.stringify(parts(t, true)), /`/, t)
  }
})

test('mid-stream: an unclosed block is an open card; a closing fence on its way is not text', () => {
  const p = parts('Intro\n```\nSituation: a\nCharacter: b\n``', true)
  assert.deepEqual(p.map(x => x.kind), ['para', 'prompt'])
  assert.equal(p[1].closed, false)
  assert.deepEqual(p[1].sections.map(s => s.text), ['a', 'b'])
})

test('mid-stream: a label still arriving is held back, not shown as text of the row above', () => {
  for (const tail of ['C', 'Char', 'Character', '**Char', '**Character**']) {
    const p = parts(`\`\`\`\nSituation: a\n${tail}`, true)
    assert.equal(p[0].sections.length, 1, tail)
    assert.equal(p[0].sections[0].text, 'a', tail)
  }
  const p = parts('```\nSituation: a\nCharacter:', true)
  assert.deepEqual(p[0].sections.map(s => [s.name, s.text]), [['Situation', 'a'], ['Character', '']], 'a label with its colon is a row at once')
})

test('mid-stream: a line that is not a label prefix shows at once', () => {
  assert.equal(parts('```\nSituation: a\nand more', true)[0].sections[0].text, 'a\nand more')
})

test('mid-stream: a half-typed ** is never shown; an open ** styles the rest as bold', () => {
  assert.deepEqual(parts('1. *', true)[0].items[0], [])
  assert.deepEqual(parts('Say *', true)[0].spans, [txt('Say ')])
  assert.deepEqual(parts('1. **What is', true)[0].items[0], [txt('What is', 'strong')])
  assert.deepEqual(parts('use `fade', true)[0].spans, [txt('use '), txt('fade', 'code')])
})

test('mid-stream: a list number still arriving is held back rather than shown as a paragraph', () => {
  assert.deepEqual(parts('Questions:\n1', true).map(x => x.kind), ['para'])
  assert.deepEqual(parts('Questions:\n1.', true).map(x => x.kind), ['para'])
  assert.deepEqual(parts('- a\n-', true)[0].items.length, 1)
})

test('mid-stream rendering of every prefix of a full answer never shows a fence or a ** mark', () => {
  for (let i = 1; i <= FULL.length; i++) {
    const s = JSON.stringify(parts(FULL.slice(0, i), true))
    assert.doesNotMatch(s, /```|``/, `at ${i}`)
  }
  for (let i = 1; i <= QUESTIONS.length; i++) {
    const s = JSON.stringify(parts(QUESTIONS.slice(0, i), true))
    assert.doesNotMatch(s, /\*\*/, `at ${i}`)
  }
})

test('parts are stable as text grows: earlier parts keep the same shape when more arrives', () => {
  const a = parts(FULL.slice(0, FULL.indexOf('Tone')), true)
  const b = parts(FULL, true)
  assert.deepEqual(a[0], b[0], 'the lead-in paragraph is unchanged')
  assert.deepEqual(a[1].sections.slice(0, 4), b[1].sections.slice(0, 4))
})

// The brainstorm offers choices under a question as sub-bullets (seen in a real run, 2026-11-25): they must stay the
// choices of that question, not become questions of their own in the pop-up.
test('regression: bullets indented under a numbered item, or right under it, are marked nested', () => {
  const p = parts('1. Which?\n   - a) One\n   - b) Two\n2. Next?')
  assert.deepEqual(p.map(x => [x.kind, x.ordered, x.nested ?? false]), [['list', true, false], ['list', false, true], ['list', true, false]])
  assert.equal(p[2].start, 2)
  assert.equal(parts('1. Which?\n- a) One\n- b) Two')[1].nested, true, 'right under it, no blank line')
  assert.equal(parts('1. Which?\n\n- a note').at(-1).nested, undefined, 'after a blank line, a bullet list of its own')
  assert.equal(parts('- Who?\n- Why?')[0].nested, undefined, 'a plain bullet list is unchanged')
})
