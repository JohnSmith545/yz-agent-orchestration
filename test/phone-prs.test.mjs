// Tests for the ONE pull request list shared by the desktop and the phone: the fog block's store (prlist-store.mjs,
// served as GET /api/prs) is the very list the phone's Agents tab shows (phone-orchestration.mjs, given the store
// through its `prs` provider, as server.mjs wires it). Same items, same order, and the phone adds no gh call of its
// own: however often both ask, gh is read at most once a minute. gh is a stub; no network, no real pull request.
// FACTORY_DATA_DIR points at a fresh temp folder BEFORE the imports.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-prs-test-'))
const { makePrList } = await import('../prlist-store.mjs')
const { makeOrchestration } = await import('../phone-orchestration.mjs')

const URL1 = 'https://github.com/acme/shop/pull/12'
const URL2 = 'https://github.com/acme/shop/pull/14'
const pr = (url, at, over = {}) => ({
  number: Number(url.split('/').pop()), url, title: `Title ${url.split('/').pop()}`, state: 'OPEN', isDraft: false, createdAt: at,
  statusCheckRollup: [], reviewDecision: '', reviewRequests: [], mergeable: 'UNKNOWN', ...over,
})
const sent = url => ({ pr: { url, number: Number(url.split('/').pop()), state: 'open', openedAt: '2026-11-26T08:00:00Z', checks: 'pending', checkedAt: null, error: null } })
const flow = (id, output) => ({ id, title: `Work ${id}`, agent: 'Agent 1', status: 'done', updatedAt: '2026-11-26T09:00:00Z', output })
const CONFIG = { coordinator: 'Coordinator', coordinatorLabel: 'Master', codingAgents: { 'Agent 1': 'Agent 1' }, pipeline: { qa: 'QA', producers: null, protectedBranches: ['dev', 'main'], maxReworks: 3 } }

test('the phone shows the fog list itself: same pull requests, same order, and no extra gh read', async () => {
  let t = 1_000_000
  const world = { [URL1]: pr(URL1, '2026-11-26T08:00:00Z'), [URL2]: pr(URL2, '2026-11-26T10:00:00Z', { title: 'Newest one' }) }
  const calls = []
  const gh = async args => {
    calls.push(args)
    const j = world[args[2]]
    return j ? { ok: true, out: JSON.stringify(j) } : { ok: false, out: '' }
  }
  const store = makePrList({ gh, flows: () => [flow('a', sent(URL1)), flow('b', sent(URL2))], repo: async () => 'acme/shop', now: () => t })
  await store.refresh()
  const reads = calls.length
  const phone = makeOrchestration({ config: CONFIG, getStatus: async () => ({ agents: [] }), prs: () => store.snapshot().items })

  const desktop = store.snapshot().items
  const { body } = await phone.orchestration()
  assert.deepEqual(body.prs.map(p => p.url), desktop.map(i => i.url))
  assert.deepEqual(body.prs.map(p => p.title), ['Newest one', 'Title 12'])

  for (let i = 0; i < 10; i++) {
    await phone.orchestration()
    store.snapshot()
  }
  await store.idle()
  assert.equal(calls.length, reads, 'the phone asking adds no gh read within the minute')

  // merged on GitHub: after the next refresh it leaves both at once
  world[URL1] = pr(URL1, '2026-11-26T08:00:00Z', { state: 'MERGED' })
  t += 61_000
  await store.refresh()
  assert.deepEqual((await phone.orchestration()).body.prs.map(p => p.url), [URL2])
  assert.deepEqual(store.snapshot().items.map(i => i.url), [URL2])
})
