// Tests for subagents.mjs: the coordinator's subagents, listed across every
// session of the watched repo (live or ended), each one a builder or a lookup.
// The fixtures under test/fixtures/subagents are synthetic. They are copied to a
// temp folder first, because the window reads file times and the tests set them.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const H = await import('../subagents.mjs')
// The tickets here use the made-up prefixes ABC and XYZ, whatever config.json says.
const { useTicketPrefixes } = await import('../transcripts.mjs')
useTicketPrefixes(['ABC', 'XYZ'])

const NOW = Date.parse('2026-11-12T12:00:00Z')
const MIN = 60_000
const DAY = 24 * 3600_000
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'subagents-test-'))
const CLAUDE = path.join(TMP, 'claude')
fs.cpSync(path.join(HERE, 'fixtures', 'subagents', 'claude'), CLAUDE, { recursive: true })
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const PROJECT = path.join(CLAUDE, 'projects', 'C--path-to-your-repo')
const subFile = (session, id) => path.join(PROJECT, session, 'subagents', `agent-${id}.jsonl`)
/** Sets when a subagent's transcript was last written, as minutes before NOW. */
function touch(session, id, minutesAgo) {
  const t = new Date(NOW - minutesAgo * MIN)
  fs.utimesSync(subFile(session, id), t, t)
}
touch('sess-live', 'b1', 60)
touch('sess-live', 'l1', 90)
touch('sess-live', 'w1', 2)
touch('sess-live', 's1', 20)
touch('sess-live', 'f1', 30)
touch('sess-live', 'old1', 10 * 24 * 60)
touch('sess-live', 'bad1', 5)
touch('sess-live', 'mid1', 1)
touch('sess-ended', 'e1', 120)
touch('sess-live', 't1', 45)
touch('sess-live', 't2', 50)

const base = { claudeDirs: [CLAUDE], match: 'your-repo', sinceMs: NOW - DAY, now: NOW }
const list = (over = {}) => H.listRepoSubagents({ ...base, ...over })
const byId = async (id, over) => (await list(over)).find(h => h.id === id)

// ═══ which subagents are listed ═══

test('every subagent of the repo in the window is listed, from live and ended sessions, newest first', async () => {
  const subagents = await list()
  assert.deepEqual(subagents.map(h => h.id), ['mid1', 'w1', 's1', 'f1', 't1', 't2', 'b1', 'l1', 'e1'])
  assert.equal((await byId('e1')).sessionId, 'sess-ended')
  assert.equal((await byId('b1')).sessionId, 'sess-live')
})

test('a subagent carries its task name, model and agent type from the meta file', async () => {
  const b = await byId('b1')
  assert.equal(b.description, 'Build ABC-101 dark mode toggle')
  assert.equal(b.model, 'fable')
  assert.equal(b.agentType, 'general-purpose')
  assert.equal(b.finished, true)
  assert.equal(b.updatedAt, new Date(NOW - 60 * MIN).toISOString())
})

test('a subagent outside the window is left out, and a wider window brings it back', async () => {
  assert.equal(await byId('old1'), undefined)
  assert.equal((await byId('old1', { sinceMs: NOW - 30 * DAY })).description, 'An old sweep')
})

test('a project folder of another repo is never listed', async () => {
  assert.equal(await byId('x1', { sinceMs: 0 }), undefined)
  assert.equal((await list({ match: 'other-thing', sinceMs: 0 })).map(h => h.id).join(), 'x1')
})

test('the match is the session folder test: case does not matter, and separators read as in the folder name', async () => {
  assert.equal((await list({ match: 'YOUR-REPO' })).length, 9)
  assert.equal((await list({ match: 'to/your-repo' })).length, 9)
})

test('broken files never break the list: a half-written meta and a meta with no transcript are skipped', async () => {
  const ids = (await list({ sinceMs: 0 })).map(h => h.id)
  assert.ok(!ids.includes('bad1'), 'a meta file that does not parse')
  assert.ok(!ids.includes('nojsonl1'), 'a meta file whose transcript is not there yet')
})

test('a transcript caught mid-write is read up to its last whole line', async () => {
  const m = await byId('mid1')
  assert.equal(m.description, 'Mid write')
  assert.equal(m.builder, false, 'the cut-off git commit line does not count')
})

