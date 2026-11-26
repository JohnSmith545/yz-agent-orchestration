// Tests for the quality commands (tools/quality-cli.mjs, behind `node tools/factory.mjs flow …`): the self-check
// (`flow self-check <flow>` prints the checklist, `--done "<id>=ok|no:<note>"` records it, a `no` needs a note, every
// item needs an answer), QA seeing it at `flow qa-start`, the pipeline.requireSelfCheck switch, the lessons printed
// after the rules at `flow new`, `flow rules` and the planner's hand-out (each with its area and why), the risk label
// stored on a new flow and printed to QA (with the deeper QA line), and that a producer's `flow write` can neither
// drop nor forge the selfcheck, critic or risk blocks. FACTORY_DATA_DIR points at a fresh temp folder BEFORE the imports.

import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-cli-test-'))
const F = await import('../flows.mjs')
const { runFlow } = await import('../tools/flow-cli.mjs')
const L = await import('../quality-lessons.mjs')
const { CORE_CHECKS } = await import('../quality-selfcheck.mjs')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-cli-files-'))
after(() => {
  fs.rmSync(F.DATA_DIR, { recursive: true, force: true })
  fs.rmSync(TMP, { recursive: true, force: true })
})

const CONFIG = {
  repo: 'C:/watched/repo',
  coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', Planner: 'Planner' },
  pipeline: { qa: 'QA', producers: null, protectedBranches: ['dev'], maxReworks: 2, planner: 'Planner' },
}
const REQUIRE = { ...CONFIG, pipeline: { ...CONFIG.pipeline, requireSelfCheck: true } }
const run = (by, argv, config = CONFIG) => runFlow(argv, { by, cwd: TMP, config })
const read = id => F.readFlow(id)
const SHA = 'ab12cd3'

function seedLessons() {
  const s = L.emptyStore()
  const add = (text, area, count) => (L.addLesson(s, { text, area, by: 'you' }).lesson.count = count)
  add('Look at the page in the dark theme.', 'ui', 3)
  add('Write the failing test first.', 'tests', 5)
  add('Name the flow in every message.', 'general', 2)
  L.writeLessons(s)
}

beforeEach(() => {
  fs.rmSync(F.FLOWS_DIR, { recursive: true, force: true })
  fs.rmSync(F.EVIDENCE_DIR, { recursive: true, force: true })
  fs.rmSync(L.LESSONS_FILE, { force: true })
  seedLessons()
})

/** A build flow Agent 1 made a code change on (a commit in its summary). */
function codeFlow(id = 'dark-page', title = 'Fix the settings page in the dark theme') {
  assert.equal(run('Agent 1', ['new', id, title, '--type', 'build']).code, 0)
  assert.equal(run('Agent 1', ['summary', id, 'Fixed it.', '--commit', SHA]).code, 0)
  return id
}
const allOk = id => [...CORE_CHECKS.map(c => c.id), ...checklistIds(id).filter(x => /^L\d+$/.test(x))].flatMap(x => ['--done', `${x}=ok`])
function checklistIds(id) {
  const out = run('Agent 1', ['self-check', id]).out
  return [...out.matchAll(/^ {2}(\S+) {2,}/gm)].map(m => m[1])
}

