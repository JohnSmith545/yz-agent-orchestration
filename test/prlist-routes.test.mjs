// Tests for prlist-store.mjs and prlist-routes.mjs: the Pull requests list on the server. gh is a stub (no
// network, never a real pull request): a sent pull request is read by its link, an agent's by its branch; the
// states are read at most once a minute however often the page asks, a merged one never again; a request never
// waits on gh (one that hangs is given up after the timeout); a failed read keeps the last good state and says
// so; GET /api/prs answers no-store from the flows on disk, and nothing else is answered there.
// FACTORY_DATA_DIR points at a fresh temp folder BEFORE the imports.

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'prlist-routes-test-'))
const F = await import('../flows.mjs')
const { makePrList } = await import('../prlist-store.mjs')
const { makePrListRoute } = await import('../prlist-routes.mjs')

const URL1 = 'https://github.com/acme/shop/pull/12'
const URL2 = 'https://github.com/acme/shop/pull/14'
const pr = (url, over = {}) => ({
  number: Number(url.split('/').pop()), url, title: `Title ${url.split('/').pop()}`, state: 'OPEN', isDraft: false, createdAt: '2026-11-26T08:00:00Z',
  statusCheckRollup: [], reviewDecision: '', reviewRequests: [], mergeable: 'UNKNOWN', ...over,
})
const flow = (id, output, more = {}) => ({ id, title: `Work ${id}`, agent: 'Agent 1', status: 'done', updatedAt: '2026-11-26T09:00:00Z', output, ...more })
const sent = url => ({ pr: { url, number: Number(url.split('/').pop()), state: 'open', openedAt: '2026-11-26T08:00:00Z', checks: 'pending', checkedAt: null, error: null } })

/** A gh stub: answers from `world` (url -> gh JSON; `head:<branch>` -> gh JSON or absent), counts and records every call. */
function fakeGh(world) {
  const calls = []
  const gh = async args => {
    calls.push(args)
    if (world.fail) return { ok: false, out: '', err: 'gh: not signed in' }
    if (args[0] === 'pr' && args[1] === 'view') {
      const j = world[args[2]]
      return j ? { ok: true, out: JSON.stringify(j) } : { ok: false, out: '', err: 'no pull request' }
    }
    if (args[0] === 'pr' && args[1] === 'list') {
      const head = args.find(a => a.startsWith('--head='))?.slice(7)
      const j = world[`head:${head}`]
      return { ok: true, out: JSON.stringify(j ? [j] : []) }
    }
    return { ok: false, out: '' }
  }
  return { gh, calls }
}

test('a sent pull request is read by its link, an agent one by its branch, with --repo and --json as single arguments', async () => {
  const { gh, calls } = fakeGh({ [URL1]: pr(URL1), 'head:feat/x': pr(URL2, { title: 'Opened by the agent' }) })
  const flows = [flow('a', sent(URL1)), flow('b', { merge: { head: 'feat/x', base: 'dev', title: 't', body: 'b', at: '2026-11-26T07:00:00Z' } })]
  const list = makePrList({ gh, flows: () => flows, repo: async () => 'acme/shop' })
  await list.refresh()
  const snap = list.snapshot()
  assert.deepEqual(snap.items.map(i => i.title).sort(), ['Opened by the agent', 'Title 12'])
  assert.equal(snap.problem, null)
  assert.ok(snap.checkedAt)
  const view = calls.find(c => c[1] === 'view')
  assert.deepEqual(view.slice(0, 3), ['pr', 'view', URL1])
  assert.ok(view.some(a => /^--json=number,url,title,state/.test(a)))
  const lst = calls.find(c => c[1] === 'list')
  assert.ok(lst.includes('--repo=acme/shop'))
  assert.ok(lst.includes('--head=feat/x'))
  assert.ok(lst.includes('--base=dev'))
  assert.ok(lst.includes('--state=all'))
  // read only: nothing but view and list, ever
  assert.ok(calls.every(c => c[0] === 'pr' && ['view', 'list'].includes(c[1])))
})

