// Tests for flow-qa.mjs, the data half of QA: the shape of a flow's `qa` block (validated on every write
// through flows.mjs validateFlow), that it is QA's alone (a `flow write` rewrite never drops or forges it,
// mergeKeepingAnswers), and the two Send blockers (qaBlockers). FACTORY_DATA_DIR points at a fresh temp
// folder BEFORE the imports, so no test touches the real data/ folder.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-qa-test-'))
const F = await import('../flows.mjs')
const Q = await import('../flow-qa.mjs')
after(() => fs.rmSync(F.DATA_DIR, { recursive: true, force: true }))

const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'no-visual.json'), 'utf8'))
const ID = FIXTURE.id
const SHA = 'abcdef1234567890abcdef1234567890abcdef12'
/** A full passed block, every field filled. */
const passed = () => ({
  status: 'passed', attempt: 2, by: 'QA', startedAt: '2026-11-20T09:00:00Z', at: '2026-11-20T10:00:00Z', commit: SHA,
  report: `${ID}/qa-2-report.md`, shots: [`${ID}/qa-2-home.png`],
  steps: [{ do: 'Open Home.', expect: 'The new card shows.', shot: `${ID}/qa-2-step-home.png` }, { do: 'Reload.', expect: 'It is still there.' }],
  summary: 'All 1299 tests pass; the card shows in light and dark.', branch: 'feature/card', remote: 'origin', repo: 'C:/repo',
  pushedAt: '2026-11-20T10:05:00Z', pushError: null, rework: null,
  attempts: [{ status: 'failed', attempt: 1, by: 'QA', at: '2026-11-19T10:00:00Z', commit: 'abc1234', report: `${ID}/qa-1-report.md`, summary: 'The card is missing in dark mode.', rework: { to: 'Agent 3', queuedAt: '2026-11-19T10:00:05Z', sentAt: '2026-11-19T10:00:40Z', error: null } }],
})
const withQa = qa => ({ ...structuredClone(FIXTURE), qa })
const problems = qa => F.validateFlow(withQa(qa))

// ═══ the shape ═══

test('a full qa block is valid, and so is one just started', () => {
  assert.deepEqual(problems(passed()), [])
  assert.deepEqual(problems({ status: 'testing', attempt: 1, by: 'QA', at: '2026-11-20T09:00:00Z' }), [])
  assert.deepEqual(F.validateFlow(structuredClone(FIXTURE)), [], 'no qa block at all is fine')
})

