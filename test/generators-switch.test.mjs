// Tests for public/generators.js with a small fake DOM: the tool switch at the top of the Generators page. A switch
// made from the keyboard keeps the focus on the pill picked; only opening the page puts the focus in Your thoughts.
// (QA A-1, 2026-11-25: ArrowLeft on Standup creator picked Prompt generator and threw the focus into the textarea.)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(HERE, '..', 'public', 'generators.js'), 'utf8')

/** Just enough DOM for generators.js: a view with the prompt page, the switch it inserts and the stand-up section. */
function harness(hash = '#/generators?tool=standup') {
  const doc = { activeElement: null }
  class El {
    constructor(attrs = {}) {
      this.attrs = { ...attrs }
      this.dataset = {}
      this.tabIndex = 0
      this.hidden = false
      this.listeners = {}
      this.focused = 0
    }
    setAttribute(k, v) { this.attrs[k] = String(v) }
    getAttribute(k) { return this.attrs[k] }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) }
    focus() { this.focused++; doc.activeElement = this }
    closest(sel) { return sel === '[role="radio"]' && this.attrs.role === 'radio' ? this : null }
    insertAdjacentHTML() {}
    fire(type, ev) { for (const fn of this.listeners[type] || []) fn(ev) }
  }
  const pill = tool => Object.assign(new El({ role: 'radio' }), { dataset: { tool } })
  const buttons = [pill('prompt'), pill('standup')]
  const group = new El()
  group.querySelectorAll = () => buttons
  group.querySelector = sel => buttons.find(b => sel === `[data-tool="${b.dataset.tool}"]`) || null
  group.contains = b => buttons.includes(b)
  const page = new El()
  const standup = new El()
  const view = { querySelector: sel => ({ '.sc-page': page, '.gen-switch': group, '#standupView': standup })[sel] || null }
  const window = {
    document: doc,
    location: { hash },
    history: { replaceState(_s, _t, h) { window.location.hash = h } },
    StandupPage: { opened: 0, open() { this.opened++ } },
  }
  vm.runInNewContext(SRC, { window })
  const prompts = []
  return { G: window.Generators, window, view, group, buttons, page, standup, prompts, hook: { prompt: o => prompts.push(JSON.parse(JSON.stringify(o ?? null))) } }
}

const key = (h, k, target) => h.group.fire('keydown', { key: k, target, preventDefault() {} })

test('opening the page on the Prompt generator asks it to focus Your thoughts', () => {
  const h = harness('#/generators')
  assert.equal(h.G.open(h.view, {}, h.hook), 'prompt')
  assert.deepEqual(h.prompts, [{ focus: true }])
  assert.equal(h.page.hidden, false)
  assert.equal(h.standup.hidden, true)
})

test('regression: picking the Prompt generator by keyboard keeps the focus on its pill', () => {
  for (const k of ['ArrowLeft', 'Home', 'ArrowDown', 'ArrowRight']) {
    const h = harness()
    h.G.open(h.view, { tool: 'standup' }, h.hook)
    assert.equal(h.prompts.length, 0, 'the Standup creator opened')
    const [promptPill, standupPill] = h.buttons
    key(h, k, standupPill)
    assert.deepEqual(h.prompts, [{ focus: false }], `${k}: the Prompt generator is told not to take the focus`)
    assert.equal(h.window.document.activeElement, promptPill, `${k}: the focus is on the picked pill`)
    assert.equal(promptPill.getAttribute('aria-checked'), 'true')
    assert.equal(promptPill.tabIndex, 0)
    assert.equal(standupPill.tabIndex, -1)
    assert.equal(h.window.location.hash, '#/generators', 'the address follows the switch')
  }
})

test('a click on the Prompt generator pill leaves the focus where the click put it, too', () => {
  const h = harness()
  h.G.open(h.view, { tool: 'standup' }, h.hook)
  h.group.fire('click', { target: h.buttons[0] })
  assert.deepEqual(h.prompts, [{ focus: false }])
})

test('the Prompt generator focuses Your thoughts only when told to (script-page.js openPrompt)', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'public', 'script-page.js'), 'utf8')
  assert.match(src, /function openPrompt\(\{ focus = true \} = \{\}\)/)
  assert.match(src, /if \(focus && state\.phase === 'idle'\) els\.input\.focus/)
})