test('no Claude folder, no projects folder and an empty subagents folder all read as no subagents', async () => {
  assert.deepEqual(await list({ claudeDirs: [path.join(TMP, 'nowhere')] }), [])
  const bare = path.join(TMP, 'bare')
  fs.mkdirSync(bare)
  assert.deepEqual(await list({ claudeDirs: [bare] }), [])
  assert.deepEqual(await list({ claudeDirs: [] }), [])
  assert.deepEqual(await H.listSubagentFiles({ claudeDirs: [CLAUDE], match: 'your-repo', sinceMs: 0 }).then(f => f.filter(x => x.sessionId === 'sess-empty')), [])
})

test('two Claude folders are read side by side, and the same folder twice lists each subagent once', async () => {
  const second = path.join(TMP, 'claude2')
  fs.cpSync(path.join(HERE, 'fixtures', 'subagents', 'claude', 'projects', 'C--path-to-other-thing'), path.join(second, 'projects', 'C--path-to-your-repo-two'), { recursive: true })
  const now = new Date(NOW - 1000)
  fs.utimesSync(path.join(second, 'projects', 'C--path-to-your-repo-two', 'sess-x', 'subagents', 'agent-x1.jsonl'), now, now)
  const ids = (await list({ claudeDirs: [CLAUDE, second, CLAUDE] })).map(h => h.id)
  assert.equal(ids.length, 10)
  assert.equal(ids[0], 'x1')
})

// ═══ builder or lookup ═══

test('a builder worked in a worktree or committed; anything else is a lookup', async () => {
  const kinds = Object.fromEntries((await list()).map(h => [h.id, h.builder]))
  assert.deepEqual(kinds, { b1: true, w1: true, f1: true, e1: true, t1: true, l1: false, s1: false, mid1: false, t2: false })
})

test('a commit counts once its command ran without an error, in Bash or PowerShell, with git options before it', async () => {
  const scan = await H.scanSubagent(subFile('sess-ended', 'e1'))
  assert.equal(scan.committed, true)
  assert.equal(scan.worktree, '')
})

test('a command that only mentions the word commit, and a commit that failed, are not commits', async () => {
  assert.equal((await H.scanSubagent(subFile('sess-live', 'l1'))).committed, false)
  const failed = await H.scanSubagent(subFile('sess-live', 'f1'))
  assert.equal(failed.committed, false)
  assert.equal(failed.worktree, 'export', 'it still worked in a worktree')
})

test('a commit whose result has not arrived yet is not counted', async () => {
  const w = await H.scanSubagent(subFile('sess-live', 'w1'))
  assert.equal(w.committed, false)
  assert.equal(w.worktree, 'label-print')
})

test('the worktree comes from tool calls only, never from tool output', async () => {
  const dir = path.join(TMP, 'out-only')
  fs.mkdirSync(dir)
  const file = path.join(dir, 'agent-o1.jsonl')
  fs.writeFileSync(file, [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git worktree list' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'C:/path/to/your-repo/.claude/worktrees/someone-else abc1234 [x]' }] } },
  ].map(r => JSON.stringify(r)).join('\n') + '\n')
  assert.equal((await H.scanSubagent(file)).worktree, '')
})

test('a worktree the subagent made next to the repo counts, named by its folder, with the branch it created', async () => {
  const t = await byId('t1')
  assert.equal(t.builder, true)
  assert.equal(t.worktree, 'your-repo-wt-300')
  assert.equal(t.branch, 'fix/abc-300-bank-form')
  assert.deepEqual(t.built, ['ABC-300'])
})

test('a folder it only moved into counts as a worktree when git lists it as one, and never the main checkout', async () => {
  assert.equal((await byId('t2')).worktree, '')
  const trees = [{ path: 'C:/path/to/your-repo', branch: 'dev' }, { path: 'C:\\path\\to\\Shared Tree', branch: 'feat/shared' }]
  const t = await byId('t2', { trees })
  assert.equal(t.builder, true)
  assert.equal(t.worktree, 'Shared Tree')
  assert.equal(t.branch, 'feat/shared')
  assert.equal((await byId('t1', { trees })).worktree, 'your-repo-wt-300', 'git -C on the main checkout is not a worktree')
})

