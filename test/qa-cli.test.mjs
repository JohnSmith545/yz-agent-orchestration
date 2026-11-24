// Tests for the QA commands (tools/qa-cli.mjs, behind `node tools/factory.mjs flow qa-start | qa | qa-push`):
// only the configured QA label may run them; a result copies the report and screenshots into the flow's
// evidence folder; PASSED marks the flow done, FAILED sends it back to its producer or stops it; qa-push
// pushes exactly the tested commit, never forced, never to a protected branch. The git runner is a STUB
// passed in the context, so no test touches a real repository or remote. FACTORY_DATA_DIR points at a
// fresh temp folder BEFORE the imports.

import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cli-test-'))
const F = await import('../flows.mjs')
const { runFlow } = await import('../tools/flow-cli.mjs')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cli-files-'))
after(() => {
  fs.rmSync(F.DATA_DIR, { recursive: true, force: true })
  fs.rmSync(TMP, { recursive: true, force: true })
})

const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'no-visual.json'), 'utf8'))
const ID = FIXTURE.id // agent Agent 3, a commit in its evidence: code producing
const SHA = 'cd34ef5000000000000000000000000000000000'
/** A config of our own, so the user's config.json never changes what these tests see. */
const CONFIG = {
  repo: 'C:/watched/repo',
  coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', 'Agent 3': 'Agent 3', tester: 'QA' },
  pipeline: { qa: 'QA', producers: null, protectedBranches: ['dev', 'stage', 'main', 'master'], maxReworks: 2 },
  pr: { remote: 'origin', bases: ['dev'], protect: ['main', 'master', 'stage', 'prod', 'production', 'release/*', 'release-*'] },
}

/** The stub git: every call recorded; rev-parse knows SHA's start; push succeeds unless told otherwise. */
const calls = []
let gitOver = {}
async function git(args, opts) {
  calls.push({ args, opts })
  const verb = args[2] // ['-C', repo, verb, …]
  if (gitOver[verb]) return gitOver[verb](args)
  if (verb === 'rev-parse') return SHA.startsWith(String(args.at(-1)).replace('^{commit}', '').toLowerCase()) ? { ok: true, out: SHA, err: '' } : { ok: false, out: '', err: '' }
  if (verb === 'push') return { ok: true, out: '', err: '' }
  if (verb === 'config') return { ok: false, out: '', err: '' }
  return { ok: false, out: '', err: 'unexpected' }
}
const ctx = (by = 'QA') => ({ by, cwd: TMP, git, config: CONFIG })
const run = (...argv) => runFlow(argv, ctx())
const runAs = (by, ...argv) => runFlow(argv, ctx(by))
const file = (name, text = 'x') => (fs.writeFileSync(path.join(TMP, name), text), name)
const qa = () => F.readFlow(ID).qa

beforeEach(() => {
  calls.length = 0
  gitOver = {}
  fs.mkdirSync(F.FLOWS_DIR, { recursive: true })
  fs.rmSync(path.join(F.EVIDENCE_DIR, ID), { recursive: true, force: true })
  fs.writeFileSync(path.join(F.FLOWS_DIR, `${ID}.json`), JSON.stringify(FIXTURE))
  file('report.md', '# QA\n\nAll good.')
  file('home.png', 'png')
  file('step.png', 'png')
})

// ═══ who may run them ═══

test('only the configured QA label runs the QA commands: anyone else is refused in one line, exit 1, nothing written', async () => {
  for (const argv of [['qa-start', ID], ['qa', ID, '--status', 'passed', '--report', 'report.md', '--commit', SHA], ['qa-push', ID, '--branch', 'feature/x']]) {
    const r = await runAs('Agent 3', ...argv)
    assert.equal(r.code, 1, argv[0])
    assert.match(r.out, /^Only QA records QA: --by must be "QA" \(config pipeline\.qa\), not "Agent 3"\.$/)
    const none = await runAs('', ...argv)
    assert.equal(none.code, 1)
    assert.match(none.out, /--by/)
  }
  assert.equal(qa(), undefined)
  assert.equal(calls.length, 0)
})

// ═══ qa-start ═══

test('qa-start: testing, attempt 1, by QA, with the commit; a second start before a result keeps the attempt', async () => {
  const r = await run('qa-start', ID, '--commit', 'cd34ef5')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /attempt 1/)
  const q = qa()
  assert.equal(q.status, 'testing')
  assert.equal(q.attempt, 1)
  assert.equal(q.by, 'QA')
  assert.equal(q.commit, 'cd34ef5')
  assert.ok(q.startedAt && q.at)
  assert.equal((await run('qa-start', ID, '--status', 'pending')).code, 0)
  assert.equal(qa().attempt, 1, 'no result yet: the same attempt')
  assert.equal(qa().status, 'pending')
  assert.equal((await run('qa-start', ID, '--status', 'done')).code, 1)
  assert.equal((await run('qa-start', ID, '--commit', 'HEAD')).code, 1)
})

