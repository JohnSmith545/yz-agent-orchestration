// Tests for public/strip-panels.js, the panel redraw and the bars' one tab stop shared by Pipeline time
// (time-strip.js) and Pipeline tokens (token-strip.js): a panel drawn again keeps every disclosure the user opened or
// closed (As a list used to close itself on every refresh, QA 2026-11-25), and the bars keep exactly ONE tab stop
// whether the focus moved by key or by a click (a click used to leave two bars at tabindex 0). The pure parts run in a
// vm with a bare window; greps check both strips use them and the page loads the file first.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const read = f => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8')
const ctx = vm.createContext({ window: {} })
vm.runInContext(read('strip-panels.js'), ctx)
const P = ctx.window.StripPanels

const HTML = '<ol class="ptm-chart"></ol><details class="ptm-list"><summary>As a list</summary><ul></ul></details><details open><summary>B</summary></details>'

test('a redraw keeps each disclosure as the user left it, by its place in the panel', () => {
  assert.equal(P.withOpen(HTML, [true, false]), '<ol class="ptm-chart"></ol><details class="ptm-list" open><summary>As a list</summary><ul></ul></details><details><summary>B</summary></details>')
  assert.equal(P.withOpen(HTML, [false, true]), '<ol class="ptm-chart"></ol><details class="ptm-list"><summary>As a list</summary><ul></ul></details><details open><summary>B</summary></details>')
  // the first draw, or a panel with no disclosure before: the HTML's own defaults
  assert.equal(P.withOpen(HTML, null), HTML)
  assert.equal(P.withOpen(HTML, []), HTML)
  // a disclosure the old panel did not have keeps its default
  assert.equal(P.withOpen(HTML, [true]), '<ol class="ptm-chart"></ol><details class="ptm-list" open><summary>As a list</summary><ul></ul></details><details open><summary>B</summary></details>')
  // text that only looks like the tag is not touched
  assert.equal(P.withOpen('<p>&lt;details&gt;</p><details>x</details>', [true]), '<p>&lt;details&gt;</p><details open>x</details>')
})

test('one tab stop: the bar the focus went to, by key or by click, is the only one at tabindex 0', () => {
  const cols = [0, 1, 2, 3].map(i => ({ i, tabIndex: i === 3 ? 0 : -1 }))
  // End was pressed (3), then the user clicked bar 1: before the fix bars 1 and 3 were both 0
  assert.equal(P.rovingTo(cols, cols[1]), cols[1])
  assert.deepEqual(cols.map(c => c.tabIndex), [-1, 0, -1, -1])
  assert.equal(P.rovingTo(cols, null), null)
  assert.deepEqual(cols.map(c => c.tabIndex), [-1, 0, -1, -1])
})

test('the arrow keys, Home and End: where each goes from a bar', () => {
  assert.equal(P.keyTarget('ArrowLeft', 2, 5), 1)
  assert.equal(P.keyTarget('ArrowRight', 2, 5), 3)
  assert.equal(P.keyTarget('ArrowRight', 4, 5), null)
  assert.equal(P.keyTarget('ArrowLeft', 0, 5), null)
  assert.equal(P.keyTarget('Home', 3, 5), 0)
  assert.equal(P.keyTarget('End', 0, 5), 4)
  assert.equal(P.keyTarget('Tab', 0, 5), null)
})

test('both strips redraw their panels and rove their bars with these, and the page loads the file before them', () => {
  for (const f of ['time-strip.js', 'token-strip.js']) {
    const src = read(f)
    assert.match(src, /StripPanels\.swap\(/, f)
    assert.match(src, /StripPanels\.rove\(el\)/, f)
    assert.doesNotMatch(src, /addEventListener\('keydown'/, f)
  }
  const html = read('index.html')
  assert.ok(html.indexOf('src="strip-panels.js"') > 0)
  assert.ok(html.indexOf('src="strip-panels.js"') < html.indexOf('src="time-strip.js"'))
  const check = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).checkList
  assert.ok(check.includes('node --check public/strip-panels.js'))
})