test('a path inside text the subagent wrote (a file body) is not where it worked', async () => {
  const scan = await H.scanSubagent(subFile('sess-live', 't2'))
  assert.equal(scan.worktree, '')
  assert.deepEqual([...scan.dirs.keys()], ['c:/path/to/shared tree/web'])
})

// ═══ reading cheaply ═══

test('a transcript is read again only when its time or size changes', async () => {
  const file = subFile('sess-live', 'b1')
  const first = await H.scanSubagent(file)
  assert.equal(await H.scanSubagent(file), first, 'the same object: no second read')
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'One more line.' }] } }) + '\n')
  const second = await H.scanSubagent(file)
  assert.notEqual(second, first)
  touch('sess-live', 'b1', 60)
})

test('only the tail of a long transcript is read: work before it is not seen, the tail is', async () => {
  const dir = path.join(TMP, 'long')
  fs.mkdirSync(dir)
  const file = path.join(dir, 'agent-long.jsonl')
  const early = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'C:/path/to/your-repo/.claude/worktrees/early-tree/a.js' } }] } }
  const filler = JSON.stringify({ type: 'api-request', blob: 'x'.repeat(1000) })
  const late = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'C:/path/to/your-repo/.claude/worktrees/late-tree/b.js' } }] } }
  fs.writeFileSync(file, [JSON.stringify(early), ...Array.from({ length: 40 }, () => filler), JSON.stringify(late)].join('\n') + '\n')
  const scan = await H.scanSubagent(file, { tailBytes: 2000 })
  assert.equal(scan.worktree, 'late-tree')
  assert.equal(scan.worktrees.has('early-tree'), false)
})

// ═══ the window ═══

test('the window starts at local midnight: today for 1 day, six days earlier for 7, and never more than 7', () => {
  const now = new Date(2026, 10, 12, 15, 30).getTime()
  assert.equal(H.windowStart(1, now), new Date(2026, 10, 12).getTime())
  assert.equal(H.windowStart(3, now), new Date(2026, 10, 10).getTime())
  assert.equal(H.windowStart(7, now), new Date(2026, 10, 6).getTime())
  assert.equal(H.windowStart(30, now), new Date(2026, 10, 6).getTime())
  for (const bad of [0, -2, 'x', undefined, null, 1.5]) assert.equal(H.windowStart(bad, now), new Date(2026, 10, 12).getTime(), String(bad))
})

// ═══ state ═══

test('state: done with a handback, failed after an API error, working, and stuck after 15 quiet minutes', async () => {
  const states = Object.fromEntries((await list()).map(h => [h.id, h.state]))
  assert.deepEqual(states, { b1: 'done', l1: 'done', e1: 'done', t1: 'done', t2: 'done', f1: 'failed', w1: 'working', mid1: 'working', s1: 'stuck' })
})

test('subagentState: the 15 minute line, and what finished means', () => {
  const s = H.subagentState
  assert.equal(s({ finished: false, ageMs: 15 * MIN - 1 }), 'working')
  assert.equal(s({ finished: false, ageMs: 15 * MIN }), 'stuck')
  assert.equal(s({ finished: true, report: 'All good.', ageMs: 5 * DAY }), 'done')
  assert.equal(s({ finished: true, report: '', ageMs: 0 }), 'stopped', 'it ended without a handback and without an error: it may need resuming')
  assert.equal(s({ finished: true, report: '', apiError: true, ageMs: 0 }), 'failed', 'no handback, and its last reply was an API error')
  assert.equal(s({ finished: true, report: 'Partly.', apiError: true, ageMs: 0 }), 'failed', 'its last reply was an API error')
  assert.equal(s({ finished: false, report: 'All good.', ageMs: DAY }), 'done', 'handed back, the finished flag not written yet')
})

