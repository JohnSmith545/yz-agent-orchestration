// Tests for the self-checked count beside Correctness (quality-score.mjs, public/quality-score.js): correctness split
// between flows whose producer recorded a self-check and flows with none, each with its right-first-time; under 5
// judged flows on a side it says Too few to trust, never a confident number; GET /api/score carries it; the scorecard
// tile and its How it is counted get it when the page has the quality script. FACTORY_DATA_DIR points at a fresh temp
// folder BEFORE the imports.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-score-test-'))
const F = await import('../flows.mjs')
const { selfCheckSplit, TRUST_MIN } = await import('../quality-score.mjs')
const { scoreGet } = await import('../score-routes.mjs')
const { pipelineGraph } = await import('../pipeline.mjs')
after(() => fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true }))
const HERE = path.dirname(fileURLToPath(import.meta.url))

const CONFIG = { coordinator: 'Master', coordinatorLabel: 'Master', codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1' }, pipeline: { qa: 'QA', producers: null, protectedBranches: ['dev'], maxReworks: 3 } }
const graph = pipelineGraph(CONFIG)
const NOW = Date.parse('2026-11-25T12:00:00.000Z')
const at = '2026-11-24T12:00:00.000Z'
const sc = { at, by: 'Agent 1', items: [{ lesson: 'tests-first', text: 'x', ok: true, note: '' }] }
let n = 0
/** A code flow QA passed: first time, or after one failure. */
function passed({ first = true, checked = false } = {}) {
  const id = `f${++n}`
  return {
    id, title: id, agent: 'Agent 1', status: 'done', updatedAt: at, nodes: [{ id: 'n1', type: 'step', title: 's', status: 'done', evidence: [{ kind: 'commit', ref: 'abc1234' }] }],
    qa: { status: 'passed', attempt: first ? 1 : 2, at, commit: 'abc1234', ...(first ? {} : { attempts: [{ status: 'failed', attempt: 1, at, rework: { to: 'Agent 1' } }] }) },
    ...(checked ? { selfcheck: sc } : {}),
  }
}

test('the split: right first time for flows with a self-check against flows with none', () => {
  const flows = [
    ...Array.from({ length: 5 }, (_, i) => passed({ checked: true, first: i < 4 })),
    ...Array.from({ length: 6 }, (_, i) => passed({ checked: false, first: i < 2 })),
  ]
  const s = selfCheckSplit(flows, graph, { now: NOW, days: 30 })
  assert.deepEqual(s.with, { right: 4, judged: 5, value: 0.8, trust: true })
  assert.deepEqual(s.without, { right: 2, judged: 6, value: 2 / 6, trust: true })
  assert.equal(s.min, TRUST_MIN)
  assert.equal(TRUST_MIN, 5)
})

test('under 5 judged on a side is not to be trusted', () => {
  const s = selfCheckSplit([passed({ checked: true }), passed({ checked: false })], graph, { now: NOW, days: 30 })
  assert.equal(s.with.trust, false)
  assert.equal(s.without.trust, false)
  assert.deepEqual(selfCheckSplit([], graph, { now: NOW, days: 30 }).with, { right: 0, judged: 0, value: null, trust: false })
})

test('GET /api/score carries the split', () => {
  F.writeFlow(passed({ checked: true }))
  const r = scoreGet('30', { config: CONFIG, now: Date.now() })
  assert.equal(r.status, 200)
  assert.ok(r.body.selfCheck)
  assert.equal(r.body.selfCheck.with.judged + r.body.selfCheck.without.judged, r.body.correctness.judged)
})

function loadView() {
  const read = f => fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8')
  const window = { UI: { esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]) } }
  vm.runInNewContext(read('quality-score.js'), { window })
  vm.runInNewContext(read('score-view.js'), { window })
  return window
}

test('the page words: a number only when there are 5 on a side, else Too few to trust', () => {
  const { QualityScore } = loadView()
  assert.equal(QualityScore.line({ with: { right: 4, judged: 5, value: 0.8, trust: true }, without: { right: 2, judged: 6, value: 1 / 3, trust: true } }),
    'Self-checked: 80% right first time (4 of 5). Not self-checked: 33% (2 of 6).')
  assert.equal(QualityScore.line({ with: { right: 1, judged: 2, value: 0.5, trust: false }, without: { right: 2, judged: 6, value: 1 / 3, trust: true } }),
    'Self-checked: Too few to trust (2). Not self-checked: 33% (2 of 6).')
  assert.equal(QualityScore.line(undefined), '')
})

test('the Correctness tile and How it is counted carry it when the quality script is on the page', () => {
  const w = loadView()
  const score = {
    precision: { value: 1, top: 1, bottom: 1 }, recall: { value: 1, top: 1, bottom: 1 }, accuracy: { value: 1, top: 1, bottom: 1 }, f: { 1: { value: 1 }, 4: { value: 1 } },
    correctness: { value: 0.5, right: 1, judged: 2 }, counts: {}, gates: { security: false, senior: false },
    selfCheck: { with: { right: 1, judged: 1, value: 1, trust: false }, without: { right: 0, judged: 1, value: 0, trust: false }, min: 5 },
  }
  const tile = w.ScoreView.tiles(score, 1).find(t => t.key === 'correctness')
  assert.match(tile.meaning, /^How often the work was right the first time\. Self-checked: Too few to trust \(1\)\./)
  assert.match(w.ScoreView.howHtml(score), /Self-checked splits correctness/)
  const plain = w.ScoreView.tiles({ ...score, selfCheck: undefined }, 1).find(t => t.key === 'correctness')
  assert.equal(plain.meaning, 'How often the work was right the first time.')
})
