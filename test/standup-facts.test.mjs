// Tests for what the Standup creator reads (standup-git.mjs, standup-facts.mjs): the author's commits in the window,
// the pull requests merged into the default branch with their work, the branches not merged yet, the saved ticket
// list, the flows and the open Human review items. Git is a STUB that answers by the shape of its arguments, and
// the ticket list, flows and items are plain functions: nothing here runs git or reads data/.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_TICKET_URL, IN_PROGRESS, gatherFacts, standupSettings, ticketLink } from '../standup-facts.mjs'
import { cleanSubject, readGit } from '../standup-git.mjs'
import { standupWindow } from '../standup-window.mjs'

const NOW = new Date(2026, 10, 25, 10, 12) // Wednesday 25 Nov, local time
const DAILY = standupWindow('daily', NOW) // Tue 24 Nov 00:00 to now
const PREFIXES = ['FLIN', 'FLA']
const ok = out => ({ ok: true, out, err: '' })
const iso = (d, h, m = 0) => new Date(2026, 10, d, h, m).toISOString()
const line = (...cols) => cols.join('\t')

/** A git that answers by what is asked; `over` replaces any answer by its key, and every call is kept. */
function stubGit(over = {}) {
  const calls = []
  const answers = {
    user: ok('Yz31LL'),
    head: ok('origin/dev'),
    commits: ok([
      line('c3', iso(24, 16, 41), 'refs/heads/chore/infra-wave2-followups', 'docs(ops): the restore drill stays an open item (FLA-775)'),
      line('c2', iso(24, 13, 55), 'refs/heads/fix/fla-803-google-chat', 'fix(infra): alerts post to a Google Chat space instead of Slack'),
      line('c1', iso(24, 9, 2), 'refs/remotes/origin/feat/fla-868-media', 'perf(web): big images are compressed'),
    ].join('\n')),
    unmerged: ok([line('c3', 'refs/heads/chore/infra-wave2-followups'), line('c1', 'refs/remotes/origin/feat/fla-868-media')].join('\n')),
    remotes: ok(['origin/HEAD', 'origin/dev', 'origin/feat/fla-868-media'].join('\n')),
    merges: ok([
      line('m3', iso(24, 15, 0), 'p1a p2a', 'Merge pull request #1226 from hytel-io/fix/fla-803-google-chat'),
      line('m2', iso(24, 13, 49), 'p1b p2b', 'Merge pull request #1225 from hytel-io/fix/admin-zero-users-since'),
      line('m1', iso(24, 11, 0), 'p1c p2c', "Merge remote-tracking branch 'origin/stage' into dev"),
    ].join('\n')),
    mine: args => ok(args.includes('p1a..p2a') ? 'c2' : ''), // only #1226 carries the author's work
    ...over,
  }
  const git = async args => {
    calls.push(args)
    const key = args[0] === 'config' ? 'user'
      : args[0] === 'symbolic-ref' ? 'head'
      : args[0] === 'for-each-ref' ? 'remotes'
      : args.includes('--merges') ? 'merges'
      : args.includes('-n') ? 'mine'
      : args.includes('--not') ? 'unmerged'
      : 'commits'
    const a = answers[key]
    return typeof a === 'function' ? a(args) : a
  }
  return { git, calls }
}

const TICKETS = {
  fetchedAt: '2026-11-12T19:32:36.260Z',
  tickets: {
    'FLA-803': { id: 'FLA-803', title: 'Alerts go to Google Chat', state: 'Delivered', owner: 'me' },
    'FLA-868': { id: 'FLA-868', title: 'Compress big web media', state: 'Started', owner: 'me' },
    'FLA-870': { id: 'FLA-870', title: 'Grant prod database access', state: 'Started', owner: 'me' },
    'FLA-900': { id: 'FLA-900', title: 'Someone else s work', state: 'Started', owner: 'other' },
    'FLA-901': { id: 'FLA-901', title: 'Done long ago', state: 'Accepted', owner: 'me' },
  },
}
const FLOWS = [
  { id: 'fla-868-media', title: 'Big web images are compressed', status: 'open', agent: 'Master', tickets: ['FLA-868'], createdAt: iso(23, 7), updatedAt: iso(24, 9, 47) },
  { id: 'old-flow', title: 'An old flow', status: 'done', agent: 'Agent 1', tickets: ['FLA-500'], createdAt: iso(10, 7), updatedAt: iso(11, 9) },
]
const HUMAN = [{ kind: 'hand', title: 'Prod database grant', reason: 'Needs a production admin to grant access.', tickets: ['FLA-870'] }]

