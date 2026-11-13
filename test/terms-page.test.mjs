// Tests for public/terms.js, the page copy of terms.mjs: the marked words an
// agent writes as [word], turned into term chips in text that is ALREADY
// escaped (Terms.html), or into the plain word for an SVG label or a tooltip
// (Terms.plain). normalise and find MUST CHANGE IN LOCKSTEP with terms.mjs, so
// a shared table runs both. A browser script, so it runs in a vm.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { normalise, findTerms } from '../terms.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const window = {}
vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', 'terms.js'), 'utf8'), { window })
const T = window.Terms
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const plain = v => JSON.parse(JSON.stringify(v))

// ═══ the shared table: the page and the server agree ═══

const WORDS = [
  'Tokens', 'token', 'status', 'analysis', 'pass', 'fast-forward', 'merge_base', '  Theme   Token ', '"quoted"', 'prefers-color-scheme',
  'SQL injection', 'idempotency.', '(cache)', 'APIs', 'class', 'bus', 'OOP', 'service accounts', 'x', 'Ünïcode words',
  'REST APIs', 'IDs', 'alias', 'aliases', 'Kubernetes', 'statuses', 'classes', 'atlas', 'canvas', 'C++',
  'databases', 'cases', 'releases', 'caches', 'boxes', 'buses', '1990s', '10s', 'MP3s', 'kudos',
]

test('normalise: the page gives the same key as terms.mjs for 40 words, and both are idempotent', () => {
  assert.equal(WORDS.length, 40)
  for (const w of WORDS) {
    assert.equal(T.normalise(w), normalise(w), w)
    assert.equal(T.normalise(T.normalise(w)), T.normalise(w), `${w} again`)
    assert.equal(normalise(normalise(w)), normalise(w), `${w} again on the server`)
  }
})

test('find: the page finds the same marked words as terms.mjs', () => {
  const texts = [
    'Checked the code for [idempotency] and built it as [detailed OOP].',
    'A [link](http://x.test), an ![image](a.png), a [ref][1], a box [ ] and [x], a [decision] kind.',
    'The [[wiki]] word, [Tokens] then [token] again, [a], and a word much too long [' + 'w'.repeat(41) + '].',
    'Two lines [not\nthis], [ spaced   out ] and [SQL injection].',
    'Shell bits [$(curl x|sh)], [a`b`], [x;y], [C++], [CI/CD] and [O(n)].',
  ]
  for (const t of texts) assert.deepEqual(plain(T.find(t)), findTerms(t), t)
})

// ═══ html: chips in escaped text ═══

test('html turns each marked word into a chip carrying its key and its raw spelling, brackets gone', () => {
  const h = T.html(esc('Checked the code for [idempotency] and built it as [detailed OOP].'))
  assert.equal(h, 'Checked the code for <dfn class="t-chip" data-term="idempotency" data-raw="idempotency" tabindex="0">idempotency</dfn>' +
    ' and built it as <dfn class="t-chip" data-term="detailed oop" data-raw="detailed OOP" tabindex="0">detailed OOP</dfn>.')
  assert.match(T.html(esc('[Tokens] and [token]')), /data-term="token" data-raw="Tokens"[^>]*>Tokens<\/dfn> and <dfn[^>]*data-term="token" data-raw="token"/, 'every mention is a chip')
})

test('html leaves markdown links, images, reference links, checkboxes and diagram kinds alone', () => {
  for (const t of ['a [link](http://x.test)', 'an ![image](a.png)', 'a [ref][1]', 'a box [ ] and [x]', 'a [decision] and [Actor] kind', 'one [' + 'w'.repeat(41) + ']']) {
    assert.equal(T.html(esc(t)), esc(t), t)
  }
})

test('html: [[wiki]] is one chip, both bracket pairs gone', () => {
  assert.equal(T.html('the [[wiki]] word'), 'the <dfn class="t-chip" data-term="wiki" data-raw="wiki" tabindex="0">wiki</dfn> word')
})

test('html never touches tags, attributes, code spans, pre blocks or links of markup it is given (md output)', () => {
  const md = '<p>Use <code>[idempotency]</code> and <a href="/x?a=[b]" title="[c]">[link text]</a> but explain [retry].</p><pre><code>[box]\n[service account]</code></pre><p>[after]</p>'
  const h = T.html(md)
  assert.match(h, /<code>\[idempotency\]<\/code>/)
  assert.match(h, /<a href="\/x\?a=\[b\]" title="\[c\]">\[link text\]<\/a>/)
  assert.match(h, /<pre><code>\[box\]\n\[service account\]<\/code><\/pre>/)
  assert.match(h, /explain <dfn class="t-chip" data-term="retry"[^>]*>retry<\/dfn>/)
  assert.match(h, /<p><dfn class="t-chip" data-term="after"[^>]*>after<\/dfn><\/p>/, 'after a closed code span, chips again')
})

test('html cannot be used to inject markup: a word holding a tag, a quote or a shell character is no word at all', () => {
  for (const t of ['Look at [<img src=x onerror=alert(1)>]', 'and ["><b>x</b>]', 'run [$(curl x|sh)]', 'pipe [a|b] and tick [a`b`]',
    "quote [x' (rm -r -fo ..) 'y]", 'brackets [O(n)]', 'a flag [-rf]']) {
    assert.equal(T.html(esc(t)), esc(t), t)
  }
  const h = T.html(esc('Built in [C++] with [CI/CD]'))
  assert.match(h, /data-raw="C\+\+"[^>]*>C\+\+<\/dfn>/)
  assert.match(h, /data-raw="CI\/CD"/)
  assert.doesNotMatch(h, /data-raw="[^"]*"[^ >]/, 'every attribute value is closed by its own quote')
})

test('html of nothing, or of text with no marks, is the text itself', () => {
  assert.equal(T.html(''), '')
  assert.equal(T.html(undefined), '')
  assert.equal(T.html('plain &amp; simple'), 'plain &amp; simple')
})

// ═══ plain: the word without its brackets (SVG labels, tooltips) ═══

test('plain drops the brackets of marked words only', () => {
  assert.equal(T.plain('Give the scheduler its own [service account]'), 'Give the scheduler its own service account')
  assert.equal(T.plain('the [[wiki]] word'), 'the wiki word')
  assert.equal(T.plain('a [link](http://x.test) and [x] and [box]'), 'a [link](http://x.test) and [x] and [box]')
  assert.equal(T.plain(null), '')
})

// ═══ sentence: the sentence a chip sits in, for Ask the agent ═══

test('sentence: the sentence holding the word, at most 300 characters', () => {
  assert.equal(T.sentence('First part. Checked the code for idempotency here. Last.', 'idempotency'), 'Checked the code for idempotency here.')
  assert.equal(T.sentence('No match at all', 'zzz'), 'No match at all')
  assert.ok(T.sentence(`${'word '.repeat(100)}idempotency ${'more '.repeat(100)}`, 'idempotency').length <= 300)
  assert.match(T.sentence(`${'word '.repeat(100)}idempotency ${'more '.repeat(100)}`, 'idempotency'), /idempotency/)
})