test('a subagent that ended without a handback and without an error is stopped, and shows its last words', async () => {
  // Made here, in its own folder, so the listing above keeps its nine subagents.
  const claude = path.join(TMP, 'claude-stopped')
  const dir = path.join(claude, 'projects', 'C--path-to-your-repo', 'sess-stop', 'subagents')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'agent-x1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Tidy ABC-300 copy', model: 'sonnet', finished: true }))
  const lines = [
    { type: 'user', isSidechain: true, timestamp: '2026-11-12T10:00:00.000Z', cwd: 'C:/path/to/your-repo', message: { role: 'user', content: 'Tidy the copy.' } },
    { type: 'assistant', timestamp: '2026-11-12T10:01:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'I changed the copy and will run the checks next.' }] } },
  ]
  const file = path.join(dir, 'agent-x1.jsonl')
  fs.writeFileSync(file, lines.map(l => `${JSON.stringify(l)}\n`).join(''))
  const t = new Date(NOW - 40 * MIN)
  fs.utimesSync(file, t, t)
  const [x] = await list({ claudeDirs: [claude] })
  assert.equal(x.id, 'x1')
  assert.equal(x.state, 'stopped')
  assert.equal(x.hasReport, false)
  assert.equal(x.lastText, 'I changed the copy and will run the checks next.')
})

// ═══ worktree, branch, tickets, pull requests ═══

test('a builder shows its worktree, its branch from the commit it made, its tickets and its pull request', async () => {
  const b = await byId('b1')
  assert.equal(b.worktree, 'dark-mode')
  assert.equal(b.branch, 'fix/abc-101-dark-mode')
  assert.deepEqual(b.tickets, ['ABC-101'])
  assert.deepEqual(b.built, ['ABC-101'])
  assert.deepEqual(b.prs, [{ repo: 'acme/your-repo', number: 12, url: 'https://github.com/acme/your-repo/pull/12' }])
  assert.equal(b.startedAt, '2026-11-12T09:00:00.000Z')
})

test('with no commit yet the branch is the one git has for its worktree, else the one it created', async () => {
  const w = await byId('w1', { trees: [{ path: 'C:/path/to/your-repo' }, { path: 'C:/path/to/your-repo/.claude/worktrees/label-print', branch: 'fix/xyz-5-label-print' }] })
  assert.equal(w.branch, 'fix/xyz-5-label-print')
  assert.deepEqual(w.tickets, ['XYZ-5'])
  assert.equal((await byId('w1')).branch, '')
  const dir = path.join(TMP, 'hint')
  fs.mkdirSync(dir)
  const file = path.join(dir, 'agent-h1.jsonl')
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git worktree add .claude/worktrees/hint -b "feat/xyz-9-hint" origin/dev' } }] } }) + '\n')
  assert.equal((await H.scanSubagent(file)).branchHint, 'feat/xyz-9-hint')
})

test('a detached commit gives no branch, and a builder with no ticket anywhere has none', async () => {
  const e = await byId('e1')
  assert.equal(e.branch, '')
  assert.deepEqual(e.tickets, [])
  assert.deepEqual(e.built, [])
  assert.deepEqual(e.prs, [])
})

test('a lookup shows the tickets it looked at but built none, and a link in tool output is not its pull request', async () => {
  const l = await byId('l1')
  assert.deepEqual(l.tickets, ['ABC-7'])
  assert.deepEqual(l.built, [])
  assert.deepEqual(l.prs, [])
})

test('pull requests: links in the report and in what gh pr create printed, each once, any github repo', () => {
  const prs = H.prLinks('Opened https://github.com/acme/your-repo/pull/12 and github.com/acme/other.repo/pull/7, see https://github.com/acme/your-repo/pull/12/files. Not https://example.com/acme/x/pull/3.')
  assert.deepEqual(prs, [
    { repo: 'acme/your-repo', number: 12, url: 'https://github.com/acme/your-repo/pull/12' },
    { repo: 'acme/other.repo', number: 7, url: 'https://github.com/acme/other.repo/pull/7' },
  ])
  assert.deepEqual(H.prLinks(''), [])
  assert.deepEqual(H.prLinks(null), [])
})

// ═══ the final report ═══

test('the list says a report exists and gives its first line; the full text is read on its own', async () => {
  const b = await byId('b1')
  assert.equal(b.hasReport, true)
  assert.equal(b.reportLine, 'ABC-101 is ready for review: PR #12 (https://github.com/acme/your-repo/pull/12).')
  assert.equal('report' in b, false, 'the list stays small')
  const full = await H.subagentReport({ ...base, sessionId: 'sess-live', id: 'b1' })
  assert.ok(full.startsWith('ABC-101 is ready for review'))
  assert.ok(full.endsWith('2. Click the moon.'), 'in full')
})

