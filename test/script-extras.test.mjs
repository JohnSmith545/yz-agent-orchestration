// Tests for the SCRIPT page's two later additions (2026-11-24): the History list under the
// two columns, and the questions pop-up on the Your thoughts box. The markup, the wiring
// rules each DOM file keeps (text only, Escape and Tab, storage in try/catch, no browser
// dialogs) and the styles that keep the two boxes aligned. Browser scripts in a vm with a
// bare window: the markup is a string, the DOM files are read as source.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const read = f => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8')
const ctx = { window: {} }
for (const f of ['script-text.js', 'script-render.js', 'script-state.js', 'script-sound.js', 'script-stream.js', 'script-view.js', 'script-questions.js', 'script-history.js', 'script-copy.js', 'script-ask.js', 'script-history-view.js', 'script-markup.js', 'script-page.js']) vm.runInNewContext(read(f), ctx)
const h = ctx.window.ScriptPage.markup()
const css = read('script.css')
const page = read('script-page.js')
const ask = read('script-ask.js')
const hist = read('script-history-view.js')
const NEW = ['script-markup.js', 'script-questions.js', 'script-history.js', 'script-copy.js', 'script-ask.js', 'script-history-view.js']

// ═══ wiring ═══

test('every new file is in index.html before script-page.js, and in npm run check', () => {
  const index = read('index.html')
  const at = s => index.indexOf(`<script src="${s}"></script>`)
  for (const f of NEW) {
    assert.ok(at(f) > 0, f)
    assert.ok(at(f) < at('script-page.js'), `${f} before script-page.js`)
  }
  assert.ok(at('script-render.js') < at('script-questions.js'), 'the questions split uses the renderer')
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  for (const f of NEW) assert.ok(pkg.checkList.includes(`node --check public/${f}`), f)
})

test('no new DOM file writes text as HTML or opens a browser dialog', () => {
  for (const f of ['script-ask.js', 'script-history-view.js', 'script-copy.js']) {
    const src = read(f)
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML/, f)
    assert.doesNotMatch(src, /\b(confirm|alert|prompt)\(/, f)
  }
})

// ═══ History ═══

test('History: a closed disclosure under the two columns, hidden until the log answers', () => {
  assert.match(h, /<details class="sc-history" id="scriptHistory" hidden>\s*<summary id="scriptHistorySum">History<\/summary>/)
  assert.ok(h.indexOf('class="sc-grid"') < h.indexOf('id="scriptHistory"'))
  assert.ok(h.indexOf('id="scriptHistory"') < h.indexOf('id="scriptContext"'))
  assert.doesNotMatch(h, /<details[^>]* open/, 'closed by default')
  assert.match(h, /<ul class="sc-h-list" id="scriptHistoryList"><\/ul>/)
  assert.match(h, /<button type="button" id="scriptHistoryClear">Clear history<\/button>/)
  assert.match(h, /<span class="sc-h-ask" id="scriptHistoryAsk" role="group" aria-label="Clear history\?" hidden>/)
})

test('History reads and deletes through the log routes, and an older server just hides it', () => {
  assert.match(hist, /'\/api\/script\/log'/)
  assert.match(hist, /method: 'DELETE'/)
  assert.match(hist, /encodeURIComponent\(id\)/)
  assert.match(hist, /section\.hidden = true/, 'a failed or missing log hides the section')
})

test('History remembers open or closed in this browser, every storage access guarded', () => {
  assert.match(hist, /script\.historyOpen/)
  const uses = hist.split(/localStorage/).length - 1
  const guarded = [...hist.matchAll(/try \{[^}]*localStorage[^}]*\}/g)].length
  assert.ok(uses >= 1 && guarded === uses, `${guarded} of ${uses} localStorage uses inside try`)
})

test('the page refreshes History after a run ends and restores through the state machine', () => {
  assert.match(page, /history\.refresh\(out\.run\)/)
  assert.match(page, /ScriptHistory\.restoreEvent\(run\)/)
})

// ═══ the questions pop-up ═══

test('the pop-up lives in the left box, which anchors it; Show the questions sits by Your answers', () => {
  assert.match(h, /<div class="sc-answers-head"><label for="scriptAnswers" class="sc-label">Your answers<\/label><button type="button" class="link sc-ask-open" id="scriptAskOpen" hidden>Show the questions<\/button><\/div>/)
  assert.match(css, /\.sc-box\s*\{[^}]*position:\s*relative/)
  assert.match(css, /\.sc-ask\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0/)
  assert.match(page, /ScriptAsk\.create\(/)
})

test('the pop-up is a labelled dialog that keeps Tab inside and takes Escape the shell way', () => {
  assert.match(ask, /setAttribute\('role', 'dialog'\)/)
  assert.match(ask, /setAttribute\('aria-labelledby', /)
  assert.match(ask, /e\.key === 'Tab'/)
  assert.match(ask, /e\.key !== 'Escape'[\s\S]{0,120}e\.preventDefault\(\)/)
  assert.match(ask, /addEventListener\('keydown', [\s\S]*?, true\)/, 'capture, before the shell closes the drawer')
  assert.match(ask, /\(e\.ctrlKey \|\| e\.metaKey\) && e\.key === 'Enter'/)
  assert.match(ask, /'Answer and generate'/)
  assert.match(ask, /'Later'/)
})

test('the pop-up eases in (about 200 ms); under reduced motion a fade only', () => {
  const m = /\.sc-ask\s*\{[^}]*animation:\s*sc-rise\s+(\d+)ms/.exec(css)
  assert.ok(m)
  assert.ok(Number(m[1]) >= 160 && Number(m[1]) <= 240)
  const at = css.indexOf('@media (prefers-reduced-motion: reduce)')
  assert.match(css.slice(at), /\.sc-ask[^{]*\{[^}]*animation-name:\s*sc-appear !important/)
})
