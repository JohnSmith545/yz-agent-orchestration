// Tests for the Brainstorming page (#/brainstorming, once called SCRIPT): how it is wired into the shell, index.html, the
// check script, the palette, the glossary and the server, the page's markup (labels,
// controls, accessible names), and its stylesheet (one accent, the narrow layout, the
// completion motion and its reduced-motion fade). Browser scripts in a vm with a bare
// window: the markup is a string, so no DOM is needed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const PUBLIC = path.join(ROOT, 'public')
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8')
const ctx = { window: {} }
for (const f of ['shell.js', 'script-text.js', 'script-render.js', 'script-state.js', 'script-sound.js', 'script-stream.js', 'script-view.js', 'script-markup.js', 'script-page.js']) vm.runInNewContext(read(f), ctx)
const { window } = ctx
const plain = v => JSON.parse(JSON.stringify(v))
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

/** The body of the first `@media <query> {...}` block in `css`, braces balanced. */
function block(css, query) {
  const at = css.indexOf(`@media ${query}`)
  if (at < 0) return null
  let i = css.indexOf('{', at)
  const start = i + 1
  for (let depth = 1; depth; ) {
    i++
    if (css[i] === '{') depth++
    else if (css[i] === '}') depth--
  }
  return css.slice(start, i)
}

// ═══ the route and the rail ═══

test('#/brainstorming is the Brainstorming page (its view keeps the old name, script) and lights its own rail entry', () => {
  const r = h => plain(window.Shell.resolve(h))
  assert.deepEqual(r('#/brainstorming'), { view: 'script', params: {}, redirect: null })
  assert.deepEqual(r('#/brainstorming/'), { view: 'script', params: {}, redirect: null })
  assert.equal(window.Shell.railFor(window.Shell.resolve('#/brainstorming')), 'script')
})

test('the old address #/script still lands on the same page, and is swapped for #/brainstorming', () => {
  const r = h => plain(window.Shell.resolve(h))
  assert.deepEqual(r('#/script'), { view: 'script', params: {}, redirect: '#/brainstorming' })
  assert.deepEqual(r('#/script/'), { view: 'script', params: {}, redirect: '#/brainstorming' })
  assert.equal(r('#/scripts').redirect, '#/', 'only the exact old address')
})

test('the rail links to Brainstorming right after QA, with its own icon, and the shell opens ScriptPage in #scriptView', () => {
  const shell = read('shell.js')
  assert.match(shell, /\$\{link\('qa', '#\/qa', 'QA'\)\}\$\{link\('script', '#\/brainstorming', 'Brainstorming'\)\}/)
  assert.match(shell, /^\s+script: svg\(/m, 'the rail icon, drawn like the others')
  assert.match(shell, /script: 'scriptView'/)
  assert.match(shell, /script: 'ScriptPage'/)
  assert.match(shell, /script: 'Brainstorming'/, 'the page title')
  assert.match(shell, /const VIEWS = \[[^\]]*'script'/)
})

test('index.html holds the section, the stylesheet and the scripts, in dependency order', () => {
  const index = read('index.html')
  assert.match(index, /<section id="scriptView" aria-label="Brainstorming" hidden><\/section>/)
  assert.ok(index.includes('<link rel="stylesheet" href="script.css">'))
  const at = s => index.indexOf(`<script src="${s}"></script>`)
  const order = ['script-text.js', 'script-render.js', 'script-state.js', 'script-sound.js', 'script-stream.js', 'script-view.js', 'script-markup.js', 'script-page.js']
  for (const s of order) assert.ok(at(s) > at('shell.js'), s)
  for (let i = 1; i < order.length; i++) assert.ok(at(order[i - 1]) < at(order[i]), `${order[i - 1]} before ${order[i]}`)
})

test('npm run check covers every new file, and the palette and glossary know the page', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  for (const f of ['script.mjs', 'script-prompt.mjs', 'script-routes.mjs', 'public/script-text.js', 'public/script-state.js', 'public/script-sound.js', 'public/script-stream.js', 'public/script-page.js', 'public/script-render.js', 'public/script-view.js', 'public/script-markup.js']) {
    assert.ok(pkg.scripts.check.includes(`node --check ${f}`), f)
  }
  assert.match(read('palette.js'), /\['Brainstorming', '#\/brainstorming'\]/)
  assert.ok(JSON.parse(read('glossary.json')).script?.short?.length > 20)
})

