// Tests for public/flow-send.js, the Send bar at the bottom of a flow's Output:
// one quiet row while the work is not sent (ready, or blocked with each reason),
// the review panel the button opens, and the pull request's state once it is
// sent. Browser scripts, so they run in a vm context with a stub window, a
// recording fetch and a stub root for the click handler. FACTORY_DATA_DIR points
// at a fresh temp folder BEFORE flows.mjs is imported (for derive).

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, '..', 'public')
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-send-test-'))
const { derive, DATA_DIR } = await import('../flows.mjs')
after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }))

const SCRIPTS = ['shell.js', 'terms.js', 'flow-chart.js', 'diagram-fit.js', 'diagram-route.js', 'diagram.js', 'flow-picture.js', 'flow-drawer.js',
  'lightbox.js', 'flow-tabs.js', 'flow-story.js', 'flow-compare.js', 'flow-visual.js', 'flow-steps.js', 'flow-send.js', 'flow-output.js']
const fetched = []
let answer = () => ({ ok: true, status: 200, body: {} })
const fetchStub = async (url, opts = {}) => {
  fetched.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null })
  const a = answer(url, opts)
  return { ok: a.ok, status: a.status, json: async () => a.body }
}
const memory = new Map()
const localStorage = { getItem: k => (memory.has(k) ? memory.get(k) : null), setItem: (k, v) => memory.set(k, String(v)), removeItem: k => memory.delete(k) }
const window = {}
const ctx = { window, localStorage, fetch: fetchStub, URL }
for (const f of SCRIPTS) vm.runInNewContext(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), ctx)
const S = window.FlowSend

const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'no-visual.json'), 'utf8'))
const MERGE = { head: 'feature/dark-mode', base: 'dev', title: 'Add a dark mode to Settings', body: '## What\n\nA moon switch next to Theme.', at: '2026-11-12T10:00:00Z' }
let n = 0
/** A fresh flow (its own id, so the bar's in-memory state starts clean) with `output` changed by `edit`. */
const fx = (edit = () => {}) => {
  const f = structuredClone(FIXTURE)
  f.id = `nv-${++n}`
  f.output = { merge: { ...MERGE } }
  edit(f.output)
  f.derived = derive(f)
  return f
}
const FACTS = {
  head: 'feature/dark-mode', base: 'dev', remote: 'origin', headExists: true, ahead: 8, behind: 0, pushed: false, unpushed: 8, mergesCleanly: true,
  conflicts: [], commits: Array.from({ length: 8 }, (_, i) => ({ sha: `abc12${i}0`, subject: `feat: part ${i + 1}` })), files: 4, attribution: [],
  existingPr: null, ghOk: true, blockers: [], warnings: ['CI has never run on these commits: feature/dark-mode is not on origin yet.'],
  sha: 'f'.repeat(40), repo: 'acme/app',
}
const c = flow => ({ flow, keyed: () => '' })
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').replace(/ ([.,])/g, '$1').trim()

// ═══ the three states ═══

test('nothing recorded and nothing sent: no bar at all', () => {
  assert.equal(S.html(c(fx(o => { delete o.merge }))), '')
})

test('not sent, facts still loading: the branch, the base and checking; the button waits', () => {
  const h = S.html(c(fx()))
  assert.match(text(h), /feature\/dark-mode → dev · checking…/)
  assert.match(h, /<button[^>]*data-send-open[^>]*disabled[^>]*>Send to dev<\/button>/)
})

test('not sent and ready: one row, the commits, the green word and the primary Send to <base>', () => {
  const flow = fx()
  S.state(flow.id).facts = FACTS
  const h = S.html(c(flow))
  assert.equal(text(h.match(/<div class="sd-row">[\s\S]*?<\/div>/)[0]), 'feature/dark-mode → dev · 8 commits · ready Send to dev')
  assert.match(h, /<span class="sd-state ok">ready<\/span>/)
  assert.match(h, /<button type="button" class="primary sd-go" data-send-open>Send to dev<\/button>/)
  assert.doesNotMatch(h, /sd-review/, 'the review opens on the click')
  const main = fx(o => { o.merge.base = 'main' })
  S.state(main.id).facts = { ...FACTS, base: 'main' }
  assert.match(S.html(c(main)), />Send to main<\/button>/, 'the base is in the label')
})