test('qa-start after a result begins attempt n+1 and moves the last one into attempts', async () => {
  await run('qa', ID, '--status', 'failed', '--report', 'report.md', '--commit', SHA, '--summary', 'The card is missing.')
  assert.equal((await run('qa-start', ID)).code, 0)
  const q = qa()
  assert.equal(q.attempt, 2)
  assert.equal(q.status, 'testing')
  assert.equal(q.attempts.length, 1)
  assert.equal(q.attempts[0].status, 'failed')
  assert.equal(q.attempts[0].summary, 'The card is missing.')
  assert.equal(q.attempts[0].attempts, undefined)
})

test('qa-start refuses a dropped flow; on a done or blocked flow it opens it again', async () => {
  const f = F.readFlow(ID)
  f.status = 'dropped'
  F.writeFlow(f)
  assert.match((await run('qa-start', ID)).out, /dropped/)
  f.status = 'blocked'
  F.writeFlow(f)
  await run('qa-start', ID)
  assert.equal(F.readFlow(ID).status, 'open')
})

// ═══ qa: the result ═══

test('qa passed: the report and shots copied into the evidence folder, the steps, the commit; the flow is done', async () => {
  await run('qa-start', ID)
  const r = await run('qa', ID, '--status', 'passed', '--report', 'report.md', '--shot', 'home.png', '--shot', 'step.png',
    '--step', 'Open Home.', '--expect', 'The card shows.', '--step-shot', 'step.png', '--step', 'Reload.', '--expect', 'Still there.',
    '--commit', SHA, '--summary', 'All tests pass.')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /passed attempt 1/)
  assert.match(r.out, /flow qa-push/)
  const q = qa()
  assert.equal(q.status, 'passed')
  assert.equal(q.report, `${ID}/qa-1-report.md`)
  assert.deepEqual(q.shots, [`${ID}/qa-1-home.png`, `${ID}/qa-1-step.png`])
  assert.deepEqual(q.steps, [{ do: 'Open Home.', expect: 'The card shows.', shot: `${ID}/qa-1-step1-step.png` }, { do: 'Reload.', expect: 'Still there.' }])
  assert.equal(q.commit, SHA)
  assert.equal(q.summary, 'All tests pass.')
  assert.equal(q.rework, null)
  for (const ref of [q.report, ...q.shots, q.steps[0].shot]) assert.ok(fs.existsSync(path.join(F.EVIDENCE_DIR, ref)), ref)
  assert.equal(fs.readFileSync(path.join(F.EVIDENCE_DIR, q.report), 'utf8'), '# QA\n\nAll good.')
  assert.equal(F.readFlow(ID).status, 'done')
})

test('qa with no qa-start records attempt 1 all the same', async () => {
  assert.equal((await run('qa', ID, '--status', 'passed', '--report', 'report.md', '--commit', SHA)).code, 0)
  assert.equal(qa().attempt, 1)
})

test('qa refuses a missing status, report or commit, an HTML report, a step with no expect, and writes nothing', async () => {
  file('report.html', '<script>alert(1)</script>')
  const cases = [
    [['--report', 'report.md', '--commit', SHA], /--status passed\|failed/],
    [['--status', 'great', '--report', 'report.md', '--commit', SHA], /--status passed\|failed/],
    [['--status', 'passed', '--commit', SHA], /--report/],
    [['--status', 'passed', '--report', 'report.md'], /--commit/],
    [['--status', 'passed', '--report', 'report.md', '--commit', 'nope'], /--commit nope is not a commit sha/],
    [['--status', 'passed', '--report', 'report.html', '--commit', SHA], /a QA report must be an existing \.md or \.txt file/],
    [['--status', 'passed', '--report', 'missing.md', '--commit', SHA], /a QA report must be an existing \.md or \.txt file/],
    [['--status', 'passed', '--report', 'report.md', '--commit', SHA, '--step', 'Open it.'], /step 1 needs --expect/],
    [['--status', 'passed', '--report', 'report.md', '--commit', SHA, '--expect', 'x'], /--expect needs a --step before it/],
    [['--status', 'passed', '--report', 'report.md', '--commit', SHA, '--shot', 'report.md'], /a shot must be/],
  ]
  for (const [argv, re] of cases) {
    const r = await run('qa', ID, ...argv)
    assert.equal(r.code, 1, argv.join(' '))
    assert.match(r.out, re)
  }
  assert.equal(qa(), undefined)
  assert.equal(fs.existsSync(path.join(F.EVIDENCE_DIR, ID)), false, 'no stray copy')
})

