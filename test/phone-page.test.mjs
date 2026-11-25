// Tests for the phone page (public/phone.html): its pure words (phone-state.js) and markup (phone-view.js), run in a
// vm like the other browser files, plus what the live half (phone-app.js), the stylesheet and the manifest must hold:
// the desktop's colour tokens in light and dark, no stored data, the CSRF header on every write, a 10 s poll.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, '..', 'public')
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8')
const ctx = vm.createContext({ window: {} })
vm.runInContext(read('phone-state.js'), ctx)
vm.runInContext(read('phone-view.js'), ctx)
const S = ctx.window.PhoneState
const V = ctx.window.PhoneView
const plain = v => JSON.parse(JSON.stringify(v))
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

const SUMMARY = {
  builtAt: '2026-11-25T10:42:00.000Z', coordinator: 'Master',
  needs: { total: 4, asks: 2, hands: 1, outputs: 1 },
  agents: [{ label: 'Agent 1', busy: true, flow: 'Login page <beta>' }, { label: 'QA', busy: false, flow: '' }],
  finishedToday: 3,
  asks: [
    { flowId: 'login', nodeId: 'a1', flowTitle: 'Login page', agent: 'Agent 1', question: 'Ship it?', why: 'It passed QA.', kind: 'yesno', yes: 'it goes to dev', no: 'it waits' },
    { flowId: 'login', nodeId: 'a2', flowTitle: 'Login page', agent: 'Agent 1', question: 'Which colour?', why: '', kind: 'text', yes: '', no: '' },
  ],
  hands: [{ flowId: 'ci', title: 'Deploy pipeline', agent: 'Agent 2', reason: '0 of 1 done.', steps: [{ id: 'h1', do: 'Add the secret', where: 'GitHub › Settings', expect: 'It is listed', copy: 'TOKEN', done: false }], progress: { done: 0, total: 1 } }],
  outputs: [{ flowId: 'shipped', title: 'Search box', agent: 'Agent 1', finishedAt: '2026-11-24T10:00:00.000Z', overdue: true, story: [{ who: 'Agent 1', did: 'Built the box.', why: 'You asked.' }] }],
  costNote: 'Your answer reaches the agent through a short paid turn on your PC: a few cents each.',
}

// ═══ the words ═══

test('needsLine and the three counts, singular and plural', () => {
  assert.equal(S.needsLine(0), 'Nothing needs you')
  assert.equal(S.needsLine(1), '1 thing needs you')
  assert.equal(S.needsLine(5), '5 things need you')
  assert.equal(S.needsLine(undefined), 'Nothing needs you')
  assert.deepEqual(plain(S.countParts({ asks: 1, hands: 2, outputs: 0 })).map(p => `${p.n} ${p.label}`), ['1 question', '2 by hand', '0 outputs to sign off'])
  assert.deepEqual(plain(S.countParts(null)).map(p => p.n), [0, 0, 0])
})

test('when: a clock time today, a day and month before today; a bad time is empty', () => {
  const now = new Date(2026, 10, 25, 15, 0).getTime() // local time, as the phone shows it
  assert.equal(S.when(new Date(2026, 10, 25, 9, 5).toISOString(), now), '09:05')
  assert.equal(S.when(new Date(2026, 10, 24, 23, 0).toISOString(), now), '24 Nov')
  assert.equal(S.when('nope', now), '')
})

test('the thread is the user messages and the replies in time order; each message says where it is', () => {
  const items = plain(S.threadItems({
    messages: [{ id: 'm1', at: '2026-11-25T10:00:00Z', text: 'Status?', state: 'sent' }, { id: 'm2', at: '2026-11-25T10:05:00Z', text: 'And now?', state: 'failed', error: 'no session' }],
    replies: [{ at: '2026-11-25T10:01:00Z', text: 'All green.' }],
  }))
  assert.deepEqual(items.map(i => [i.who, i.text]), [['you', 'Status?'], ['them', 'All green.'], ['you', 'And now?']])
  assert.equal(S.messageWord({ state: 'sending' }, 'Master'), 'Sending…')
  assert.equal(S.messageWord({ state: 'sent' }, 'Master'), 'Sent to Master')
  assert.equal(S.messageWord({ state: 'failed', error: 'no session' }, 'Master'), 'Not sent: no session')
  assert.deepEqual(plain(S.threadItems(null)), [])
})

test('a failed message puts its text back in the box, once, and only the one just sent', () => {
  const sending = [{ id: 'm1', text: 'hi', state: 'sending' }]
  assert.equal(S.draftBack(sending, [{ id: 'm1', text: 'hi', state: 'failed' }], 'm1'), 'hi')
  assert.equal(S.draftBack(sending, [{ id: 'm1', text: 'hi', state: 'sent' }], 'm1'), null)
  assert.equal(S.draftBack([{ id: 'm1', text: 'hi', state: 'failed' }], [{ id: 'm1', text: 'hi', state: 'failed' }], 'm1'), null, 'already put back')
  assert.equal(S.draftBack(sending, [{ id: 'm1', text: 'hi', state: 'failed' }], null), null)
  assert.equal(S.draftBack([], [{ id: 'm1', text: 'hi', state: 'failed' }], 'm1'), 'hi', 'failed before the first poll saw it sending')
})