test('the refresh limit: however often the page asks, gh is asked at most once a minute', async () => {
  let t = 1_000_000
  const { gh, calls } = fakeGh({ [URL1]: pr(URL1) })
  const list = makePrList({ gh, flows: () => [flow('a', sent(URL1))], repo: async () => 'acme/shop', now: () => t })
  list.snapshot()
  await list.idle()
  assert.equal(calls.length, 1)
  for (let i = 0; i < 10; i++) list.snapshot()
  t += 30_000
  list.snapshot()
  await list.idle()
  assert.equal(calls.length, 1, 'not again within the minute')
  t += 31_000
  list.snapshot()
  await list.idle()
  assert.equal(calls.length, 2, 'again after the minute')
})

test('a merged pull request leaves the list and is never read again', async () => {
  let t = 0
  const world = { [URL1]: pr(URL1) }
  const { gh, calls } = fakeGh(world)
  const list = makePrList({ gh, flows: () => [flow('a', sent(URL1))], repo: async () => '', now: () => t })
  await list.refresh()
  assert.equal(list.snapshot().items.length, 1)
  world[URL1] = pr(URL1, { state: 'MERGED' })
  t += 61_000
  await list.refresh()
  assert.equal(list.snapshot().items.length, 0)
  const before = calls.length
  t += 61_000
  await list.refresh()
  assert.equal(calls.length, before, 'a merged pull request cannot change: no read')
})

test('closed on GitHub, or Completed by the user: it leaves', async () => {
  let t = 0
  const world = { [URL1]: pr(URL1), [URL2]: pr(URL2) }
  const flows = [flow('a', sent(URL1)), flow('b', sent(URL2))]
  const list = makePrList({ gh: fakeGh(world).gh, flows: () => flows, repo: async () => '', now: () => t })
  await list.refresh()
  assert.equal(list.snapshot().items.length, 2)
  world[URL1] = pr(URL1, { state: 'CLOSED' })
  flows[1] = { ...flows[1], completedAt: '2026-11-26T10:00:00Z', completedBy: 'you' }
  // Completed is read from the flow at once, before the next gh read
  assert.deepEqual(list.snapshot().items.map(i => i.flow.id), ['a'])
  t += 61_000
  await list.refresh()
  assert.deepEqual(list.snapshot().items, [])
})

test('a gh failure keeps the last good state, marks it stale and says so in a plain sentence', async () => {
  let t = 0
  const world = { [URL1]: pr(URL1, { title: 'Known title' }) }
  const list = makePrList({ gh: fakeGh(world).gh, flows: () => [flow('a', sent(URL1))], repo: async () => '', now: () => t })
  await list.refresh()
  const good = list.snapshot()
  world.fail = true
  t += 61_000
  await list.refresh()
  const snap = list.snapshot()
  assert.equal(snap.items.length, 1)
  assert.equal(snap.items[0].title, 'Known title')
  assert.equal(snap.items[0].stale, true)
  assert.match(snap.problem, /Could not read GitHub/)
  assert.equal(snap.checkedAt, good.checkedAt, 'the time of the last good read is kept')
  // back again: fresh, and no problem
  delete world.fail
  t += 61_000
  await list.refresh()
  assert.equal(list.snapshot().items[0].stale, false)
  assert.equal(list.snapshot().problem, null)
})

test('the page never waits on gh: a read that hangs is given up after the timeout, and a request answers at once', async () => {
  const gh = () => new Promise(() => {}) // never answers
  const list = makePrList({ gh, flows: () => [flow('a', sent(URL1))], repo: async () => '', timeoutMs: 30 })
  const started = Date.now()
  const snap = list.snapshot() // kicks the refresh, does not wait for it
  assert.ok(Date.now() - started < 20)
  assert.equal(snap.items.length, 1, 'shown from what the flow stored')
  await list.idle()
  assert.match(list.snapshot().problem, /Could not read GitHub/)
})

test('an agent record with no repository known (an address gh cannot name) is still looked up without --repo; null repo skips it and says why', async () => {
  const { gh, calls } = fakeGh({ 'head:feat/x': pr(URL2) })
  const flows = [flow('b', { merge: { head: 'feat/x', base: 'dev', title: 't', body: 'b', at: '2026-11-26T07:00:00Z' } })]
  const noName = makePrList({ gh, flows: () => flows, repo: async () => '' })
  await noName.refresh()
  assert.equal(noName.snapshot().items.length, 1)
  assert.ok(!calls[0].some(a => a.startsWith('--repo')))
  const unknown = makePrList({ gh, flows: () => flows, repo: async () => null })
  await unknown.refresh()
  assert.equal(unknown.snapshot().items.length, 0)
  assert.match(unknown.snapshot().problem, /repository/)
})

