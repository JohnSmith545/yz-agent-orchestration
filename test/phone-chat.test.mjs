// Tests for the phone chat with the coordinator (public/phone-chat.js) and the safe reply formatting it uses
// (public/phone-text.js), run in a vm like the other browser files. Every reply is HOSTILE text: it is the
// coordinator's words, and they may quote anything an agent, a ticket or a web page put in front of it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = f => fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8')
const ctx = vm.createContext({ window: {} })
for (const f of ['phone-state.js', 'phone-text.js', 'phone-chat.js']) vm.runInContext(read(f), ctx)
const X = ctx.window.PhoneText
const C = ctx.window.PhoneChat
const plain = v => JSON.parse(JSON.stringify(v))
/** An event handler attribute INSIDE a tag: escaped text that merely reads onerror= is no attribute. */
/** Quoted attribute values are emptied first: a raw quote never survives esc, so a value cannot hide a real one. */
const handlerIn = h => /<[^>]*\son[a-z]+\s*=/i.test(h.replace(/"[^"]*"/g, '""'))

const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

// ═══ the formatting ═══

test('paragraphs, line breaks, bold, inline code and bullet lists', () => {
  const h = X.render('First **bold** and `npm test`.\nSame paragraph.\n\nDone:\n- one\n- two\n\n1. a\n2. b')
  assert.equal(h, '<p>First <b>bold</b> and <code>npm test</code>.<br>Same paragraph.</p><p>Done:</p><ul><li>one</li><li>two</li></ul><ol><li>a</li><li>b</li></ol>')
})

test('a fenced block keeps its lines as code; a heading line is bold', () => {
  assert.equal(X.render('```js\nconst a = 1 < 2\n```'), '<pre><code>const a = 1 &lt; 2</code></pre>')
  assert.equal(X.render('## Status\nAll green.'), '<p><b>Status</b><br>All green.</p>')
})

test('hostile text is escaped everywhere: tags, quotes, handlers', () => {
  for (const evil of ['<img src=x onerror=alert(1)>', '"><script>alert(1)</script>', "'><svg onload=alert(1)>", '**<img src=x onerror=alert(1)>**', '`<script>`', '- <b onclick=x>y</b>']) {
    const h = X.render(evil)
    assert.doesNotMatch(h, /<img|<script|<svg|<b onclick/i, evil)
    assert.equal(handlerIn(h), false, evil)
  }
})

test('links: shown as text, except https github.com ones, clickable with rel noopener', () => {
  const gh = X.render('See [the PR](https://github.com/o/r/pull/3) or https://github.com/o/r/issues/9.')
  assert.ok(gh.includes('<a href="https://github.com/o/r/pull/3" target="_blank" rel="noopener noreferrer">the PR</a>'))
  assert.ok(gh.includes('<a href="https://github.com/o/r/issues/9" target="_blank" rel="noopener noreferrer">https://github.com/o/r/issues/9</a>.'), 'the full stop stays outside')
  for (const evil of ['[click](javascript:alert(1))', '[x](JaVaScRiPt:alert(1))', '[x](data:text/html,<script>alert(1)</script>)', '[x](https://github.com.evil.example/a)', '[x](http://github.com/a)',
    '[x](https://github.com@evil.example/a)', 'https://evil.example/a', '[x](//github.com/a)', '[x](https://github.com/a\\\\evil)']) {
    const h = X.render(evil)
    assert.doesNotMatch(h, /<a\s/i, evil)
    assert.doesNotMatch(h, /href=/i, evil)
    assert.equal(handlerIn(h), false, evil)
  }
  assert.equal(text(X.render('[click](javascript:alert(1))')), 'click (javascript:alert(1))', 'said as text')
  const quoted = X.render('[x](https://github.com/a" onmouseover="alert(1))')
  assert.equal(handlerIn(quoted), false, 'a quote ends the address: the rest stays text')
  assert.doesNotMatch(quoted, /href="[^"]*\s[^"]*"/, 'no space inside an address')
})

test('empty and odd input', () => {
  assert.equal(X.render(''), '')
  assert.equal(X.render(null), '')
  assert.equal(X.render('\n\n\n'), '')
  assert.equal(X.render('a\r\nb'), '<p>a<br>b</p>')
})

// ═══ the chat states ═══

const NOW = Date.parse('2026-11-26T10:10:00Z')
const msg = (o = {}) => ({ id: 'm1', at: '2026-11-26T10:00:00Z', text: 'Status?', state: 'sent', deliveredAt: '2026-11-26T10:00:20Z', replies: [], ...o })
const th = (messages, more = {}) => ({ label: 'Master', running: true, busy: false, now: new Date(NOW).toISOString(), messages, cost: 'Each message costs about 14 cents.', ...more })

test('each message says where it is: Sending, Delivered to Master, Not delivered with the reason', () => {
  assert.equal(C.messageWord(msg({ state: 'sending' }), 'Master'), 'Sending…')
  assert.equal(C.messageWord(msg(), 'Master'), 'Delivered to Master')
  assert.equal(C.messageWord(msg({ state: 'failed', error: 'Master has no session open.' }), 'Master'), 'Not delivered: Master has no session open.')
  assert.equal(C.messageWord(msg({ state: 'failed' }), 'Master'), 'Not delivered.')
})

test('the thread: sending, working from delivery for 10 minutes, then quiet; a reply ends it', () => {
  assert.equal(C.status(th([]), NOW).kind, 'idle')
  assert.equal(C.status(th([msg({ state: 'sending' })]), NOW).kind, 'sending')
  const working = C.status(th([msg()]), NOW)
  assert.equal(working.kind, 'working')
  assert.equal(working.text, 'Master is working…')
  const quiet = C.status(th([msg()]), Date.parse('2026-11-26T10:10:21Z'))
  assert.equal(quiet.kind, 'quiet')
  assert.match(quiet.text, /No reply yet/)
  assert.equal(C.status(th([msg({ replies: [{ at: '2026-11-26T10:05:00Z', text: 'ok' }] })]), NOW).kind, 'idle')
  assert.equal(C.status(th([msg({ state: 'failed', error: 'x' })]), NOW).kind, 'idle')
  assert.equal(C.status(th([msg({ deliveredAt: undefined, at: '2026-11-26T10:09:00Z' })]), NOW).kind, 'working', 'an older record with no deliveredAt counts from its own time')
})

test('the poll: 5 s while a message is on its way or Master works and the tab shows, else 15 s; none while hidden', () => {
  assert.equal(C.pollMs(th([msg()]), NOW, true), 5000)
  assert.equal(C.pollMs(th([msg({ state: 'sending' })]), NOW, true), 5000)
  assert.equal(C.pollMs(th([msg({ replies: [{ at: '2026-11-26T10:05:00Z', text: 'ok' }] })]), NOW, true), 15000)
  assert.equal(C.pollMs(th([]), NOW, true), 15000)
  assert.equal(C.pollMs(null, NOW, true), 15000)
  assert.equal(C.pollMs(th([msg()]), NOW, false), null)
})

test('near the bottom, and a new reply: follow it or show the pill', () => {
  assert.equal(C.nearBottom({ scrollTop: 900, clientHeight: 800, scrollHeight: 1750 }), true)
  assert.equal(C.nearBottom({ scrollTop: 100, clientHeight: 800, scrollHeight: 1750 }), false)
  assert.equal(C.replyCount(th([msg({ replies: [{ at: 'a', text: 'x' }, { at: 'b', text: 'y' }] }), msg({ id: 'm2' })])), 2)
  assert.equal(C.onNewReplies(2, 3, true), 'follow')
  assert.equal(C.onNewReplies(2, 3, false), 'pill')
  assert.equal(C.onNewReplies(3, 3, false), 'none')
  assert.equal(C.onNewReplies(-1, 3, false), 'follow', 'the first draw opens at the bottom')
})

test('Send is off while the box is empty or a message is in flight', () => {
  assert.equal(C.canSend('hi', false), true)
  assert.equal(C.canSend('   ', false), false)
  assert.equal(C.canSend('', false), false)
  assert.equal(C.canSend('hi', true), false)
})

// ═══ the markup ═══

test('the thread: your message on one side, the replies under it on the other, each with a short time', () => {
  const h = C.view(th([msg({ replies: [{ at: '2026-11-26T10:05:00Z', text: '**Done.** Merged.' }] }), msg({ id: 'm2', at: '2026-11-26T10:06:00Z', text: 'Thanks', replies: [] })]), { talkDraft: '' }, NOW)
  const order = [...h.matchAll(/class="ph-bubble (is-you|is-them)/g)].map(m => m[1])
  assert.deepEqual(order, ['is-you', 'is-them', 'is-you'])
  assert.ok(h.includes('<b>Done.</b> Merged.'))
  assert.match(text(h), /Status\? \d\d:\d\d · Delivered to Master/)
  assert.match(text(h), /Master · \d\d:\d\d/)
  assert.match(h, /class="ph-working" role="status"/, 'the last message has no reply yet: Master is working')
})

test('a failed message: Not delivered with the reason and a Try again that names the message', () => {
  const h = C.view(th([msg({ state: 'failed', error: 'Master has no session open.' })]), {}, NOW)
  assert.match(text(h), /Not delivered: Master has no session open\./)
  assert.match(h, /<button type="button" class="ph-retry" data-ph-retry="m1">Try again<\/button>/)
  assert.match(h, /ph-bubble is-you is-failed/)
})

test('the composer: one box that grows, Send off while empty or sending, and the cost line under it', () => {
  const empty = C.view(th([]), { talkDraft: '' }, NOW)
  assert.match(empty, /<textarea id="phTalk" class="ph-input ph-compose-box" rows="1" maxlength="2000" data-draft="talk" placeholder="Message Master"><\/textarea>/)
  assert.match(empty, /<button type="submit" class="primary ph-send-btn" disabled>Send<\/button>/)
  assert.match(C.view(th([]), { talkDraft: 'hi' }, NOW), /<button type="submit" class="primary ph-send-btn">Send<\/button>/)
  assert.match(C.view(th([msg({ state: 'sending' })], { busy: true }), { talkDraft: 'hi' }, NOW), /class="primary ph-send-btn" disabled>Sending…</)
  assert.match(text(empty), /Each message costs about 14 cents\./)
  assert.match(text(C.view(th([], { cost: '' }), {}, NOW)), /Each message costs a few cents\./)
})

test('empty thread, help, and a coordinator with no session', () => {
  const h = C.view(th([], { running: false }), {}, NOW)
  assert.match(text(h), /Write to Master/)
  assert.match(text(h), /How this works/)
  assert.match(text(h), /same on every phone signed in with your PIN/)
  assert.match(text(h), /before your first phone message is never shown/)
  assert.match(text(h), /Master has no session open on your PC/)
  assert.doesNotMatch(C.view(th([]), {}, NOW), /no session open/)
})

test('no markup holds an inline style, an inline handler or a script; hostile text in every field is escaped', () => {
  const evil = '"><script>alert(1)</script><img src=x onerror=alert(1)>'
  const h = C.view(th([msg({ text: evil, state: 'failed', error: evil, id: 'm"1', replies: [{ at: '2026-11-26T10:05:00Z', text: `${evil} [x](javascript:alert(1))` }] })], { label: evil, cost: evil }), { talkDraft: evil, status: { talk: evil } }, NOW)
  assert.doesNotMatch(h, /<script|<img|\sstyle=|javascript:alert\(1\)"|href=/i)
  assert.equal(handlerIn(h), false)
  assert.ok(h.includes('data-ph-retry="m&quot;1"'))
})

test('the times: a clock time today, the day and the time before today', () => {
  assert.match(C.stamp('2026-11-26T09:00:00Z', NOW), /^\d\d:\d\d$/)
  assert.match(C.stamp('2026-11-20T09:00:00Z', NOW), /^\d{1,2} Nov \d\d:\d\d$/)
  assert.equal(C.stamp('nope', NOW), '')
  assert.deepEqual(plain(Object.keys(C).sort()), ['WORKING_MS', 'canSend', 'messageWord', 'nearBottom', 'onNewReplies', 'pollMs', 'replyCount', 'stamp', 'status', 'view'])
})