test('the server mounts the route with its own port', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8')
  assert.match(server, /import \{ makeScriptRoute \} from '\.\/script-routes\.mjs'/)
  assert.match(server, /makeScriptRoute\(\{ port: PORT[ ,}]/) // further deps (the context gatherer) may follow
  assert.match(server, /if \(await scriptRoute\(req, res, url\)\) return/)
})

// ═══ the markup ═══

test('two boxes: "Your thoughts" with Generate on the left, the letters, mute, Copy and the output on the right', () => {
  const h = window.ScriptPage.markup()
  assert.match(h, /<label for="scriptInput"[^>]*>Your thoughts<\/label>/)
  assert.match(h, /<textarea id="scriptInput"[^>]*maxlength="8000"/)
  assert.match(h, /<label for="scriptAnswers"[^>]*>Your answers<\/label>/)
  assert.match(h, /<div class="sc-answers" id="scriptAnswersBox" hidden>/, 'the answers box waits for questions')
  assert.equal((h.match(/class="primary"/g) || []).length, 1, 'ONE primary button')
  assert.match(h, /<button type="button" class="primary" id="scriptGo">Generate<\/button>/)
  assert.match(h, /<button type="button" id="scriptCopy" disabled>Copy<\/button>/, 'Copy waits for a code block')
  assert.match(h, /<div class="sc-out" id="scriptOut" tabindex="0" role="region" aria-label="Your prompt"/)
  assert.ok(h.indexOf('id="scriptLetters"') < h.indexOf('id="scriptOut"'), 'the letters sit above the output')
  assert.ok(h.indexOf('id="scriptInput"') < h.indexOf('id="scriptOut"'), 'input on the left, output on the right')
})

test('the letters spell S C R I P T, one per section, each named for screen readers', () => {
  const h = window.ScriptPage.markup()
  const letters = [...h.matchAll(/<span class="sc-letter" data-section="(\w+)" title="(\w+)" style="--i:(\d)">(\w)<\/span>/g)].map(m => [m[1], m[4]])
  assert.deepEqual(letters, [['Situation', 'S'], ['Character', 'C'], ['Request', 'R'], ['Intent', 'I'], ['Presentation', 'P'], ['Tone', 'T']])
})

test('the mute toggle is a button with a speaker icon and an accessible label', () => {
  const h = window.ScriptPage.markup()
  assert.match(h, /<button type="button" class="sc-mute" id="scriptMute" aria-pressed="false" aria-label="Mute the completion sound" title="Mute the completion sound">\s*<svg/)
})

test('the error line is calm: a small mark, the message and Retry, hidden until needed', () => {
  const h = window.ScriptPage.markup()
  assert.match(h, /<div class="sc-error" id="scriptError" role="alert" hidden><i class="sc-mark" aria-hidden="true"><\/i><span id="scriptErrorText"><\/span><button type="button" id="scriptRetry">Retry<\/button><\/div>/)
})

test('the page never writes model text as HTML: the output only ever gets textContent', () => {
  const src = read('script-page.js')
  const html = [...src.matchAll(/\.(?:innerHTML|outerHTML)\s*=\s*([^\n]+)/g)].map(m => m[1].trim())
  assert.ok(html.length >= 1)
  for (const rhs of html) assert.match(rhs, /^(markup\(\)|muted \? ICON\.muted : ICON\.sound\b)/, `only the static markup and the fixed icons go in as HTML: ${rhs}`)
  assert.doesNotMatch(src, /insertAdjacentHTML/)
  // the output box is drawn by script-view.js, from DOM nodes with textContent only
  const view = read('script-view.js')
  assert.doesNotMatch(view, /innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment/)
  assert.match(view, /\.textContent = /)
  assert.doesNotMatch(read('script-render.js'), /innerHTML|document/, 'the renderer is pure: text in, parts out')
})

test('Ctrl or Cmd with Enter generates from either box', () => {
  const src = read('script-page.js')
  assert.match(src, /\(e\.ctrlKey \|\| e\.metaKey\) && e\.key === 'Enter'/)
})

