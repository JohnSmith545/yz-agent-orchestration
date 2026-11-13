// Tests for Home's /api/status poll in public/app.js (spec 5): load() runs
// every 60 s on EVERY page, but the header chip belongs to whichever page is
// showing, so a failed load writes the chip only on Home or Agents (the pages
// that show this data). app.js skips its DOM code when window.document is
// missing, so it runs here in a vm with a bare window and a stub document
// global for load() itself.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(HERE, '..', 'public', 'app.js'), 'utf8')

/** app.js on the page `view`, with /api/status failing; resolves to every Shell.setStatus call. */
async function failedLoadOn(view) {
  const statuses = []
  const stubs = new Map()
  const document = { getElementById: id => (stubs.has(id) || stubs.set(id, { id, disabled: false, textContent: '', innerHTML: '' }), stubs.get(id)) }
  const window = { Shell: { current: { view, params: {}, redirect: null }, setStatus: (...a) => statuses.push(a) } }
  const fetch = async () => ({ ok: false, status: 500, text: async () => 'status build failed' })
  const ctx = vm.createContext({ window, document, fetch })
  vm.runInContext(SRC, ctx)
  await ctx.load(false)
  return { statuses, refresh: document.getElementById('refresh') }
}

test('a failed load on Home writes Could not load into the chip', async () => {
  const { statuses, refresh } = await failedLoadOn('home')
  assert.equal(statuses.length, 1)
  assert.match(statuses[0][0], /Could not load: status build failed/)
  assert.equal(refresh.disabled, false, 'Refresh is usable again')
})

test('a failed load on Agents writes the chip too (the Agents page shows this data)', async () => {
  const { statuses } = await failedLoadOn('agents')
  assert.equal(statuses.length, 1)
})

test('a failed load while Tickets, Flows or the Timeline shows leaves their chip alone', async () => {
  for (const view of ['tickets', 'flows', 'timeline', 'agent']) {
    const { statuses, refresh } = await failedLoadOn(view)
    assert.deepEqual(statuses, [], view)
    assert.equal(refresh.disabled, false, view)
  }
})
