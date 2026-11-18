// Tests for the Since you were away digest (since.mjs, spec F2) and the
// change records it reads (since-store.mjs): levels-prev.json, flows-prev.json
// and sources/<id>.prev.json. FACTORY_DATA_DIR points at a fresh temp folder
// BEFORE the imports, so no test ever touches the real data/ folder.

import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'since-test-'))
const F = await import('../flows.mjs')
const { sinceDigest, gatherCommits, MAX_LINES } = await import('../since.mjs')
const S = await import('../since-store.mjs')
// The tickets here use the made-up prefixes ABC and XYZ, whatever config.json says.
const { useTicketPrefixes } = await import('../transcripts.mjs')
useTicketPrefixes(['ABC', 'XYZ'])
after(() => fs.rmSync(F.DATA_DIR, { recursive: true, force: true }))
beforeEach(() => {
  for (const f of ['levels.json', 'levels-prev.json', 'flows-prev.json']) fs.rmSync(path.join(F.DATA_DIR, f), { force: true })
  fs.rmSync(F.FLOWS_DIR, { recursive: true, force: true })
  fs.rmSync(path.join(F.DATA_DIR, 'sources'), { recursive: true, force: true })
})

const SINCE = '2026-11-12T23:10:00.000Z'
const NOW = Date.parse('2026-11-13T08:00:00.000Z')
const AFTER = '2026-11-13T02:00:00.000Z'
const BEFORE = '2026-11-12T20:00:00.000Z'
const texts = lines => lines.map(l => l.text)
const digest = more => sinceDigest({ since: SINCE, now: NOW, ...more })
const commit = (sha, subject, agent = 'Agent 1', date = AFTER) => ({ sha, subject, agent, date, branch: 'b' })

// ═══ the digest ═══

test('commits after the baseline group by agent and ticket', () => {
  const d = digest({
    commits: [
      commit('a1', 'fix(web): ABC-102 one'),
      commit('a2', 'fix(web): ABC-102 two', 'Agent 1', '2026-11-13T03:00:00.000Z'),
      commit('a3', 'test(web): ABC-102 three'),
      commit('a0', 'fix(web): ABC-102 old', 'Agent 1', BEFORE),
      commit('b1', 'feat(api): ABC-12 thing', 'Agent 2'),
      commit('c1', 'chore: no ticket here', 'Coordinator'),
    ],
  })
  assert.deepEqual(texts(d.commits), ['Agent 1 committed 3 times on ABC-102', 'Agent 2 committed once on ABC-12'])
  assert.equal(d.commits[0].href, '#/tickets')
  assert.equal(d.commits[0].ticket, 'ABC-102')
  assert.equal(d.commits[0].at, '2026-11-13T03:00:00.000Z', 'the newest commit of the group')
})

test('a commit on two tickets is listed once', () => {
  const d = digest({
    commits: [
      commit('a1', 'fix: ABC-1 and ABC-2 together'),
      commit('a1', 'fix: ABC-1 and ABC-2 together', 'Coordinator'), // the same sha merged onto followup
    ],
  })
  assert.deepEqual(texts(d.commits), ['Agent 1 committed once on ABC-1'])
})

test('a level change is one line', () => {
  const d = digest({
    levels: { 'ABC-101': 'stage', 'ABC-1': 'dev', 'ABC-2': 'dev', 'ABC-3': 'prod' },
    levelsPrev: {
      'ABC-101': { level: 'dev', at: AFTER },
      'ABC-1': { level: 'local', at: BEFORE }, // moved before the baseline: already seen
      'ABC-2': { level: 'dev', at: AFTER }, // moved and moved back
      'ABC-3': { level: null, at: AFTER },
    },
  })
  assert.deepEqual(texts(d.levels), ['ABC-101 moved to Stage', 'ABC-3 moved to Prod'])
  assert.equal(d.levels[0].ticket, 'ABC-101')
  assert.equal(d.levels[0].href, '#/tickets')
})

