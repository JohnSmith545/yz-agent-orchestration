// Tests for the delivery line under an answered ask in public/flow-drawer.js
// (sent, not delivered, sending, or not sent yet with a retry). The file is a
// browser script that only attaches window.FlowDrawer at load, so it runs here
// in a vm context with a bare window.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const window = {}
// shell.js first: the drawer writes its times through Shell.ago
for (const f of ['shell.js', 'flow-drawer.js']) vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8'), { window })
const { delivery, deliveryState } = window.FlowDrawer

const NOW = Date.parse('2026-11-12T10:00:00Z')
const ago = min => new Date(NOW - min * 60_000).toISOString()
const asked = more => ({ id: 'n3', type: 'ask', kind: 'yesno', answer: 'yes', answeredAt: ago(0.5), sentAt: null, deliveryError: null, ...more })

test('deliveryState: open, sent, failed, sending, and stale after two minutes', () => {
  assert.equal(deliveryState(asked({ answer: null, answeredAt: null }), NOW), '')
  assert.equal(deliveryState(asked({ sentAt: ago(0.2) }), NOW), 'sent')
  assert.equal(deliveryState(asked({ deliveryError: 'FAILED: gone' }), NOW), 'failed')
  assert.equal(deliveryState(asked(), NOW), 'sending')
  assert.equal(deliveryState(asked({ answeredAt: ago(1.9) }), NOW), 'sending')
  assert.equal(deliveryState(asked({ answeredAt: ago(2.1) }), NOW), 'stale')
  assert.equal(deliveryState(asked({ answeredAt: null }), NOW), 'stale', 'no time at all is old enough to retry')
})

test('delivery shows sending for a fresh unsent answer, and a retry once it is stale', () => {
  const fresh = delivery(asked({ answeredAt: new Date(Date.now() - 10_000).toISOString() }))
  assert.match(fresh, /sending…/)
  assert.doesNotMatch(fresh, /data-retry/)
  const stale = delivery(asked({ answeredAt: new Date(Date.now() - 5 * 60_000).toISOString() }))
  assert.match(stale, /not sent yet/)
  assert.match(stale, /data-retry="n3"/)
})

test('delivery keeps sent and not delivered as they were', () => {
  assert.match(delivery(asked({ sentAt: new Date().toISOString() })), /class="fl-sent"/)
  assert.match(delivery(asked({ deliveryError: 'FAILED: <b>' })), /<dfn data-term="not delivered" tabindex="0">not delivered<\/dfn> · <button type="button" class="link" data-retry="n3">retry<\/button>/)
  assert.match(delivery(asked({ deliveryError: 'FAILED: <b>' })), /title="FAILED: &lt;b&gt;"/)
  assert.equal(delivery(asked({ answer: null })), '')
})
