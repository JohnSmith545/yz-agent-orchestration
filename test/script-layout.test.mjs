// Tests for the SCRIPT page's second pass (2026-11-24, the user's words: "add a restart
// button for SCRIPT. Fix the UI properly because it's not aligned perfectly when
// generated. Also i don't see the animations i asked you"). The markup of Restart, its
// Undo and the Context hooks; the stylesheet's aligned layout (same head height, one
// shared box height, the page as wide as the banner); and the animations, each with a
// calm reduced-motion form. Browser scripts in a vm with a bare window.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, '..', 'public')
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8')
const ctx = { window: {} }
for (const f of ['script-text.js', 'script-render.js', 'script-state.js', 'script-sound.js', 'script-stream.js', 'script-view.js', 'script-markup.js', 'script-page.js']) vm.runInNewContext(read(f), ctx)
const h = ctx.window.ScriptPage.markup()
const css = read('script.css')
const src = read('script-page.js')

/** The body of the first `@media <query> {...}` block in `text`, braces balanced. */
function block(text, query) {
  const at = text.indexOf(`@media ${query}`)
  if (at < 0) return null
  let i = text.indexOf('{', at)
  const start = i + 1
  for (let depth = 1; depth; ) {
    i++
    if (text[i] === '{') depth++
    else if (text[i] === '}') depth--
  }
  return text.slice(start, i)
}
/** Each `selector { body }` rule (no nesting) as { sel, decls: Map(prop -> { value, important }) }. */
function rules(text) {
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => {
    const decls = new Map()
    for (const d of body.split(';')) {
      const m = /^\s*([a-z-]+)\s*:\s*([\s\S]+?)\s*$/.exec(d)
      if (m) decls.set(m[1], { value: m[2].replace(/\s*!important$/, ''), important: /!important$/.test(m[2]) })
    }
    return { sel: sel.replace(/\/\*[\s\S]*?\*\//g, '').trim(), decls }
  })
}
const ms = v => (/^[\d.]+ms$/.test(v) ? Number.parseFloat(v) : /^[\d.]+s$/.test(v) ? Number.parseFloat(v) * 1000 : NaN)
const outside = (text, query) => text.replace(block(text, query) ?? '', '')

// ═══ the markup ═══

test('Restart sits right after Generate, off until there is something to restart', () => {
  assert.match(h, /id="scriptGo">Generate<\/button>\s*<button type="button" id="scriptRestart" disabled>Restart<\/button>/)
})

test('Started over. with Undo, hidden until a restart, and announced politely', () => {
  assert.match(h, /<span class="small sc-undo" id="scriptUndo" role="status" hidden><span>Started over\.<\/span> <button type="button" class="link" id="scriptUndoBtn">Undo<\/button><\/span>/)
})

test('both columns are head row, box, foot row; the left head holds the label, the right head the letters', () => {
  const cols = h.split('<div class="sc-col')
  assert.equal(cols.length, 3, 'two columns')
  for (const c of cols.slice(1)) {
    const head = c.indexOf('class="sc-head"')
    const box = c.search(/class="sc-(box|out)"/)
    const foot = c.indexOf('class="sc-foot')
    assert.ok(head > 0 && head < box && box < foot, 'head, then box, then foot')
  }
  assert.match(cols[1], /<div class="sc-head"><label for="scriptInput" class="sc-label">Your thoughts<\/label><\/div>/)
  assert.match(cols[2], /<div class="sc-head">\s*<div class="sc-letters"/)
})

test('Your answers shares the left box with Your thoughts, so the column never grows', () => {
  const box = /<div class="sc-box" id="scriptInBox">([\s\S]*?)<\/div>\s*<div class="sc-foot/.exec(h)
  assert.ok(box, 'the left box')
  assert.ok(box[1].includes('id="scriptInput"') && box[1].includes('id="scriptAnswersBox"'))
  assert.ok(box[1].indexOf('id="scriptInput"') < box[1].indexOf('id="scriptAnswersBox"'), 'thoughts above, answers below')
})

test('the right foot holds the error line and the quiet Sent with line', () => {
  const foot = h.slice(h.lastIndexOf('class="sc-foot'))
  assert.match(foot, /id="scriptError"/)
  assert.match(foot, /<p class="small faint sc-sent" id="scriptSent" hidden><\/p>/)
})

test('the Context hook: an empty aside beside the grid, and ScriptContext.create on mount when it exists', () => {
  assert.match(h, /<\/(div|details)>\s*<aside class="sc-ctx" id="scriptContext" aria-label="Context"><\/aside>\s*<\/div>$/)
  assert.ok(h.indexOf('class="sc-grid"') < h.indexOf('id="scriptContext"'))
  assert.match(src, /window\.ScriptContext\?\.create\(doc\.getElementById\('scriptContext'\), \{ page: view\.querySelector\('\.sc-page'\) \}\)/)
  assert.doesNotMatch(css, /\.sc-ctx/, 'nothing styles the panel: its own file does')
})

test('the page wires Restart: it aborts the run, resets the state, and tags each event with its run', () => {
  assert.match(src, /new AbortController\(\)/)
  assert.match(src, /signal: ctl\.signal/)
  assert.match(src, /\.abort\(\)/)
  assert.match(src, /dispatch\(\{ type: 'reset' \}\)/)
  assert.match(src, /dispatch\(\{ type: 'delta', text: t, run \}\)/)
  assert.match(src, /dispatch\(\{ type: 'end', ok: out\.type === 'done', error: out\.error, run \}\)/)
  assert.match(src, /onContext: c => dispatch\(\{ type: 'context', \.\.\.c, run \}\)/)
  assert.match(src, /UNDO_MS = 6000/)
})

test('the Sent with line is built from text nodes, never HTML', () => {
  assert.match(src, /sent\.textContent = /)
})

// ═══ the layout ═══

test('the page is as wide as the banner above it: no width cap; it is the anchor for the Context panel', () => {
  const page = rules(css).find(r => r.sel === '.sc-page')
  assert.ok(page)
  assert.equal(page.decls.get('max-width'), undefined)
  assert.equal(page.decls.get('position')?.value, 'relative')
})

test('both head rows have the same fixed height, and both boxes share one height that fits the window', () => {
  const wide = rules(outside(css, '(max-width: 900px)'))
  const head = wide.find(r => r.sel === '.sc-head')
  assert.match(head.decls.get('height')?.value || '', /^\d+px$/, 'a fixed height, not a min-height')
  const grid = wide.find(r => r.sel === '.sc-grid')
  assert.match(grid.decls.get('--sc-box-h')?.value || '', /^clamp\(\d+px, calc\(100dvh - \d+px\), \d+px\)$/)
  for (const sel of ['.sc-box', '.sc-out']) {
    assert.equal(wide.find(r => r.sel === sel)?.decls.get('height')?.value, 'var(--sc-box-h)', sel)
  }
  assert.equal(wide.find(r => r.sel === '.sc-out')?.decls.get('overflow')?.value, 'auto', 'the output scrolls inside its box')
})

test('the stacked layout under 900 px lets the heads wrap and keeps one column', () => {
  const narrow = block(css, '(max-width: 900px)')
  assert.match(narrow, /\.sc-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)\s*;/)
  assert.match(narrow, /\.sc-head\s*\{[^}]*height:\s*auto/)
})

