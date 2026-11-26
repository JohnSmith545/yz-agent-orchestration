// Tests for public/prlist-view.js, the pure half of the Pull requests list on the page (the fog), run in a vm with
// a bare window: the fog steps per position (each item a little smaller, shorter and fainter, the CSS in lockstep),
// the cap of 5 and the `and N more` line, the order, every item a real link with an accessible name (no numbers,
// no aria-hidden), the words of the small line under the first item, the move-up when the first leaves, and the
// reduced-motion path. Everything GitHub or an agent wrote is escaped. And greps that wire it in.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8')
// Shell.ago, the one relative-time helper (shell.js), as the page has it
const ago = (iso, now = Date.now()) => {
  const t = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(t)) return ''
  const s = Math.floor((now - t) / 1000)
  return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`
}
const ctx = vm.createContext({ window: { Shell: { ago } } })
vm.runInContext(read('public/prlist-view.js'), ctx)
const V = ctx.window.PrListView

const NOW = Date.parse('2026-11-26T12:00:00Z')
const item = (n, more = {}) => ({
  key: `https://github.com/acme/shop/pull/${n}`, url: `https://github.com/acme/shop/pull/${n}`, repo: 'acme/shop', number: n, label: `acme/shop #${n}`,
  title: `Pull request number ${n} with a long enough title to be cut short`, flow: { id: `flow-${n}`, title: `Flow ${n}` }, agent: 'Agent 1',
  openedAt: new Date(NOW - n * 3_600_000).toISOString(), draft: false, checks: 'passing', needs: null, stale: false, ...more,
})
const data = n => ({ items: Array.from({ length: n }, (_, i) => item(i + 1)), checkedAt: new Date(NOW).toISOString(), problem: null })
const plain = x => JSON.parse(JSON.stringify(x))

test('the fog steps: full and clear first, then each a little smaller, shorter and fainter: 1, 0.62, 0.38, 0.22, 0.12', () => {
  assert.deepEqual(plain(V.FOG.map(s => s.opacity)), [1, 0.62, 0.38, 0.22, 0.12])
  for (let i = 1; i < V.FOG.length; i++) {
    assert.ok(V.FOG[i].size < V.FOG[i - 1].size, `step ${i} is smaller`)
    if (i > 1) assert.ok(V.FOG[i].ch < V.FOG[i - 1].ch, `step ${i} shows less of its title`)
  }
  assert.equal(V.FOG[0].ch, 0, 'the first shows its whole title')
  assert.deepEqual(plain(V.fogStep(0)), plain(V.FOG[0]))
  assert.deepEqual(plain(V.fogStep(3)), plain(V.FOG[3]))
  assert.deepEqual(plain(V.fogStep(9)), plain(V.FOG[4]), 'past the last step it stays at the last')
})

test('the CSS draws the same steps (MUST CHANGE IN LOCKSTEP): opacity, size and how much of the title per position', () => {
  const css = read('public/prlist.css')
  V.FOG.forEach((s, i) => {
    const rule = new RegExp(`\\[data-fog="${i}"\\]\\s*\\{[^}]*--fog-o:\\s*${s.opacity}[;\\s][^}]*--fog-fs:\\s*${s.size}px[^}]*--fog-ch:\\s*${s.ch ? `${s.ch}ch` : 'none'}`)
    assert.match(css, rule, `step ${i}`)
  })
})

test('plan: at most 5 shown, the rest counted as more; all of them once the more line is opened', () => {
  const items = data(8).items
  const p = V.plan(items)
  assert.equal(p.shown.length, 5)
  assert.equal(p.more, 3)
  assert.deepEqual(plain(p.shown.map(i => i.number)), [1, 2, 3, 4, 5], 'the order the server gave: newest first')
  const open = V.plan(items, { open: true })
  assert.equal(open.shown.length, 8)
  assert.equal(open.more, 0)
  assert.equal(V.plan(data(3).items).more, 0)
  assert.equal(V.plan(null).shown.length, 0)
})

test('the block: nothing at all when the list is empty or not loaded', () => {
  assert.equal(V.blockHtml({ items: [] }, { now: NOW }), '')
  assert.equal(V.blockHtml(null, { now: NOW }), '')
  assert.equal(V.blockHtml({ error: 'x' }, { now: NOW }), '')
})

