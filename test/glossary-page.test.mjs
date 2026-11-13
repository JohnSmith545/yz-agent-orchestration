// Tests for public/glossary-page.js, the Glossary page (#/glossary): every word
// the dashboard can explain, searchable and filterable, with your own wording
// saved through the shared store. A browser script, so it runs in a vm with a
// stub store, a stub shell and a small stub DOM.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, '..', 'public')

const TERMS = [
  { key: 'idempotency', term: 'idempotency', short: 'Doing it twice has the same effect as once.', more: null, source: 'learned', at: '2026-11-11T10:00:00Z', seenIn: ['dark-mode', 'no-visual', 'other'] },
  { key: 'token', term: 'token', short: 'A short secret string.', more: null, source: 'you', at: '2026-11-12T10:00:00Z', seenIn: [] },
  { key: 'worktree', term: 'worktree', short: 'A second checkout of the same repository.', more: null, source: 'built-in', at: null, seenIn: [] },
  { key: 'retry storm', term: 'retry storm', short: 'Many clients retrying at once.', more: null, source: 'agent', at: '2026-11-13T09:00:00Z', seenIn: ['dark-mode'] },
]

function stub(props = {}) {
  return { hidden: false, innerHTML: '', value: '', dataset: {}, listeners: {}, addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn) }, querySelector: () => null, querySelectorAll: () => [], focus() { this.focused = true }, closest: () => null, ...props }
}

function load(terms = TERMS) {
  const calls = []
  const titles = []
  const gone = []
  let store = structuredClone(terms)
  const Glossary = {
    all: () => store,
    onChange: () => {},
    refresh: async () => { calls.push(['refresh']) },
    save: async b => { calls.push(['save', b]); return { ok: true, entry: { ...b, key: b.term, source: 'you' } } },
    remove: async key => { calls.push(['remove', key]); store = store.filter(e => e.key !== key); return { ok: true } },
  }
  const section = stub()
  const document = stub({ getElementById: id => (id === 'glossaryView' ? section : null) })
  const window = {
    Glossary,
    Shell: { setTitle: (...a) => titles.push(a), setStatus: () => {}, ago: iso => (iso ? '2d' : ''), current: { view: 'glossary' } },
    FlowsView: { gotoFlow: id => gone.push(id) },
    Help: { attach: () => {} },
  }
  vm.runInNewContext(fs.readFileSync(path.join(PUBLIC, 'glossary-page.js'), 'utf8'), { window, document })
  return { G: window.GlossaryPage, calls, titles, gone, section }
}
const rowsOf = h => [...h.matchAll(/<li class="gl-row" data-key="([^"]*)"/g)].map(m => m[1])

test('search filters as you type over the word and its explanation, any case', () => {
  const { G } = load()
  assert.deepEqual(rowsOf(G.listHtml(TERMS, { q: '' })), ['idempotency', 'retry storm', 'token', 'worktree'])
  assert.deepEqual(rowsOf(G.listHtml(TERMS, { q: 'TWICE' })), ['idempotency'], 'over the explanation')
  assert.deepEqual(rowsOf(G.listHtml(TERMS, { q: 'work' })), ['worktree'])
})

test('the filter: All, Learned, From agents, Yours, Built-in', () => {
  const { G } = load()
  assert.deepEqual(rowsOf(G.listHtml(TERMS, { filter: 'learned' })), ['idempotency'])
  assert.deepEqual(rowsOf(G.listHtml(TERMS, { filter: 'agents' })), ['retry storm'])
  assert.deepEqual(rowsOf(G.listHtml(TERMS, { filter: 'yours' })), ['token'])
  assert.deepEqual(rowsOf(G.listHtml(TERMS, { filter: 'built-in' })), ['worktree'])
  assert.deepEqual(rowsOf(G.listHtml(TERMS, { filter: 'all', q: 'secret' })), ['token'])
})

test('each filter carries its count the way every head does: Yours · 1', () => {
  const { G } = load()
  assert.deepEqual(JSON.parse(JSON.stringify(G.filterLabels(TERMS))), [
    ['all', 'All · 4'], ['learned', 'Learned · 1'], ['agents', 'From agents · 1'], ['yours', 'Yours · 1'], ['built-in', 'Built-in · 1'],
  ])
})

test('a row: the word, the one-line explanation, a muted meta line, and seen in N flows linking to the first', () => {
  const { G } = load()
  const h = G.listHtml(TERMS, {})
  assert.match(h, /<span class="gl-term">idempotency<\/span><p class="gl-short">Doing it twice has the same effect as once\.<\/p><p class="gl-meta">learned 2d · <button type="button" class="link" data-gl-flow="dark-mode">seen in 3 flows<\/button><\/p>/)
  assert.match(h, /<p class="gl-meta">yours<\/p>/)
  assert.match(h, /<p class="gl-meta">built-in<\/p>/)
  assert.match(h, /<p class="gl-meta">from the agent 2d · <button[^>]*>seen in 1 flow<\/button>/)
})

