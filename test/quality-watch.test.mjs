// Tests for the server's quality watch (quality-watch.mjs): the risk label of each live flow is worked out again from
// the files its commits touched (a STUB git) only when the flow moved, and written without moving its updatedAt; a
// new failure is turned into lessons on its own only with quality.autoLessons, only when it came after the library
// started, and one at a time; a plan gets its automatic second opinion only with quality.critic auto, once.
// FACTORY_DATA_DIR points at a fresh temp folder BEFORE the imports.

import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-watch-test-'))
const F = await import('../flows.mjs')
const L = await import('../quality-lessons.mjs')
const { makeQualityWatch, filesOf } = await import('../quality-watch.mjs')
after(() => fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true }))

const CONFIG = {
  repo: 'C:/watched/repo', coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1' },
  pipeline: { qa: 'QA', producers: null, protectedBranches: ['dev'], maxReworks: 2 },
}
const withQuality = over => ({ ...CONFIG, quality: { autoLessons: true, critic: 'manual', areas: ['tests', 'ui', 'general'], requireSelfCheck: false, ...over } })

const gitCalls = []
async function git(args) {
  gitCalls.push(args)
  if (args[0] === 'show' && args.at(-1) === 'ab12cd3') return { ok: true, out: 'db/091_clubs.sql\napps/api/src/clubs.ts' }
  return { ok: false, out: '' }
}
const ran = { extract: [], critic: [] }
const extractor = { busy: () => false, extract: async f => (ran.extract.push(f.key), { ok: true, candidates: 0 }) }
const critic = { busy: () => false, run: async id => (ran.critic.push(id), { ok: true }) }

beforeEach(() => {
  fs.rmSync(F.FLOWS_DIR, { recursive: true, force: true })
  fs.rmSync(L.LESSONS_FILE, { force: true })
  gitCalls.length = 0
  ran.extract.length = 0
  ran.critic.length = 0
})

const code = (id = 'clubs', title = 'Rename the clubs tab') => F.writeFlow({
  id, title, agent: 'Agent 1', status: 'open', nodes: [{ id: 'n1', type: 'step', title: 'Change it', status: 'done', evidence: [{ kind: 'commit', ref: 'ab12cd3' }] }],
})

test('filesOf: the files of the commits on the flow, once each, cached by commit', async () => {
  code()
  const flow = F.readFlow('clubs')
  assert.deepEqual(await filesOf(flow, git), ['db/091_clubs.sql', 'apps/api/src/clubs.ts'])
  await filesOf(flow, git)
  assert.equal(gitCalls.length, 1, 'the second read comes from the cache')
  assert.deepEqual(await filesOf({ id: 'x', nodes: [] }, git), [])
})

test('the risk label is worked out from the files and stored, without moving updatedAt; again only when the flow moved', async () => {
  code()
  const before = F.readFlow('clubs').updatedAt
  const w = makeQualityWatch({ extractor, critic, git, config: () => withQuality({}) })
  await w.tick()
  const flow = F.readFlow('clubs')
  assert.equal(flow.risk.level, 'high', 'db/ files: the database rule')
  assert.equal(flow.updatedAt, before)
  const calls = gitCalls.length
  await w.tick()
  assert.equal(gitCalls.length, calls, 'nothing moved: no new work')
})

test('auto lessons: a failure after the library started runs on its own, one per tick; an older one waits for the user', async () => {
  L.writeLessons(L.emptyStore('2026-11-25T10:00:00.000Z'))
  F.writeFlow({ id: 'old', title: 'Old', agent: 'Agent 1', status: 'open', nodes: [], qa: { status: 'failed', attempt: 1, at: '2026-11-24T10:00:00.000Z', summary: 'old' } })
  F.writeFlow({ id: 'new1', title: 'New 1', agent: 'Agent 1', status: 'open', nodes: [], qa: { status: 'failed', attempt: 1, at: '2026-11-25T11:00:00.000Z', summary: 'a' } })
  F.writeFlow({ id: 'new2', title: 'New 2', agent: 'Agent 1', status: 'open', nodes: [], qa: { status: 'failed', attempt: 1, at: '2026-11-25T12:00:00.000Z', summary: 'b' } })
  const w = makeQualityWatch({ extractor, critic, git, config: () => withQuality({}) })
  await w.tick()
  assert.deepEqual(ran.extract, ['new1:qa:1'], 'one run per tick, the oldest first')
})

test('auto lessons off: nothing runs on its own', async () => {
  L.writeLessons(L.emptyStore('2026-11-25T10:00:00.000Z'))
  F.writeFlow({ id: 'new1', title: 'New 1', agent: 'Agent 1', status: 'open', nodes: [], qa: { status: 'failed', attempt: 1, at: '2026-11-25T11:00:00.000Z', summary: 'a' } })
  await makeQualityWatch({ extractor, critic, git, config: () => withQuality({ autoLessons: false }) }).tick()
  assert.deepEqual(ran.extract, [])
})

test('a busy extractor or critic is left alone', async () => {
  L.writeLessons(L.emptyStore('2026-11-25T10:00:00.000Z'))
  F.writeFlow({ id: 'new1', title: 'New 1', agent: 'Agent 1', status: 'open', nodes: [], qa: { status: 'failed', attempt: 1, at: '2026-11-25T11:00:00.000Z', summary: 'a' } })
  await makeQualityWatch({ extractor: { ...extractor, busy: () => true }, critic, git, config: () => withQuality({}) }).tick()
  assert.deepEqual(ran.extract, [])
})

function planned(id) {
  const dir = path.join(F.EVIDENCE_DIR, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'plan-1.md'), '# Plan')
  const at = new Date().toISOString()
  F.writeFlow({ id, title: 'Planned', agent: 'Agent 1', status: 'open', nodes: [], plan: { status: 'handed', by: 'Planner', startedAt: at, at, to: 'Agent 1', file: `${id}/plan-1.md` } })
}

test('auto critic: a handed-out plan gets one run when quality.critic is auto, and none when manual', async () => {
  planned('p1')
  await makeQualityWatch({ extractor, critic, git, config: () => withQuality({ critic: 'manual' }) }).tick()
  assert.deepEqual(ran.critic, [])
  await makeQualityWatch({ extractor, critic, git, config: () => withQuality({ critic: 'auto' }) }).tick()
  assert.deepEqual(ran.critic, ['p1'])
})

test('a tick never throws, and two ticks never overlap', async () => {
  code()
  const slow = { busy: () => false, extract: () => new Promise(r => setTimeout(() => r({ ok: true }), 30)) }
  const w = makeQualityWatch({ extractor: slow, critic, git: async () => { throw new Error('git broke') }, config: () => withQuality({}) })
  const a = w.tick()
  const b = await w.tick()
  assert.equal(b, 'busy')
  await a
})
