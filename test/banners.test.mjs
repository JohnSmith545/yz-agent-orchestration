// The banners above every page (public/app.js App.banners): a missing repo folder
// is said plainly, instead of a git error about spawning git in a folder that is
// not there, and it replaces the fetch and remote banners it would cause.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ctx = vm.createContext({ window: {} })
for (const f of ['shell.js', 'app.js']) vm.runInContext(fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8'), ctx)
const banners = d => [...ctx.window.App.banners(d)]

const ok = { repo: 'C:/path/to/acme-app', repoOk: true, fetch: { ok: true, err: '' }, remotesOk: { dev: true, stage: true }, ticketSnapshotAt: null }

test('no banner when the repo, the fetch and the remotes are fine', () => {
  assert.deepEqual(banners(ok), [])
})

test('a missing repo folder says so, with its path, and nothing about git', () => {
  const d = { ...ok, repo: 'C:/path/to/<gone>', repoOk: false, fetch: { ok: false, err: 'spawn git ENOENT' }, remotesOk: { dev: false, stage: false } }
  assert.deepEqual(banners(d), ['The repo folder in config.json does not exist: C:/path/to/&lt;gone&gt;'])
})

test('a failed fetch and unreadable remotes still show when the repo is there', () => {
  const d = { ...ok, fetch: { ok: false, err: 'network down' }, remotesOk: { dev: false, stage: true } }
  assert.deepEqual(banners(d), ['git fetch failed, so dev and stage may be stale: network down', 'origin/dev or origin/stage could not be read.'])
})