const gather = (over = {}) => gatherFacts({
  window: DAILY, now: NOW, settings: standupSettings({}), prefixes: PREFIXES, repoName: 'flinki-v2', fallbackBase: 'origin/dev',
  readTickets: () => TICKETS, readFlows: () => FLOWS, readHuman: () => HUMAN, ...stubGit(), ...over,
})

// ═══ settings ═══

test('standupSettings: everything is optional; the ticket link pattern defaults to Switchboard', () => {
  assert.deepEqual(standupSettings(undefined), { author: '', name: '', project: '', base: '', ticketUrl: DEFAULT_TICKET_URL })
  assert.equal(DEFAULT_TICKET_URL, 'https://app.switchboardpm.ai/stories/{id}')
  const s = standupSettings({ author: ' Jo ', name: 'Jo Bloggs', project: 'Flinki', base: 'origin/main', ticketUrl: 'https://t.example/{id}' })
  assert.deepEqual(s, { author: 'Jo', name: 'Jo Bloggs', project: 'Flinki', base: 'origin/main', ticketUrl: 'https://t.example/{id}' })
})

test('standupSettings: a link pattern without {id} or not http(s), and a non-object, fall back with a warning', () => {
  const warned = []
  const warn = m => warned.push(m)
  assert.equal(standupSettings({ ticketUrl: 'https://t.example/' }, warn).ticketUrl, DEFAULT_TICKET_URL)
  assert.equal(standupSettings({ ticketUrl: 'javascript:alert({id})' }, warn).ticketUrl, DEFAULT_TICKET_URL)
  assert.equal(standupSettings({ base: '--all' }, warn).base, '', 'a base that git would read as a flag is dropped')
  assert.deepEqual(standupSettings('yes', warn), standupSettings(undefined))
  assert.equal(warned.length, 4)
  assert.ok(warned.every(w => /standup/.test(w)))
})

test('ticketLink puts the id in the pattern, encoded', () => {
  assert.equal(ticketLink(DEFAULT_TICKET_URL, 'FLA-886'), 'https://app.switchboardpm.ai/stories/FLA-886')
  assert.equal(ticketLink('https://t.example/{id}?x={id}', 'A B'), 'https://t.example/A%20B?x=A%20B')
})

// ═══ git ═══

test('cleanSubject drops the conventional prefix, for a title when the ticket list has none', () => {
  assert.equal(cleanSubject('fix(infra): alerts post to a Google Chat space'), 'alerts post to a Google Chat space')
  assert.equal(cleanSubject('A plain subject'), 'A plain subject')
  assert.equal(cleanSubject('docs: the drill stays open (FLA-775, FLA-776)'), 'the drill stays open', 'the ids at the end go: the line names the ticket already')
})

test('readGit: the author filter is a fixed string, the window goes to --since and --until, merges are left out', async () => {
  const { git, calls } = stubGit()
  await readGit({ git, author: 'Yz.31*', base: 'origin/dev', window: DAILY, prefixes: PREFIXES })
  const log = calls.find(a => a[0] === 'log' && a.includes('--all') && !a.includes('--not'))
  assert.ok(log.includes('-F') && log.includes('--author=Yz.31*'), 'a name with regex characters is matched as written')
  assert.ok(log.includes('--no-merges'))
  assert.ok(log.includes(`--since=${DAILY.from}`) && log.includes(`--until=${DAILY.to}`))
  for (const a of calls) assert.ok(a.every(x => typeof x === 'string'), 'an argv, never a shell string')
})

