// Tests for pr-check.mjs, the facts the page shows before a branch is sent to
// its base: ahead and behind, pushed or not, whether it merges cleanly, the
// commits, any line that credits an AI tool, an existing pull request, and the
// blockers and warnings made from them. Pure: git and gh are stub runners, so
// no repository and no network are touched.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { prFacts, prUrlOf, checksOf, mergeTreeOf, scrub, repoOf, isProtected } = await import('../pr-check.mjs')
const PROTECT = ['main', 'master', 'stage', 'prod', 'production', 'release/*', 'release-*']

const HEAD_SHA = 'a'.repeat(40)
const BASE_SHA = 'b'.repeat(40)
const TREE = 'c'.repeat(40)
const rec = (sha, subject, body = subject) => `${sha}\x1f${subject}\x1f${body}\n\x1e`
const LOG = [rec('1'.repeat(40), 'feat: a dark theme'), rec('2'.repeat(40), 'feat: a moon switch'), rec('3'.repeat(40), 'docs: how to turn it on')].join('\n')

/**
 * A stub git over the sandbox shape: feature/dark-mode 3 ahead of origin/dev and 0 behind, never
 * pushed, merging cleanly. `over` replaces one answer by its key (see `key`). Records every call.
 */
function fakeGit(over = {}) {
  const calls = []
  const answers = {
    'rev-parse refs/heads/feature/dark-mode': { ok: true, out: HEAD_SHA },
    'rev-parse refs/remotes/origin/dev': { ok: true, out: BASE_SHA },
    'rev-parse refs/remotes/origin/feature/dark-mode': { ok: false, out: '', code: 1 },
    'rev-list --left-right': { ok: true, out: '0\t3' },
    'rev-list --count': { ok: true, out: '1' },
    log: { ok: true, out: LOG },
    diff: { ok: true, out: 'theme.css\ntoggle.js\nREADME.md' },
    'merge-tree': { ok: true, out: TREE },
    config: { ok: true, out: 'https://github.com/acme/app.git' },
    ...over,
  }
  const key = args => args[0] === 'rev-parse' ? `rev-parse ${args.at(-1).replace('^{commit}', '')}`
    : args[0] === 'rev-list' ? `rev-list ${args[1]}` : args[0]
  const run = async args => {
    calls.push(args)
    return { err: '', code: 0, ...(answers[key(args)] || { ok: false, out: '', err: 'unexpected', code: 128 }) }
  }
  return Object.assign(run, { calls })
}
/** A stub gh: signed in, no pull request yet. */
function fakeGh(over = {}) {
  const calls = []
  const answers = { auth: { ok: true, out: '' }, pr: { ok: true, out: '[]' }, ...over }
  const run = async args => (calls.push(args), { err: '', code: 0, ...answers[args[0]] })
  return Object.assign(run, { calls })
}
const MERGE = { head: 'feature/dark-mode', base: 'dev', title: 'Add a dark mode', body: '## What\n\nA moon switch.' }
const facts = (opts = {}) => prFacts({ ...MERGE, remote: 'origin', bases: ['dev'], protect: PROTECT, enabled: true, git: fakeGit(), gh: fakeGh(), ...opts })

// ═══ the happy path ═══

test('a branch three ahead, never pushed, merging cleanly: no blockers, one warning that CI has never run', async () => {
  const git = fakeGit()
  const gh = fakeGh()
  const f = await facts({ git, gh })
  assert.deepEqual({ ...f, commits: f.commits.length }, {
    head: 'feature/dark-mode', base: 'dev', remote: 'origin', repo: 'acme/app', sha: HEAD_SHA, headExists: true, ahead: 3, behind: 0, pushed: false, unpushed: 3,
    mergesCleanly: true, conflicts: [], commits: 3, files: 3, attribution: [], existingPr: null, ghOk: true,
    blockers: [], warnings: ['CI has never run on these commits: feature/dark-mode is not on origin yet.'],
  })
  assert.deepEqual(f.commits[0], { sha: '1111111', subject: 'feat: a dark theme' })
  assert.deepEqual(gh.calls, [['auth', 'status'], ['pr', 'list', '--repo=acme/app', '--head=feature/dark-mode', '--base=dev', '--state=all', '--json=number,url,state', '--limit=1']])
  assert.ok(git.calls.some(a => a.join(' ') === 'config --get remote.origin.url'), 'the raw remote address, no insteadOf rewriting')
  assert.ok(git.calls.some(a => a.join(' ') === 'merge-tree --write-tree --name-only --no-messages refs/remotes/origin/dev refs/heads/feature/dark-mode'))
  assert.ok(git.calls.every(a => !['push', 'commit', 'merge', 'checkout', 'branch', 'reset', 'rebase'].includes(a[0])), 'facts only read')
})