test('the PIN must be 6 to 12 digits before it is sent', () => {
  assert.equal(S.pinProblem('123456'), null)
  assert.equal(S.pinProblem('12345'), 'At least 6 digits.')
  assert.equal(S.pinProblem('12a456'), 'Only digits.')
  assert.equal(S.pinProblem('1'.repeat(13)), 'At most 12 digits.')
  assert.equal(S.failureOf(401), 'signedOut')
  assert.equal(S.failureOf(0), 'offline')
  assert.equal(S.failureOf(500), 'error')
})

// ═══ the markup ═══

const ALL = () => [V.signIn({ status: 'Wrong PIN. 4 tries left before a 15 minute lock.' }), V.nav('now', SUMMARY, 'Master'), V.now(SUMMARY, Date.parse('2026-11-25T12:00:00Z')),
  V.needs(SUMMARY, {}), V.outputs(SUMMARY, { confirm: 'shipped' }), V.outputs(SUMMARY, {}),
  V.talk({ label: 'Master', running: false, busy: false, messages: [{ id: 'm1', at: '2026-11-25T10:00:00Z', text: '<b>hi</b>', state: 'failed', error: 'x' }], replies: [{ at: '2026-11-25T10:01:00Z', text: 'ok "fine"' }] }, {})]

test('no markup holds an inline style or an inline handler (the CSP allows neither)', () => {
  for (const h of ALL()) {
    assert.doesNotMatch(h, /\sstyle=/i)
    assert.doesNotMatch(h, /\son[a-z]+=/i)
    assert.doesNotMatch(h, /<script/i)
  }
})

test('everything from the server is escaped', () => {
  assert.match(V.now(SUMMARY), /Login page &lt;beta&gt;/)
  const t = V.talk({ label: 'Master', messages: [{ id: 'm1', at: '2026-11-25T10:00:00Z', text: '<img src=x onerror=alert(1)>', state: 'sent' }], replies: [] }, {})
  assert.doesNotMatch(t, /<img/)
  assert.match(t, /&lt;img src=x onerror=alert\(1\)&gt;/)
})