test('readGit: commits newest first, with their branch and the ticket ids from the subject and the branch', async () => {
  const { git } = stubGit()
  const g = await readGit({ git, author: 'Yz31LL', base: 'origin/dev', window: DAILY, prefixes: PREFIXES })
  assert.deepEqual(g.commits.map(c => c.sha), ['c3', 'c2', 'c1'])
  assert.deepEqual(g.commits[0], { sha: 'c3', at: iso(24, 16, 41), branch: 'chore/infra-wave2-followups', subject: 'docs(ops): the restore drill stays an open item (FLA-775)', ids: ['FLA-775'] })
  assert.deepEqual(g.commits[1].ids, ['FLA-803'], 'from the branch name')
  assert.equal(g.commits[2].branch, 'feat/fla-868-media', 'a remote branch reads as its own name')
})

test('readGit: only pull requests whose branch carries the author s work, with number, branch and ids', async () => {
  const { git, calls } = stubGit()
  const g = await readGit({ git, author: 'Yz31LL', base: 'origin/dev', window: DAILY, prefixes: PREFIXES })
  assert.deepEqual(g.merges, [{ sha: 'm3', at: iso(24, 15, 0), number: 1226, branch: 'fix/fla-803-google-chat', ids: ['FLA-803'] }])
  const merges = calls.find(a => a.includes('--merges'))
  assert.ok(merges.includes('origin/dev') && merges.includes('--first-parent'), 'merges into the default branch itself')
  assert.equal(calls.filter(a => a.includes('-n')).length, 2, 'the merge that is not a pull request is never checked')
})

test('readGit: branches not merged yet, each once, with whether it is pushed', async () => {
  const { git } = stubGit()
  const g = await readGit({ git, author: 'Yz31LL', base: 'origin/dev', window: DAILY, prefixes: PREFIXES })
  assert.deepEqual(g.unmerged, [
    { branch: 'chore/infra-wave2-followups', commits: 1, pushed: false, ids: [] },
    { branch: 'feat/fla-868-media', commits: 1, pushed: true, ids: ['FLA-868'] },
  ])
})

test('readGit: a git that fails leaves that part out and says so; the rest is still read', async () => {
  const { git } = stubGit({ merges: { ok: false, out: '', err: 'fatal: bad revision' } })
  const g = await readGit({ git, author: 'Yz31LL', base: 'origin/nope', window: DAILY, prefixes: PREFIXES })
  assert.equal(g.commits.length, 3)
  assert.deepEqual(g.merges, [])
  assert.deepEqual(g.skipped, [{ title: 'Merged pull requests', why: 'git could not read origin/nope.' }])
})

// ═══ gathering everything ═══

test('gatherFacts: whose work comes from the config, else git config user.name', async () => {
  assert.equal((await gather()).author, 'Yz31LL')
  const { git, calls } = stubGit()
  const f = await gather({ git, settings: standupSettings({ author: 'Jo' }) })
  assert.equal(f.author, 'Jo')
  assert.ok(!calls.some(a => a[0] === 'config'), 'git config is not asked when the config names the author')
})

test('gatherFacts: the default branch comes from the config, else origin/HEAD, else the fallback', async () => {
  assert.equal((await gather()).base, 'origin/dev')
  assert.equal((await gather({ settings: standupSettings({ base: 'origin/main' }) })).base, 'origin/main')
  const { git } = stubGit({ head: { ok: false, out: '', err: 'no' } })
  assert.equal((await gather({ git, fallbackBase: 'origin/stage' })).base, 'origin/stage')
})

test('gatherFacts: every ticket seen gets its title, state and the server-built link; unknown ones say so', async () => {
  const f = await gather()
  const t = Object.fromEntries(f.tickets.map(x => [x.id, x]))
  assert.equal(t['FLA-803'].line, 'FLA-803: Alerts go to Google Chat — https://app.switchboardpm.ai/stories/FLA-803')
  assert.equal(t['FLA-803'].state, 'Delivered')
  assert.equal(t['FLA-775'].known, false, 'not in the saved list')
  assert.equal(t['FLA-775'].line, 'FLA-775: the restore drill stays an open item — https://app.switchboardpm.ai/stories/FLA-775', 'its commit subject stands in')
  assert.equal(f.ticketListAt, TICKETS.fetchedAt)
})

test('gatherFacts: What s next candidates are the author s tickets in progress, in the real states', async () => {
  assert.deepEqual([...IN_PROGRESS], ['Started', 'Rejected', 'Finished', 'Delivered'])
  const f = await gather()
  assert.deepEqual(f.next.map(t => t.id), ['FLA-868', 'FLA-870', 'FLA-803'], 'Started first; never someone else s, never an accepted one')
})

