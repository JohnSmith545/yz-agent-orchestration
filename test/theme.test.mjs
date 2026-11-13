// Tests for the one theme toggle in public/theme.js (spec 5). The file is a
// browser script loaded in <head>; it runs here in a vm context with a stub
// document, matchMedia and localStorage, so a throwing storage can be pinned.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(HERE, '..', 'public', 'theme.js'), 'utf8')

/** Loads theme.js against a fresh stub page. `systemDark` is the OS preference. */
function load({ storage, systemDark = false } = {}) {
  const documentElement = { dataset: {}, classList: { add() {}, remove() {} } }
  const document = { documentElement, addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] }
  const window = { matchMedia: () => ({ matches: systemDark, addEventListener() {} }) }
  const ctx = { window, document, localStorage: storage, setTimeout: () => 0 }
  vm.runInNewContext(SRC, ctx)
  return { Theme: window.Theme, root: documentElement }
}

const memory = (init = {}) => {
  const m = new Map(Object.entries(init))
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m }
}
const throwing = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() { throw new Error('denied') } }

// ═══ the cycle ═══

test('next cycles light to dark to system to light', () => {
  const { Theme } = load({ storage: memory() })
  assert.equal(Theme.next('light'), 'dark')
  assert.equal(Theme.next('dark'), 'system')
  assert.equal(Theme.next('system'), 'light')
})

test('next of anything unknown starts the cycle at light', () => {
  const { Theme } = load({ storage: memory() })
  assert.equal(Theme.next('sepia'), 'light')
})

// ═══ storage ═══

test('set dark still applies the theme when setItem throws', () => {
  const { Theme, root } = load({ storage: { ...memory(), setItem() { throw new Error('quota') } } })
  Theme.set('dark')
  assert.equal(root.dataset.theme, 'dark')
  assert.equal(Theme.get(), 'dark')
})

test('a storage that throws on read leaves the system default', () => {
  const { Theme, root } = load({ storage: throwing, systemDark: true })
  assert.equal(Theme.get(), 'system')
  assert.equal(root.dataset.theme, 'dark')
})

test('the choice is kept under the theme key, and system removes it', () => {
  const storage = memory()
  const { Theme } = load({ storage })
  Theme.set('light')
  assert.equal(storage.m.get('theme'), 'light')
  Theme.set('system')
  assert.equal(storage.m.has('theme'), false)
})

test('system follows the OS: a light OS gives light', () => {
  const { root } = load({ storage: memory(), systemDark: false })
  assert.equal(root.dataset.theme, 'light')
})