test('sign in: a PIN field for digits that is never shown, the number pad, and the status line', () => {
  const h = V.signIn({ status: 'Wrong PIN.' })
  assert.match(h, /<input id="phPin" class="ph-pin" type="password" inputmode="numeric" autocomplete="current-password" maxlength="12" data-ph-pin>/)
  assert.deepEqual([...h.matchAll(/data-ph-key="([^"]+)"/g)].map(m => m[1]), ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'])
  assert.match(text(h), /Wrong PIN\./)
  assert.match(V.signIn({ busy: true }), /disabled>Signing in…/)
})

test('the bottom bar: Now, Needs you with its count, Outputs with its count, and the coordinator', () => {
  const h = V.nav('needs', SUMMARY, 'Master')
  assert.deepEqual([...h.matchAll(/data-ph-tab="([^"]+)"/g)].map(m => m[1]), ['now', 'needs', 'outputs', 'talk'])
  assert.match(h, /data-ph-tab="needs" aria-current="page"/)
  assert.match(text(h), /^Now Needs you 3 Outputs 1 Master$/)
})

test('Now: N things need you, the counts that go to their tab, each agent in one line, finished today', () => {
  const h = V.now(SUMMARY)
  assert.match(text(h), /4 things need you/)
  assert.match(h, /data-ph-tab="needs"><span class="ph-count-n">2<\/span><span class="ph-count-l">questions/)
  assert.match(h, /data-ph-tab="outputs"><span class="ph-count-n">1<\/span><span class="ph-count-l">output to sign off/)
  assert.match(text(h), /Agent 1 Busy Login page &lt;beta&gt;/)
  assert.match(text(h), /QA Idle no open flow/)
  assert.match(text(h), /Finished today: 3/)
  assert.match(V.now({ ...SUMMARY, agents: [] }), /No agents are running/)
})

test('Needs you: Yes and No with what each means, a text box for a text question, the cost said once, by-hand ticks', () => {
  const h = V.needs(SUMMARY, {})
  assert.equal((h.match(/a few cents/g) || []).length, 1)
  assert.match(h, /data-ph-answer="yes" data-flow="login" data-node="a1">Yes</)
  assert.match(h, /data-ph-answer="no" data-flow="login" data-node="a1">No</)
  assert.match(text(h), /Yes: it goes to dev · No: it waits/)
  assert.match(h, /<textarea class="ph-input" rows="3" maxlength="2000" id="phA-login-a2" data-draft="ask:login:a2"><\/textarea>/)
  assert.match(h, /<label class="ph-k" for="phA-login-a2">Your answer<\/label>/)
  assert.match(h, /<input type="checkbox" data-ph-tick data-flow="ci" data-step="h1">/)
  assert.match(text(h), /Where: GitHub › Settings/)
  assert.match(V.needs(SUMMARY, { busy: { 'ask:login:a1': true } }), /data-node="a1" disabled>Yes/)
  assert.match(text(V.needs({ ...SUMMARY, asks: [], hands: [] }, {})), /Nothing waits on you/)
})

test('Outputs: the story, Completed, and an inline confirm in its place', () => {
  const plainView = V.outputs(SUMMARY, {}, Date.parse('2026-11-26T10:00:00Z'))
  assert.match(text(plainView), /Agent 1 · finished 24 Nov · waiting a while/)
  assert.match(text(plainView), /Agent 1 Built the box\. You asked\./)
  assert.match(plainView, /data-ph-complete data-flow="shipped">Completed</)
  const confirm = V.outputs(SUMMARY, { confirm: 'shipped' })
  assert.match(text(confirm), /Mark it completed\? It moves to the archive\. Yes, completed Cancel/)
  assert.doesNotMatch(confirm, /data-ph-complete data-flow/)
  assert.match(text(V.outputs({ ...SUMMARY, outputs: [] }, {})), /No outputs to sign off/)
})

test('Talk: what happens to a message in plain words, the thread, a warning when the coordinator is not running, one Send', () => {
  const th = { label: 'Master', running: false, busy: false, messages: [{ id: 'm1', at: '2026-11-25T10:00:00Z', text: 'Hi', state: 'sent' }], replies: [{ at: '2026-11-25T10:01:00Z', text: 'Hello.' }] }
  const h = V.talk(th, {})
  assert.match(text(h), /Your message is handed to Master on your PC by a short paid turn \(a few cents\)\. Master answers when it gets to it\. Your PC must be on\./)
  assert.match(text(h), /Master is not running on your PC now/)
  assert.match(h, /class="ph-msg is-you">/)
  assert.match(h, /class="ph-msg is-them">/)
  assert.match(text(h), /Sent to Master/)
  assert.match(h, /<textarea id="phTalk" class="ph-input" rows="3" maxlength="2000" data-draft="talk" placeholder="Message Master"><\/textarea>/)
  assert.match(h, /<button type="submit" class="primary">Send<\/button>/)
  assert.match(V.talk({ ...th, busy: true }, {}), /disabled>Sending…/, 'one message in flight')
  assert.doesNotMatch(V.talk({ ...th, running: true }, {}), /not running/)
})

// ═══ the live half, the stylesheet, the manifest ═══

test('phone-app.js stores nothing in the browser, registers no service worker, and sends the CSRF header', () => {
  const app = read('phone-app.js')
  for (const s of ['localStorage', 'sessionStorage', 'indexedDB', 'serviceWorker', 'caches.', 'document.cookie']) assert.equal(app.includes(s), false, s)
  assert.match(app, /'x-phone-csrf': st\.csrf/)
  assert.match(app, /const TALK_MS = 10_000/)
  assert.match(app, /visibilitychange/)
  assert.match(app, /if \(field\) field\.value = '' \/\/ read once, never kept/)
})

/** The custom properties of the first block that starts with `head` in `css`. */
function tokens(css, head) {
  const at = css.indexOf(head)
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at))
  return Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]))
}

test('the colour tokens are the desktop ones, light and dark, value for value (MUST CHANGE IN LOCKSTEP)', () => {
  const desk = read('styles.css')
  const phone = read('phone.css')
  const light = tokens(phone, ':root {')
  const dark = tokens(phone, '@media (prefers-color-scheme: dark) {\n  :root {')
  const deskLight = tokens(desk, ':root {')
  const deskDark = tokens(desk, ':root[data-theme="dark"] {')
  assert.ok(Object.keys(light).length >= 20)
  for (const [k, v] of Object.entries(light)) if (k in deskLight) assert.equal(v, deskLight[k], `light ${k}`)
  for (const [k, v] of Object.entries(dark)) assert.equal(v, deskDark[k], `dark ${k}`)
  for (const k of ['--bg', '--surface', '--ink', '--muted', '--accent', '--line', '--ok', '--warn', '--bad']) assert.ok(k in dark, `dark ${k}`)
})

test('the manifest makes it a home-screen app on /phone with the drawn icons', () => {
  const m = JSON.parse(read('phone-manifest.webmanifest'))
  assert.equal(m.start_url, '/phone')
  assert.equal(m.scope, '/phone')
  assert.equal(m.display, 'standalone')
  assert.deepEqual(m.icons.map(i => i.src), ['/phone/icon.svg', '/phone/icon-180.png'])
  const page = read('phone.html')
  assert.match(page, /<link rel="manifest" href="\/phone\/manifest\.webmanifest">/)
  assert.match(page, /<link rel="apple-touch-icon" href="\/phone\/icon-180\.png">/)
  assert.match(page, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/)
})