test('pushed and up to date on the remote: no warning; pushed but behind locally: how many are not on the remote', async () => {
  const up = await facts({ git: fakeGit({ 'rev-parse refs/remotes/origin/feature/dark-mode': { ok: true, out: HEAD_SHA } }) })
  assert.equal(up.pushed, true)
  assert.equal(up.unpushed, 0)
  assert.deepEqual(up.warnings, [])
  const some = await facts({ git: fakeGit({ 'rev-parse refs/remotes/origin/feature/dark-mode': { ok: true, out: 'd'.repeat(40) } }) })
  assert.equal(some.pushed, false)
  assert.equal(some.unpushed, 1)
  assert.deepEqual(some.warnings, ['CI has not run on the newest commit: it is not on origin yet.'])
})

// ═══ blockers ═══

test('turned off: one blocker saying why (the config, or no send PIN), and git and gh are not run at all', async () => {
  const git = fakeGit()
  const gh = fakeGh()
  const f = await facts({ enabled: false, git, gh })
  assert.deepEqual(f.blockers, ['Sending is turned off: set pr.enabled to true in config.json.'])
  assert.deepEqual([git.calls, gh.calls], [[], []])
  assert.deepEqual((await facts({ enabled: false, off: 'Sending is off: set a send PIN (see the guide).' })).blockers, ['Sending is off: set a send PIN (see the guide).'])
})

test('a protected head is a blocker: a base, HEAD, or a pr.protect pattern; the check is a simple * glob', async () => {
  assert.equal(isProtected('feature/x', { bases: ['dev'], protect: PROTECT }), null)
  assert.match(isProtected('dev', { bases: ['dev'], protect: PROTECT }), /base branch/)
  assert.match(isProtected('HEAD', { bases: ['dev'], protect: PROTECT }), /protected/)
  for (const h of ['main', 'master', 'stage', 'prod', 'production', 'release/1.2', 'release-7']) assert.match(isProtected(h, { bases: ['dev'], protect: PROTECT }), /protected/, h)
  for (const h of ['mainline', 'feature/main', 'releases', 'pre-release-1']) assert.equal(isProtected(h, { bases: ['dev'], protect: PROTECT }), null, h)
  const f = await facts({ head: 'release/1.2', git: fakeGit({ 'rev-parse refs/heads/release/1.2': { ok: true, out: HEAD_SHA } }) })
  assert.equal(f.blockers[0], 'release/1.2 is a protected branch (pr.protect): send a feature branch instead.')
})

test('the head commit is in the facts (the page sends it back, and the push sends exactly it)', async () => {
  assert.equal((await facts()).sha, HEAD_SHA)
})

test('repoOf reads owner/name from the remote address, https or ssh; another host keeps its name', () => {
  assert.equal(repoOf('https://github.com/acme/app.git'), 'acme/app')
  assert.equal(repoOf('https://github.com/acme/app'), 'acme/app')
  assert.equal(repoOf('git@github.com:acme/app.git'), 'acme/app')
  assert.equal(repoOf('ssh://git@github.com/acme/app.git'), 'acme/app')
  assert.equal(repoOf('https://git.example.com/acme/app.git'), 'git.example.com/acme/app')
  for (const bad of ['../origin.git', 'C:/repos/app', '', 'https://github.com/acme', 'https://github.com/acme/app/extra']) assert.equal(repoOf(bad), null, bad)
  assert.equal(repoOf('git@work:acme/app.git'), '', 'an ssh host alias: no --repo at all, gh reads the remote itself')
})

test('A4: an ssh alias remote sends no --repo; a gh pr list that fails is a warning', async () => {
  const gh = fakeGh({ pr: { ok: false, out: '', err: 'HTTP 502' } })
  const f = await facts({ gh, git: fakeGit({ config: { ok: true, out: 'git@work:acme/app.git' } }) })
  assert.equal(f.repo, '')
  assert.deepEqual(f.blockers, [])
  assert.deepEqual(gh.calls[1], ['pr', 'list', '--head=feature/dark-mode', '--base=dev', '--state=all', '--json=number,url,state', '--limit=1'])
  assert.ok(f.warnings.includes('Could not check for an existing pull request.'))
})

test('no GitHub repository behind the remote is a blocker', async () => {
  const f = await facts({ git: fakeGit({ config: { ok: true, out: '../origin.git' } }) })
  assert.ok(f.blockers.includes('Could not tell the GitHub repository from the address of origin.'), f.blockers.join('\n'))
})