// ═══ the route ═══

let server
let base
let route
const put = f => fs.writeFileSync(path.join(F.FLOWS_DIR, `${f.id}.json`), JSON.stringify(f))
before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (!(await route(req, res, url))) res.writeHead(404).end('not found')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => {
  server.close()
  fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true })
})
beforeEach(() => {
  fs.rmSync(F.FLOWS_DIR, { recursive: true, force: true })
  fs.mkdirSync(F.FLOWS_DIR, { recursive: true })
})

test('GET /api/prs: the list from the flows on disk, uncached; other methods are refused; other paths are not ours', async () => {
  const now = new Date().toISOString()
  const base0 = { tickets: [], status: 'done', why: '', createdAt: now, nodes: [] }
  F.writeFlow({ ...flow('a', sent(URL1)), ...base0 })
  put({ ...flow('b', undefined), ...base0 }) // no pull request
  const { gh } = fakeGh({ [URL1]: pr(URL1, { title: 'From <GitHub>' }) })
  route = makePrListRoute({ gh, git: async () => ({ ok: true, out: 'git@github.com:acme/shop.git\n' }), remote: () => 'origin' })
  await route.list.refresh()
  const r = await fetch(`${base}/api/prs`)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('cache-control'), 'no-store')
  const body = await r.json()
  assert.deepEqual(body.items.map(i => i.flow.id), ['a'])
  assert.equal(body.items[0].title, 'From <GitHub>', 'the JSON carries the text as GitHub gave it; the page escapes it')
  assert.equal((await fetch(`${base}/api/prs`, { method: 'POST' })).status, 405)
  assert.equal((await fetch(`${base}/api/prsx`)).status, 404)
})

test('the route reads the repository from the remote address, read only', async () => {
  const gitCalls = []
  const { gh, calls } = fakeGh({ 'head:feat/y': pr(URL2) })
  route = makePrListRoute({
    gh, git: async args => { gitCalls.push(args); return { ok: true, out: 'https://github.com/acme/shop.git\n' } }, remote: () => 'origin',
    flows: () => [flow('b', { merge: { head: 'feat/y', base: 'dev', title: 't', body: 'b', at: '2026-11-26T07:00:00Z' } })],
  })
  await route.list.refresh()
  assert.deepEqual(gitCalls[0], ['config', '--get', 'remote.origin.url'])
  assert.ok(calls[0].includes('--repo=acme/shop'))
})

test('server.mjs mounts the route with its gh and git runners and starts the background reads', () => {
  const src = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  assert.match(src, /import \{ makePrListRoute \} from '\.\/prlist-routes\.mjs'/)
  assert.match(src, /makePrListRoute\(\{ gh, git, remote: \(\) => prNow\(\)\.remote \}\)/)
  assert.match(src, /if \(await prListRoute\(req, res, url\)\) return/)
  assert.match(src, /prListRoute\.start\(\)/)
})

test('a pull request on the branch older than the agent record is the one before: not shown, and looked for again later', async () => {
  let t = 0
  const world = { 'head:feat/z': pr(URL2, { state: 'MERGED', createdAt: '2026-11-20T08:00:00Z' }) }
  const { gh, calls } = fakeGh(world)
  const flows = [flow('c', { merge: { head: 'feat/z', base: 'dev', title: 't', body: 'b', at: '2026-11-26T07:00:00Z' } })]
  const list = makePrList({ gh, flows: () => flows, repo: async () => '', now: () => t })
  await list.refresh()
  assert.equal(list.snapshot().items.length, 0)
  // the agent now opens the next pull request on the same branch: found on the next read
  world['head:feat/z'] = pr('https://github.com/acme/shop/pull/30', { createdAt: '2026-11-26T07:30:00Z' })
  t += 61_000
  await list.refresh()
  assert.equal(calls.length, 2, 'the old merged one did not stop the lookup')
  assert.deepEqual(list.snapshot().items.map(i => i.number), [30])
})
