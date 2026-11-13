// Tests for public/worktrees.js: the worktree table as pure HTML from the
// /api/status worktrees rows (it left Home; Tickets mounts it in Task 3).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ctx = vm.createContext({ window: {} })
for (const f of ['shell.js', 'app.js', 'worktrees.js']) vm.runInContext(fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8'), ctx)
const { html } = ctx.window.Worktrees

const wt = (name, extra = {}) => ({
  name, branch: `feat/${name}`, agent: null, isAgentTree: false, dirty: 0, upstream: null, vsUpstream: null,
  vsDev: { ahead: 1, behind: 2 }, followup: 'no', dev: 'no', stage: 'no',
  last: { sha: 'abc1234', when: new Date(Date.now() - 2 * 3600_000).toISOString(), subject: 'feat: x' }, ...extra,
})

test('agent worktrees come first, then the rest by name', () => {
  const out = html([wt('b'), wt('z', { isAgentTree: true, agent: 'Agent 1' }), wt('a')])
  const names = [...out.matchAll(/<td class="mono">([^<]+)<\/td>/g)].map(m => m[1])
  assert.deepEqual(names, ['z', 'a', 'b'])
})

test('one row per worktree under a ten-column head', () => {
  const out = html([wt('a'), wt('b')])
  assert.equal((out.match(/<tr>/g) || []).length, 3)
  assert.equal((out.match(/<th>/g) || []).length, 10)
})

test('no rows is an empty body, and the input list is not reordered', () => {
  assert.match(html([]), /<tbody><\/tbody>/)
  assert.match(html(undefined), /<tbody><\/tbody>/)
  const rows = [wt('b'), wt('a')]
  html(rows)
  assert.deepEqual(rows.map(r => r.name), ['b', 'a'])
})

test('it escapes what it prints', () => {
  assert.doesNotMatch(html([wt('<x>', { last: { sha: 's', when: 'w', subject: '<b>' } })]), /<x>|<b>/)
})

test('the last commit time arrives as ISO (git %cI) and shows short, through Shell.ago', () => {
  const out = html([wt('a')])
  assert.match(out, /<span class="mono">abc1234<\/span> 2h</)
  assert.doesNotMatch(out, /\d{4}-\d{2}-\d{2}T/, 'the raw ISO time is never printed')
})
