// Tests for subagent-prs.mjs: the state of a subagent's pull request, read with
// `gh pr view --json` and nothing else, at most once a minute per pull request,
// never waiting long, and hidden (null) whenever gh fails. gh is a stub runner
// here, so no process starts and no network is touched.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { makePrStates } = await import('../subagent-prs.mjs')

const PR = { repo: 'acme/your-repo', number: 12, url: 'https://github.com/acme/your-repo/pull/12' }
const OPEN = { state: 'OPEN', isDraft: false, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }
const out = body => ({ ok: true, out: JSON.stringify(body), err: '', code: 0 })
const wait = ms => new Promise(r => setTimeout(r, ms))

/** A gh stub that records every call and answers with `answer(args)`; and a clock the test moves. */
function world(answer = () => out(OPEN), timeoutMs = 300) {
  const calls = []
  const clock = { t: Date.parse('2026-11-12T12:00:00Z') }
  const gh = async args => {
    calls.push(args)
    return answer(args)
  }
  return { calls, clock, states: makePrStates({ gh, now: () => clock.t, timeoutMs }) }
}

test('an open pull request with passing checks reads as open and passing', async () => {
  const w = world()
  await w.states.refresh([PR])
  assert.deepEqual(w.states.get(PR), { state: 'open', checks: 'passing', draft: false, at: '2026-11-12T12:00:00.000Z' })
})

test('it runs gh pr view with --json and the repo of the link, and nothing else', async () => {
  const w = world()
  await w.states.refresh([PR])
  assert.deepEqual(w.calls, [['pr', 'view', '12', '--repo=acme/your-repo', '--json=state,isDraft,statusCheckRollup']])
})

test('merged and closed read as such; failing checks win over pending; no checks is none; a draft is said', async () => {
  const cases = [
    [{ state: 'MERGED', statusCheckRollup: [] }, { state: 'merged', checks: 'none', draft: false }],
    [{ state: 'CLOSED', statusCheckRollup: null }, { state: 'closed', checks: 'none', draft: false }],
    [{ state: 'OPEN', isDraft: true, statusCheckRollup: [{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }] }, { state: 'open', checks: 'failing', draft: true }],
    [{ state: 'OPEN', statusCheckRollup: [{ status: 'QUEUED' }] }, { state: 'open', checks: 'pending', draft: false }],
  ]
  for (const [body, want] of cases) {
    const w = world(() => out(body))
    await w.states.refresh([PR])
    const { at, ...got } = w.states.get(PR)
    assert.deepEqual(got, want)
  }
})

test('a pull request is read at most once a minute, then again', async () => {
  const w = world()
  await w.states.refresh([PR])
  w.clock.t += 59_000
  await w.states.refresh([PR])
  assert.equal(w.calls.length, 1, 'still fresh')
  w.clock.t += 2_000
  await w.states.refresh([PR])
  assert.equal(w.calls.length, 2, 'a minute later it is read again')
})

test('a merged pull request is final: it is never read again', async () => {
  const w = world(() => out({ state: 'MERGED', statusCheckRollup: [] }))
  await w.states.refresh([PR])
  w.clock.t += 3600_000
  await w.states.refresh([PR])
  assert.equal(w.calls.length, 1)
  assert.equal(w.states.get(PR).state, 'merged')
})

test('the same pull request asked for twice at once is one gh call, and on two cards is one too', async () => {
  const w = world(async () => { await wait(20); return out(OPEN) })
  await Promise.all([w.states.refresh([PR, { ...PR }]), w.states.refresh([PR])])
  assert.equal(w.calls.length, 1)
})

test('a failure hides the state and is not retried within the minute', async () => {
  for (const bad of [() => ({ ok: false, out: '', err: 'gh: not found', code: null }), () => ({ ok: true, out: 'not json', err: '' }), () => out({ state: 'WEIRD' }), () => out(null), () => { throw new Error('spawn failed') }]) {
    const w = world(bad)
    await w.states.refresh([PR])
    assert.equal(w.states.get(PR), null)
    await w.states.refresh([PR])
    assert.equal(w.calls.length, 1)
  }
})

test('a failure after a good read keeps the last good state until gh answers again', async () => {
  let fail = false
  const w = world(() => (fail ? { ok: false, out: '', err: 'rate limited' } : out(OPEN)))
  await w.states.refresh([PR])
  fail = true
  w.clock.t += 61_000
  await w.states.refresh([PR])
  assert.equal(w.states.get(PR).state, 'open')
  assert.equal(w.states.get(PR).at, '2026-11-12T12:00:00.000Z', 'with the time it was last read')
})

test('a gh that never answers is given up on, and the state stays hidden', async () => {
  const w = world(() => new Promise(() => {}))
  const started = Date.now()
  await w.states.refresh([PR])
  assert.ok(Date.now() - started < 3000, 'it did not wait')
  assert.equal(w.states.get(PR), null)
})

test('refresh returns once its budget is spent; the answer still lands for the next read', async () => {
  const w = world(async () => { await wait(400); return out(OPEN) }, 5000)
  const started = Date.now()
  await w.states.refresh([PR], { budgetMs: 10 })
  assert.ok(Date.now() - started < 350, 'it came back before gh did')
  assert.equal(w.states.get(PR), null)
  await wait(500)
  assert.equal(w.states.get(PR).state, 'open')
})

test('a link that is not a plain owner/name and number is never passed to gh', async () => {
  const w = world()
  await w.states.refresh([{ repo: 'acme/your-repo --web', number: 12 }, { repo: '-x/y', number: 1 }, { repo: 'acme/your-repo', number: -3 }, { repo: 'acme/your-repo', number: '12; rm' }, { repo: 'acme', number: 1 }, null, {}])
  assert.equal(w.calls.length, 0)
  assert.equal(w.states.get({ repo: 'acme/your-repo --web', number: 12 }), null)
})

test('many pull requests are read a few at a time', async () => {
  let running = 0
  let most = 0
  const w = world(async () => {
    most = Math.max(most, ++running)
    await wait(5)
    running--
    return out(OPEN)
  })
  await w.states.refresh(Array.from({ length: 12 }, (_, i) => ({ repo: 'acme/your-repo', number: i + 1 })))
  assert.equal(w.calls.length, 12)
  assert.ok(most <= 4, `at most 4 at once, saw ${most}`)
})

test('withStates adds what is known to each link and leaves the rest as they are', async () => {
  const w = world()
  await w.states.refresh([PR])
  const other = { repo: 'acme/your-repo', number: 99, url: 'https://github.com/acme/your-repo/pull/99' }
  assert.deepEqual(w.states.withStates([PR, other]), [{ ...PR, state: 'open', checks: 'passing', draft: false, at: '2026-11-12T12:00:00.000Z' }, other])
})