test('a flow whose status changed is one line', () => {
  const flow = (id, title, status) => ({ id, title, status, updatedAt: AFTER, nodes: [] })
  const d = digest({
    flows: [flow('dark', 'Add a dark mode toggle', 'done'), flow('login', 'Fix the login', 'blocked'), flow('old', 'Old', 'done'), flow('same', 'Same', 'open')],
    flowsPrev: {
      dark: { status: 'open', at: AFTER },
      login: { status: 'open', at: '2026-11-13T01:00:00.000Z' },
      old: { status: 'open', at: BEFORE },
      same: { status: 'open', at: AFTER },
    },
  })
  assert.deepEqual(texts(d.flows), ['Add a dark mode toggle is done', 'Fix the login is blocked'])
  assert.equal(d.flows[0].flow, 'dark')
  assert.equal(d.flows[0].href, '#/flows')
})

test('deliveries count sent and failed', () => {
  const ask = more => ({ id: 'n' + Math.random(), type: 'ask', title: 'Q', kind: 'yesno', answer: 'yes', sentAt: null, deliveryError: null, ...more })
  const d = digest({
    flows: [
      { id: 'a', title: 'A', status: 'open', updatedAt: AFTER, nodes: [ask({ sentAt: AFTER }), ask({ sentAt: BEFORE }), ask({ deliveryError: 'gone' })] },
      { id: 'b', title: 'B', status: 'open', updatedAt: AFTER, nodes: [ask({ sentAt: AFTER })] },
      { id: 'c', title: 'C', status: 'open', updatedAt: BEFORE, nodes: [ask({ deliveryError: 'old failure' })] },
    ],
  })
  assert.deepEqual(texts(d.deliveries), ['2 answers delivered, 1 not delivered'])
  assert.equal(d.deliveries[0].href, '#/flows')
  assert.equal(d.deliveries[0].flow, undefined, 'two flows: the board, not one flow')

  const one = digest({ flows: [{ id: 'a', title: 'A', status: 'open', updatedAt: AFTER, nodes: [ask({ sentAt: AFTER })] }] })
  assert.deepEqual(texts(one.deliveries), ['1 answer delivered'])
  assert.equal(one.deliveries[0].flow, 'a')
  const failed = digest({ flows: [{ id: 'a', title: 'A', status: 'open', updatedAt: AFTER, nodes: [ask({ deliveryError: 'x' })] }] })
  assert.deepEqual(texts(failed.deliveries), ['1 answer not delivered'])
})

test('a source state change is one line', () => {
  const d = digest({
    sources: [{ id: 'abc', label: 'Switchboard', tickets: { 'ABC-103': { state: 'In Review' }, 'ABC-104': { state: 'Started' }, 'ABC-105': { state: 'Done' } } }],
    sourcesPrev: {
      abc: { tickets: { 'ABC-103': { state: 'In Progress', at: AFTER }, 'ABC-104': { state: 'None', at: BEFORE }, 'ABC-105': { state: 'Done', at: AFTER } } },
    },
  })
  assert.deepEqual(texts(d.tickets), ['ABC-103 changed on Switchboard: In Progress → In Review'])
  assert.equal(d.tickets[0].ticket, 'ABC-103')
})

test('an empty or None state reads Unstarted, as on the Tickets page', () => {
  const d = digest({
    sources: [{ id: 'abc', label: 'Switchboard', tickets: { 'ABC-5': { state: 'Started' } } }],
    sourcesPrev: { abc: { tickets: { 'ABC-5': { state: 'None', at: AFTER } } } },
  })
  assert.deepEqual(texts(d.tickets), ['ABC-5 changed on Switchboard: Unstarted → Started'])
})

