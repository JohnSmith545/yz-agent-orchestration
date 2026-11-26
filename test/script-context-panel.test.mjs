// Tests for the SCRIPT Context panel (public/script-context.js, public/script-context.css): its pure helpers
// run in node:vm (the tab count, sizes, the total and the warning near the cap, which files are text, a file
// as a note), and greps for the rules the DOM glue keeps: user and model text is never HTML, every
// localStorage access is in try/catch, the closed panel is inert, colours are tokens only, no motion under
// reduced motion, and the files are wired into the page and the check list.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, '..', 'public')
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8')
const JS = read('script-context.js')
const CSS = read('script-context.css')
const window = {}
vm.runInNewContext(JS, { window })
const P = window.ScriptContext.pure

/** The body of the first `@media <query> {...}` block in `css`, braces balanced. */
function block(css, query) {
  const at = css.indexOf(`@media ${query}`)
  if (at < 0) return ''
  let i = css.indexOf('{', at)
  const start = i + 1
  for (let depth = 1; depth; ) {
    i++
    if (css[i] === '{') depth++
    else if (css[i] === '}') depth--
  }
  return css.slice(start, i)
}

const view = (o = {}) => ({
  orchestration: { on: true, chars: 3_000, text: 'brief' },
  session: { on: null, choices: [], max: 12_000 },
  notes: [],
  total: 3_000,
  limits: { titleMax: 80, textMax: 20_000, notesMax: 40, totalMax: 60_000, sessionMax: 12_000 },
  ...o,
})

test('the tab counts what is on: the brief, a chosen session and each note that is on', () => {
  assert.equal(P.countOn(view()), 1)
  assert.equal(P.countOn(view({ orchestration: { on: false } })), 0)
  assert.equal(P.countOn(view({ session: { on: 'Master' }, notes: [{ on: true }, { on: false }, { on: true }] })), 4)
  assert.equal(P.countOn(null), 0)
  assert.equal(P.tabLabel(3), 'Context · 3')
  assert.equal(P.tabLabel(0), 'Context')
})

test('sizes read as plain words', () => {
  assert.equal(P.sizeText(1), '1 character')
  assert.equal(P.sizeText(1234), '1,234 characters')
  assert.equal(P.sizeText(0), '0 characters')
})

test('the foot: about N characters attached, plus the session when one is chosen', () => {
  assert.equal(P.totalLine(view()), 'About 3,000 characters attached.')
  assert.equal(P.totalLine(view({ session: { on: 'Master', max: 12_000 } })), 'About 3,000 characters attached, plus up to 12,000 from the live session.')
})

test('a calm warning only near and over the 60,000 cap', () => {
  assert.equal(P.warnLine(view({ total: 40_000 })), '')
  assert.match(P.warnLine(view({ total: 50_000 })), /^Close to the 60,000 limit\./)
  assert.match(P.warnLine(view({ total: 70_000 })), /^Over the 60,000 limit\. The largest parts will be cut or left out\.$/)
  // a session can push it over at Generate time
  assert.match(P.warnLine(view({ total: 45_000, session: { on: 'Master', max: 12_000 } })), /^Close to/)
})

test('which files are text: by type or by name; pictures, archives and documents are not', () => {
  for (const f of [{ name: 'a.md', type: '' }, { name: 'notes.txt', type: 'text/plain' }, { name: 'data.json', type: 'application/json' }, { name: 'x.csv', type: 'text/csv' }, { name: 'app.mjs', type: '' }, { name: 'README', type: 'text/plain' }]) {
    assert.equal(P.isTextFile(f), true, f.name)
  }
  for (const f of [{ name: 'pic.png', type: 'image/png' }, { name: 'a.zip', type: 'application/zip' }, { name: 'doc.pdf', type: 'application/pdf' }, { name: 'b.docx', type: '' }, { name: 'noext', type: '' }]) {
    assert.equal(P.isTextFile(f), false, f.name)
  }
})

test('a file as a note: named after the file, refused calmly when it is not text, empty or too long', () => {
  const limits = view().limits
  assert.deepEqual({ ...P.noteFromFile({ name: 'brief.md', type: '' }, '# Hi', limits) }, { title: 'brief.md', text: '# Hi' })
  assert.deepEqual(P.noteFromFile({ name: 'x'.repeat(100) + '.txt', type: 'text/plain' }, 'a', limits).title.length, 80)
  assert.equal(P.noteFromFile({ name: 'pic.png', type: 'image/png' }, '', limits).error, 'pic.png is not a text file, so it was not added.')
  assert.equal(P.noteFromFile({ name: 'bin.txt', type: 'text/plain' }, 'a\u0000b', limits).error, 'bin.txt is not a text file, so it was not added.')
  assert.equal(P.noteFromFile({ name: 'e.txt', type: 'text/plain' }, '  \n', limits).error, 'e.txt is empty, so it was not added.')
  assert.equal(P.noteFromFile({ name: 'big.txt', type: 'text/plain' }, 'x'.repeat(20_001), limits).error, 'big.txt is over 20,000 characters, so it was not added.')
})