test('gatherFacts: flows touched in the window, and the open Human review items as Blocker candidates', async () => {
  const f = await gather()
  assert.deepEqual(f.flows.map(x => x.id), ['fla-868-media'])
  assert.deepEqual(f.waiting, [{ kind: 'hand', title: 'Prod database grant', reason: 'Needs a production admin to grant access.', tickets: ['FLA-870'] }])
  assert.ok(f.tickets.some(t => t.id === 'FLA-870'), 'a waiting item s ticket gets its line too')
})

test('gatherFacts: a source that fails is left out and named; the run still has the rest', async () => {
  const f = await gather({ readTickets: () => { throw new Error('ENOENT') }, readFlows: () => { throw new Error('bad json') } })
  assert.equal(f.commits.length, 3)
  assert.equal(f.ticketListAt, null)
  assert.deepEqual(f.skipped.map(s => s.title), ['Ticket list', 'Flows'])
  assert.ok(f.tickets.every(t => t.known === false))
})

test('gatherFacts: with no author at all there is no git read, and it says why', async () => {
  const { git, calls } = stubGit({ user: { ok: true, out: '', err: '' } })
  const f = await gather({ git })
  assert.deepEqual(f.commits, [])
  assert.ok(!calls.some(a => a[0] === 'log'))
  assert.match(f.skipped.find(s => s.title === 'Git').why, /user\.name|standup\.author/)
})

test('gatherFacts: the weekly header has a name and a project, from the config or the git user and the repo folder', async () => {
  const f = await gather()
  assert.equal(f.name, 'Yz31LL')
  assert.equal(f.project, 'flinki-v2')
  const g = await gather({ settings: standupSettings({ name: 'Jo Bloggs', project: 'Flinki' }) })
  assert.deepEqual([g.name, g.project], ['Jo Bloggs', 'Flinki'])
})

// ═══ the saved ticket list across collections ═══

test('savedTicketList: every collection s saved tickets, the first one seen wins, and the OLDEST save date', async () => {
  const { savedTicketList } = await import('../standup-facts.mjs')
  const sources = {
    prod: { fetchedAt: '2026-11-12T19:32:36.260Z', tickets: { 'FLA-1': { title: 'From prod' } } },
    beta: { fetchedAt: '2026-11-20T08:00:00.000Z', tickets: { 'FLA-1': { title: 'From beta' }, 'FLIN-2': { title: 'Beta only' } } },
  }
  const list = savedTicketList({ collections: [{ id: 'prod' }, { id: 'gone' }, { id: 'beta' }], readSource: id => sources[id] || null })
  assert.equal(list.fetchedAt, '2026-11-12T19:32:36.260Z', 'the oldest list is how old the facts can be')
  assert.deepEqual(Object.keys(list.tickets).sort(), ['FLA-1', 'FLIN-2'])
  assert.equal(list.tickets['FLA-1'].title, 'From prod')
})

test('savedTicketList: no saved list at all throws, so the Read line says the ticket list was left out', async () => {
  const { savedTicketList } = await import('../standup-facts.mjs')
  assert.throws(() => savedTicketList({ collections: [], readSource: () => null }), /No saved ticket list/)
  assert.throws(() => savedTicketList({ collections: [{ id: 'x' }], readSource: () => { throw new Error('bad') } }), /No saved ticket list/)
})

test('config.example.json s standup block reads with no warning, and the README names every key', async () => {
  const fs = await import('node:fs')
  const raw = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')).standup
  const warned = []
  const s = standupSettings(raw, m => warned.push(m))
  assert.deepEqual(warned, [])
  assert.equal(s.ticketUrl, DEFAULT_TICKET_URL)
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const row = readme.split('\n').find(l => l.startsWith('| `standup` |'))
  for (const k of Object.keys(raw)) assert.ok(row.includes(`\`${k}\``) || row.includes(`"${k}"`), k)
})

// ═══ only ticket work goes in (QA of the first real run, 2026-11-25) ═══
// The daily run said "Agent tooling in the dashboard": the dashboard s own flows (no ticket) were in the facts as
// FLOWS TOUCHED, and a test flow s ABC-101 came in through Human review. Commits come only from the config repo, so
// those two paths were the only way in.