test('the AudioContext is made or resumed from the Generate click, and the pop is skipped when muted', () => {
  const src = read('script-page.js')
  assert.match(src, /ScriptSound\.ensureContext\(\)/)
  assert.match(src, /if \(!window\.ScriptSound\.isMuted\(store\(\)\)\) window\.ScriptSound\.play\(audio\)/)
})

// ═══ the stylesheet ═══

test('script.css: the two boxes stack on a narrow window, and nothing forces a horizontal scroll', () => {
  const css = read('script.css')
  assert.match(css, /\.sc-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/)
  const narrow = block(css, '(max-width: 900px)')
  assert.ok(narrow, 'a narrow-window block')
  assert.match(narrow, /\.sc-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)\s*;/)
  assert.match(css, /\.sc-out\s*\{[^}]*white-space:\s*pre-wrap/)
  assert.match(css, /\.sc-out\s*\{[^}]*overflow-wrap:\s*anywhere/)
  assert.match(css, /\.sc-text\s*\{[^}]*box-sizing:\s*border-box/)
  assert.doesNotMatch(css, /min-width:\s*[4-9]\d\dpx/, 'no wide minimum width')
})

test('script.css: the accent marks only the lit letters and the completion highlight', () => {
  const css = read('script.css')
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*var\(--accent(?:-soft)?\)[^{}]*)\}/g)].map(m => m[1].trim())
  assert.ok(rules.length >= 2)
  // .sc-letter.now is a lit letter too: the one whose section is being written right now
  for (const sel of rules) assert.match(sel, /sc-letter\.on|sc-letter\.now|sc-glow|^\d+%|^from|^to/, sel)
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'tokens only, no fixed colours: light and dark both follow')
})