test('the block: titled Pull requests with one ?, a plain list with no numbers, each item on its own fog step', () => {
  const html = V.blockHtml(data(7), { now: NOW, where: 'agents' })
  assert.match(html, />Pull requests</)
  assert.equal((html.match(/class="help"/g) || []).length, 1)
  assert.match(html, /<ul class="prl-list"/)
  assert.doesNotMatch(html, /<ol/)
  assert.doesNotMatch(html, /aria-hidden/)
  const fogs = [...html.matchAll(/data-fog="(\d)"/g)].map(m => Number(m[1]))
  assert.deepEqual(fogs, [0, 1, 2, 3, 4])
  assert.match(html, /and 2 more/)
  assert.match(html, /data-prl-more[^>]*aria-expanded="false"/)
  // labels, not list numbers: the repo and number are a small tag
  assert.match(html, /class="prl-tag">acme\/shop #1</)
})

test('every item is a real link to its pull request in a new tab, with its full title as its name and in its title', () => {
  const html = V.blockHtml(data(5), { now: NOW })
  const links = [...html.matchAll(/<a class="prl-title"([^>]*)>([^<]*)/g)]
  assert.equal(links.length, 5)
  for (const [, attrs, text] of links) {
    assert.match(attrs, /href="https:\/\/github\.com\/acme\/shop\/pull\/\d+"/)
    assert.match(attrs, /target="_blank"/)
    assert.match(attrs, /rel="noopener"/)
    assert.match(attrs, /title="Pull request number \d+ with a long enough title to be cut short"/)
    assert.match(text, /^Pull request number \d+ with a long enough title to be cut short$/, 'the whole title is in the link: the CSS cuts it, a screen reader reads it all')
  }
  assert.equal((html.match(/href="#\/flows\?flow=flow-\d"/g) || []).length, 5, 'and an Open the flow link on each')
  assert.match(html, />Open the flow</)
  assert.match(html, /aria-label="Open the flow: Flow 1"/, 'each Open the flow names its flow for a screen reader')
})

test('a link that is not https is drawn as text, never as a link', () => {
  const html = V.blockHtml({ items: [item(1, { url: 'javascript:alert(1)' })] }, { now: NOW })
  assert.doesNotMatch(html, /javascript:/)
  assert.doesNotMatch(html, /<a class="prl-title"/)
  assert.match(html, /class="prl-title"/)
})

test('everything GitHub or an agent wrote is escaped', () => {
  const html = V.blockHtml({ items: [item(1, { title: '<img src=x onerror=alert(1)>', agent: 'A<b>', label: '<x>', flow: { id: 'a"b', title: 't' } })] }, { now: NOW })
  assert.doesNotMatch(html, /<img/)
  assert.doesNotMatch(html, /A<b>/)
  assert.match(html, /&lt;img/)
  assert.match(html, /flow=a%22b/)
})

test('the small line under the first item: the agent, how long ago it opened, its checks, and whether it needs you', () => {
  assert.deepEqual(plain(V.metaWords(item(2), NOW)), ['Agent 1', 'opened 2h', 'checks passing'])
  assert.deepEqual(plain(V.metaWords(item(0, { openedAt: new Date(NOW - 10_000).toISOString() }), NOW)), ['Agent 1', 'opened now', 'checks passing'])
  assert.deepEqual(plain(V.metaWords(item(1, { checks: 'failing', needs: null }), NOW)).slice(2), ['checks failing'])
  assert.deepEqual(plain(V.metaWords(item(1, { checks: 'running' }), NOW)).slice(2), ['checks running'])
  assert.deepEqual(plain(V.metaWords(item(1, { checks: 'none' }), NOW)).slice(2), ['no checks'])
  assert.deepEqual(plain(V.metaWords(item(1, { checks: null, openedAt: null, agent: '' }), NOW)), [])
  assert.deepEqual(plain(V.metaWords(item(1, { draft: true }), NOW)).slice(2), ['draft', 'checks passing'])
  assert.deepEqual(plain(V.metaWords(item(1, { needs: 'merge' }), NOW)).slice(3), ['ready for you to merge'])
  assert.deepEqual(plain(V.metaWords(item(1, { needs: 'review' }), NOW)).slice(3), ['waiting for your review'])
  assert.deepEqual(plain(V.metaWords(item(1, { stale: true }), NOW)).slice(3), ['last known state'])
})

test('a pull request that needs you carries a mark and says so, wherever it stands in the fog', () => {
  const html = V.blockHtml({ items: [item(1), item(2, { needs: 'review' })] }, { now: NOW })
  assert.match(html, /<li class="prl-item is-needs" data-fog="1"/)
  assert.match(html, /waiting for your review/)
})

test('a read that failed: one quiet line under the list says so, with when GitHub last answered', () => {
  const html = V.blockHtml({ ...data(2), problem: 'Could not read GitHub just now (1 pull request): what shows is what it said before.', checkedAt: new Date(NOW - 4 * 60_000).toISOString() }, { now: NOW })
  assert.match(html, /class="prl-note"[^>]*>Could not read GitHub just now/)
  assert.match(html, /last read 4m</)
})

test('the more line opened: every item, the extra ones on the last step, and Show fewer', () => {
  const html = V.blockHtml(data(7), { now: NOW, open: true })
  const fogs = [...html.matchAll(/data-fog="(\d)"/g)].map(m => Number(m[1]))
  assert.deepEqual(fogs, [0, 1, 2, 3, 4, 4, 4])
  assert.match(html, /Show fewer/)
  assert.match(html, /aria-expanded="true"/)
})

test('change: the first leaves, the rest move up one place each; a new one arrives at the top', () => {
  const c = V.change(['a', 'b', 'c'], ['b', 'c'])
  assert.deepEqual(plain(c.left), ['a'])
  assert.deepEqual(plain(c.entered), [])
  assert.deepEqual(plain(c.kept), [{ key: 'b', from: 1, to: 0 }, { key: 'c', from: 2, to: 1 }])
  const n = V.change(['b', 'c'], ['x', 'b', 'c'])
  assert.deepEqual(plain(n.entered), ['x'])
  assert.deepEqual(plain(n.kept), [{ key: 'b', from: 0, to: 1 }, { key: 'c', from: 1, to: 2 }])
})

test('motionPlan: the move up over about 400 ms; under reduced motion, or on the first draw, the list simply redraws', () => {
  const p = V.motionPlan(['a', 'b', 'c'], ['b', 'c'], { reduced: false })
  assert.equal(p.mode, 'animate')
  assert.ok(p.ms >= 350 && p.ms <= 450, String(p.ms))
  assert.deepEqual(plain(p.left), ['a'])
  assert.equal(V.motionPlan(['a', 'b', 'c'], ['b', 'c'], { reduced: true }).mode, 'redraw')
  assert.equal(V.motionPlan([], ['a'], { reduced: false }).mode, 'redraw', 'the first draw does not animate')
  assert.equal(V.motionPlan(['a', 'b'], ['a', 'b'], { reduced: false }).mode, 'redraw', 'nothing moved: a quiet redraw')
  assert.equal(V.motionPlan(['a'], [], { reduced: false }).mode, 'animate', 'the last one fades out too')
})

test('the scale each kept item grows from: its old size over its new one', () => {
  assert.equal(V.scaleFrom(1, 0), V.FOG[1].size / V.FOG[0].size)
  assert.equal(V.scaleFrom(2, 2), 1)
  assert.equal(V.scaleFrom(7, 4), 1)
})

test('the help says what the list is, why the items fade and what makes one leave', () => {
  assert.match(V.HELP, /pull request/i)
  assert.match(V.HELP, /fade/)
  assert.match(V.HELP, /merged|closed/)
  assert.match(V.HELP, /Completed/)
})

test('wired in: the scripts and the stylesheet on the page, the slots on the Agents page and Home, every file checked', () => {
  const index = read('public/index.html')
  assert.match(index, /<link rel="stylesheet" href="prlist\.css">/)
  assert.match(index, /<script src="prlist-view\.js"><\/script>\s*<script src="prlist\.js"><\/script>/)
  assert.match(index, /<div id="homePrs" data-prl hidden><\/div>/)
  assert.match(read('public/agents-page.js'), /data-prl hidden/)
  const pkg = read('package.json')
  for (const f of ['public/prlist-view.js', 'public/prlist.js']) assert.ok(pkg.includes(`node --check ${f}`), f)
})

// ═══ the DOM half (public/prlist.js) with a bare stand-in for the page: the reduced-motion path ═══

function page({ reduce }) {
  const slot = {
    id: 'plPrs', hidden: true, offsetParent: {}, innerHTML: '', _prlHtml: undefined,
    contains: () => false, matches: () => false,
    querySelector: sel => (sel === '.prl-list' && slot.innerHTML.includes('prl-list') ? {} : null),
    querySelectorAll: sel => (sel.includes('.prl-item') ? [...slot.innerHTML.matchAll(/data-prl-key="([^"]*)"/g)].map(m => ({ getAttribute: () => m[1] })) : []),
  }
  let answer = null
  const doc = { visibilityState: 'visible', activeElement: null, addEventListener() {}, querySelectorAll: sel => (sel === '[data-prl]' ? [slot] : []) }
  const win = { document: doc, matchMedia: () => ({ matches: reduce }), Help: { attach() {} }, Shell: { ago } }
  const c = vm.createContext({ window: win, setInterval: () => 0, setTimeout, CSS: { escape: s => s }, fetch: async () => ({ ok: true, json: async () => answer }) })
  vm.runInContext(read('public/prlist-view.js'), c)
  vm.runInContext(read('public/prlist.js'), c)
  return { slot, PrList: win.PrList, set: d => { answer = d } }
}

test('the list draws into its slot, and the slot hides again when the list is empty', async () => {
  const p = page({ reduce: true })
  p.set(data(3))
  await p.PrList.refresh()
  assert.equal(p.slot.hidden, false)
  assert.equal((p.slot.innerHTML.match(/class="prl-item/g) || []).length, 3)
  p.set({ items: [] })
  await p.PrList.refresh()
  assert.equal(p.slot.hidden, true)
  assert.equal(p.slot.innerHTML, '')
})

test('reduced motion: when the first leaves, the list simply redraws at once, no slide and no fade', async () => {
  const p = page({ reduce: true })
  p.set(data(3))
  await p.PrList.refresh()
  p.set({ ...data(3), items: data(3).items.slice(1) })
  await p.PrList.refresh()
  assert.ok(!p.slot._prlBusy, 'nothing is moving')
  assert.deepEqual([...p.slot.innerHTML.matchAll(/data-fog="(\d)"/g)].map(m => m[1]), ['0', '1'])
  assert.match(p.slot.innerHTML, /data-fog="0" data-prl-key="https:\/\/github\.com\/acme\/shop\/pull\/2"/, 'the second is now the clear first')
  assert.doesNotMatch(p.slot.innerHTML, /prl-ghost|prl-entering/)
})

test('a clean leave: the one that leaves has faded out fully before any item starts to rise into its place', () => {
  const p = V.motionPlan(['a', 'b', 'c'], ['b', 'c'], { reduced: false })
  assert.ok(p.leaveMs > 0 && p.leaveMs <= 160, `the leave is short: ${p.leaveMs}`)
  assert.ok(p.delay >= p.leaveMs, 'the rest wait until it is gone: never text over text')
  assert.ok(p.ms - p.delay >= 240, 'and still rise calmly, not in a jump')
  assert.ok(p.ms >= 350 && p.ms <= 450, `the whole move about 400 ms: ${p.ms}`)
  // nothing left (a new one arrived at the top): nothing to wait for
  const n = V.motionPlan(['b', 'c'], ['x', 'b', 'c'], { reduced: false })
  assert.equal(n.delay, 0)
})

test('the leaving copy only fades and lifts a little: its own transition, no long slide over the next one', () => {
  const css = read('public/prlist.css')
  assert.match(css, /\.prl-ghost\.is-gone\s*\{[^}]*opacity:\s*0[^}]*translateY\(-[1-8]px\)/)
  const js = read('public/prlist.js')
  assert.match(js, /plan\.leaveMs/)
  assert.match(js, /plan\.delay/)
})

test('the new first item shows its small line only in the second half of its rise, so it never lands on the item under it', () => {
  const p = V.motionPlan(['a', 'b', 'c'], ['b', 'c'], { reduced: false })
  assert.ok(p.metaAt >= p.delay + (p.ms - p.delay) / 2, `the small line waits: ${p.metaAt}`)
  assert.ok(p.metaAt + p.metaMs <= p.ms, 'and is in by the end of the move')
  assert.match(read('public/prlist.js'), /plan\.metaAt/)
})
