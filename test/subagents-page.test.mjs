// Tests for public/subagents-page.js, the Subagents page: the Builders and Lookups
// filter, the window, a card per subagent (state, worktree, branch, tickets, pull
// requests, the final report), and its place in the shell (route, rail,
// palette, index.html, the check list). Browser scripts in a vm with a bare window.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const PUBLIC = path.join(ROOT, 'public')
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8')

/** The page's pure functions, in a window with the shell's time subagent and (when `md`) the chat's Markdown renderer. */
function page({ md = false } = {}) {
  const window = { Shell: { ago: () => '3m' } }
  if (md) window.FactoryChat = { md: text => `<p class="from-md">${text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</p>` }
  vm.runInNewContext(read('subagents-page.js'), { window })
  return window.SubagentsPage
}
const P = page()
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

const subagent = (over = {}) => ({
  id: 'b1', sessionId: 'sess-live', parent: { label: 'Coordinator', live: true }, description: 'Build ABC-101 dark mode toggle', agentType: 'general-purpose',
  model: 'fable', finished: true, state: 'done', builder: true, startedAt: '2026-11-12T09:00:00.000Z', updatedAt: '2026-11-12T11:00:00.000Z',
  worktree: 'dark-mode', branch: 'fix/abc-101-dark-mode', tickets: ['ABC-101'], built: ['ABC-101'],
  prs: [{ repo: 'acme/your-repo', number: 12, url: 'https://github.com/acme/your-repo/pull/12', state: 'merged', checks: 'passing', draft: false }],
  hasReport: true, reportLine: 'ABC-101 is ready for review.', lastText: '', ...over,
})
const LOOKUP = subagent({ id: 'l1', description: 'Sweep tickets for open QA items', model: 'haiku', builder: false, worktree: '', branch: '', tickets: ['ABC-7'], built: [], prs: [], reportLine: 'Two tickets are open.' })
const data = (subagents = [subagent(), LOOKUP]) => ({
  at: '2026-11-12T12:00:00.000Z', days: 1, subagents,
  counts: { working: 0, stuck: 0, done: subagents.length, stopped: 0, failed: 0, builders: subagents.filter(h => h.builder).length, lookups: subagents.filter(h => !h.builder).length },
})
const view = (over = {}) => ({ data: data(), kind: 'builders', days: 1, open: new Map(), error: '', ...over })

// ═══ the filter and the window ═══

test('Builders is the default and shows only subagents that built; Lookups shows the rest', () => {
  assert.deepEqual(P.shown(data().subagents, 'builders').map(h => h.id), ['b1'])
  assert.deepEqual(P.shown(data().subagents, 'lookups').map(h => h.id), ['l1'])
  assert.deepEqual(P.shown(data().subagents).map(h => h.id), ['b1'], 'no kind given is Builders')
  assert.equal(P.shown(null, 'builders').length, 0)
  const h = P.html(view())
  assert.match(h, /Build ABC-101 dark mode toggle/)
  assert.doesNotMatch(h, /Sweep tickets/)
  assert.match(P.html(view({ kind: 'lookups' })), /Sweep tickets for open QA items/)
})

test('the bar: Builders · N and Lookups · N as pressed buttons, and the window with Today chosen', () => {
  const h = P.html(view())
  assert.match(h, /<button type="button" data-hp-kind="builders" aria-pressed="true">Builders · 1<\/button>/)
  assert.match(h, /<button type="button" data-hp-kind="lookups" aria-pressed="false">Lookups · 1<\/button>/)
  assert.deepEqual([...h.matchAll(/<option value="(\d)"( selected)?>([^<]+)<\/option>/g)].map(m => [m[1], Boolean(m[2]), m[3]]), [['1', true, 'Today'], ['2', false, '2 days'], ['3', false, '3 days'], ['7', false, '7 days']])
  assert.match(P.html(view({ days: 7 })), /<option value="7" selected>7 days<\/option>/)
})