test('a handback seen only in the hook line is read too', async () => {
  assert.equal(await H.subagentReport({ ...base, sessionId: 'sess-live', id: 'l1' }), 'Two tickets are open: ABC-7 and ABC-9. Nothing else needs you.')
})

test('a failed subagent has no report, and shows its last words instead', async () => {
  const f = await byId('f1')
  assert.equal(f.hasReport, false)
  assert.equal(f.reportLine, '')
  assert.equal(f.lastText, 'API Error: 529 overloaded')
  assert.equal(await H.subagentReport({ ...base, sessionId: 'sess-live', id: 'f1' }), '')
})

test('a report for a subagent that is not there, or an id that is not a plain name, is null', async () => {
  assert.equal(await H.subagentReport({ ...base, sessionId: 'sess-live', id: 'nope' }), null)
  assert.equal(await H.subagentReport({ ...base, sessionId: '..', id: 'b1' }), null)
  assert.equal(await H.subagentReport({ ...base, sessionId: 'sess-live', id: '../../x' }), null)
  assert.equal(await H.subagentReport({ ...base, sessionId: undefined, id: undefined }), null)
})

// ═══ one subagent, and a session that has ended (the live view) ═══

test('one subagent is found by its session and id, live session or ended, described like in the list', async () => {
  const e = await H.oneSubagent({ ...base, sessionId: 'sess-ended', id: 'e1' })
  assert.equal(e.description, 'Fix the footer link')
  assert.equal(e.state, 'done')
  assert.deepEqual(e, await byId('e1', { sinceMs: 0 }))
  const old = await H.oneSubagent({ ...base, sessionId: 'sess-live', id: 'old1' })
  assert.equal(old.description, 'An old sweep', 'the window does not matter for one subagent')
})

test('one subagent that is not there, has a broken meta file, or an id that is a path, is null', async () => {
  assert.equal(await H.oneSubagent({ ...base, sessionId: 'sess-live', id: 'nope' }), null)
  assert.equal(await H.oneSubagent({ ...base, sessionId: 'sess-live', id: 'bad1' }), null)
  assert.equal(await H.oneSubagent({ ...base, sessionId: '../sess-live', id: 'b1' }), null)
})

test('an ended session is found by its id among the project folders of the repo: its transcript path', async () => {
  assert.equal(await H.sessionFile({ ...base, sessionId: 'sess-ended' }), path.join(PROJECT, 'sess-ended.jsonl'))
  assert.equal(await H.sessionFile({ ...base, sessionId: 'sess-live' }), path.join(PROJECT, 'sess-live.jsonl'))
})

test('a session with subagents but no transcript of its own is still found; an unknown or unsafe id is null', async () => {
  assert.equal(await H.sessionFile({ ...base, sessionId: 'sess-empty' }), path.join(PROJECT, 'sess-empty.jsonl'))
  assert.equal(await H.sessionFile({ ...base, sessionId: 'sess-nope' }), null)
  assert.equal(await H.sessionFile({ ...base, sessionId: '..' }), null)
  assert.equal(await H.sessionFile({ ...base, sessionId: 'sess-x' }), null, 'another repo')
  assert.equal(await H.sessionFile({ ...base, sessionId: undefined }), null)
})

// ═══ who built a ticket (the Tickets grid) ═══

test('ticketBuilders: each ticket goes to the newest builder that built it, with a short label and its session label', async () => {
  const builders = H.ticketBuilders(await list(), id => (id === 'sess-live' ? 'Coordinator' : ''))
  assert.deepEqual([...builders.keys()].sort(), ['ABC-101', 'ABC-200', 'ABC-300', 'XYZ-5'])
  assert.deepEqual(builders.get('ABC-101'), { sessionId: 'sess-live', id: 'b1', description: 'Build ABC-101 dark mode toggle', label: 'Build ABC-101 dark mode…', parent: 'Coordinator' })
  assert.equal(builders.get('ABC-300').id, 't1')
})

