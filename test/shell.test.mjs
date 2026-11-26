// Tests for the hash routing in public/shell.js (spec 5). The file is a
// browser script: it attaches window.Shell first and returns before touching
// the DOM when there is no document, so it runs here in a vm context with a
// bare window. Shell.resolve is pure: a hash in, a route out.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const window = {}
vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', 'shell.js'), 'utf8'), { window })
const { resolve } = window.Shell
/** Objects made inside the vm have its prototypes, so strict deepEqual needs plain copies. */
const r = h => JSON.parse(JSON.stringify(resolve(h)))

// ═══ the pages ═══

test('#/ is Flows, the landing page, with no params and no redirect', () => {
  assert.deepEqual(r('#/'), { view: 'flows', params: {}, redirect: null })
})

test('no hash at all, or a bare #, is Flows without a redirect', () => {
  assert.deepEqual(r(''), { view: 'flows', params: {}, redirect: null })
  assert.deepEqual(r('#'), { view: 'flows', params: {}, redirect: null })
})

test('Home moved to #/home; #/flows still opens Flows, so old links keep working', () => {
  assert.deepEqual(r('#/home'), { view: 'home', params: {}, redirect: null })
  assert.deepEqual(r('#/home/'), { view: 'home', params: {}, redirect: null })
  assert.deepEqual(r('#/flows'), { view: 'flows', params: {}, redirect: null })
})

test('each page route resolves to its own view without a redirect', () => {
  for (const view of ['flows', 'home', 'qa', 'tickets', 'timeline', 'agents', 'subagents', 'glossary', 'settings']) {
    assert.deepEqual(r(`#/${view}`), { view, params: {}, redirect: null })
  }
  assert.deepEqual(r('#/generators'), { view: 'script', params: {}, redirect: null }, 'Generators: its view keeps the old name')
  assert.deepEqual(r('#/generators?tool=standup'), { view: 'script', params: { query: { tool: 'standup' } }, redirect: null }, 'a link that opens the Standup creator')
})

// ═══ old routes ═══

test('#/script and #/brainstorming (the page s earlier names) redirect to #/generators, a query kept', () => {
  assert.deepEqual(r('#/script'), { view: 'script', params: {}, redirect: '#/generators' })
  assert.deepEqual(r('#/brainstorming'), { view: 'script', params: {}, redirect: '#/generators' })
  assert.deepEqual(r('#/brainstorming?tool=standup'), { view: 'script', params: { query: { tool: 'standup' } }, redirect: '#/generators?tool=standup' })
})

test('#/factory redirects to #/tickets', () => {
  assert.deepEqual(r('#/factory'), { view: 'tickets', params: {}, redirect: '#/tickets' })
})

test('#/flow redirects to #/timeline, and #/flows is not mistaken for it', () => {
  assert.deepEqual(r('#/flow'), { view: 'timeline', params: {}, redirect: '#/timeline' })
  assert.equal(r('#/flows').redirect, null)
})

// ═══ one agent ═══

test('#/agent/<id>/<sub> decodes both parts', () => {
  assert.deepEqual(r('#/agent/abc%20d/sub1'), { view: 'agent', params: { id: 'abc d', sub: 'sub1' }, redirect: null })
})

test('#/agent/<id> without a subagent has sub null', () => {
  assert.deepEqual(r('#/agent/s-1'), { view: 'agent', params: { id: 's-1', sub: null }, redirect: null })
})

test('a malformed percent escape in an agent id keeps the raw text instead of throwing', () => {
  assert.deepEqual(r('#/agent/a%E0b'), { view: 'agent', params: { id: 'a%E0b', sub: null }, redirect: null })
})

test('#/agent/ with no id is unknown and goes to the landing page', () => {
  assert.deepEqual(r('#/agent/'), { view: 'flows', params: {}, redirect: '#/' })
})

// ═══ anything else ═══

test('an unknown route goes to Flows with a redirect to #/', () => {
  assert.deepEqual(r('#/nonsense'), { view: 'flows', params: {}, redirect: '#/' })
})

test('a non-string hash never throws', () => {
  assert.deepEqual(r(undefined), { view: 'flows', params: {}, redirect: null })
})

test('the rail: the brand mark still opens #/home, and the Work group starts Home, then Flows', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'public', 'shell.js'), 'utf8')
  assert.match(src, /<a class="rail-item rail-brand" href="#\/home"/)
  const ctx = { window: {} }
  for (const f of ['rail-groups.js', 'shell.js']) vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8'), ctx)
  assert.equal(ctx.window.RailGroups.groups()[0].entries.slice(0, 2).map(e => e.href).join(' '), '#/home #/flows')
})

test('no link still sends a reader Home by #/ (that is Flows now): the palette and the Since card use #/home', () => {
  const pub = f => fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8')
  const ctx = { window: {} }
  for (const f of ['rail-groups.js', 'palette.js']) vm.runInNewContext(pub(f), ctx)
  assert.equal(ctx.window.Palette.gather({}).find(i => i.label === 'Home')?.hint, '#/home')
  assert.doesNotMatch(pub('since.js'), /'#\/'|"#\/"/)
})

// ═══ the rail, for a popover anchored to it (notify.js, the Alerts panel) ═══

test('Shell.collapseRail exists so a panel opened from the rail can fold a hover-opened rail', () => {
  assert.equal(typeof window.Shell.collapseRail, 'function')
})

// ═══ the rail carries no explainable terms ═══

test('the rail labels are plain text: a click there follows the link, so no inert dfn markup', () => {
  // The page title (a dfn) explains the page; explain.js never opens a rail term.
  const src = fs.readFileSync(path.join(HERE, '..', 'public', 'shell.js'), 'utf8')
  assert.doesNotMatch(src, /rail-label"><dfn/)
})

// ═══ which rail entry is lit ═══

test('a subagent in the live view lights Subagents, a session lights Agents, and a page lights itself', () => {
  const { railFor } = window.Shell
  assert.equal(railFor(resolve('#/agent/sess-1/sub-1')), 'subagents')
  assert.equal(railFor(resolve('#/agent/sess-1')), 'agents')
  assert.equal(railFor(resolve('#/subagents')), 'subagents')
  assert.equal(railFor(resolve('#/flows')), 'flows')
  assert.equal(railFor(resolve('#/')), 'flows')
  assert.equal(railFor(resolve('#/home')), 'home')
})

// ═══ a query on a page route ═══

test('a page route may carry a query: handed to the page as params.query, decoded; a bare page keeps params {}', () => {
  assert.deepEqual(r('#/flows?flow=dark-mode&at=hand'), { view: 'flows', params: { query: { flow: 'dark-mode', at: 'hand' } }, redirect: null })
  assert.deepEqual(r('#/agents?human'), { view: 'agents', params: { query: { human: '' } }, redirect: null })
  assert.deepEqual(r('#/archive?q=dark+mode%21'), { view: 'archive', params: { query: { q: 'dark mode!' } }, redirect: null })
  assert.deepEqual(r('#/archive?q=%E0%A4'), { view: 'archive', params: { query: { q: '%E0%A4' } }, redirect: null }, 'a malformed escape is kept raw')
  assert.deepEqual(r('#/archive'), { view: 'archive', params: {}, redirect: null })
  assert.deepEqual(r('#/nope?x=1'), { view: 'flows', params: {}, redirect: '#/' })
})