const NOISY_FLOWS = [
  ...FLOWS,
  { id: 'agent-window', title: 'Agent tooling in the dashboard', status: 'done', agent: 'Master', tickets: [], createdAt: iso(24, 8), updatedAt: iso(24, 12) },
  { id: 'dark-mode', title: 'Add a dark mode toggle', status: 'open', agent: 'Agent 1', tickets: ['ABC-101'], createdAt: iso(24, 8), updatedAt: iso(24, 12) },
  { id: 'mixed', title: 'Mixed tickets', status: 'open', agent: 'Agent 1', tickets: ['ABC-7', 'FLA-886'], createdAt: iso(24, 8), updatedAt: iso(24, 12) },
]
const NOISY_HUMAN = [
  ...HUMAN,
  { kind: 'ask', title: 'Add a dark mode toggle', reason: 'The team has used it for a day.', tickets: ['ABC-101'] },
  { kind: 'blocked', title: 'A dashboard chore', reason: 'Blocked.', tickets: [] },
  { kind: 'hand', title: 'Mixed', reason: 'Needs a grant.', tickets: ['ABC-5', 'FLA-870'] },
]

test('regression: a flow or waiting item goes in only with a ticket of the configured prefixes, and only those ids go with it', async () => {
  const f = await gather({ readFlows: () => NOISY_FLOWS, readHuman: () => NOISY_HUMAN })
  assert.deepEqual(f.flows.map(x => [x.id, x.tickets]), [['fla-868-media', ['FLA-868']], ['mixed', ['FLA-886']]])
  assert.deepEqual(f.waiting.map(x => [x.title, x.tickets]), [['Prod database grant', ['FLA-870']], ['Mixed', ['FLA-870']]])
  assert.deepEqual(f.skipped, [], 'left out silently: it is not a failed source')
  assert.ok(!f.tickets.some(t => t.id.startsWith('ABC-')))
  const { factsText } = await import('../standup-text.mjs')
  const s = factsText(f, NOW)
  for (const noise of ['Agent tooling in the dashboard', 'dark mode', 'A dashboard chore', 'ABC-']) assert.ok(!s.includes(noise), noise)
})

test('the tickets in the facts are exactly: the author s commits, merges and unmerged branches, their own tickets in progress, and the filtered flows and items', async () => {
  const f = await gather({ readFlows: () => NOISY_FLOWS, readHuman: () => NOISY_HUMAN })
  assert.deepEqual(f.tickets.map(t => t.id), ['FLA-803', 'FLA-775', 'FLA-868', 'FLA-886', 'FLA-870'])
  for (const never of ['FLA-900', 'FLA-901', 'FLA-500']) assert.ok(!f.tickets.some(t => t.id === never), never)
})

test('the prompt says a line with no ticket must be work in the stand-up s repo, never on the dashboard itself', async () => {
  const { systemPrompt } = await import('../standup-prompt.mjs')
  for (const mode of ['daily', 'week']) assert.match(systemPrompt(mode), /no ticket[^.]*only when it is work in the repo[^.]*never work on the dashboard/i)
})

test('Human review items: only questions, by-hand steps and blocked flows go in; a ticket merely marked no-code is backlog, not a blocker', async () => {
  const human = [
    ...HUMAN,
    { kind: 'ask', title: 'Which region?', reason: 'Needs your answer.', tickets: ['FLA-871'] },
    { kind: 'blocked', title: 'Stuck flow', reason: 'Blocked at: deploy.', tickets: ['FLA-872'] },
    { kind: 'ticket', ticketId: 'FLA-873', title: 'Marked no-code', reason: 'Marked not codebase work.' },
    { kind: 'ticket', title: 'Also marked', reason: 'x', tickets: ['FLA-874'] },
  ]
  const f = await gather({ readHuman: () => human })
  assert.deepEqual(f.waiting.map(w => w.kind), ['hand', 'ask', 'blocked'])
  for (const id of ['FLA-873', 'FLA-874']) assert.ok(!f.tickets.some(t => t.id === id), id)
  assert.deepEqual(f.skipped, [], 'left out silently')
})
