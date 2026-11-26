// Tests for prlist-items.mjs, the pure half of the Pull requests list (the fog on the Agents page and Home):
// which flow names which pull request (a sent one by its link, an agent's own by its branch), what gh's JSON
// means (open, draft, merged, closed, the checks in one word, whether it needs the user), and the list itself:
// open and draft in, merged, closed and Completed out, a flow with no pull request out, two flows naming the same
// pull request counted once, newest first, and a failed read keeping the last good state and saying so.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { lookupOf, prItems, readOf, repoOfPrUrl } from '../prlist-items.mjs'

const URL1 = 'https://github.com/acme/shop/pull/12'
const URL2 = 'https://github.com/acme/shop/pull/14'
const flow = (id, more = {}) => ({ id, title: `Work ${id}`, agent: 'Agent 1', status: 'done', updatedAt: '2026-11-26T09:00:00Z', ...more })
const sent = (url = URL1, more = {}) => ({ pr: { url, number: Number(url.split('/').pop()), state: 'open', openedAt: '2026-11-26T08:00:00Z', checks: 'pending', checkedAt: null, error: null, ...more } })
const merge = (head = 'feat/dark', more = {}) => ({ merge: { head, base: 'dev', title: `Agent title ${head}`, body: 'b', at: '2026-11-26T07:00:00Z', ...more } })
const gh = (over = {}) => ({
  number: 12, url: URL1, title: 'Dark mode for the settings page', state: 'OPEN', isDraft: false, createdAt: '2026-11-26T08:00:00Z',
  statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }], reviewDecision: '', reviewRequests: [], mergeable: 'MERGEABLE', ...over,
})
const reads = entries => new Map(entries.map(([key, value, stale = false]) => [key, { value, stale }]))

test('repoOfPrUrl: owner/name of a GitHub pull request link, null for anything else', () => {
  assert.equal(repoOfPrUrl(URL1), 'acme/shop')
  assert.equal(repoOfPrUrl('https://github.example.com/acme/shop/pull/3'), 'acme/shop')
  assert.equal(repoOfPrUrl('https://github.com/acme/shop/issues/3'), null)
  assert.equal(repoOfPrUrl('http://github.com/acme/shop/pull/3'), null)
  assert.equal(repoOfPrUrl(undefined), null)
})

test('lookupOf: a sent pull request is read by its link, an agent record by its branch, nothing else is looked up', () => {
  assert.deepEqual(lookupOf(flow('a', { output: sent() })), { key: `url:${URL1}`, by: 'url', url: URL1 })
  const byHead = lookupOf(flow('b', { output: merge('feat/dark') }))
  assert.equal(byHead.by, 'head')
  assert.equal(byHead.head, 'feat/dark')
  assert.equal(byHead.base, 'dev')
  assert.match(byHead.key, /^head:feat\/dark:dev:2026-11-26T07:00:00Z$/)
  // a newer record after a merged pull request is the next one: looked up by its branch again
  const next = lookupOf(flow('c', { output: { ...merge('feat/dark', { at: '2026-11-26T10:00:00Z' }), ...sent(URL1, { state: 'merged' }) } }))
  assert.equal(next.by, 'head')
  // no pull request at all, a failed send with no link, a bad branch name, a link that is not https
  assert.equal(lookupOf(flow('d')), null)
  assert.equal(lookupOf(flow('e', { output: { pr: { error: 'push refused' } } })), null)
  assert.equal(lookupOf(flow('f', { output: merge('-x') })), null)
  assert.equal(lookupOf(flow('g', { output: { pr: { url: 'http://x/pull/1', state: 'open' } } })), null)
})

