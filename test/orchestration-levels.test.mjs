// The orchestration build notes level changes for Home's Since card
// (orchestration.mjs -> since-store.mjs recordLevels), but ONLY from a build
// whose git reads all succeeded: a failed `git log` reads as an empty index,
// which would drop every ticket a level and note it, then note it again as a
// rise on the next good build. FACTORY_DATA_DIR points at a fresh temp folder
// BEFORE the imports, so no test ever touches the real data/ folder.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-levels-test-'))
const { DATA_DIR } = await import('../flows.mjs')
const { makeOrchestration } = await import('../orchestration.mjs')
const S = await import('../since-store.mjs')
// The tickets here use the made-up prefixes ABC and XYZ, whatever config.json says.
const { useTicketPrefixes } = await import('../transcripts.mjs')
useTicketPrefixes(['ABC', 'XYZ'])
after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }))

/** Which level ABC-9001 has reached, and which remote's log fails, for the next build. */
const world = { level: 'dev', failing: null }
const REMOTES = { 'origin/main': 'prod', 'origin/stage': 'stage', 'origin/dev': 'dev' }
const RANK = ['dev', 'stage', 'prod']

async function git(args) {
  const ref = args[1]
  if (args[0] !== 'log' || !REMOTES[ref]) return { ok: true, out: '', err: '' }
  if (ref === world.failing) return { ok: false, out: '', err: 'fatal: unable to read' }
  const reached = RANK.indexOf(world.level) >= RANK.indexOf(REMOTES[ref])
  return { ok: true, out: reached ? `abc1234\t2026-11-12\tfix: ABC-9001 thing\x1e` : '', err: '' }
}
const getStatus = async () => ({ tickets: [{ id: 'ABC-9001', title: 'Thing', agents: [] }], agents: [] })
const orchestration = makeOrchestration({ git, getStatus, listWorktrees: async () => [] })
const build = () => orchestration('', true)

test('a build with a failed git read notes no level changes; good builds do', async () => {
  world.level = 'dev'
  world.failing = null
  assert.equal((await build()).tickets['ABC-9001'].level, 'dev')
  assert.equal(S.readLevels()['ABC-9001'], 'dev')

  // origin/dev cannot be read: the ticket reads as no level for this build only.
  world.failing = 'origin/dev'
  assert.equal((await build()).tickets['ABC-9001'].level, null)
  assert.equal(S.readLevels()['ABC-9001'], 'dev', 'the degraded build leaves levels.json alone')
  assert.deepEqual(S.readLevelsPrev(), {}, 'and notes nothing')

  // The next good build sees no change: no false rise either.
  world.failing = null
  await build()
  assert.deepEqual(S.readLevelsPrev(), {})

  // A real move is noted.
  world.level = 'stage'
  await build()
  assert.equal(S.readLevels()['ABC-9001'], 'stage')
  assert.equal(S.readLevelsPrev()['ABC-9001'].level, 'dev')

  // A failed main read is skipped the same way.
  world.failing = 'origin/main'
  world.level = 'prod'
  await build()
  assert.equal(S.readLevels()['ABC-9001'], 'stage')
})

test('a build whose local worktree log failed notes no level drop either', async () => {
  const local = { failing: false }
  const tree = { path: fs.mkdtempSync(path.join(os.tmpdir(), 'wt-local-9002-')), branch: 'feat/thing' }
  async function gitLocal(args, cwd) {
    if (cwd === tree.path) return local.failing ? { ok: false, out: '', err: 'fatal: index.lock' } : { ok: true, out: 'feat: ABC-9002 local only', err: '' }
    return { ok: true, out: '', err: '' }
  }
  const getStatusLocal = async () => ({ tickets: [{ id: 'ABC-9002', title: 'Local', agents: [] }], agents: [] })
  const orch = makeOrchestration({ git: gitLocal, getStatus: getStatusLocal, listWorktrees: async () => [tree] })
  assert.equal((await orch('', true)).tickets['ABC-9002'].level, 'local')
  assert.equal(S.readLevels()['ABC-9002'], 'local')

  local.failing = true
  assert.equal((await orch('', true)).tickets['ABC-9002'].level, null)
  assert.equal(S.readLevels()['ABC-9002'], 'local', 'the degraded build leaves levels.json alone')
  assert.equal(S.readLevelsPrev()['ABC-9002'], undefined, 'and notes no drop')
  fs.rmSync(tree.path, { recursive: true, force: true })
})

test('a worktree whose folder is gone, or marked prunable, is skipped: it never stops the level record', async () => {
  const live = { path: fs.mkdtempSync(path.join(os.tmpdir(), 'wt-live-9003-')), branch: 'feat/live' }
  const gone = { path: path.join(os.tmpdir(), 'wt-gone-9003-does-not-exist'), branch: 'feat/gone-ABC-9004' }
  const pruned = { path: fs.mkdtempSync(path.join(os.tmpdir(), 'wt-pruned-9003-')), branch: 'feat/pruned', prunable: true }
  const asked = []
  async function gitTrees(args, cwd) {
    if (cwd) asked.push(cwd)
    if (cwd === live.path) return { ok: true, out: 'feat: ABC-9003 local only', err: '' }
    if (cwd === gone.path || cwd === pruned.path) return { ok: false, out: '', err: 'spawn git ENOENT' }
    return { ok: true, out: '', err: '' }
  }
  const getStatusTrees = async () => ({ tickets: [{ id: 'ABC-9003', title: 'Live', agents: [] }, { id: 'ABC-9004', title: 'Gone', agents: [] }], agents: [] })
  const orch = makeOrchestration({ git: gitTrees, getStatus: getStatusTrees, listWorktrees: async () => [live, gone, pruned] })
  const built = await orch('', true)
  assert.equal(built.tickets['ABC-9003'].level, 'local')
  assert.equal(S.readLevels()['ABC-9003'], 'local', 'the build counts as good, so its levels are recorded')
  assert.deepEqual(asked.filter(c => c === gone.path || c === pruned.path), [], 'git is never run in a gone or prunable worktree')
  assert.equal(built.tickets['ABC-9004'].level, null, 'a gone worktree branch name is not local work')
  fs.rmSync(live.path, { recursive: true, force: true })
  fs.rmSync(pruned.path, { recursive: true, force: true })
})