test('flow new prints the matching lessons after the rules, each with its area and why, and stores the risk', () => {
  const r = run('Agent 1', ['new', 'dark-page', 'Fix the login page in the dark theme', '--type', 'build'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /^Flow dark-page created/)
  assert.match(r.out, /Lessons from earlier work/)
  assert.match(r.out, /1\. Look at the page in the dark theme\. \(ui: the task names "page"; seen 3 times\) \[L1\]/)
  assert.match(r.out, /Name the flow in every message\. \(general: fits any task; seen 2 times\)/)
  assert.doesNotMatch(r.out, /Write the failing test first/, 'tests is not an area of this task')
  const risk = read('dark-page').risk
  assert.equal(risk.level, 'high')
  assert.ok(risk.reasons.includes('It touches sign-in or sessions.'))
})

test('a refused flow new prints no lessons', () => {
  const r = run('Agent 1', ['new', 'x', 'No type'])
  assert.equal(r.code, 1)
  assert.doesNotMatch(r.out, /Lessons/)
})

test('flow rules <flow> prints the lessons for that flow; with no flow, for the agent newest open flow', () => {
  codeFlow()
  const one = run('Agent 1', ['rules', 'dark-page'])
  assert.equal(one.code, 0)
  assert.match(one.out, /Lessons from earlier work/)
  assert.match(one.out, /Look at the page in the dark theme/)
  const newest = run('Agent 1', ['rules'])
  assert.match(newest.out, /Look at the page in the dark theme/)
  const nobody = run('Master', ['rules'])
  assert.match(nobody.out, /Name the flow in every message/, 'no open flow of its own: the general lessons')
  assert.doesNotMatch(nobody.out, /dark theme/)
})

test('flow self-check prints the checklist: the core rules, then this flow lessons, with how to answer', () => {
  codeFlow()
  const r = run('Agent 1', ['self-check', 'dark-page'])
  assert.equal(r.code, 0, r.out)
  for (const c of CORE_CHECKS.filter(c => c.id !== 'screens')) assert.match(r.out, new RegExp(`^  ${c.id} {2,}`, 'm'))
  assert.match(r.out, /^ {2}screens {2,}/m, 'UI work: the screenshots line is there')
  assert.match(r.out, /^ {2}L1 {2,}Look at the page in the dark theme\./m)
  assert.match(r.out, /one --done each: "<id>=ok" when it is true/)
  assert.match(r.out, /no:<what is missing>/)
  assert.doesNotMatch(r.out, /--done "checks-run=ok"/, 'no ready-made all-ok line to copy without checking')
})

test('the screenshots line is left out of a task with no screen', () => {
  run('Agent 1', ['new', 'job', 'Speed up the nightly export job', '--type', 'build'])
  assert.doesNotMatch(run('Agent 1', ['self-check', 'job']).out, /^ {2}screens /m)
})

test('flow self-check --done records every answer; a no needs a note; every item needs an answer; an unknown id is refused', () => {
  const id = codeFlow()
  const ids = checklistIds(id)
  const answers = ids.map((x, i) => (i === 1 ? `${x}=no:the suite takes 20 minutes, ran the area only` : `${x}=ok`))
  const missing = run('Agent 1', ['self-check', id, '--done', `${ids[0]}=ok`])
  assert.equal(missing.code, 1)
  assert.match(missing.out, /Answer every item/)
  const noNote = run('Agent 1', ['self-check', id, ...ids.flatMap(x => ['--done', `${x}=no`])])
  assert.equal(noNote.code, 1)
  assert.match(noNote.out, /needs a note/)
  const unknown = run('Agent 1', ['self-check', id, ...ids.flatMap(x => ['--done', `${x}=ok`]), '--done', 'made-up=ok'])
  assert.equal(unknown.code, 1)
  assert.match(unknown.out, /made-up is not on this checklist/)
  const bad = run('Agent 1', ['self-check', id, '--done', 'tests-first=maybe'])
  assert.equal(bad.code, 1)
  assert.match(bad.out, /<id>=ok or <id>=no:<note>/)
  assert.equal(read(id).selfcheck, undefined, 'nothing recorded by a refusal')
  const r = run('Agent 1', ['self-check', id, ...answers.flatMap(a => ['--done', a])])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /self-check recorded/)
  const sc = read(id).selfcheck
  assert.equal(sc.by, 'Agent 1')
  assert.ok(sc.at)
  assert.equal(sc.items.length, ids.length)
  assert.deepEqual(sc.items[1], { lesson: ids[1], text: sc.items[1].text, ok: false, note: 'the suite takes 20 minutes, ran the area only' })
  assert.equal(sc.items[0].ok, true)
  assert.equal(run('Agent 1', ['self-check', id, '--done']).code, 1)
  assert.match(run(undefined, ['self-check', id]).out, /--by/)
})

test('flow qa-start prints the producer self-check for QA to test the claims, and the risk', () => {
  const id = codeFlow()
  run('Agent 1', ['self-check', id, ...checklistIds(id).map((x, i) => (i === 0 ? `${x}=no:wrote it after` : `${x}=ok`)).flatMap(a => ['--done', a])])
  const r = run('QA', ['qa-start', id])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /QA attempt 1 testing/)
  assert.match(r.out, /Self-check by Agent 1/)
  assert.match(r.out, /no: .*wrote it after/)
  assert.doesNotMatch(r.out, /Risk: low/, 'a harmless task prints no risk line, as the page shows none (QA, 2026-11-26)')
  assert.doesNotMatch(r.out, /\n\s*$/, 'and leaves no blank line at the end')
})

