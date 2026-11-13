// Tests for public/glossary.json, the hand-written word list behind every
// <dfn data-term> on the pages (spec 7). Every entry needs a short text; every
// term a page marks must have an entry, or a click on it explains nothing.
// Most terms are marked in a template (`data-term="${state}"`), so besides the
// grep for literal values the renderers that can run in a vm are run here and
// their markup is checked too.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, '..', 'public')
const glossary = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'glossary.json'), 'utf8'))
const has = term => Object.hasOwn(glossary, term)
/** Every data-term value in some markup. */
const termsIn = html => [...String(html).matchAll(/data-term="([^"]*)"/g)].map(m => m[1])

// What the controller listed: rail labels, state words, proof states, levels, node types, evidence kinds, general terms.
const REQUIRED = [
  'home', 'flows', 'tickets', 'timeline', 'agents', 'agent', 'ask', 'alerts', 'theme',
  'idle', 'working', 'waiting', 'blocked', 'done', 'active', 'testing',
  'claimed', 'verified', 'unproven', 'pending', 'sent', 'not delivered',
  'local', 'dev', 'stage', 'prod',
  'step', 'check', 'note',
  'commit', 'diff', 'test', 'shot', 'url',
  'worktree', 'branch', 'fast-forward', 'merge base', 'headless turn', 'relay', 'evidence', 'pr', 'subagent',
  'idempotent', 'sse', 'token', 'mcp', 'playwright', 'switchboard', 'tracker', 'collection', 'source', 'verdict', 'snapshot',
]

test('every entry is keyed by a trimmed lowercase term and has a non-empty short; more is optional text', () => {
  const entries = Object.entries(glossary)
  assert.ok(entries.length >= 55, `about 60 entries, found ${entries.length}`)
  for (const [term, e] of entries) {
    assert.equal(term, term.trim().toLowerCase(), term)
    assert.equal(typeof e.short, 'string', term)
    assert.ok(e.short.trim().length > 0, term)
    assert.ok(e.more === undefined || (typeof e.more === 'string' && e.more.trim().length > 0), term)
    for (const k of Object.keys(e)) assert.ok(k === 'short' || k === 'more', `${term} has an unknown key ${k}`)
  }
})

test('every term the controller listed has an entry', () => {
  const missing = REQUIRED.filter(t => !has(t))
  assert.deepEqual(missing, [])
})

test('every literal data-term value in public/*.js exists in the glossary', () => {
  const found = []
  for (const f of fs.readdirSync(PUBLIC).filter(f => f.endsWith('.js'))) {
    for (const t of termsIn(fs.readFileSync(path.join(PUBLIC, f), 'utf8'))) if (!t.includes('${')) found.push([f, t])
  }
  assert.ok(found.length > 0, 'the pages mark at least one term with a literal value')
  assert.deepEqual(found.filter(([, t]) => !has(t)), [])
})

test('the state chips mark each state with its spec word (testing and active both read Working)', () => {
  const ctx = vm.createContext({ window: {} })
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8'), ctx)
  const WORD = { idle: 'idle', active: 'working', testing: 'working', waiting: 'waiting', blocked: 'blocked', done: 'done' }
  for (const [s, term] of Object.entries(WORD)) {
    const html = ctx.window.UI.stateChip(s)
    assert.deepEqual(termsIn(html), [term], html)
    assert.match(html, /<dfn data-term="[^"]+" tabindex="0">/)
  }
  assert.match(ctx.window.UI.stateChip('testing'), /title="Working: running tests/, 'what it runs is in the hover')
  assert.deepEqual(termsIn(ctx.window.UI.stateChip('weird')), [], 'an unknown state is printed but not marked')
})

test('the flow drawer marks node types, proof states, evidence kinds and delivery words with known terms', () => {
  const window = {}
  for (const f of ['shell.js', 'flow-drawer.js']) vm.runInNewContext(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), { window })
  const { html, delivery } = window.FlowDrawer
  const at = new Date().toISOString()
  const evidence = ['commit', 'diff', 'test', 'shot', 'url', 'note'].map(kind => ({ kind, ref: kind === 'commit' ? 'ab12cd3' : 'x', at }))
  const flow = { id: 'f', derived: { proof: { s1: 'claimed', s2: 'unproven' } } }
  const marked = [
    ...termsIn(html(flow, { id: 's1', type: 'step', title: 'T', status: 'done', evidence }, '')),
    ...termsIn(html(flow, { id: 's2', type: 'check', title: 'T', status: 'done' }, '')),
    ...termsIn(html(flow, { id: 'a1', type: 'ask', title: 'Q', answer: null }, '')),
    ...termsIn(html(flow, { id: 'n1', type: 'note', title: 'N' }, '')),
    ...termsIn(delivery({ id: 'a1', answer: 'yes', sentAt: at })),
    ...termsIn(delivery({ id: 'a1', answer: 'yes', deliveryError: 'gone' })),
  ]
  for (const t of ['step', 'check', 'ask', 'note', 'claimed', 'unproven', 'commit', 'diff', 'test', 'shot', 'url', 'sent', 'not delivered']) {
    assert.ok(marked.includes(t), `${t} is marked`)
  }
  assert.deepEqual(marked.filter(t => !has(t)), [])
})

test('the server serves .json from public/, so the page can fetch glossary.json', () => {
  // server.mjs listens on import, so its static TYPES map is read as text here.
  const src = fs.readFileSync(path.join(HERE, '..', 'server.mjs'), 'utf8')
  const types = /const TYPES = \{([\s\S]*?)\n\}/.exec(src)?.[1] || ''
  assert.match(types, /'\.json': 'application\/json; charset=utf-8'/)
})