test('a base that is not in pr.bases, and a head equal to its base, are blockers', async () => {
  assert.deepEqual((await facts({ base: 'main' })).blockers[0], 'main is not a branch this dashboard sends to (pr.bases: dev).')
  const same = await facts({ head: 'dev', git: fakeGit({ 'rev-parse refs/heads/dev': { ok: true, out: BASE_SHA } }) })
  assert.ok(same.blockers.includes('The branch and its base are the same branch.'), same.blockers.join('\n'))
})

test('a missing head branch, and a base missing on the remote, are blockers', async () => {
  const f = await facts({ git: fakeGit({ 'rev-parse refs/heads/feature/dark-mode': { ok: false, out: '', code: 1 } }) })
  assert.equal(f.headExists, false)
  assert.deepEqual(f.blockers, ['There is no branch feature/dark-mode in the repo.'])
  const nobase = await facts({ git: fakeGit({ 'rev-parse refs/remotes/origin/dev': { ok: false, out: '', code: 1 } }) })
  assert.deepEqual(nobase.blockers, ['origin has no branch dev.'])
})

test('no commits ahead is a blocker', async () => {
  const f = await facts({ git: fakeGit({ 'rev-list --left-right': { ok: true, out: '2\t0' }, log: { ok: true, out: '' }, diff: { ok: true, out: '' } }) })
  assert.equal(f.ahead, 0)
  assert.ok(f.blockers.includes('feature/dark-mode has no commits that dev does not have.'))
})

test('a conflict is a blocker naming the files; an old git that cannot tell is null and no blocker', async () => {
  const f = await facts({ git: fakeGit({ 'merge-tree': { ok: false, out: `${TREE}\ntheme.css\ntheme.css\nREADME.md`, code: 1 } }) })
  assert.equal(f.mergesCleanly, false)
  assert.deepEqual(f.conflicts, ['theme.css', 'README.md'])
  assert.deepEqual(f.blockers, ['It does not merge cleanly into dev: theme.css, README.md conflict.'])
  const old = await facts({ git: fakeGit({ 'merge-tree': { ok: false, out: '', err: 'unknown option', code: 129 } }) })
  assert.equal(old.mergesCleanly, null)
  assert.deepEqual(old.blockers, [])
  assert.ok(old.warnings.includes('Could not check that it merges cleanly (needs git 2.38 or newer).'))
})

test('mergeTreeOf reads git merge-tree: clean, conflicted, or unknown', () => {
  assert.deepEqual(mergeTreeOf({ ok: true, out: TREE }), { clean: true, conflicts: [] })
  assert.deepEqual(mergeTreeOf({ ok: false, out: `${TREE}\na.css`, code: 1 }), { clean: false, conflicts: ['a.css'] })
  assert.equal(mergeTreeOf({ ok: false, out: '', code: 1 }), null)
})

test('a commit that credits an AI tool is a blocker; a human co-author or a tool named in passing is not', async () => {
  const log = [
    rec('1'.repeat(40), 'feat: a dark theme', 'feat: a dark theme\n\nCo-Authored-By: Claude <noreply@anthropic.com>'),
    rec('2'.repeat(40), 'chore: bump the anthropic client', 'chore: bump the anthropic client\n\nCo-authored-by: Jane Doe <jane@example.com>'),
    rec('3'.repeat(40), 'docs: x', 'docs: x\n\nGenerated with a tool'),
  ].join('\n')
  const f = await facts({ git: fakeGit({ log: { ok: true, out: log } }) })
  assert.deepEqual(f.attribution, [{ sha: '1111111', line: 'Co-Authored-By: Claude <noreply@anthropic.com>' }, { sha: '3333333', line: 'Generated with a tool' }])
  assert.deepEqual(f.blockers, [
    'Commit 1111111 "Co-Authored-By: Claude <noreply@anthropic.com>": this commit credits an AI tool; it cannot be reworded once pushed, so make a new branch without it',
    'Commit 3333333 "Generated with a tool": this commit credits an AI tool; it cannot be reworded once pushed, so make a new branch without it',
  ])
})

test('a title or body that credits an AI tool is a blocker; a product it talks about is not', async () => {
  assert.deepEqual((await facts({ title: 'Dark mode, built with Claude' })).blockers, ['a pull request must not credit an AI tool: "Dark mode, built with Claude": remove this line'])
  assert.deepEqual((await facts({ body: 'Done.\n\nGenerated with a tool' })).blockers, ['a pull request must not credit an AI tool: "Generated with a tool": remove this line'])
  assert.deepEqual((await facts({ title: 'Gemini 3 Flash summarises the report' })).blockers, [])
})

test('a fetch that failed is a warning: the facts may be out of date', async () => {
  assert.ok((await facts({ fetchFailed: true })).warnings.includes('Could not reach origin: these facts may be out of date.'))
})