test('flow qa-start with no self-check says so; a deep-qa label adds one line for QA', () => {
  const id = codeFlow('login', 'Fix the login session timeout')
  const r = run('QA', ['qa-start', id])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /No self-check was recorded/)
  assert.match(r.out, /Risk: high/)
  assert.match(r.out, /deeper QA pass: /)
})

test('pipeline.requireSelfCheck: QA cannot start a code flow with no self-check, one plain sentence; with one it can', () => {
  const id = codeFlow()
  const refused = run('QA', ['qa-start', id], REQUIRE)
  assert.equal(refused.code, 1)
  assert.match(refused.out, /^dark-page has no self-check yet: Agent 1 runs flow self-check dark-page before handing it to QA\.$/)
  assert.equal(read(id).qa, undefined)
  run('Agent 1', ['self-check', id, ...allOk(id)])
  assert.equal(run('QA', ['qa-start', id], REQUIRE).code, 0)
})

test('pipeline.requireSelfCheck leaves a flow with no code change alone, and is off by default', () => {
  run('Agent 1', ['new', 'question', 'Why is the build slow', '--type', 'ask'])
  assert.equal(run('QA', ['qa-start', 'question'], REQUIRE).code, 0)
  const id = codeFlow()
  assert.equal(run('QA', ['qa-start', id]).code, 0, 'off by default')
})

test('the planner hand-out prints the lessons for the plan, files named in the plan included', () => {
  assert.equal(run('Master', ['new', 'plan-me', 'Speed up the export', '--type', 'build']).code, 0)
  run('Planner', ['plan-start', 'plan-me'])
  fs.writeFileSync(path.join(TMP, 'plan.md'), '# Plan\n1. Change public/export.css and add test/export.test.mjs first.\n')
  const r = run('Planner', ['plan', 'plan-me', '--file', 'plan.md', '--to', 'Agent 1'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /handed to Agent 1 with the plan/)
  assert.match(r.out, /Lessons from earlier work/)
  assert.match(r.out, /Write the failing test first\. \(tests: it touches test\/export\.test\.mjs/)
  assert.match(r.out, /Look at the page in the dark theme\. \(ui: it touches public\/export\.css/)
})

test('a producer flow write can neither drop nor forge the selfcheck, critic or risk blocks', () => {
  const id = codeFlow()
  run('Agent 1', ['self-check', id, ...allOk(id)])
  const stored = read(id)
  const file = path.join(TMP, 'f.json')
  const { selfcheck, risk, ...rest } = stored
  fs.writeFileSync(file, JSON.stringify({ ...rest, critic: { at: stored.updatedAt, verdict: 'ok', points: [], cost: 0 } }))
  assert.equal(run('Agent 1', ['write', file]).code, 0)
  const after1 = read(id)
  assert.deepEqual(after1.selfcheck, selfcheck)
  assert.deepEqual(after1.risk, risk)
  assert.equal(after1.critic, undefined, 'a forged critic is dropped')
})

test('a bad selfcheck, critic or risk block is a validation problem', () => {
  const id = codeFlow()
  const f = read(id)
  assert.match(F.validateFlow({ ...f, selfcheck: { at: 'x', by: 'Agent 1', items: 'no' } }).join('\n'), /selfcheck/)
  assert.match(F.validateFlow({ ...f, critic: { at: f.updatedAt, verdict: 'great', points: [] } }).join('\n'), /critic verdict/)
  assert.match(F.validateFlow({ ...f, critic: { at: f.updatedAt, verdict: 'ok', points: ['a', 'b', 'c', 'd', 'e', 'f'] } }).join('\n'), /at most 5/)
  assert.match(F.validateFlow({ ...f, risk: { level: 'huge', reasons: [], needs: [] } }).join('\n'), /risk level/)
  assert.deepEqual(F.validateFlow(f), [])
})