test('Edit on every row; Remove on every row but a built-in one', () => {
  const { G } = load()
  const h = G.listHtml(TERMS, {})
  const row = key => h.slice(h.indexOf(`data-key="${key}"`), h.indexOf('</li>', h.indexOf(`data-key="${key}"`)))
  for (const k of ['idempotency', 'token', 'worktree', 'retry storm']) assert.match(row(k), /data-gl-edit/, k)
  for (const k of ['idempotency', 'token', 'retry storm']) assert.match(row(k), /data-gl-remove/, k)
  assert.doesNotMatch(row('worktree'), /data-gl-remove/)
})

test('Remove asks first: the button reads Remove? and a second click removes', () => {
  const { G } = load()
  const h = G.listHtml(TERMS, { confirm: 'token' })
  const row = h.slice(h.indexOf('data-key="token"'), h.indexOf('</li>', h.indexOf('data-key="token"')))
  assert.match(row, /<button type="button" class="link" data-gl-remove data-confirm>Remove\?<\/button>/)
  assert.doesNotMatch(G.listHtml(TERMS, {}), /Remove\?/)
})

test('a word with more shows a More disclosure on its row', () => {
  const { G } = load([{ ...TERMS[0], more: 'So a retry is safe.' }])
  assert.match(G.listHtml([{ ...TERMS[0], more: 'So a retry is safe.' }], {}), /<details class="gl-more"><summary>More<\/summary><p>So a retry is safe\.<\/p><\/details>/)
})

test('opening the page reloads the glossary, so a word an agent defined since shows at once', () => {
  const { G, calls } = load()
  G.open()
  assert.ok(calls.some(c => c[0] === 'refresh'))
})

test('editing a row shows a textarea with the explanation and Save, Cancel', () => {
  const { G } = load()
  const h = G.listHtml(TERMS, { editing: 'token' })
  assert.match(h, /data-key="token"[\s\S]*?<textarea class="gl-edit"[^>]*>A short secret string\.<\/textarea>[\s\S]*?data-gl-save[\s\S]*?data-gl-cancel/)
})

test('add, edit and remove go through the store: your wording, saved as yours', async () => {
  const { G, calls } = load()
  assert.equal((await G.add('Circuit breaker', 'Stops calling a service that keeps failing.')).ok, true)
  await G.edit('token', 'token', 'My own words.')
  await G.remove('idempotency')
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['save', { term: 'Circuit breaker', short: 'Stops calling a service that keeps failing.' }],
    ['save', { term: 'token', short: 'My own words.' }],
    ['remove', 'idempotency'],
  ])
  assert.deepEqual(JSON.parse(JSON.stringify(await G.add('  ', 'x'))), { error: 'Write the word and what it means.' }, 'nothing blank is sent')
  assert.equal(calls.length, 3)
})

test('the empty glossary and a search that matches nothing are one line each', () => {
  const { G } = load()
  assert.equal(G.listHtml([], {}), '<p class="small faint gl-empty">No words yet.</p>')
  assert.equal(G.listHtml(TERMS, { q: 'zebra' }), '<p class="small faint gl-empty">No word matches “zebra”.</p>')
})

test('word, explanation and search text are escaped', () => {
  const { G } = load()
  const bad = [{ key: 'x', term: '<img src=x onerror=1>', short: '<script>2</script>', more: null, source: 'learned', at: null, seenIn: ['a"b'] }]
  const h = G.listHtml(bad, {})
  assert.doesNotMatch(h, /<img|<script/)
  assert.match(h, /data-gl-flow="a&quot;b"/)
  assert.doesNotMatch(G.listHtml(bad, { q: '<b>' }), /<b>/)
})

test('more than 500 words: the first 500 and a note saying so', () => {
  const { G } = load()
  const many = Array.from({ length: 520 }, (_, i) => ({ key: `w${String(i).padStart(3, '0')}`, term: `w${i}`, short: 's', source: 'learned', at: null, seenIn: [] }))
  const h = G.listHtml(many, {})
  assert.equal(rowsOf(h).length, 500)
  assert.match(h, /showing 500 of 520/)
})

test('opening the page writes the head Glossary · N', () => {
  const { G, titles } = load()
  G.open()
  assert.deepEqual(JSON.parse(JSON.stringify(titles.at(-1))), ['Glossary', 'glossary', 4])
})