test('the filter is remembered in this browser, and a closed storage never breaks the page', () => {
  const kept = {}
  const storage = { getItem: k => kept[k] ?? null, setItem: (k, v) => { kept[k] = v } }
  assert.equal(P.storedKind(storage), 'builders', 'nothing stored yet')
  P.storeKind(storage, 'lookups')
  assert.equal(kept['subagents.kind'], 'lookups')
  assert.equal(P.storedKind(storage), 'lookups')
  kept['subagents.kind'] = 'something else'
  assert.equal(P.storedKind(storage), 'builders')
  const closed = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
  assert.equal(P.storedKind(closed), 'builders')
  assert.doesNotThrow(() => P.storeKind(closed, 'lookups'))
  assert.equal(P.storedKind(undefined), 'builders')
  assert.match(read('subagents-page.js'), /try \{\s*return storage\?\.getItem\(KIND_KEY\)/, 'the read is inside try')
})

// ═══ a card ═══

test('a card shows the task name, the model, the session and when it last wrote', () => {
  const h = P.cardHtml(subagent())
  assert.match(h, /<h3 class="hp-name"[^>]*>Build ABC-101 dark mode toggle<\/h3>/)
  assert.equal(text(h.match(/<p class="hp-meta">.*?<\/p>/s)[0]), 'fable · Coordinator · 3m')
})

test('a subagent of a session that has ended says so', () => {
  const h = P.cardHtml(subagent({ parent: { label: '', live: false } }))
  assert.equal(text(h.match(/<p class="hp-meta">.*?<\/p>/s)[0]), 'fable · ended session · 3m')
})

test('the state is a dot and one word: Working, Stuck, Done, Stopped, Failed, each with what it means on hover', () => {
  const chip = state => P.cardHtml(subagent({ state })).match(/<span class="dot [^>]*>[^<]*<\/span>/)[0]
  assert.match(chip('working'), /class="dot active" title="[^"]*last 15 minutes">Working</)
  assert.match(chip('stuck'), /class="dot waiting" title="[^"]*15 minutes or more">Stuck</)
  assert.match(chip('done'), /class="dot done" title="Handed back its final report">Done</)
  assert.match(chip('stopped'), /class="dot waiting" title="Ended without a final report; it may need resuming">Stopped</, 'amber, not red: nothing went wrong')
  assert.match(chip('failed'), /class="dot blocked" title="Its last reply was an error">Failed</)
})

test('a card shows the worktree, the branch and the tickets, and leaves out the lines it has nothing for', () => {
  const h = P.cardHtml(subagent())
  assert.match(h, /<span class="hp-tree" title="Worktree">dark-mode<\/span>/)
  assert.match(h, /<span class="branch" title="Branch">fix\/abc-101-dark-mode<\/span>/)
  assert.match(h, /<p class="hp-ids ids"><span class="id">ABC-101<\/span><\/p>/)
  const bare = P.cardHtml(subagent({ worktree: '', branch: '', tickets: [], prs: [] }))
  for (const cls of ['hp-where', 'hp-ids', 'hp-prs']) assert.doesNotMatch(bare, new RegExp(`class="${cls}`), cls)
})

test('a pull request is a link in a new tab with its number, then its state and checks', () => {
  assert.match(P.prHtml({ number: 12, url: 'https://github.com/acme/your-repo/pull/12', state: 'merged', checks: 'passing' }),
    /<a class="link" href="https:\/\/github\.com\/acme\/your-repo\/pull\/12" target="_blank" rel="noopener">PR #12<\/a> <span class="hp-pr-state">merged<\/span>/)
  assert.equal(text(P.prHtml({ number: 12, url: 'https://x/pull/12', state: 'open', checks: 'passing' })), 'PR #12 open · checks passing')
  assert.equal(text(P.prHtml({ number: 12, url: 'https://x/pull/12', state: 'open', checks: 'pending', draft: true })), 'PR #12 open · draft · checks running')
  assert.equal(text(P.prHtml({ number: 12, url: 'https://x/pull/12', state: 'closed', checks: 'failing' })), 'PR #12 closed')
  assert.equal(text(P.prHtml({ number: 12, url: 'https://x/pull/12', state: 'open', checks: 'none' })), 'PR #12 open')
})

test('failing checks on an open pull request are marked; a state gh could not give is just the link', () => {
  assert.match(P.prHtml({ number: 12, url: 'https://x/pull/12', state: 'open', checks: 'failing' }), /class="hp-pr is-failing"/)
  assert.doesNotMatch(P.prHtml({ number: 12, url: 'https://x/pull/12', state: 'merged', checks: 'failing' }), /is-failing/)
  const plain = P.prHtml({ number: 12, url: 'https://x/pull/12' })
  assert.equal(text(plain), 'PR #12')
  assert.doesNotMatch(plain, /hp-pr-state/)
})

test('a pull request address that is not https is shown as text, never as a link', () => {
  const h = P.prHtml({ number: 12, url: 'javascript:alert(1)', state: 'open' })
  assert.doesNotMatch(h, /<a /)
  assert.doesNotMatch(h, /javascript:/)
})

test('a card opens that subagent live: its session and its own id in the link, encoded', () => {
  assert.match(P.cardHtml(subagent()), /data-hp-open="#\/agent\/sess-live\/b1"/)
  assert.match(P.cardHtml(subagent({ sessionId: 'a b', id: 'c/d' })), /data-hp-open="#\/agent\/a%20b\/c%2Fd"/)
  assert.match(P.cardHtml(subagent()), /<article class="card hp-card" tabindex="0" role="link"/, 'reachable with the keyboard')
})

// ═══ the final report ═══

test('a finished subagent shows the first line of its report and a Report button, folded', () => {
  const h = P.cardHtml(subagent())
  assert.match(h, /<p class="hp-line">ABC-101 is ready for review\.<\/p>/)
  assert.match(h, /<button type="button" class="link" data-hp-report="sess-live\/b1" aria-expanded="false">Report<\/button>/)
  assert.doesNotMatch(h, /hp-report"/)
})

test('unfolded, the report is drawn in full through the Markdown renderer, with a Copy button', () => {
  const M = page({ md: true })
  const h = M.cardHtml(subagent(), { text: '## What changed\n- The **switch** remembers.' })
  assert.match(h, /aria-expanded="true">Hide report<\/button>/)
  assert.match(h, /<button type="button" class="link" data-hp-copy>Copy<\/button>/)
  assert.match(h, /<div class="fc-msg ai hp-md"><p class="from-md">## What changed\n- The \*\*switch\*\* remembers\.<\/p><\/div>/)
})

test('a report is never drawn as HTML: with the renderer or without it, markup in it is escaped', () => {
  const evil = 'Done <img src=x onerror=alert(1)> <script>alert(2)</script>'
  for (const p of [page({ md: true }), page()]) {
    const h = p.cardHtml(subagent(), { text: evil })
    assert.doesNotMatch(h, /<img|<script/)
    assert.match(h, /&lt;img src=x onerror=alert\(1\)&gt;/)
  }
  assert.match(page().cardHtml(subagent(), { text: 'plain' }), /<pre>plain<\/pre>/, 'without the renderer it is plain text')
})

test('while the report loads the card says so, and a report that cannot be read is one line', () => {
  assert.match(P.cardHtml(subagent(), { loading: true }), /Reading the report…/)
  const h = P.cardHtml(subagent(), { error: 'Could not read that report. Try again.' })
  assert.match(h, /<p class="small warn">Could not read that report\. Try again\.<\/p>/)
  assert.doesNotMatch(h, /data-hp-copy/)
})

test('a failed subagent has no Report button and shows its last words; a working one shows neither', () => {
  const failed = P.cardHtml(subagent({ state: 'failed', hasReport: false, reportLine: '', lastText: 'API Error: 529 overloaded' }))
  assert.doesNotMatch(failed, /data-hp-report/)
  assert.match(failed, /<p class="hp-line is-last">API Error: 529 overloaded<\/p>/)
  const working = P.cardHtml(subagent({ state: 'working', finished: false, hasReport: false, reportLine: '' }))
  assert.doesNotMatch(working, /data-hp-report|hp-line/)
})

test('a stopped subagent shows its last words, has no Report button, and counts as finished in the strip', () => {
  const stopped = subagent({ id: 'x1', state: 'stopped', hasReport: false, reportLine: '', lastText: 'I will run the checks next.' })
  const h = P.cardHtml(stopped)
  assert.doesNotMatch(h, /data-hp-report/)
  assert.match(h, /<p class="hp-line is-last">I will run the checks next\.<\/p>/)
  assert.equal(P.running([stopped]), 0)
  assert.match(P.stripHtml({ subagents: [stopped] }), /class="dot waiting"[^>]*>Stopped</)
})

test('everything a subagent wrote is escaped: its name, branch, tickets and report line', () => {
  const h = P.cardHtml(subagent({ description: '<b>x</b>"', branch: '<i>', worktree: '<u>', tickets: ['<s>'], reportLine: '<em>hi</em>', parent: { label: '<p>', live: true }, model: '<m>' }))
  for (const tag of ['<b>', '<i>', '<u>', '<s>', '<em>', '<p>', '<m>']) assert.ok(!h.includes(tag), tag)
  assert.match(h, /&lt;b&gt;x&lt;\/b&gt;&quot;/)
})

// ═══ the page around the cards ═══

test('before the first answer the page says Loading; a failure is one banner line', () => {
  assert.equal(text(P.html({ data: null })), 'Loading…')
  assert.equal(text(P.html({ data: null, error: 'Could not read the subagents. Try again.' })), 'Could not read the subagents. Try again.')
  const h = P.html(view({ error: 'Could not read the subagents. Try again.' }))
  assert.match(h, /<div class="banner">Could not read the subagents\. Try again\.<\/div>/)
  assert.match(h, /Build ABC-101/, 'the last good list stays')
})

test('an empty list is one line that says which list and which window', () => {
  assert.match(P.html(view({ data: data([LOOKUP]) })), /<p class="empty">No builders today\.<\/p>/)
  assert.match(P.html(view({ data: data([subagent()]), kind: 'lookups', days: 3 })), /<p class="empty">No lookups in the last 3 days\.<\/p>/)
  assert.match(P.html(view({ data: data([]) })), /<p class="empty">No subagents today\. They show here when a session starts a subagent\.<\/p>/)
})

test('an open report stays open on the next draw: the view carries it by session and subagent id', () => {
  const open = new Map([['sess-live/b1', { text: 'The whole report.' }]])
  assert.match(P.html(view({ open })), /The whole report\./)
  assert.doesNotMatch(P.html(view()), /The whole report\./)
})

// ═══ its place in the shell ═══

test('#/subagents is a route with its own section, and the rail links to it after Agents', () => {
  const window = {}
  vm.runInNewContext(read('shell.js'), { window })
  assert.deepEqual(JSON.parse(JSON.stringify(window.Shell.resolve('#/subagents'))), { view: 'subagents', params: {}, redirect: null })
  const shell = read('shell.js')
  assert.match(shell, /link\('agents', '#\/agents', 'Agents'\)\}\$\{link\('subagents', '#\/subagents', 'Subagents'\)\}/)
  assert.match(shell, /subagents: 'subagentsView'/)
  assert.match(shell, /subagents: 'SubagentsPage'/)
  assert.match(shell, /^\s+subagents: svg\(/m, 'the rail icon')
})

test('index.html holds the section, the script after the shell and the stylesheet', () => {
  const index = read('index.html')
  assert.match(index, /<section id="subagentsView" aria-label="Subagents" hidden><\/section>/)
  assert.match(index, /<link rel="stylesheet" href="subagents\.css">/)
  assert.ok(index.indexOf('src="subagents-page.js"') > index.indexOf('src="shell.js"'))
})

test('the command palette lists Subagents with the pages', () => {
  const window = {}
  vm.runInNewContext(read('palette.js'), { window })
  let went = null
  const items = window.Palette.gather({ Shell: { go: h => { went = h } } })
  const item = items.find(i => i.kind === 'page' && i.label === 'Subagents')
  assert.ok(item)
  item.run()
  assert.equal(went, '#/subagents')
})

test('the page title explains itself: the glossary has the word', () => {
  const glossary = JSON.parse(read('glossary.json'))
  assert.ok(glossary.subagents?.short?.length > 20)
})

test('npm run check covers the new files', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  for (const f of ['subagents.mjs', 'subagent-prs.mjs', 'subagent-routes.mjs', 'public/subagents-page.js']) assert.ok(pkg.scripts.check.includes(`node --check ${f}`), f)
})

test('the copy rules hold: no em dash in the page, its styles or the server files behind it', () => {
  const files = ['public/subagents-page.js', 'public/subagents.css', 'subagents.mjs', 'subagent-prs.mjs', 'subagent-routes.mjs']
  for (const f of files) assert.ok(!fs.readFileSync(path.join(ROOT, f), 'utf8').includes('—'), f)
})

test('the styles keep the look: tokens for colour, the one radius, no shadow', () => {
  const css = read('subagents.css')
  assert.doesNotMatch(css, /box-shadow/)
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'no raw colours')
  for (const r of css.matchAll(/border-radius:\s*([^;]+);/g)) assert.equal(r[1].trim(), 'var(--radius)')
})

// ═══ Home's Subagents strip ═══

const mixed = () => [
  subagent({ id: 'w1', state: 'working', finished: false, hasReport: false, description: 'Fix XYZ-5 label print', updatedAt: '2026-11-12T11:58:00.000Z', prs: [] }),
  subagent({ id: 's1', state: 'stuck', finished: false, hasReport: false, builder: false, description: 'Seed a test order', prs: [] }),
  subagent({ id: 'd1', description: 'Done one' }), subagent({ id: 'd2', description: 'Done two', builder: false, prs: [] }),
  subagent({ id: 'f1', state: 'failed', hasReport: false, description: 'Failed three', prs: [] }),
  subagent({ id: 'd4', description: 'Done four' }), subagent({ id: 'd5', description: 'Done five' }),
]

test('the strip lists the subagents still running first, then the latest four finished, builders and lookups alike', () => {
  const rows = P.stripRows(mixed())
  assert.deepEqual(Array.from(rows, h => h.id), ['w1', 's1', 'd1', 'd2', 'f1', 'd4'])
  assert.equal(P.running(mixed()), 2)
  assert.equal(P.stripRows([]).length, 0)
  assert.equal(P.stripRows(null).length, 0)
})

test('many running subagents do not push the page down: six rows at most, and the rest is a count', () => {
  const many = Array.from({ length: 9 }, (_, i) => subagent({ id: `w${i}`, state: 'working', finished: false, hasReport: false }))
  assert.equal(P.stripRows(many).length, 6)
  assert.match(P.stripHtml(data(many)), /and 3 more/)
  assert.doesNotMatch(P.stripHtml(data(mixed())), /more</)
})

test('a strip row is one link to that subagent live: its state, its name, its model and when, and its pull request', () => {
  const h = P.stripHtml(data([subagent()]))
  assert.match(h, /<a class="hp-row" href="#\/agent\/sess-live\/b1">/)
  const row = text(h.match(/<a class="hp-row".*?<\/a>/s)[0])
  assert.equal(row, 'Done Build ABC-101 dark mode toggle PR #12 merged fable · 3m')
  assert.doesNotMatch(h.match(/<a class="hp-row".*?<\/a>/s)[0], /<a [^>]*href="https/, 'no link inside the link')
})

test('the strip escapes what a subagent wrote', () => {
  const h = P.stripHtml(data([subagent({ description: '<b>x</b>', model: '<m>' })]))
  assert.ok(!h.includes('<b>') && !h.includes('<m>'))
})

test('with no subagent today the strip is empty, so Home hides the zone', () => {
  assert.equal(P.stripHtml(data([])), '')
  assert.equal(P.stripHtml(null), '')
})

test('Home has the Subagents zone between Agents and Messages: a name, a number and a link to the page', () => {
  const index = read('index.html')
  const zone = index.match(/<div class="home-zone" id="homeSubagentsZone" hidden>.*?<\/div>\s*<\/div>/s)?.[0]
  assert.ok(zone, 'the zone, hidden until there is something to show')
  assert.match(zone, /<h2>Subagents <span class="faint">· <span class="num" id="subagentsCount">0<\/span> running<\/span><\/h2>/, 'the number is how many still run, and the head says so')
  assert.match(zone, /<a class="link" href="#\/subagents">All subagents<\/a>/)
  assert.ok(index.indexOf('id="agentCards"') < index.indexOf('id="homeSubagentsZone"') && index.indexOf('id="homeSubagentsZone"') < index.indexOf('id="talk"'))
})

test('the strip polls only while Home shows', () => {
  const src = read('subagents-page.js')
  assert.match(src, /onRoute\(r => \(r\.view === 'home' \? mountStrip\(\) : unmountStrip\(\)\)\)/)
})

// ═══ the flow link and the "no story" badge ═══

test('a subagent with a flow links to it by its id, with the flow title in the hover', () => {
  const h = P.cardHtml(subagent({ flow: { id: 'dark-mode', title: 'Add a dark mode toggle', story: true, visual: true }, noStory: '' }))
  assert.match(h, /<button type="button" class="link" data-hp-flow="dark-mode" title="Add a dark mode toggle">Flow<\/button>/)
  assert.doesNotMatch(h, /hp-nostory/)
})

test('a builder that owes a story shows a quiet "no story" with the reason in the hover, next to its flow when it has one', () => {
  const none = P.cardHtml(subagent({ flow: null, noStory: 'No flow recorded' }))
  assert.match(none, /<span class="hp-nostory" title="No flow recorded">no story<\/span>/)
  assert.doesNotMatch(none, /data-hp-flow/)
  const partial = P.cardHtml(subagent({ flow: { id: 'dark-mode', title: 'Dark', story: false, visual: true }, noStory: 'Its flow has no story' }))
  assert.match(partial, /data-hp-flow="dark-mode"/)
  assert.match(partial, /title="Its flow has no story">no story</)
})

test('a lookup, a builder whose flow is complete, and a builder still working show no badge', () => {
  assert.doesNotMatch(P.cardHtml(subagent({ builder: false, flow: null, noStory: '' })), /hp-nostory|data-hp-flow/)
  // the server sends no reason for a working builder; the page holds the line even if one arrives
  for (const noStory of ['', 'No flow recorded']) {
    const working = P.cardHtml(subagent({ state: 'working', finished: false, hasReport: false, reportLine: '', flow: null, noStory }))
    assert.doesNotMatch(working, /hp-nostory/)
  }
})

test('a builder that is done, failed, stopped or stuck with nothing told shows the badge, also with no report to unfold', () => {
  for (const state of ['done', 'failed', 'stopped', 'stuck']) {
    const h = P.cardHtml(subagent({ state, hasReport: false, reportLine: '', flow: null, noStory: 'No flow recorded' }))
    assert.match(h, /<div class="hp-acts"><span class="hp-nostory"/, state)
  }
})

test('the flow id and title are escaped', () => {
  const h = P.cardHtml(subagent({ flow: { id: '"><b>', title: '<i>t</i>' }, noStory: '<u>' }))
  assert.ok(!h.includes('<b>') && !h.includes('<i>') && !h.includes('<u>'))
})

test('a click on Flow opens that flow on the Flows page, not the live view', () => {
  const src = read('subagents-page.js')
  const click = src.slice(src.indexOf("box.addEventListener('click'"), src.indexOf("box.addEventListener('change'"))
  assert.ok(click.indexOf('[data-hp-flow]') < click.indexOf('[data-hp-open]'), 'the flow link is handled before the card')
  assert.match(click, /FlowsView\.gotoFlow\(flow\.dataset\.hpFlow\)/)
})
