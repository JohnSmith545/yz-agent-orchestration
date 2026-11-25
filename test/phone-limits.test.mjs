// Tests for phone-limits.mjs: the rate limits of the phone listener (per session, per address, per sign-in
// address), with an injected clock.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { makeLimiter, PHONE_LIMITS } = await import('../phone-limits.mjs')

test('the limits are 60 a minute per session, and stricter for sign-in', () => {
  assert.equal(PHONE_LIMITS.session.max, 60)
  assert.equal(PHONE_LIMITS.session.ms, 60_000)
  assert.ok(PHONE_LIMITS.login.max <= 10)
  assert.ok(PHONE_LIMITS.address.max >= PHONE_LIMITS.session.max)
})

test('a key gets max hits in a window, then a refusal with the seconds to wait; the next window opens again', () => {
  const clock = { t: 0 }
  const limit = makeLimiter({ max: 3, ms: 60_000, now: () => clock.t })
  for (let i = 0; i < 3; i++) assert.equal(limit.hit('a').ok, true)
  const r = limit.hit('a')
  assert.equal(r.ok, false)
  assert.equal(r.retryAfter, 60)
  assert.equal(limit.hit('b').ok, true, 'another key has its own count')
  clock.t += 30_000
  assert.equal(limit.hit('a').retryAfter, 30)
  clock.t += 30_000
  assert.equal(limit.hit('a').ok, true)
})

test('an empty key is limited like any other, and the table of keys never grows without end', () => {
  const clock = { t: 0 }
  const limit = makeLimiter({ max: 1, ms: 1000, now: () => clock.t, keys: 50 })
  assert.equal(limit.hit('').ok, true)
  assert.equal(limit.hit('').ok, false)
  for (let i = 0; i < 500; i++) limit.hit(`k${i}`)
  assert.ok(limit.size() <= 50)
})