test('qa failed: rework goes to the flow agent, a producer, with nothing sent yet; the flow stays open', async () => {
  const r = await run('qa', ID, '--status', 'failed', '--report', 'report.md', '--commit', SHA, '--summary', 'The card is missing in dark mode.')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /goes back to Agent 3/)
  assert.deepEqual(qa().rework, { to: 'Agent 3', queuedAt: null, sentAt: null, error: null })
  assert.equal(F.readFlow(ID).status, 'open')
})

test('qa failed more than maxReworks times: qa-failed, the flow blocked, nothing to send', async () => {
  for (let i = 1; i <= 2; i++) {
    await run('qa-start', ID)
    await run('qa', ID, '--status', 'failed', '--report', 'report.md', '--commit', SHA)
    assert.equal(qa().status, 'failed', `failure ${i} goes back`)
  }
  await run('qa-start', ID)
  const r = await run('qa', ID, '--status', 'failed', '--report', 'report.md', '--commit', SHA)
  assert.match(r.out, /stopped after 2 reworks/)
  const q = qa()
  assert.equal(q.status, 'qa-failed')
  assert.equal(q.attempt, 3)
  assert.equal(q.rework, null)
  assert.equal(F.readFlow(ID).status, 'blocked')
})

test('qa failed on a flow whose agent is not a producer stops at once', async () => {
  const f = F.readFlow(ID)
  f.agent = 'Master'
  F.writeFlow(f)
  const r = await run('qa', ID, '--status', 'failed', '--report', 'report.md', '--commit', SHA)
  assert.match(r.out, /Master is not a producer/)
  assert.equal(qa().status, 'qa-failed')
  assert.equal(F.readFlow(ID).status, 'blocked')
})

test('a flow write by the producer keeps the QA record whole', async () => {
  await run('qa', ID, '--status', 'failed', '--report', 'report.md', '--commit', SHA)
  const before = qa()
  const mine = { ...structuredClone(FIXTURE), qa: { status: 'passed', attempt: 1, by: 'QA', at: '2026-11-20T10:00:00Z', commit: SHA } }
  fs.writeFileSync(path.join(TMP, 'mine.json'), JSON.stringify(mine))
  assert.equal(runFlow(['write', 'mine.json'], { by: 'Agent 3', cwd: TMP }).code, 0)
  assert.deepEqual(qa(), before)
})

test('flow show says where QA stands', async () => {
  await run('qa', ID, '--status', 'failed', '--report', 'report.md', '--commit', SHA)
  assert.match(runFlow(['show', ID], { by: 'QA', cwd: TMP }).err, /\n {2}qa: failed, attempt 1 at cd34ef5, back to Agent 3 \(not sent yet\)/)
})

// ═══ qa-push ═══

const pass = () => run('qa', ID, '--status', 'passed', '--report', 'report.md', '--commit', 'cd34ef5')
const pushes = () => calls.filter(c => c.args[2] === 'push')

test('qa-push: verifies the commit, then pushes EXACTLY it to the branch, no force, no tags; records pushedAt', async () => {
  await pass()
  const r = await run('qa-push', ID, '--branch', 'feature/card')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /pushed cd34ef5 to origin feature\/card/)
  assert.deepEqual(calls[0].args, ['-C', 'C:/watched/repo', 'rev-parse', '--verify', '--quiet', 'cd34ef5^{commit}'])
  assert.deepEqual(pushes().map(c => c.args), [['-C', 'C:/watched/repo', 'push', 'origin', `${SHA}:refs/heads/feature/card`]])
  for (const c of calls) assert.ok(!c.args.some(a => /^(--force|-f|--force-with-lease|--tags|\+)/.test(a) || a.startsWith('+')), c.args.join(' '))
  const q = qa()
  assert.ok(q.pushedAt)
  assert.equal(q.branch, 'feature/card')
  assert.equal(q.remote, 'origin')
  assert.equal(q.pushError, null)
})

test('qa-push takes --remote and --repo (resolved), and defaults the branch to the flow pull request head', async () => {
  const f = F.readFlow(ID)
  f.output = { merge: { head: 'feature/rec', base: 'dev', title: 'A card', body: '' } }
  F.writeFlow(f)
  await pass()
  assert.equal((await run('qa-push', ID, '--remote', 'upstream', '--repo', 'other')).code, 0)
  assert.deepEqual(pushes()[0].args, ['-C', path.resolve(TMP, 'other'), 'push', 'upstream', `${SHA}:refs/heads/feature/rec`])
})