test('readOf: open, draft, merged and closed; the checks as passing, failing, running or none', () => {
  const open = readOf(gh())
  assert.equal(open.state, 'open')
  assert.equal(open.draft, false)
  assert.equal(open.checks, 'passing')
  assert.equal(open.title, 'Dark mode for the settings page')
  assert.equal(open.repo, 'acme/shop')
  assert.equal(open.number, 12)
  assert.equal(open.openedAt, '2026-11-26T08:00:00Z')
  assert.equal(readOf(gh({ isDraft: true })).draft, true)
  assert.equal(readOf(gh({ state: 'MERGED' })).state, 'merged')
  assert.equal(readOf(gh({ state: 'CLOSED' })).state, 'closed')
  assert.equal(readOf(gh({ statusCheckRollup: [{ __typename: 'CheckRun', status: 'IN_PROGRESS' }] })).checks, 'running')
  assert.equal(readOf(gh({ statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }] })).checks, 'failing')
  assert.equal(readOf(gh({ statusCheckRollup: [] })).checks, 'none')
  // not a pull request: no state, no link, a link that is not https, not an object
  assert.equal(readOf(gh({ state: 'WEIRD' })), null)
  assert.equal(readOf(gh({ url: 'javascript:alert(1)' })), null)
  assert.equal(readOf(null), null)
  assert.equal(readOf('x'), null)
})

test('readOf: it needs you when a review is requested, or when it is mergeable and green; a draft never does', () => {
  assert.equal(readOf(gh({ reviewRequests: [{ login: 'you' }], mergeable: 'MERGEABLE' })).needs, 'review')
  assert.equal(readOf(gh({ reviewDecision: 'REVIEW_REQUIRED' })).needs, 'review')
  assert.equal(readOf(gh()).needs, 'merge')
  assert.equal(readOf(gh({ statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }] })).needs, null)
  assert.equal(readOf(gh({ mergeable: 'CONFLICTING' })).needs, null)
  assert.equal(readOf(gh({ reviewDecision: 'CHANGES_REQUESTED' })).needs, null)
  assert.equal(readOf(gh({ isDraft: true, reviewRequests: [{ login: 'you' }] })).needs, null)
  assert.equal(readOf(gh({ state: 'MERGED' })).needs, null)
})

test('readOf: a long title is cut to 300 characters and a title that is not text falls back to none', () => {
  assert.equal(readOf(gh({ title: 'x'.repeat(400) })).title.length, 300)
  assert.equal(readOf(gh({ title: 7 })).title, null)
})

test('prItems: an open pull request and a draft are in; merged and closed are out', () => {
  const flows = [
    flow('open', { output: sent(URL1) }),
    flow('draft', { output: sent(URL2) }),
    flow('merged', { output: sent('https://github.com/acme/shop/pull/20') }),
    flow('closed', { output: sent('https://github.com/acme/shop/pull/21') }),
  ]
  const items = prItems(flows, reads([
    [`url:${URL1}`, readOf(gh())],
    [`url:${URL2}`, readOf(gh({ number: 14, url: URL2, isDraft: true, title: 'Draft one', createdAt: '2026-11-26T08:30:00Z' }))],
    ['url:https://github.com/acme/shop/pull/20', readOf(gh({ number: 20, url: 'https://github.com/acme/shop/pull/20', state: 'MERGED' }))],
    ['url:https://github.com/acme/shop/pull/21', readOf(gh({ number: 21, url: 'https://github.com/acme/shop/pull/21', state: 'CLOSED' }))],
  ]))
  assert.deepEqual(items.map(i => i.flow.id), ['draft', 'open'])
  assert.equal(items[0].draft, true)
  const one = items[1]
  assert.equal(one.url, URL1)
  assert.equal(one.title, 'Dark mode for the settings page')
  assert.equal(one.label, 'acme/shop #12')
  assert.equal(one.agent, 'Agent 1')
  assert.equal(one.checks, 'passing')
  assert.equal(one.needs, 'merge')
  assert.equal(one.stale, false)
  assert.deepEqual(one.flow, { id: 'open', title: 'Work open' })
})