test('blocked: the warn word, each blocker on its own line, and the button disabled', () => {
  const flow = fx()
  S.state(flow.id).facts = { ...FACTS, blockers: ['It does not merge cleanly into dev: theme.css conflict.', 'The GitHub CLI (gh) is missing or not signed in: run gh auth login.'] }
  const h = S.html(c(flow))
  assert.match(h, /<span class="sd-state warn">blocked<\/span>/)
  assert.deepEqual([...h.matchAll(/<li>([^<]*)<\/li>/g)].map(m => m[1]), ['It does not merge cleanly into dev: theme.css conflict.', 'The GitHub CLI (gh) is missing or not signed in: run gh auth login.'])
  assert.match(h, /<button[^>]*data-send-open disabled>Send to dev<\/button>/)
})

test('an open pull request already there: its link instead of the button', () => {
  const flow = fx()
  S.state(flow.id).facts = { ...FACTS, existingPr: { number: 7, url: 'https://example.com/acme/app/pull/7', state: 'open' }, blockers: ['A pull request is already open for feature/dark-mode: #7.'] }
  const h = S.html(c(flow))
  assert.match(h, /<a class="sd-pr" href="https:\/\/example\.com\/acme\/app\/pull\/7" target="_blank" rel="noopener noreferrer">PR #7 is already open<\/a>/)
  assert.doesNotMatch(h, /data-send-open/)
})

test('sent: PR #12 open as a new-tab link, the checks word and updated; merged says Merged into dev', () => {
  const pr = { url: 'https://example.com/acme/app/pull/12', number: 12, state: 'open', openedAt: new Date(Date.now() - 3 * 60_000).toISOString(), checks: 'passing', checkedAt: new Date(Date.now() - 2 * 60_000).toISOString(), error: null }
  const h = S.html(c(fx(o => { o.pr = pr })))
  assert.equal(text(h), 'PR #12 open · checks passing · updated 2m')
  assert.match(h, /<a class="sd-pr" href="https:\/\/example\.com\/acme\/app\/pull\/12" target="_blank" rel="noopener noreferrer">PR #12 open<\/a>/)
  for (const [checks, word] of [['pending', 'checks pending'], ['failing', 'checks failing'], ['none', 'no checks']]) {
    assert.match(text(S.html(c(fx(o => { o.pr = { ...pr, checks } })))), new RegExp(`· ${word} ·`))
  }
  assert.match(text(S.html(c(fx(o => { o.pr = { ...pr, state: 'merged' } })))), /^Merged into dev · updated 2m$/)
  assert.match(text(S.html(c(fx(o => { delete o.merge; o.pr = { ...pr, state: 'closed' } })))), /^PR #12 closed/)
})

test('a link that is not https is shown as text, never as a link', () => {
  const pr = { url: 'https://example.com/acme/app/pull/12', number: 12, state: 'open', openedAt: '2026-11-12T10:00:00Z', checks: 'pending', checkedAt: null, error: null }
  const flow = fx(o => { o.pr = pr })
  flow.output.pr.url = 'javascript:alert(1)'
  const h = S.html(c(flow))
  assert.doesNotMatch(h, /href=/)
  assert.match(text(h), /^PR #12 open/)
  const other = fx()
  S.state(other.id).facts = { ...FACTS, existingPr: { number: 7, url: 'http://example.com/pull/7', state: 'open' }, blockers: ['x'] }
  assert.doesNotMatch(S.html(c(other)), /href=/)
})

test('a failed send: the plain reason and Try again', () => {
  const flow = fx(o => { o.pr = { error: 'The push was refused (it is never forced): ! [rejected] non-fast-forward' } })
  S.state(flow.id).facts = FACTS
  const h = S.html(c(flow))
  assert.match(text(h), /not sent/)
  assert.match(h, /<p class="sd-error">The push was refused \(it is never forced\): ! \[rejected\] non-fast-forward<\/p>/)
  assert.match(h, /<button type="button" class="primary sd-go" data-send-open>Try again<\/button>/)
})

// ═══ the review panel ═══

test('the review panel: title, the body through md in a scroll box, commits collapsed after 5, the warnings, the sentence, the two buttons', () => {
  const flow = fx()
  Object.assign(S.state(flow.id), { facts: FACTS, review: true })
  const h = S.html(c(flow))
  const panel = h.slice(h.indexOf('sd-review'))
  assert.match(panel, /<h4 class="sd-title">Add a dark mode to Settings<\/h4>/)
  assert.match(panel, /<div class="sd-body sb-md">[\s\S]*A moon switch next to Theme\.[\s\S]*<\/div>/)
  assert.equal((panel.match(/<li class="sd-commit">/g) || []).length, 8)
  assert.match(panel, /<details class="sd-more"><summary>3 more commits<\/summary>/)
  assert.match(panel, /<code>abc1200<\/code> feat: part 1/)
  assert.match(panel, /CI has never run on these commits/)
  assert.match(text(panel), /This pushes feature\/dark-mode to origin and opens a pull request into dev\. It does not merge anything\./)
  assert.match(panel, /<input type="password" class="sd-pin" data-send-pin name="pin" autocomplete="new-password" placeholder="Send PIN" aria-label="Send PIN"><button type="button" class="primary" data-send-go>Open pull request<\/button><button type="button" class="link" data-send-cancel>Cancel<\/button>/)
  assert.match(text(panel), /Add a dark mode to Settings · 8 commits · 4 files /, 'the counts beside the title')
  assert.doesNotMatch(h, /data-send-open/, 'the row button gives way to the panel')
})

test('the review panel escapes a script in the title, the body and a commit subject', () => {
  const flow = fx(o => { o.merge.title = 'A <script>alert(1)</script> title'; o.merge.body = '<script>alert(2)</script>' })
  Object.assign(S.state(flow.id), { facts: { ...FACTS, commits: [{ sha: 'abc1234', subject: '<script>alert(3)</script>' }] }, review: true })
  const h = S.html(c(flow))
  assert.doesNotMatch(h, /<script>/)
  assert.match(h, /&lt;script&gt;alert\(1\)/)
  assert.match(h, /&lt;script&gt;alert\(2\)/)
  assert.match(h, /&lt;script&gt;alert\(3\)/)
})

test('sending: the button says Sending… and waits', () => {
  const flow = fx()
  Object.assign(S.state(flow.id), { facts: FACTS, review: true, sending: true })
  assert.match(S.html(c(flow)), /<button type="button" class="primary" data-send-go disabled>Sending…<\/button>/)
})

// ═══ the clicks ═══

/** A stub root: records its listeners; a click is a target whose closest() finds `attr`; its PIN field holds `pin`. */
function stubRoot(pin = '246810') {
  const on = {}
  const field = { value: pin }
  return {
    field,
    addEventListener: (t, fn) => { (on[t] ||= []).push(fn) },
    querySelector: sel => (sel === '[data-send-pin]' ? field : null),
    click: attr => Promise.all((on.click || []).map(fn => fn({ target: { closest: sel => (sel.includes(attr) ? {} : null) } }))),
  }
}
const settle = () => new Promise(r => setTimeout(r, 0))

test('Open pull request POSTs the PIN and what was reviewed (head, sha, digest), then shows the pull request; the PIN field is emptied', async () => {
  const flow = fx()
  Object.assign(S.state(flow.id), { facts: FACTS, digest: 'd'.repeat(64), review: true })
  const root = stubRoot()
  let drawn = 0
  S.bind(root, () => flow, () => { drawn++ })
  const pr = { url: 'https://github.com/acme/app/pull/12', number: 12, state: 'open', openedAt: new Date().toISOString(), checks: 'pending', checkedAt: null, error: null }
  answer = () => ({ ok: true, status: 200, body: { ok: true, pr } })
  fetched.length = 0
  await root.click('data-send-go')
  await settle()
  assert.deepEqual(fetched.map(f => [f.url, f.method, f.body]), [[`/api/flows/${flow.id}/pr`, 'POST', { pin: '246810', confirm: { head: 'feature/dark-mode', sha: 'f'.repeat(40), digest: 'd'.repeat(64) } }]])
  assert.equal(root.field.value, '')
  assert.equal(flow.output.pr.number, 12)
  assert.ok(drawn >= 2, 'drawn while sending and after')
  assert.equal(text(S.html(c(flow))).startsWith('PR #12 open'), true)
})

test('no PIN typed: nothing is sent, the panel asks for it', async () => {
  const flow = fx()
  Object.assign(S.state(flow.id), { facts: FACTS, digest: 'x', review: true })
  const root = stubRoot('')
  S.bind(root, () => flow, () => {})
  fetched.length = 0
  await root.click('data-send-go')
  assert.deepEqual(fetched, [])
  assert.match(S.html(c(flow)), /<p class="sd-error">Type your send PIN\.<\/p>/)
})

test('a wrong PIN stays in the review with the reason; a review gone stale reloads its facts and says to review again', async () => {
  const flow = fx()
  Object.assign(S.state(flow.id), { facts: FACTS, digest: 'x', review: true })
  const root = stubRoot()
  S.bind(root, () => flow, () => {})
  answer = () => ({ ok: false, status: 403, body: { error: 'Wrong PIN.' } })
  await root.click('data-send-go')
  await settle()
  assert.equal(S.state(flow.id).review, true)
  assert.match(S.html(c(flow)), /sd-review[\s\S]*<p class="sd-error">Wrong PIN\.<\/p>/)
  assert.match(S.html(c(flow)), /<span class="sd-state ok">ready<\/span>/, 'nothing was tried: the row still says ready')
  assert.equal(root.field.value, '', 'the PIN is typed again for each try')
  root.field.value = '246810'
  answer = () => ({ ok: false, status: 409, body: { error: 'Changed since you reviewed it. Review again.', changed: true } })
  await root.click('data-send-go')
  await settle()
  assert.equal(S.state(flow.id).facts, null, 'the facts load again')
  assert.match(S.html(c(flow)), /<p class="sd-error">Changed since you reviewed it\. Review again\.<\/p>/)
})

test('a refused push keeps the reason for Try again (which reopens the review); Cancel closes the panel', async () => {
  const flow = fx()
  Object.assign(S.state(flow.id), { facts: FACTS, digest: 'x', review: true })
  const root = stubRoot()
  S.bind(root, () => flow, () => {})
  answer = () => ({ ok: false, status: 502, body: { error: 'The push was refused (it is never forced): rejected' } })
  await root.click('data-send-go')
  await settle()
  const h = S.html(c(flow))
  assert.match(h, /<p class="sd-error">The push was refused \(it is never forced\): rejected<\/p>/)
  assert.match(h, /data-send-open>Try again</)
  S.state(flow.id).review = true
  await root.click('data-send-cancel')
  assert.equal(S.state(flow.id).review, false)
})

test('Send off (turned off, or no PIN): the branch, Sending is off, and a quiet link to Settings, no button', () => {
  const flow = fx()
  S.state(flow.id).facts = { ...FACTS, off: true, blockers: ['Sending is off: set a send PIN in Settings.'] }
  const h = S.html(c(flow))
  assert.equal(text(h), 'feature/dark-mode → dev · Sending is off · Open Settings')
  assert.match(h, /<a class="link" href="#\/settings">Open Settings<\/a>/)
  assert.doesNotMatch(h, /<button|terminal|factory\.mjs/)
})

test('A1: while the review is open no poll reloads the facts, and a reload changes nothing the bar draws, so the typed PIN and the focus stay', () => {
  const flow = fx()
  Object.assign(S.state(flow.id), { facts: FACTS, digest: 'x', merge: { ...MERGE }, review: true, factsAt: 1 })
  fetched.length = 0
  S.update(flow, () => {})
  assert.deepEqual(fetched, [], 'no facts reload while reviewing')
  const before = S.sig(flow.id)
  S.state(flow.id).loading = true
  assert.equal(S.sig(flow.id), before, 'loading is not part of what the bar draws')
  S.state(flow.id).loading = false
  assert.equal(S.state(flow.id).facts.sha, FACTS.sha, 'the reviewed commit stays the one sent')
})

test('A1: the facts are loaded afresh when the review opens', async () => {
  const flow = fx()
  Object.assign(S.state(flow.id), { facts: FACTS, digest: 'old', factsAt: Date.now() })
  const root = stubRoot()
  S.bind(root, () => flow, () => {})
  answer = () => ({ ok: true, status: 200, body: { merge: MERGE, pr: null, ready: true, digest: 'fresh', facts: { ...FACTS, sha: 'e'.repeat(40) } } })
  fetched.length = 0
  await root.click('data-send-open')
  await settle()
  assert.deepEqual(fetched.map(f => [f.url, f.method]), [[`/api/flows/${flow.id}/pr`, 'GET']])
  assert.deepEqual([S.state(flow.id).digest, S.state(flow.id).facts.sha, S.state(flow.id).review], ['fresh', 'e'.repeat(40), true])
})

test('A2: the review shows the title and text the facts GET returned (what the digest covers), not the flow poll', () => {
  const flow = fx(o => { o.merge.title = 'A newer title from the poll' })
  Object.assign(S.state(flow.id), { facts: FACTS, digest: 'x', merge: { ...MERGE, title: 'The title that was reviewed' }, review: true })
  const h = S.html(c(flow))
  assert.match(h, /<h4 class="sd-title">The title that was reviewed<\/h4>/)
  assert.doesNotMatch(h, /A newer title/)
})

test('A10: while reviewing, the commit count shows once, beside the title', () => {
  const flow = fx()
  Object.assign(S.state(flow.id), { facts: FACTS, digest: 'x', merge: { ...MERGE }, review: true })
  const t = text(S.html(c(flow)))
  assert.equal((t.match(/8 commits/g) || []).length, 1, t)
  assert.match(t, /8 commits · 4 files/)
})

test('pushed but no pull request yet: says so, with the reason and Try again', () => {
  const flow = fx(o => { o.pr = { error: 'The branch was pushed, but GitHub did not open the pull request: GraphQL', pushed: true } })
  S.state(flow.id).facts = FACTS
  const h = S.html(c(flow))
  assert.match(text(h), /^feature\/dark-mode → dev · 8 commits · Pushed, no pull request yet Try again/)
  assert.match(h, /<p class="sd-error">The branch was pushed, but GitHub did not open the pull request: GraphQL<\/p>/)
})

test('a disabled Send uses the neutral disabled look, not the accent faded', () => {
  const css = fs.readFileSync(path.join(PUBLIC, 'flow-output.css'), 'utf8')
  assert.match(css, /\.sd-go:disabled \{[^}]*background: var\(--surface-2\)[^}]*color: var\(--faint\)/)
})

test('the bar is the last block of Output, after Details, inside the column (never floating)', () => {
  const flow = fx()
  S.state(flow.id).facts = FACTS
  const h = window.FlowOutput.html(flow)
  assert.ok(h.indexOf('aria-label="Send"') > h.indexOf('aria-label="How to test"'))
  assert.match(h, /<section class="ob ob-send" aria-label="Send"[^>]*>[\s\S]*<\/section><\/div>$/, 'the last child of .ob-col')
  assert.doesNotMatch(window.FlowOutput.html(fx(o => { delete o.merge })), /ob-send/)
})

test('a send that pushed but opened no pull request says Pushed, no pull request yet at once, not only after a reload', async () => {
  const flow = fx()
  Object.assign(S.state(flow.id), { facts: FACTS, digest: 'x', review: true })
  const root = stubRoot()
  S.bind(root, () => flow, () => {})
  answer = () => ({ ok: false, status: 502, body: { error: 'The branch was pushed, but GitHub did not open the pull request: GraphQL', pushed: true } })
  await root.click('data-send-go')
  await settle()
  const h = S.html(c(flow))
  assert.match(text(h), /Pushed, no pull request yet Try again/)
  assert.deepEqual(JSON.parse(JSON.stringify(flow.output.pr)), { error: 'The branch was pushed, but GitHub did not open the pull request: GraphQL', pushed: true })
})