test('the copy is plain: the agreed lines, no em dash', () => {
  for (const line of [
    'What the Prompt generator is told before it writes. It goes only to your own Claude run.',
    'Your agents, routes and rules, written by the dashboard.',
    'Its latest conversation is read when you press Generate.',
    'Add a note', 'Add files', 'Preview', 'Live session', 'Orchestration', 'Notes',
  ]) assert.ok(JS.includes(line), line)
  assert.ok(!JS.includes('—') && !CSS.includes('—'))
})

test('user and model text is never HTML: innerHTML only ever takes the fixed markup', () => {
  const sets = [...JS.matchAll(/\.innerHTML\s*=\s*([^\n;]+)/g)].map(m => m[1].trim())
  assert.ok(sets.length >= 1)
  for (const s of sets) assert.match(s, /^(MARKUP|'')$/, s)
  assert.doesNotMatch(JS, /insertAdjacentHTML|outerHTML\s*=/)
  assert.doesNotMatch(window.ScriptContext.MARKUP, /\$\{/)
})

test('every localStorage access is inside a try', () => {
  const lines = JS.split('\n')
  lines.forEach((l, i) => {
    if (!/localStorage\./.test(l)) return
    const before = lines.slice(Math.max(0, i - 3), i).join('\n')
    assert.match(before, /try \{/, `line ${i + 1}: ${l.trim()}`)
  })
})

test('the closed panel is inert, the tab says whether it is open, and focus moves in and back', () => {
  assert.match(JS, /\.inert = !/)
  assert.match(JS, /aria-expanded/)
  assert.match(JS, /classList\.toggle\('ctx-open'/)
  assert.match(JS, /\.focus\(\)/)
  assert.match(JS, /Escape/)
})

test('the CSS: tokens only for colour, the tab hides while open, room on a wide window, overlay on a narrow one, no motion when reduced', () => {
  const noComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(noComments, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, 'colours come from the tokens')
  assert.doesNotMatch(noComments, /box-shadow/)
  assert.match(CSS, /\.sc-ctx\.open \.sc-ctx-tab\s*\{[^}]*display:\s*none/)
  assert.match(block(CSS, '(min-width: 901px)'), /\.sc-page\.ctx-open\s*\{/)
  assert.match(block(CSS, '(max-width: 720px)'), /\.sc-ctx-tab\s*\{[^}]*bottom:/)
  assert.match(block(CSS, '(prefers-reduced-motion: reduce)'), /\.sc-ctx[^{]*\{[^}]*transition:\s*none/)
})

test('wired in: the stylesheet and the script on the page, the script in npm run check', () => {
  const html = read('index.html')
  assert.match(html, /<link rel="stylesheet" href="script-context\.css">/)
  assert.match(html, /<script src="script-context\.js"><\/script>/)
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
  for (const f of ['public/script-context.js', 'script-context.mjs', 'script-context-routes.mjs', 'script-compose.mjs', 'script-brief.mjs', 'script-session.mjs', 'tools/context-cli.mjs', 'script-log.mjs', 'script-log-routes.mjs']) {
    assert.ok(pkg.checkList.includes(`node --check ${f}`), f)
  }
})

// QA, 2026-11-24: Space on a note's switch redrew the list (replaceChildren) and the focus fell to the page body,
// so the focus ring vanished and a second Space did nothing. The redraw puts the focus back on the same switch.
test('redrawing the notes keeps the keyboard focus on the switch that had it', () => {
  const paint = JS.slice(JS.indexOf('function paint()'), JS.indexOf('async function load()'))
  const held = paint.indexOf('const held =')
  const redraw = paint.indexOf('list.replaceChildren(')
  const back = paint.indexOf('[data-toggle="${CSS.escape(held)}"]')
  assert.ok(held >= 0 && redraw > held, 'the focused switch is noted before the list is replaced')
  assert.ok(back > redraw, 'and focused again after')
  assert.ok(paint.slice(back).includes('?.focus()'), 'the same switch is focused again')
})

// QA, 2026-11-25: the page-wide notice ran under the open panel. Its margin used --sc-ctx-w, which was set only on
// #scriptView, and the banners sit outside it, so the value was invalid and the margin fell back to 0.
test('regression: the panel width token is defined where the banners can read it', () => {
  assert.match(CSS, /:root\s*\{\s*--sc-ctx-w:\s*340px;\s*\}/)
  assert.doesNotMatch(CSS, /#scriptView\s*\{\s*--sc-ctx-w/)
})

// QA, 2026-11-25: on a phone the closed tab sat over the right edge of the boxes and the Copy corner.
test('regression: on a phone the page keeps a right gutter the closed tab fits in', () => {
  const at = CSS.indexOf('@media (max-width: 720px)')
  const body = CSS.slice(at, CSS.indexOf('\n}', at))
  assert.match(body, /\.sc-page:not\(\.ctx-open\)\s*\{[^}]*padding-right:\s*20px/)
  assert.match(body, /main:has\(#scriptView:not\(\[hidden\]\) \.sc-page:not\(\.ctx-open\)\) \.banners\s*\{[^}]*margin-right:\s*20px/)
})