test('gh missing or not signed in is a blocker, and no pull request is looked up', async () => {
  const gh = fakeGh({ auth: { ok: false, out: '', err: 'You are not logged into any GitHub hosts.', code: 1 } })
  const f = await facts({ gh })
  assert.equal(f.ghOk, false)
  assert.deepEqual(f.blockers, ['The GitHub CLI (gh) is missing or not signed in: run gh auth login.'])
  assert.deepEqual(gh.calls, [['auth', 'status']])
})

test('an open pull request for the branch is a blocker and its link is in the facts; a merged one is not', async () => {
  const open = await facts({ gh: fakeGh({ pr: { ok: true, out: '[{"number":12,"url":"https://example.com/acme/app/pull/12","state":"OPEN"}]' } }) })
  assert.deepEqual(open.existingPr, { number: 12, url: 'https://example.com/acme/app/pull/12', state: 'open' })
  assert.deepEqual(open.blockers, ['A pull request is already open for feature/dark-mode: #12.'])
  const merged = await facts({ gh: fakeGh({ pr: { ok: true, out: '[{"number":9,"url":"https://example.com/acme/app/pull/9","state":"MERGED"}]' } }) })
  assert.equal(merged.existingPr.state, 'merged')
  assert.deepEqual(merged.blockers, [])
  const junk = await facts({ gh: fakeGh({ pr: { ok: true, out: 'not json' } }) })
  assert.equal(junk.existingPr, null)
})

// ═══ warnings ═══

test('behind its base, and more than 50 commits, are warnings, not blockers; the list stops at 50', async () => {
  const many = Array.from({ length: 60 }, (_, i) => rec(String(i).padStart(40, '0'), `feat: part ${i}`)).join('\n')
  const f = await facts({ git: fakeGit({ 'rev-list --left-right': { ok: true, out: '4\t60' }, log: { ok: true, out: many } }) })
  assert.equal(f.behind, 4)
  assert.equal(f.commits.length, 50)
  assert.deepEqual(f.blockers, [])
  assert.deepEqual(f.warnings, [
    'feature/dark-mode is 4 commits behind dev.',
    'CI has never run on these commits: feature/dark-mode is not on origin yet.',
    '60 commits: only the first 50 are listed.',
  ])
  const one = await facts({ git: fakeGit({ 'rev-list --left-right': { ok: true, out: '1\t3' } }) })
  assert.equal(one.warnings[0], 'feature/dark-mode is 1 commit behind dev.')
})

// ═══ reading gh ═══

test('prUrlOf takes the pull request link from gh pr create, and only an https one', () => {
  assert.equal(prUrlOf('Creating pull request\n\nhttps://example.com/acme/app/pull/12\n'), 'https://example.com/acme/app/pull/12')
  assert.equal(prUrlOf('http://example.com/acme/app/pull/12'), null)
  assert.equal(prUrlOf('nothing here'), null)
})

test('checksOf maps statusCheckRollup to pending, passing, failing or none', () => {
  const run = (status, conclusion) => ({ __typename: 'CheckRun', status, conclusion })
  const ctx = state => ({ __typename: 'StatusContext', state })
  assert.equal(checksOf([]), 'none')
  assert.equal(checksOf(undefined), 'none')
  assert.equal(checksOf([run('COMPLETED', 'SUCCESS'), ctx('SUCCESS'), run('COMPLETED', 'SKIPPED')]), 'passing')
  assert.equal(checksOf([run('COMPLETED', 'SUCCESS'), run('IN_PROGRESS', '')]), 'pending')
  assert.equal(checksOf([ctx('PENDING')]), 'pending')
  assert.equal(checksOf([run('COMPLETED', 'FAILURE'), run('IN_PROGRESS', '')]), 'failing', 'a failure wins over pending')
  assert.equal(checksOf([ctx('ERROR')]), 'failing')
  assert.equal(checksOf([run('COMPLETED', 'TIMED_OUT')]), 'failing')
})

test('scrub keeps the reason and drops any credential from what git or gh said', () => {
  const err = "To https://user:ghp_abcdefghijklmnop1234@example.com/acme/app.git\n ! [rejected]        feature/x -> feature/x (non-fast-forward)\nerror: failed to push some refs to 'https://user:secret@example.com/acme/app.git'\nhint: Updates were rejected"
  const s = scrub(err)
  assert.doesNotMatch(s, /ghp_|secret|user:/)
  assert.match(s, /\[rejected\]/)
  assert.ok(s.length <= 300)
  assert.equal(scrub('token gho_ABCDEF1234567890abcd and github_pat_11ABCDEFG_xyz'), 'token *** and ***')
})
