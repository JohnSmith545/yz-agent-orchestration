// Regression tests from the QA pass on the Agents page (2026-11-24): the panel switch shows the mode that will
// open, the slim Tickets tab hides while the panel is open and keeps off the banners on a phone, and no class of
// the Agents page is one the command palette (palette.css, also pl-) styles: the shared .pl-hint cut the
// page's hint to one line with an ellipsis, and .pl-label / .pl-list leaked the palette's sizes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, '..', 'public')
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8')
const window = {}
vm.runInNewContext(read('pipeline-panel.js'), { window })
const P = window.PipelinePanel
const CSS = read('pipeline.css')

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

test('the switch and the list read ONE remembered mode: Outputs only when Outputs was chosen', () => {
  assert.equal(P.modeOf('outputs'), 'outputs')
  for (const v of [null, '', 'tickets', 'junk']) assert.equal(P.modeOf(v), 'tickets', String(v))
  // the panel keeps no copy of its own that could disagree with what opening it shows
  assert.doesNotMatch(read('pipeline-panel.js'), /st\.mode\b/)
})

test('the slim Tickets tab hides while the panel is open, so it never sits beside it over the page', () => {
  assert.match(CSS, /\.pl-panel\.open \.pl-tab\s*\{[^}]*display:\s*none/)
})

test('on a wide window the banners make room for the open panel, only while the Agents page shows', () => {
  assert.match(block(CSS, '(min-width: 901px)'), /main:has\(#agentsView:not\(\[hidden\]\) \.pl-page\.panel-open\) \.banners\s*\{[^}]*margin-right:/)
})

test('on a phone the tab sits low on the edge, clear of the banners at the top of the page', () => {
  assert.match(block(CSS, '(max-width: 720px)'), /\.pl-tab\s*\{[^}]*top:\s*auto;[^}]*bottom:/)
})

test('no class of the Agents page is one the command palette styles', () => {
  const classes = css => new Set([...css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{[^}]*\}/g, '{}').matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map(m => m[1]))
  const palette = classes(read('palette.css'))
  const ours = new Set([...classes(CSS)])
  for (const f of ['pipeline-view.js', 'pipeline-panel.js', 'pipeline-tickets.js', 'pipeline-details.js', 'agents-page.js']) {
    for (const m of read(f).matchAll(/class="([^"$]*)/g)) for (const c of m[1].split(/\s+/).filter(Boolean)) ours.add(c)
  }
  assert.deepEqual([...ours].filter(c => palette.has(c)), [])
})

test('the hint under the Independent card wraps', () => {
  assert.match(read('pipeline-details.js'), /class="pl-intro"/)
  assert.doesNotMatch(CSS, /\.pl-intro[^{]*\{[^}]*(nowrap|ellipsis)/)
})
