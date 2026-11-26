// The reply box for a waiting session (human-review.js replyHtml): Human review's row and the session's own page
// both draw it. Pure: a row in, HTML out, run in a vm with a bare window like the other Human review tests.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = f => fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8')

function load() {
  const window = { Shell: { ago: iso => (iso ? '2m' : '') }, FlowDrawer: { delivery: () => '' } }
  vm.runInNewContext(read('flow-board.js'), { window })
  vm.runInNewContext(read('human-review.js'), { window })
  return window.HumanReview
}

const ROW = { key: 'session:abc', kind: 'session', sessionId: 'abc', title: 'agent-3', agent: 'agent-3', since: '2026-11-26T10:00:00Z', reason: 'Asked you: Should I build it?', wait: 'question' }

test('a question row has a reply box and a Send button, named for the session, Enter to send', () => {
  const h = load().replyHtml(ROW)
  assert.match(h, /<form class="hr-reply" data-hr-reply="abc">/)
  assert.match(h, /<textarea name="reply" rows="2" maxlength="2000" data-key="reply:abc" aria-label="Your reply to agent-3"/)
  assert.match(h, /placeholder="Your reply\. Enter sends, Shift\+Enter adds a line\."/)
  assert.match(h, /<button type="submit" class="primary">Send<\/button>/)
  assert.doesNotMatch(h, /hr-reply-state/, 'nothing sent yet, nothing to report')
})

test('a permission row has no box: it says to approve or deny in VS Code, since a message cannot press the button', () => {
  const h = load().replyHtml({ ...ROW, wait: 'permission', reason: 'Needs your OK to use Bash' })
  assert.doesNotMatch(h, /<form|<textarea/)
  assert.match(h, /Approve or deny it in VS Code/)
})

test('how the last reply went: sending disables the box, sent says it clears once picked up, failed offers Retry', () => {
  const H = load()
  const sending = H.replyHtml({ ...ROW, reply: { status: 'sending', text: 'Yes', at: 'x' } })
  assert.match(sending, /<textarea[^>]* disabled><\/textarea>/)
  assert.match(sending, /<button type="submit" class="primary" disabled>Send<\/button>/)
  assert.match(sending, /Sending your reply/)
  assert.match(H.replyHtml({ ...ROW, reply: { status: 'sent', text: 'Yes', at: 'x', sentAt: '2026-11-26T10:01:00Z' } }), /Sent 2m\. This clears once the session picks it up\./)
  const failed = H.replyHtml({ ...ROW, reply: { status: 'failed', text: 'Yes', at: 'x', error: 'FAILED: <no session>' } })
  assert.match(failed, /class="hr-reply-state is-failed">Not delivered: FAILED: &lt;no session&gt;\./)
  assert.match(failed, /<button type="button" class="link" data-hr-retry="abc">Retry<\/button>/)
})

test('the session row in Human review carries the reply box; other rows do not', () => {
  const H = load()
  assert.match(H.rowHtml(ROW), /data-hr-reply="abc"/)
  assert.equal(H.replyHtml({ key: 'ask:a:n1', kind: 'ask' }), '')
})

test('the session page shows the same box above Live activity, and only redraws it when the row changed', () => {
  const src = read('agent.js')
  assert.match(src, /<div id="agentReply" class="agent-reply" hidden><\/div>\s*<div class="agent-grid">/)
  assert.match(src, /window\.HumanReview\.replyHtml\(row\)/)
  assert.match(src, /if \(sig === view\.replySig\) return/)
})
