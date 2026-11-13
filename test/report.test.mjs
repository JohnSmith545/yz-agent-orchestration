// The progress report (report.mjs) names files relative to the watched repo,
// whatever its folder is called, and names tickets of any prefix.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildReport, shortPath } from '../report.mjs'

test('shortPath: drops everything up to the repo folder, by its own name', () => {
  assert.equal(shortPath('C:\\path\\to\\acme-app\\src\\login.js', 'acme-app'), 'src/login.js')
  assert.equal(shortPath('/home/dev/code/widgets/lib/a.ts', 'widgets'), 'lib/a.ts')
})

test('shortPath: a worktree path drops the worktree folder too', () => {
  assert.equal(shortPath('C:/path/to/acme-app/.claude/worktrees/abc-1-x/src/a.js', 'acme-app'), 'src/a.js')
})

test('shortPath: a path outside the repo, or no repo name, keeps the path (slashes forward)', () => {
  assert.equal(shortPath('C:\\elsewhere\\notes.md', 'acme-app'), 'C:/elsewhere/notes.md')
  assert.equal(shortPath('C:\\path\\to\\acme-app\\a.js', ''), 'C:/path/to/acme-app/a.js')
})

test('shortPath: a repo name with regex characters is taken literally', () => {
  assert.equal(shortPath('/x/my.repo/a.js', 'my.repo'), 'a.js')
  assert.equal(shortPath('/x/myXrepo/a.js', 'my.repo'), '/x/myXrepo/a.js')
})

test('the report names tickets of any prefix, from text and from the branch it worked on', async () => {
  const t = new Date().toISOString()
  const events = [
    { seq: 1, t, kind: 'user', text: 'Pick up OPS-7 please' },
    { seq: 2, t, kind: 'tool', tool: 'Edit', file: 'C:/path/to/acme-app/.claude/worktrees/wt-a/src/a.js', edits: [{}] },
  ]
  const worktrees = { 'wt-a': { path: 'C:/path/to/acme-app/.claude/worktrees/wt-a', branch: 'fix/xyz-10-11-login' } }
  const git = async () => ({ ok: true, out: '' })
  const md = await buildReport({ label: 'Agent 1', events, hours: 0, worktrees, git, repoName: 'acme-app' })
  assert.match(md, /\*\*Tickets:\*\* OPS-7, XYZ-10, XYZ-11/)
  assert.match(md, /`src\/a\.js` \(1 edit\)/)
})

const edit = { seq: 1, t: new Date().toISOString(), kind: 'tool', tool: 'Edit', file: 'C:/r/.claude/worktrees/wt-a/a.js', edits: [{}] }
const commitsGit = async args => (args[0] === 'log' ? { ok: true, out: 'a1 fix: ABC-1 login\nb2 chore: tidy the readme' } : { ok: true, out: '' })

test('with known prefixes, only those count: a lower-case id in text, and the branch ids', async () => {
  const events = [{ seq: 0, t: edit.t, kind: 'user', text: 'see abc-5 and OPS-7' }, edit]
  const worktrees = { 'wt-a': { path: 'C:/r/.claude/worktrees/wt-a', branch: 'feat/step-2-abc-12' } }
  const md = await buildReport({ label: 'A', events, hours: 0, worktrees, git: commitsGit, prefixes: ['ABC'] })
  assert.match(md, /\*\*Tickets:\*\* ABC-12, ABC-5\n/)
})

test('a branch that names its own tickets keeps only the commits naming them', async () => {
  const worktrees = { 'wt-a': { path: 'C:/r/.claude/worktrees/wt-a', branch: 'abc-1-login' } }
  const md = await buildReport({ label: 'A', events: [edit], hours: 0, worktrees, git: commitsGit })
  assert.match(md, /`abc-1-login`: 1 commit\n {2}- a1 fix: ABC-1 login/)
  assert.doesNotMatch(md, /tidy the readme/)
})

test('a branch with no ticket of its own keeps every commit', async () => {
  const worktrees = { 'wt-a': { path: 'C:/r/.claude/worktrees/wt-a', branch: 'feat/login-page-2' } }
  const md = await buildReport({ label: 'A', events: [edit], hours: 0, worktrees, git: commitsGit })
  assert.match(md, /`feat\/login-page-2`: 2 commits/)
})