test('prItems: a flow the user marked Completed leaves, whatever GitHub says', () => {
  const items = prItems([flow('a', { output: sent(), completedAt: '2026-11-26T09:10:00Z', completedBy: 'you' })], reads([[`url:${URL1}`, readOf(gh())]]))
  assert.deepEqual(items, [])
})

test('prItems: a flow with no pull request, or an agent record GitHub has no pull request for, shows nothing', () => {
  assert.deepEqual(prItems([flow('a'), flow('b', { output: { story: [] } })], new Map()), [])
  const f = flow('c', { output: merge('feat/x') })
  assert.deepEqual(prItems([f], reads([[lookupOf(f).key, null]])), [])
  // not read yet: an agent record is not shown until GitHub has said there is a pull request
  assert.deepEqual(prItems([f], new Map()), [])
})

test('prItems: an agent opened the pull request itself; it is found by its branch, with the title GitHub gives', () => {
  const f = flow('c', { output: merge('feat/x') })
  const items = prItems([f], reads([[lookupOf(f).key, readOf(gh({ title: 'From GitHub' }))]]))
  assert.equal(items.length, 1)
  assert.equal(items[0].title, 'From GitHub')
  assert.equal(items[0].flow.id, 'c')
})

test('prItems: before the first read a sent pull request shows from what the flow stored; the title falls back to the agent record, then the flow', () => {
  const items = prItems([flow('a', { output: { ...merge('feat/a'), ...sent(URL1, { checks: 'pending' }) } }), flow('b', { output: sent(URL2) })], new Map())
  assert.deepEqual(items.map(i => i.title), ['Agent title feat/a', 'Work b'])
  assert.equal(items[0].checks, 'running')
  assert.equal(items[0].stale, false)
  // stored as merged: out, even before a read
  assert.deepEqual(prItems([flow('m', { output: sent(URL1, { state: 'merged' }) })], new Map()), [])
})

test('prItems: two flows naming the same pull request count once, on the flow updated last', () => {
  const older = flow('older', { updatedAt: '2026-11-25T09:00:00Z', output: sent(URL1) })
  const newer = flow('newer', { updatedAt: '2026-11-26T11:00:00Z', output: merge('feat/same') })
  const items = prItems([older, newer], reads([[`url:${URL1}`, readOf(gh())], [lookupOf(newer).key, readOf(gh({ url: `${URL1}/` }))]]))
  assert.equal(items.length, 1)
  assert.equal(items[0].flow.id, 'newer')
})

test('prItems: newest pull request first; one with no opening time goes last', () => {
  const a = flow('a', { output: sent('https://github.com/acme/shop/pull/1') })
  const b = flow('b', { output: sent('https://github.com/acme/shop/pull/2') })
  const c = flow('c', { output: sent('https://github.com/acme/shop/pull/3', { openedAt: null }) })
  const items = prItems([a, b, c], reads([
    ['url:https://github.com/acme/shop/pull/1', readOf(gh({ number: 1, url: 'https://github.com/acme/shop/pull/1', createdAt: '2026-11-20T08:00:00Z' }))],
    ['url:https://github.com/acme/shop/pull/2', readOf(gh({ number: 2, url: 'https://github.com/acme/shop/pull/2', createdAt: '2026-11-26T08:00:00Z' }))],
  ]))
  assert.deepEqual(items.map(i => i.flow.id), ['b', 'a', 'c'])
})

test('prItems: a read that failed keeps the last good state, marked stale so the page can say so', () => {
  const items = prItems([flow('a', { output: sent() })], reads([[`url:${URL1}`, readOf(gh()), true]]))
  assert.equal(items.length, 1)
  assert.equal(items[0].stale, true)
  assert.equal(items[0].checks, 'passing')
})

test('prItems: wrong shapes are skipped, never thrown on', () => {
  assert.deepEqual(prItems(null, null), [])
  assert.deepEqual(prItems([null, 7, { id: 'x' }], new Map()), [])
})