test('the output is the UI font, not monospace; the prompt card lines its rows up on one grid', () => {
  const out = rules(css).find(r => r.sel === '.sc-out')
  assert.doesNotMatch(out.decls.get('font')?.value || '', /--mono/)
  assert.match(css, /\.sc-card\s*\{[^}]*display:\s*grid/)
  assert.match(css, /\.sc-row\s*\{[^}]*grid-template-columns:\s*subgrid/)
  assert.match(css, /\.sc-row-text\s*\{[^}]*white-space:\s*pre-wrap/)
  assert.match(css, /\.sc-note\s*\{/)
})

// ═══ the animations ═══

test('thinking: the letters ripple in a slow wave, one after another', () => {
  assert.match(css, /\.sc-letters\.sc-thinking \.sc-letter\s*\{[^}]*animation:\s*sc-wave\s+\d+ms[^;]*infinite/)
  assert.match(css, /\.sc-letters\.sc-thinking \.sc-letter\s*\{[^}]*animation-delay:\s*calc\(var\(--i\)/)
})

test('a letter lighting pops (about 260 ms); the letter being written keeps a soft pulsing ring', () => {
  const pop = /\.sc-letter\.sc-pop\s*\{[^}]*animation:\s*sc-pop\s+(\d+)ms/.exec(css)
  assert.ok(pop)
  assert.ok(Number(pop[1]) >= 200 && Number(pop[1]) <= 320, pop[1])
  assert.match(css, /\.sc-letter\.now::after\s*\{[^}]*animation:\s*sc-ring\s+\d+ms[^;]*infinite/)
})

test('each prompt row eases in (about 220 ms), and a thin caret blinks where the text is arriving', () => {
  const rise = /\.sc-row\s*\{[^}]*animation:\s*sc-rise\s+(\d+)ms/.exec(css)
  assert.ok(rise)
  assert.ok(Number(rise[1]) >= 180 && Number(rise[1]) <= 260, rise[1])
  assert.match(css, /@keyframes sc-rise\s*\{[^@]*opacity[^@]*translateY/)
  assert.match(css, /\.sc-live::after\s*\{[^}]*animation:\s*sc-blink/)
})

test('the questions fade in and the answers box eases open', () => {
  assert.match(css, /\.sc-para[^{]*\{[^}]*animation:\s*sc-(rise|appear)/)
  // sc-open grows its share of the left box from nothing, so Your thoughts eases up to make room
  assert.match(css, /\.sc-answers\s*\{[^}]*animation:\s*sc-open\s+\d+ms/)
  assert.match(css, /@keyframes sc-open\s*\{[^@]*flex-basis[^@]*opacity/)
})

test('reduced motion: nothing loops or moves; every animation left is a real fade that beats the global rule', () => {
  const calm = block(css, '(prefers-reduced-motion: reduce)')
  assert.doesNotMatch(calm, /infinite|scale|translate|rotate/)
  for (const sel of ['.sc-letters.sc-thinking .sc-letter', '.sc-letter.sc-pop', '.sc-live::after']) {
    const r = rules(calm).find(x => x.sel.split(/\s*,\s*/).includes(sel))
    assert.ok(r, `${sel} is calmed`)
    assert.equal(r.decls.get('animation-name')?.value, 'none', sel)
    assert.equal(r.decls.get('animation-name')?.important, true, sel)
  }
  for (const sel of ['.sc-row', '.sc-para', '.sc-answers', '.sc-letter.now::after']) {
    const r = rules(calm).find(x => x.sel.split(/\s*,\s*/).includes(sel))
    assert.ok(r, `${sel} fades`)
    assert.match(r.decls.get('animation-name')?.value || '', /^sc-(appear|fade)$/, sel)
    for (const p of ['animation-name', 'animation-duration', 'animation-iteration-count', 'transition-duration']) {
      assert.equal(r.decls.get(p)?.important, true, `${sel}: ${p} !important`)
    }
    assert.ok(ms(r.decls.get('animation-duration').value) >= 150, sel)
  }
  assert.match(css, /@keyframes sc-appear\s*\{[^}]*opacity/)
})

test('reduced motion: a letter lighting is a colour fade that the global rule does not cut to one frame', () => {
  const calm = rules(block(css, '(prefers-reduced-motion: reduce)'))
  const r = calm.find(x => x.sel === '.sc-letter')
  assert.ok(r)
  assert.equal(r.decls.get('transition-duration')?.important, true)
  assert.ok(ms(r.decls.get('transition-duration').value) >= 150)
})

// ═══ QA, 2026-11-25: with the Context panel open at 1024 to 1100 px, each column was about 270 px, too narrow for
// the letters, mute and Copy (about 320 px), so Copy ran under the panel. The viewport cannot tell how much room the
// page has (rail pinned or not, panel open or not, Ask drawer open or not); the page's own width can. ═══

/** The body of the first `@container <query> {...}` block in `text`, braces balanced. */
function containerBlock(text, query) {
  const at = text.indexOf(`@container ${query}`)
  if (at < 0) return null
  let i = text.indexOf('{', at)
  const start = i + 1
  for (let depth = 1; depth; ) {
    i++
    if (text[i] === '{') depth++
    else if (text[i] === '}') depth--
  }
  return text.slice(start, i)
}

test('regression: the grid sits in its own size container, and the fixed Context panel is NOT inside it', () => {
  assert.match(h, /<div class="sc-fit">\s*<div class="sc-grid">/)
  const fit = h.slice(h.indexOf('<div class="sc-fit">'), h.indexOf('<details class="sc-history"'))
  assert.ok(!fit.includes('id="scriptContext"'), 'a size container would hold the fixed panel inside it')
  assert.ok(h.indexOf('id="scriptContext"') > h.indexOf('<div class="sc-fit">'))
  assert.match(css, /\.sc-fit\s*\{[^}]*container:\s*sc-fit \/ inline-size/)
})

test('regression: when the page itself is under 760 px wide the boxes stack and the heads may wrap, whatever the window', () => {
  const narrow = containerBlock(css, 'sc-fit (max-width: 760px)')
  assert.ok(narrow, 'a container query on the page width')
  assert.match(narrow, /\.sc-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/)
  assert.match(narrow, /\.sc-head\s*\{[^}]*height:\s*auto[^}]*flex-wrap:\s*wrap/)
})