test('the digest is capped at 8 lines in priority order', () => {
  const flows = []
  const flowsPrev = {}
  for (let i = 1; i <= 3; i++) {
    flows.push({ id: `f${i}`, title: `Flow ${i}`, status: 'done', updatedAt: AFTER, nodes: [] })
    flowsPrev[`f${i}`] = { status: 'open', at: AFTER }
  }
  flows[0].nodes.push({ id: 'n1', type: 'ask', title: 'Q', kind: 'yesno', answer: 'yes', sentAt: AFTER, deliveryError: null })
  const levels = {}
  const levelsPrev = {}
  for (let i = 1; i <= 3; i++) {
    levels[`ABC-${i}`] = 'dev'
    levelsPrev[`ABC-${i}`] = { level: 'local', at: AFTER }
  }
  const d = digest({
    flows,
    flowsPrev,
    levels,
    levelsPrev,
    sources: [{ id: 'abc', label: 'Switchboard', tickets: { 'ABC-50': { state: 'Done' }, 'ABC-51': { state: 'Done' } } }],
    sourcesPrev: { abc: { tickets: { 'ABC-50': { state: 'Started', at: AFTER }, 'ABC-51': { state: 'Started', at: AFTER } } } },
    commits: [commit('a', 'ABC-9 x')],
  })
  assert.equal(MAX_LINES, 8)
  assert.equal(d.flows.length, 3)
  assert.equal(d.deliveries.length, 1)
  assert.equal(d.levels.length, 3)
  assert.equal(d.tickets.length, 1, 'only one ticket line fits')
  assert.equal(d.commits.length, 0, 'commits come last and are cut')
})

test('a future or unparsable baseline gives an empty digest', () => {
  const busy = {
    commits: [commit('a', 'ABC-1 x')],
    levels: { 'ABC-1': 'dev' },
    levelsPrev: { 'ABC-1': { level: 'local', at: AFTER } },
  }
  const empty = { commits: [], levels: [], flows: [], deliveries: [], tickets: [] }
  for (const since of ['2026-11-14T00:00:00.000Z', 'not a date', '', null, undefined]) {
    const d = sinceDigest({ since, now: NOW, ...busy })
    assert.deepEqual({ commits: d.commits, levels: d.levels, flows: d.flows, deliveries: d.deliveries, tickets: d.tickets }, empty, String(since))
  }
})

test('every line is a plain fact: text and href, no markup from the inputs', () => {
  const d = digest({
    flows: [{ id: 'x', title: '<b>Bold</b>', status: 'done', updatedAt: AFTER, nodes: [] }],
    flowsPrev: { x: { status: 'open', at: AFTER } },
  })
  assert.equal(d.flows[0].text, '<b>Bold</b> is done', 'the text is raw: the page escapes it')
})

// ═══ gathering commits ═══

/**
 * A tiny git: each ref lists the shas reachable from it, newest first, and
 * `log A..B` is what B reaches that A does not (as git computes it). The agent
 * branch and followup both reach dev's commits, made by someone else.
 */
function fakeGit() {
  const META = {
    d1: `d1\t${AFTER}\tfix(api): ABC-500 landed on dev by someone else`,
    d2: `d2\t${AFTER}\tfix(web): ABC-501 also on dev`,
    a1: `a1\t${AFTER}\tfix: ABC-102 one`,
    f1: `f1\t${AFTER}\tchore: ABC-2 docs`,
  }
  const REACH = { 'origin/dev': ['d2', 'd1'], 'abc-102-x': ['a1', 'd2', 'd1'], followup: ['f1', 'a1', 'd2', 'd1'] }
  const calls = []
  const git = async args => {
    calls.push(args)
    const m = /^(?:(.+)\.\.)?(.+)$/.exec(args[1])
    const reach = REACH[m[2]]
    if (!reach) return { ok: false, out: '', err: 'unknown revision' }
    const not = new Set(m[1] ? REACH[m[1]] || [] : [])
    return { ok: true, out: reach.filter(sha => !not.has(sha)).map(sha => META[sha]).join('\n'), err: '' }
  }
  return { git, calls }
}
const TREES = {
  worktrees: [
    { name: 'acme-app', path: 'C:/r', branch: 'followup', isAgentTree: false, agent: 'Coordinator' },
    { name: 'a1', path: 'C:/r/.claude/worktrees/a1', branch: 'abc-102-x', isAgentTree: true, agent: 'Agent 1' },
    { name: 'loose', path: 'C:/r/.worktrees/loose', branch: 'loose', isAgentTree: false, agent: '' },
  ],
}