test('ticketBuilders: a lookup that only looked at a ticket is never credited, and no subagents is an empty map', async () => {
  const builders = H.ticketBuilders(await list())
  assert.equal(builders.has('ABC-7'), false)
  assert.equal(builders.get('ABC-101').parent, '', 'no session label given')
  assert.equal(H.ticketBuilders([]).size, 0)
  assert.equal(H.ticketBuilders(null).size, 0)
})

test('ticketBuilders: when two subagents built the same ticket the newer one is credited', () => {
  const older = { id: 'a', sessionId: 's', description: 'First pass', builder: true, built: ['ABC-1'], updatedAt: '2026-11-12T09:00:00.000Z' }
  const newer = { id: 'b', sessionId: 's', description: 'Second pass', builder: true, built: ['ABC-1'], updatedAt: '2026-11-12T10:00:00.000Z' }
  assert.equal(H.ticketBuilders([older, newer]).get('ABC-1').id, 'b')
  assert.equal(H.ticketBuilders([newer, older]).get('ABC-1').id, 'b')
})

test('shortLabel: a short name stays, a long one is cut at a word with an ellipsis, one long word is cut hard', () => {
  assert.equal(H.shortLabel('Fix the footer link'), 'Fix the footer link')
  assert.equal(H.shortLabel('Build bank details error states fix'), 'Build bank details…')
  assert.equal(H.shortLabel('Supercalifragilisticexpialidocious thing'), 'Supercalifragilisticexp…')
  assert.equal(H.shortLabel('  Spaces   everywhere  '), 'Spaces everywhere')
  assert.equal(H.shortLabel(''), '')
  assert.equal(H.shortLabel(null), '')
})

// ═══ a subagent's flow, and the story it owes ═══

const DARK = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'dark-mode.json'), 'utf8')) // a story, a result shot and a diagram; ABC-101
const BARE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'no-visual.json'), 'utf8')) // no output at all; ABC-102
const flow = (base, over = {}) => ({ ...structuredClone(base), ...over })
const builder = (over = {}) => ({ id: 'b1', description: 'Build ABC-101 dark mode toggle', builder: true, built: ['ABC-101'], branch: 'fix/abc-101-dark-mode', ...over })

test('flowFor: a flow written by the subagent (its --by is the subagent task name) is its flow, whatever tickets it names', () => {
  const mine = flow(BARE, { id: 'mine', agent: 'build abc-101 dark mode toggle ' })
  assert.equal(H.flowFor(builder(), [flow(DARK), mine]).id, 'mine')
})

test('flowFor: else the flow that names its branch as the pull request head, else one that names a ticket it built', () => {
  const byBranch = flow(BARE, { id: 'by-branch', tickets: [], output: { merge: { head: 'fix/abc-101-dark-mode', base: 'dev', title: 'Dark mode', body: 'x' } } })
  assert.equal(H.flowFor(builder(), [flow(DARK), byBranch]).id, 'by-branch')
  assert.equal(H.flowFor(builder(), [flow(BARE), flow(DARK)]).id, 'dark-mode')
})

test('flowFor: no match is null, a dropped flow never matches, and of two equal matches the newest wins', () => {
  assert.equal(H.flowFor(builder({ built: ['XYZ-1'], branch: '' }), [flow(DARK), flow(BARE)]), null)
  assert.equal(H.flowFor(builder(), [flow(DARK, { status: 'dropped' })]), null)
  assert.equal(H.flowFor(builder(), []), null)
  assert.equal(H.flowFor(builder(), null), null)
  const older = flow(DARK, { id: 'older', updatedAt: '2026-11-10T09:00:00Z' })
  const newer = flow(DARK, { id: 'newer', updatedAt: '2026-11-12T09:00:00Z' })
  assert.equal(H.flowFor(builder(), [older, newer]).id, 'newer')
})

test('flowFor: a subagent with no branch does not match a flow with no pull request head', () => {
  assert.equal(H.flowFor(builder({ built: [], branch: '' }), [flow(BARE, { tickets: [] })]), null)
})

