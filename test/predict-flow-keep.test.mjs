// Tests for the flow's `estimate` in the flow store (flows.mjs, through predict-keep.mjs): it is the SERVER'S, like
// archivedAt is the user's. A `flow write` keeps the stored one and can neither add, change nor drop it; the store
// refuses a malformed one; the server's own write keeps the flow's updatedAt so the scorecard does not move.
// FACTORY_DATA_DIR points at a fresh temp folder BEFORE the imports.

import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'predict-keep-test-'))
const F = await import('../flows.mjs')
const { runFlow } = await import('../tools/flow-cli.mjs')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'predict-keep-files-'))
after(() => {
  fs.rmSync(F.DATA_DIR, { recursive: true, force: true })
  fs.rmSync(TMP, { recursive: true, force: true })
})

const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'dark-mode.json'), 'utf8'))
function fx(id, edit = () => {}) {
  const f = structuredClone(FIXTURE)
  f.id = id
  for (const r of f.output.result) r.ref = r.ref.replace('dark-mode/', `${id}/`)
  for (const t of f.output.testing) t.shot = t.shot.replace('dark-mode/', `${id}/`)
  edit(f)
  return f
}
const EST = { at: '2026-11-25T09:00:00.000Z', minutes: 70, usd: 40, tokens: 12_000_000, basedOn: ['a', 'b', 'c'], spread: { minutes: [40, 120], usd: [10, 90], tokens: [1e6, 3e7] } }

beforeEach(() => fs.rmSync(F.FLOWS_DIR, { recursive: true, force: true }))

test('an agent rewrite keeps the stored estimate, and one it sends of its own is ignored', () => {
  F.writeFlow(fx('dark', f => { f.estimate = EST }))
  const file = path.join(TMP, 'dark.json')
  fs.writeFileSync(file, JSON.stringify(fx('dark', f => { f.estimate = { ...EST, minutes: 1 } })))
  assert.equal(runFlow(['write', file], { by: 'Agent 3', cwd: TMP }).code, 0)
  assert.deepEqual(F.readFlow('dark').estimate, EST)
  fs.writeFileSync(file, JSON.stringify(fx('dark')))
  assert.equal(runFlow(['write', file], { by: 'Agent 3', cwd: TMP }).code, 0)
  assert.deepEqual(F.readFlow('dark').estimate, EST, 'leaving it out does not drop it')
  fs.writeFileSync(path.join(TMP, 'other.json'), JSON.stringify(fx('other', f => Object.assign(f, { estimate: EST, route: { type: 'ask' } }))))
  assert.equal(runFlow(['write', path.join(TMP, 'other.json')], { by: 'Agent 3', cwd: TMP }).code, 0)
  assert.equal('estimate' in F.readFlow('other'), false, 'an agent cannot add one')
})

test('the store refuses a malformed estimate, one problem per line', () => {
  assert.throws(() => F.writeFlow(fx('dark', f => { f.estimate = { ...EST, minutes: -5 } })), /estimate minutes/)
  assert.deepEqual(F.validateFlow(fx('dark', f => { f.estimate = EST })), [])
})

test('the server s own write of an estimate keeps the flow s updatedAt (stamp false)', () => {
  const f = F.writeFlow(fx('dark'))
  const before = F.readFlow('dark').updatedAt
  F.writeFlow({ ...F.readFlow('dark'), estimate: EST }, { stamp: false })
  assert.equal(F.readFlow('dark').updatedAt, before)
  assert.ok(f)
})
