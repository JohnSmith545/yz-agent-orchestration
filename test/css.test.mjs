// The visual language (spec 8) as greps over the stylesheets: the two layout
// breakpoints in shell.css, every motion class switched off under reduced
// motion, one 6 px radius, and no shadow outside the drawer, the popovers and
// the alerts panel. Light mode keeps its colours.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, '..', 'public')
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8')
const SHELL = read('shell.css')

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

test('shell.css holds the two layout breakpoints and the reduced-motion block', () => {
  assert.ok(block(SHELL, '(max-width: 900px)'), 'the 900 px breakpoint')
  assert.ok(block(SHELL, '(max-width: 720px)'), 'the 720 px bottom bar')
  assert.ok(block(SHELL, '(prefers-reduced-motion: reduce)'), 'the reduced-motion block')
})

test('every motion class is defined in shell.css and switched off under reduced motion', () => {
  const calm = block(SHELL, '(prefers-reduced-motion: reduce)')
  // spotlight, list entry, the Dock hover on the rail, the brand sheen, the ? popover
  for (const sel of ['.spot', '.enter', '.rail-icon', '.rail-mark', '.help-pop']) {
    assert.ok(SHELL.replace(calm, '').includes(sel), `${sel} is styled`)
    assert.ok(calm.includes(sel), `${sel} is calmed under reduced motion`)
  }
  assert.match(calm, /\.spot[^{]*::after[^{]*\{[^}]*display:\s*none/, 'no spotlight at all')
  assert.match(calm, /\.enter[^{]*\{[^}]*animation:\s*none/, 'lists appear at once')
  assert.match(calm, /\.rail-icon[^{]*\{[^}]*transform:\s*none/, 'the rail never scales')
})

test('the Dock hover is transform only: the hovered icon at 1.1, its neighbours at 1.03', () => {
  assert.match(SHELL, /\.rail-item:hover\s+\.rail-icon[^{]*\{[^}]*transform:\s*scale\(1\.1\)/)
  assert.match(SHELL, /\{[^}]*transform:\s*scale\(1\.03\)/)
})

test('cards, buttons and inputs use the one radius token', () => {
  const styles = read('styles.css')
  assert.match(styles, /--radius:\s*6px/)
  assert.match(styles, /\.card\s*\{[^}]*border-radius:\s*var\(--radius\)/)
  assert.match(styles, /button, select, input\[type="search"\]\s*\{[^}]*border-radius:\s*var\(--radius\)/)
})

test('no resting shadow on cards: only the drawer, popovers, menus and the alerts panel cast one', () => {
  const offenders = []
  for (const f of ['styles.css', 'agent-cards.css', 'card-stack.css', 'factory.css', 'flows.css', 'orchestration.css']) {
    for (const m of read(f).matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const [, sel, body] = m
      if (!/box-shadow:(?!\s*(?:none|inset|0 0 0))/.test(body)) continue
      // (a nested @media block reads as one selector with the inner one in its body)
      if (/popover|modal|menu|tip|toast|focus-visible|data-state='drag'/.test(sel + body.split(/box-shadow/)[0])) continue
      offenders.push(`${f}: ${sel.trim()}`)
    }
  }
  assert.deepEqual(offenders, [])
})

test('light mode keeps its colours: the tokens are unchanged', () => {
  const root = read('styles.css').match(/:root\s*\{([^}]*)\}/)[1]
  for (const [k, v] of Object.entries({ '--bg': '#f6f6f7', '--surface': '#ffffff', '--ink': '#1a1a1f', '--line': '#e4e4e9', '--accent': '#4a4ed4' })) {
    assert.match(root, new RegExp(`${k}:\\s*${v};`), k)
  }
})

test('every state word has a dot colour: waiting and blocked too', () => {
  const styles = read('styles.css')
  assert.match(styles, /\.dot\.waiting[^{]*\{[^}]*--dot:\s*var\(--warn\)/)
  assert.match(styles, /\.dot\.blocked[^{]*\{[^}]*--dot:\s*var\(--bad\)/)
})