test('gatherCommits reads what each agent branch added since the baseline, agent trees first, no merges', async () => {
  const { git, calls } = fakeGit()
  const commits = await gatherCommits({ git, status: TREES, since: SINCE })
  assert.deepEqual(calls.map(a => a[1]), ['origin/dev..abc-102-x', 'origin/dev..followup'], 'agent trees first, none without an agent')
  for (const a of calls) {
    assert.ok(a.includes('--no-merges'))
    assert.ok(a.includes(`--since=${SINCE}`))
    assert.equal(a.at(-1), '--', 'a branch name is never read as a path')
  }
  const d = digest({ commits })
  assert.deepEqual(texts(d.commits), ['Agent 1 committed once on ABC-102', 'Coordinator committed once on ABC-2'])
})

test('a base commit someone else landed on dev is never credited to an agent', async () => {
  const { git } = fakeGit()
  const d = digest({ commits: await gatherCommits({ git, status: TREES, since: SINCE }) })
  assert.ok(!d.commits.some(l => /ABC-50[01]/.test(l.text)), texts(d.commits).join(' | '))
})

test('gatherCommits survives a status with no worktrees and a failing git', async () => {
  assert.deepEqual(await gatherCommits({ git: async () => ({ ok: false, out: '', err: 'x' }), status: {}, since: SINCE }), [])
})

// ═══ the change records ═══

const readJson = f => JSON.parse(fs.readFileSync(path.join(F.DATA_DIR, f), 'utf8'))

test('recordLevels keeps the current map and notes a change with the level it left', () => {
  S.recordLevels({ 'ABC-1': 'local', 'ABC-2': null }, '2026-11-13T01:00:00.000Z')
  assert.deepEqual(readJson('levels.json'), { 'ABC-1': 'local', 'ABC-2': null })
  assert.ok(!fs.existsSync(path.join(F.DATA_DIR, 'levels-prev.json')), 'a first build notes nothing')

  S.recordLevels({ 'ABC-1': 'dev', 'ABC-2': null }, '2026-11-13T02:00:00.000Z')
  S.recordLevels({ 'ABC-1': 'dev', 'ABC-2': null }, '2026-11-13T03:00:00.000Z') // a later build with nothing new keeps the note
  assert.deepEqual(readJson('levels-prev.json'), { 'ABC-1': { level: 'local', at: '2026-11-13T02:00:00.000Z' } })

  // Another collection's build adds its tickets without forgetting these.
  S.recordLevels({ 'XYZ-9': 'stage' }, '2026-11-13T04:00:00.000Z')
  assert.deepEqual(readJson('levels.json'), { 'ABC-1': 'dev', 'ABC-2': null, 'XYZ-9': 'stage' })
  S.recordLevels({ 'ABC-2': 'local' }, '2026-11-13T05:00:00.000Z')
  assert.deepEqual(S.readLevels(), { 'ABC-1': 'dev', 'ABC-2': 'local', 'XYZ-9': 'stage' })
  assert.deepEqual(S.readLevelsPrev()['ABC-2'], { level: null, at: '2026-11-13T05:00:00.000Z' })
})