test('qa-push refuses before QA passed, a protected branch in any case, a base or pr.protect branch, a bad name, another head', async () => {
  assert.match((await run('qa-push', ID, '--branch', 'feature/x')).out, /QA has not passed/)
  await pass()
  for (const b of ['dev', 'DEV', 'Main', 'master', 'stage', 'release/1.2', 'production', 'HEAD']) {
    const r = await run('qa-push', ID, '--branch', b)
    assert.equal(r.code, 1, b)
    assert.match(r.out, /protected|base branch/, b)
  }
  assert.match((await run('qa-push', ID, '--branch', '-f')).out, /--branch must be a branch name/)
  assert.match((await run('qa-push', ID, '--branch', 'a..b')).out, /--branch must be a branch name/)
  assert.match((await run('qa-push', ID)).out, /--branch/)
  assert.match((await run('qa-push', ID, '--branch', 'x', '--remote', '--force')).out, /--remote must be a remote name/)
  const f = F.readFlow(ID)
  f.output = { merge: { head: 'feature/rec', base: 'dev', title: 'A card', body: '' } }
  F.writeFlow(f)
  assert.match((await run('qa-push', ID, '--branch', 'feature/other')).out, /records its pull request from feature\/rec/)
  assert.equal(pushes().length, 0)
  assert.equal(qa().pushedAt ?? null, null)
})

test('qa-push: a commit the repo does not have is refused and recorded, nothing pushed', async () => {
  await pass()
  gitOver['rev-parse'] = () => ({ ok: false, out: '', err: '' })
  const r = await run('qa-push', ID, '--branch', 'feature/card')
  assert.equal(r.code, 1)
  assert.match(r.out, /has no commit cd34ef5/)
  assert.equal(pushes().length, 0)
  assert.match(qa().pushError, /has no commit cd34ef5/)
})

test('qa-push: a refused push is recorded with a scrubbed reason and never retried; a pushed flow is not pushed twice', async () => {
  await pass()
  gitOver.push = () => ({ ok: false, out: '', err: 'hint: x\n! [rejected] non-fast-forward https://bob:ghp_abcdefghijklmnop@github.com/a/b' })
  const r = await run('qa-push', ID, '--branch', 'feature/card')
  assert.equal(r.code, 1)
  assert.equal(pushes().length, 1, 'one try, never retried')
  assert.match(qa().pushError, /^The push was refused \(it is never forced\): ! \[rejected\] non-fast-forward https:\/\/github\.com\/a\/b$/)
  assert.doesNotMatch(qa().pushError, /ghp_|bob/)
  delete gitOver.push
  assert.equal((await run('qa-push', ID, '--branch', 'feature/card')).code, 0)
  assert.equal(qa().pushError, null)
  assert.match((await run('qa-push', ID, '--branch', 'feature/card')).out, /already pushed/)
  assert.equal(pushes().length, 2)
})

test('the QA commands on a flow in the Trash are refused like every other flow command', async () => {
  const { moveToTrash } = await import('../trash.mjs')
  moveToTrash(ID)
  const r = await run('qa-start', ID)
  assert.equal(r.code, 1)
  assert.match(r.out, /in the Trash/)
})


// ═══ the briefs ═══

test('every brief says: never push; record flow pr and hand the flow to QA, which tests, pushes on a pass and sends failures back', async () => {
  const { chatBrief } = await import('../chat.mjs')
  const read = f => fs.readFileSync(path.join(HERE, '..', f), 'utf8').replace(/\s*\n>?\s*/g, ' ')
  for (const text of [chatBrief(), read('docs/agent-brief.md'), read('README.md'), read('docs/USER_GUIDE.md')]) {
    assert.match(text, /[Nn]ever push or open (the pull request|it) yourself/)
    assert.match(text, /hand the flow to QA/)
    assert.match(text, /QA tests it, pushes the branch on a pass, and sends a failure back to you/)
  }
})

test('the QA brief: tests and Playwright with screenshots, a report, qa-start, qa, qa-push on a pass; never fix, force or push protected', () => {
  const brief = fs.readFileSync(path.join(HERE, '..', 'docs', 'qa-agent-brief.md'), 'utf8').replace(/\s*\n>?\s*/g, ' ')
  for (const re of [/flow qa-start/, /flow qa \S+ --status passed/, /flow qa-push/, /Playwright/, /screenshot/, /report/,
    /[Nn]ever fix the code yourself/, /[Nn]ever push anything that did not pass/, /[Nn]ever force/, /protected branch/, /how to reproduce/]) {
    assert.match(brief, re)
  }
})