test('script.css: the letters settle with a scale bounce under 400 ms; the box glows briefly', () => {
  const css = read('script.css')
  const settle = /\.sc-settle[^{]*\{[^}]*animation:\s*sc-settle\s+(\d+)ms/.exec(css)
  assert.ok(settle, 'the settle animation')
  assert.ok(Number(settle[1]) < 400, `${settle[1]} ms`)
  // staggered across the six letters, and ALL of it still done in under 400 ms
  const step = /\.sc-settle[^{]*\{[^}]*animation-delay:\s*calc\(var\(--i\)\s*\*\s*(\d+)ms\)/.exec(css)
  assert.ok(step, 'the settle is staggered by letter')
  assert.ok(Number(settle[1]) + 5 * Number(step[1]) < 400, `${settle[1]} + 5 x ${step[1]} ms`)
  assert.match(css, /@keyframes sc-settle\s*\{[^@]*scale\(/)
  assert.match(css, /\.sc-out\.sc-glow\s*\{[^}]*animation:\s*sc-glow\s+\d+ms/)
})

// ═══ regression (QA 2026-11-24, FAIL-30): the reduced-motion fade must really run ═══
// styles.css has a global reduced-motion rule, `*, *::before, *::after { animation-duration: .01ms !important; ... }`.
// It beat script.css's plain 300 ms and 700 ms, so the letters' opacity jumped in one frame and the box edge
// snapped back with no visible highlight. The SCRIPT rules must win with their own !important, without
// weakening the global rule for the rest of the app.

/** Each `selector { body }` rule in a block of CSS (no nesting), as { sel, decls: Map(prop -> { value, important }) }. */
function rules(css) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => {
    const decls = new Map()
    for (const d of body.split(';')) {
      const m = /^\s*([a-z-]+)\s*:\s*([\s\S]+?)\s*$/.exec(d)
      if (!m) continue
      decls.set(m[1], { value: m[2].replace(/\s*!important$/, ''), important: /!important$/.test(m[2]) })
    }
    return { sel: sel.replace(/\/\*[\s\S]*?\*\//g, '').trim(), decls }
  })
}
const ms = v => (/^[\d.]+ms$/.test(v) ? Number.parseFloat(v) : /^[\d.]+s$/.test(v) ? Number.parseFloat(v) * 1000 : NaN)

test('regression: under reduced motion the Brainstorming fade and tint beat the global zeroing with !important and a real duration', () => {
  const star = rules(block(read('styles.css'), '(prefers-reduced-motion: reduce)')).find(r => /^\*\s*,/.test(r.sel))
  assert.ok(star, 'the global reduced-motion rule is still there')
  assert.equal(star.decls.get('animation-duration')?.important, true, 'the global rule still zeroes the rest of the app')
  const zeroed = [...star.decls].filter(([p, d]) => d.important && /^(animation|transition)-/.test(p)).map(([p]) => p)
  assert.ok(zeroed.includes('animation-duration') && zeroed.includes('transition-duration'), zeroed.join(','))

  const calm = block(read('script.css'), '(prefers-reduced-motion: reduce)')
  for (const name of ['sc-fade', 'sc-tint']) {
    const own = rules(calm).filter(r => r.decls.get('animation-name')?.value === name)
    assert.ok(own.length >= 1, `a reduced-motion rule that runs ${name}, named with animation-name`)
    for (const r of own) {
      assert.ok(/\.sc-/.test(r.sel) && !/^\*/.test(r.sel), `${r.sel}: a Brainstorming page selector, more specific than *`)
      assert.equal(r.decls.get('animation-name').important, true, `${r.sel}: animation-name !important`)
      for (const p of zeroed) assert.equal(r.decls.get(p)?.important, true, `${r.sel}: ${p} must be declared !important to beat the * rule`)
      const dur = ms(r.decls.get('animation-duration').value)
      assert.ok(dur >= 150, `${r.sel}: ${name} runs ${dur} ms, which is not a visible fade`)
      assert.equal(r.decls.get('animation-iteration-count').value, '1', `${r.sel}: once`)
    }
  }
  assert.doesNotMatch(calm, /scale|translate|rotate/, 'still no movement')
})

test('script.css: under reduced motion nothing scales or moves, a simple fade only', () => {
  const css = read('script.css')
  const calm = block(css, '(prefers-reduced-motion: reduce)')
  assert.ok(calm, 'a reduced-motion block')
  assert.match(calm, /\.sc-settle[^{]*\{[^}]*animation(?:-name)?:\s*sc-fade/)
  assert.doesNotMatch(calm, /scale|translate|rotate/)
  const fade = /@keyframes sc-fade\s*\{([^@]*?)\}\s*\}/.exec(css)?.[1] || ''
  assert.match(fade, /opacity/)
  assert.doesNotMatch(fade, /transform/)
})

// ═══ the rename: every label the user reads says Brainstorming; SCRIPT stays only as the six-part method ═══

test('the words the user reads name the page Brainstorming: glossary, spend, Context panel, brief, CLI help, page help', () => {
  const g = JSON.parse(read('glossary.json')).script
  assert.match(g.short, /^Brainstorming: /)
  assert.doesNotMatch(g.short + g.more, /SCRIPT Generator/)
  assert.match(read('spend.js'), /script: 'Brainstorming'/)
  assert.match(read('script-context.js'), /What Brainstorming is told before it writes\./)
  assert.match(fs.readFileSync(path.join(ROOT, 'script-brief.mjs'), 'utf8'), /\['Brainstorming', 'turns a rough idea/)
  const cli = fs.readFileSync(path.join(ROOT, 'tools', 'context-cli.mjs'), 'utf8') + fs.readFileSync(path.join(ROOT, 'tools', 'factory.mjs'), 'utf8')
  assert.match(cli, /what the Brainstorming page is told before it writes/)
  assert.doesNotMatch(cli, /SCRIPT (Generator|is told|uses it)/)
  const page = read('script-page.js')
  assert.match(page, /window\.Shell\.setTitle\('Brainstorming', 'script'\)/)
  assert.match(page, /brainstorming skill/, 'the help says when the skill is used')
  assert.doesNotMatch(read('script-markup.js'), />[^<]*SCRIPT[^<]*</, 'no SCRIPT in the visible markup')
})

test('one comment says why the files, names, routes and data keep the word script', () => {
  assert.match(read('script-page.js'), /file names, the window\.Script\* names, the \/api\/script\/ routes and the data files keep/)
})

// At 390 px with History open, a long idea made the list wider than the page (603 px), so the page scrolled
// sideways: the grid's one column sized to its widest row. minmax(0, 1fr) keeps it to the page.
test('regression: the History list never widens the page at phone width', () => {
  assert.match(read('script.css'), /\.sc-h-list \{[^}]*grid-template-columns: minmax\(0, 1fr\)/)
})