test('flowFor says whether the flow has a story (say lines) and a visual (a result shot or a diagram)', () => {
  assert.deepEqual(H.flowFor(builder(), [flow(DARK)]), { id: 'dark-mode', title: DARK.title, story: true, visual: true })
  const bare = H.flowFor(builder({ built: ['ABC-102'] }), [flow(BARE)])
  assert.deepEqual({ story: bare.story, visual: bare.visual }, { story: false, visual: false })
  const beforeOnly = flow(DARK, { output: { story: DARK.output.story, result: DARK.output.result.filter(r => r.when === 'before') } })
  assert.equal(H.flowFor(builder(), [beforeOnly]).visual, false, 'a before shot alone is not the result')
  const diagramOnly = flow(DARK, { output: { diagram: DARK.output.diagram } })
  assert.deepEqual({ story: H.flowFor(builder(), [diagramOnly]).story, visual: H.flowFor(builder(), [diagramOnly]).visual }, { story: false, visual: true })
})

test('storyGap: a builder with no flow, no story or no visual owes one; a lookup never does', () => {
  assert.equal(H.storyGap(builder(), null), 'No flow recorded')
  assert.equal(H.storyGap(builder(), { id: 'f', story: false, visual: true }), 'Its flow has no story')
  assert.equal(H.storyGap(builder(), { id: 'f', story: true, visual: false }), 'Its flow has no picture')
  assert.equal(H.storyGap(builder(), { id: 'f', story: false, visual: false }), 'Its flow has no story and no picture')
  assert.equal(H.storyGap(builder(), { id: 'f', story: true, visual: true }), '')
  assert.equal(H.storyGap(builder({ builder: false }), null), '')
})

test('storyGap: a builder still working owes nothing yet; once it is done, failed, stopped or stuck it does', () => {
  assert.equal(H.storyGap(builder({ state: 'working' }), null), '')
  assert.equal(H.storyGap(builder({ state: 'working' }), { id: 'f', story: false, visual: false }), '')
  for (const state of ['done', 'failed', 'stopped', 'stuck']) assert.equal(H.storyGap(builder({ state }), null), 'No flow recorded', state)
})

// ═══ the stop check (tools/flow-gate.mjs) reads the same scan ═══

test('a transcript says which flows it wrote and under which names: the ids and the --by of its flow commands', async () => {
  const scan = await H.scanSubagent(path.join(PROJECT, 'sess-gate.jsonl'))
  assert.equal(scan.committed, true)
  assert.deepEqual([...scan.flowIds], ['gate-flow'])
  assert.deepEqual([...scan.flowBy], ['Agent 9'], '--by "Agent 9" and FACTORY_BY, once')
  assert.equal(scan.firstAt.slice(0, 4), '2026')
  const none = await H.scanSubagent(subFile('sess-live', 'b1'))
  assert.equal(none.flowIds.size, 0)
  assert.equal(none.flowBy.size, 0)
})

test('flowTold: a story is say lines, a picture is a result shot or a diagram, and a before shot alone is neither', () => {
  assert.deepEqual(H.flowTold(DARK), { story: true, visual: true })
  assert.deepEqual(H.flowTold(BARE), { story: false, visual: false })
  assert.deepEqual(H.flowTold({ output: { story: [], result: [{ ref: 'x/a.png', when: 'before' }] } }), { story: false, visual: false })
  assert.deepEqual(H.flowTold({}), { story: false, visual: false })
})

test('toldBy: a flow counts for an agent when it wrote it (by name or by id), it is not dropped, it is not older than the work, and it has a story and a picture', () => {
  const who = { names: ['agent 3'], ids: [], since: '2026-11-12T08:00:00Z' }
  assert.equal(H.toldBy([flow(DARK)], who), true, 'its name, any case')
  assert.equal(H.toldBy([flow(DARK)], { names: [], ids: ['dark-mode'], since: null }), true, 'a flow it wrote commands for')
  assert.equal(H.toldBy([flow(DARK)], { names: ['Agent 1'], ids: [], since: null }), false, 'someone else')
  assert.equal(H.toldBy([flow(DARK, { status: 'dropped' })], who), false)
  assert.equal(H.toldBy([flow(DARK, { updatedAt: '2026-11-11T09:00:00Z' })], who), false, 'last written before this work started')
  assert.equal(H.toldBy([flow(BARE)], who), false, 'no story and no picture')
  assert.equal(H.toldBy([flow(BARE), flow(DARK)], who), true, 'one complete flow is enough')
  assert.equal(H.toldBy([], who), false)
  assert.equal(H.toldBy(null, who), false)
})