test('writeFlow notes the previous status only when it changes', () => {
  const flow = F.createFlow({ id: 'dark', title: 'Add a dark mode toggle', agent: 'Agent 3' })
  assert.deepEqual(S.readFlowsPrev(), {}, 'a new flow is not a change')
  F.writeFlow(flow)
  assert.deepEqual(S.readFlowsPrev(), {}, 'the same status is not a change')
  flow.status = 'done'
  F.writeFlow(flow)
  const prev = S.readFlowsPrev()
  assert.equal(prev.dark.status, 'open')
  assert.ok(Date.parse(prev.dark.at) <= Date.now())
  F.writeFlow(flow)
  assert.equal(S.readFlowsPrev().dark.status, 'open', 'a later write with the same status keeps the note')
})

test('recordSource notes each ticket whose state changed, keeping earlier notes', () => {
  const src = (fetchedAt, states) => ({ fetchedAt, tickets: Object.fromEntries(Object.entries(states).map(([id, state]) => [id, { id, state }])) })
  S.recordSource('abc', src('t0', { 'ABC-1': 'Started', 'ABC-2': 'Started' }), src('t1', { 'ABC-1': 'Finished', 'ABC-2': 'Started', 'ABC-3': 'New' }), '2026-11-13T01:00:00.000Z')
  S.recordSource('abc', src('t1', { 'ABC-1': 'Finished', 'ABC-2': 'Started' }), src('t2', { 'ABC-1': 'Finished', 'ABC-2': 'Delivered' }), '2026-11-13T02:00:00.000Z')
  const prev = S.readSourcePrev('abc')
  assert.equal(prev.fetchedAt, 't1')
  assert.deepEqual(prev.tickets, {
    'ABC-1': { state: 'Started', at: '2026-11-13T01:00:00.000Z' },
    'ABC-2': { state: 'Started', at: '2026-11-13T02:00:00.000Z' },
  })
  assert.ok(fs.existsSync(path.join(F.DATA_DIR, 'sources', 'abc.prev.json')))
  assert.equal(S.readSourcePrev('nope'), null)
})

test('a broken record file reads as empty, never throws', () => {
  fs.mkdirSync(F.DATA_DIR, { recursive: true })
  fs.writeFileSync(path.join(F.DATA_DIR, 'levels-prev.json'), '{not json')
  fs.writeFileSync(path.join(F.DATA_DIR, 'flows-prev.json'), '[1,2]')
  assert.deepEqual(S.readLevelsPrev(), {})
  assert.deepEqual(S.readFlowsPrev(), {})
})

test('notes older than 30 days are dropped on the next write', () => {
  S.recordLevels({ 'ABC-1': 'local', 'ABC-2': 'local' }, '2026-10-01T00:00:00.000Z')
  S.recordLevels({ 'ABC-1': 'dev', 'ABC-2': 'local' }, '2026-10-01T01:00:00.000Z')
  S.recordLevels({ 'ABC-1': 'dev', 'ABC-2': 'dev' }, '2026-11-13T00:00:00.000Z')
  assert.deepEqual(Object.keys(S.readLevelsPrev()), ['ABC-2'])
})

test('a value that returns to its noted value drops the note: open, done, open again is no line', () => {
  S.recordFlowStatus('back', 'open', 'done', '2026-11-13T01:00:00.000Z')
  assert.equal(S.readFlowsPrev().back.status, 'open')
  S.recordFlowStatus('back', 'done', 'open', '2026-11-13T02:00:00.000Z')
  assert.equal(S.readFlowsPrev().back, undefined, 'the change undid itself')
  const d = digest({ flows: [{ id: 'back', title: 'Back again', status: 'open', updatedAt: AFTER, nodes: [] }], flowsPrev: S.readFlowsPrev() })
  assert.deepEqual(texts(d.flows), [])
  // the pure rule, for levels too: local -> dev -> local leaves no note
  const { prev } = S.notePrev({ 'ABC-1': { level: 'local', at: AFTER } }, { 'ABC-1': 'dev' }, { 'ABC-1': 'local' }, 'level', AFTER)
  assert.deepEqual(prev, {})
})