test('each bad field is one plain problem line', () => {
  const bad = (edit, re) => {
    const q = passed()
    edit(q)
    const p = problems(q)
    assert.equal(p.length, 1, p.join('\n'))
    assert.match(p[0], re)
  }
  bad(q => (q.status = 'great'), /qa status must be one of pending, testing, passed, failed, qa-failed/)
  bad(q => (q.attempt = 0), /qa attempt must be a whole number from 1/)
  bad(q => (q.by = 'bad"name'), /qa by must be a label/)
  bad(q => (q.at = 'yesterday'), /qa at must be a time/)
  bad(q => (q.commit = 'HEAD'), /qa commit must be a commit sha/)
  bad(q => (q.report = 'other/qa-2-report.md'), /qa report must be no-visual\/<file>\.md or \.txt/)
  bad(q => (q.report = `${ID}/qa-2-report.html`), /qa report must be no-visual\/<file>\.md or \.txt/)
  bad(q => (q.shots = [`${ID}/../x.png`]), /qa shots #1 must be no-visual\/<file name>/)
  bad(q => (q.steps = [{ do: '', expect: 'x' }]), /qa steps #1 do must be non-empty text of at most 500/)
  bad(q => (q.steps = [{ do: 'x', expect: 'y'.repeat(501) }]), /qa steps #1 expect must be non-empty text of at most 500/)
  bad(q => (q.summary = 'x'.repeat(1001)), /qa summary must be text of at most 1000/)
  bad(q => (q.branch = '--force'), /qa branch must be a branch name/)
  bad(q => (q.remote = 'a b'), /qa remote must be a remote name/)
  bad(q => (q.pushError = 'x'.repeat(301)), /qa pushError must be null or text of at most 300/)
  bad(q => (q.rework = { to: '' }), /qa rework to must be a label/)
  bad(q => (q.rework = { to: 'Agent 3', error: 7 }), /qa rework error must be null or text of at most 300/)
  bad(q => (q.attempts[0].attempts = []), /qa attempts #1 must not hold attempts of its own/)
  bad(q => (q.attempts[0].status = 'nope'), /qa attempts #1 status must be one of/)
  bad(q => (q.steps = Array.from({ length: 31 }, () => ({ do: 'a', expect: 'b' }))), /qa steps has 31, at most 30/)
  assert.deepEqual(problems('passed'), ['qa must be a JSON object'])
})

// ═══ QA's alone ═══

test('a flow write keeps the stored qa block whole and drops a forged one', () => {
  const stored = withQa(passed())
  const incoming = structuredClone(FIXTURE)
  assert.deepEqual(F.mergeKeepingAnswers(incoming, stored).qa, passed(), 'left out: the stored one stays')
  const forged = { ...structuredClone(FIXTURE), qa: { status: 'passed', attempt: 1, by: 'QA', at: '2026-11-20T10:00:00Z', commit: SHA } }
  assert.equal(F.mergeKeepingAnswers(forged, structuredClone(FIXTURE)).qa, undefined, 'none stored: an agent cannot add one')
  const changed = { ...structuredClone(FIXTURE), qa: { ...passed(), status: 'failed' } }
  assert.deepEqual(F.mergeKeepingAnswers(changed, stored).qa, passed(), 'stored: an agent cannot change it')
})

// ═══ the Send blockers ═══

const code = { output: { merge: { head: 'feature/card', base: 'dev', title: 'A card', body: '' } } }

test('qaBlockers: a code change QA has not passed is blocked; one QA passed at the head sent is not', () => {
  assert.deepEqual(Q.qaBlockers({ ...structuredClone(FIXTURE), ...code }, SHA).map(b => b.slice(0, 19)), ['QA has not passed: '])
  assert.match(Q.qaBlockers({ ...withQa({ status: 'testing', attempt: 1, by: 'QA', at: 'x' }), ...code }, SHA)[0], /^QA has not passed: QA is testing it/)
  assert.deepEqual(Q.qaBlockers({ ...withQa(passed()), ...code }, SHA), [])
  assert.deepEqual(Q.qaBlockers({ ...withQa({ ...passed(), commit: SHA.slice(0, 7) }), ...code }, SHA), [], 'a short sha QA tested matches the full head')
  assert.deepEqual(Q.qaBlockers({ ...withQa({ ...passed(), commit: SHA.slice(0, 7).toUpperCase() }), ...code }, SHA), [], 'case does not matter')
})

test('qaBlockers: QA passed a different commit than the head being sent', () => {
  const b = Q.qaBlockers({ ...withQa({ ...passed(), commit: '1234567' }), ...code }, SHA)
  assert.equal(b.length, 1)
  assert.match(b[0], /^QA tested a different commit \(1234567\) than the head being sent \(abcdef1\)/)
  assert.deepEqual(Q.qaBlockers({ ...withQa(passed()), ...code }, null), [], 'no head yet: the branch blocker already says so')
})

test('qaBlockers: a flow that changed no code needs no QA', () => {
  const plain = structuredClone(FIXTURE)
  for (const n of plain.nodes) n.evidence = (n.evidence || []).filter(e => e.kind !== 'commit')
  assert.deepEqual(Q.qaBlockers(plain, SHA), [])
})

test('qaView: the qa block for a page, its attempts slimmed to the outline', () => {
  const v = Q.qaView(passed())
  assert.equal(v.status, 'passed')
  assert.deepEqual(v.attempts, [{ attempt: 1, status: 'failed', at: '2026-11-19T10:00:00Z', commit: 'abc1234', summary: 'The card is missing in dark mode.', report: `${ID}/qa-1-report.md` }])
  assert.equal(Q.qaView(undefined), null)
})