// ═══ where a pull request may come from (fixtures/subagents-prs, one subagent per source) ═══

const PR_SOURCES = path.join(HERE, 'fixtures', 'subagents-prs', 'claude')
/** The pull request numbers on each card of the source fixtures, by subagent id. */
async function prNumbers() {
  const cards = await H.listRepoSubagents({ claudeDirs: [PR_SOURCES], match: 'your-repo', sinceMs: 0, now: NOW })
  return Object.fromEntries(cards.map(c => [c.id, c.prs.map(p => p.number)]))
}

test('a link in a file the subagent read is not its pull request', async () => {
  assert.deepEqual((await prNumbers())['read-result'], [])
})

test('a link in a file the subagent wrote or edited is not its pull request', async () => {
  const n = await prNumbers()
  assert.deepEqual(n['write-input'], [])
  assert.deepEqual(n['edit-input'], [])
})

test('a link in a search result is not its pull request', async () => {
  assert.deepEqual((await prNumbers())['grep-result'], [])
})

test('a link in test output is not its pull request', async () => {
  assert.deepEqual((await prNumbers())['test-output'], [])
})

test('a command that only mentions gh pr (a search for it, a file body, an echo) does not make its output a pull request', async () => {
  const n = await prNumbers()
  assert.deepEqual(n['grep-for-gh'], [])
  assert.deepEqual(n['heredoc-gh'], [])
  assert.deepEqual(n['echo-gh'], [])
})

test('a gh pr command that failed gives no pull request', async () => {
  assert.deepEqual((await prNumbers())['gh-failed'], [])
})

test('the output of gh pr view, merge, checks and status the subagent ran gives its pull requests', async () => {
  const n = await prNumbers()
  assert.deepEqual(n['gh-view'], [31])
  assert.deepEqual(n['gh-merge'], [32], 'also after a cd in the same command')
  assert.deepEqual(n['gh-checks'], [33])
  assert.deepEqual(n['gh-status'], [34], 'also behind a variable set for that command')
})

test('a pull request the subagent named in its own words is its pull request', async () => {
  assert.deepEqual((await prNumbers()).prose, [35])
})

// ═══ a flow the subagent wrote under another name ═══

test('flowFor: a flow the subagent ran its flow commands on is its flow, whatever name it signed with', () => {
  const signed = flow(DARK, { id: 'signed-otherwise', agent: 'Dashboard builder', tickets: [], updatedAt: '2026-11-12T10:00:00Z' })
  const mine = builder({ built: [], branch: '', flowIds: ['signed-otherwise'] })
  assert.equal(H.flowFor(mine, [flow(BARE), signed]).id, 'signed-otherwise')
  assert.equal(H.flowFor(builder({ built: [], branch: '', flowIds: [] }), [signed]), null, 'not without having written it')
  assert.equal(H.flowFor(mine, [{ ...signed, status: 'dropped' }]), null, 'a dropped flow never counts')
})

test('the list carries the flows each subagent wrote, read from its own flow commands', async () => {
  const dir = path.join(TMP, 'claude-flowids', 'projects', 'C--path-to-your-repo', 'sess-f', 'subagents')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'agent-w9.meta.json'), JSON.stringify({ description: 'Build the thing', finished: true }))
  const lines = [
    { type: 'user', isSidechain: true, timestamp: '2026-11-12T10:00:00.000Z', cwd: 'C:/path/to/your-repo', message: { role: 'user', content: 'Build.' } },
    { type: 'assistant', timestamp: '2026-11-12T10:01:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'node C:/dash/tools/factory.mjs flow say the-thing "Built it." --by "Somebody else"' } }] } },
  ]
  fs.writeFileSync(path.join(dir, 'agent-w9.jsonl'), lines.map(l => `${JSON.stringify(l)}\n`).join(''))
  const [w] = await H.listRepoSubagents({ claudeDirs: [path.join(TMP, 'claude-flowids')], match: 'your-repo', sinceMs: 0, now: NOW })
  assert.deepEqual(w.flowIds, ['the-thing'])
})
