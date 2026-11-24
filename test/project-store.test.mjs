// Tests for project-store.mjs: projects.json, which project is the current one, where its data lives, and how
// its config is put together from config.json. The resolvers are pure; the file helpers take the file as an
// argument. FACTORY_DATA_DIR points at a fresh temp folder BEFORE the import, so the module's own defaults
// (DATA_ROOT, PROJECTS_FILE) never name the real folder.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'project-store-test-'))
process.env.FACTORY_DATA_DIR = ROOT
const P = await import('../project-store.mjs')
after(() => fs.rmSync(ROOT, { recursive: true, force: true }))

const BASE = {
  repo: 'C:/Users/me/flinki-v2', port: 4317, sessionCwdMatch: 'flinki-v2', coordinator: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1' }, aliases: { x: 'X' }, ticketPrefixes: ['FLA'],
  pinnedAgents: { 'Agent 1': { sessionId: 'abc', cwd: 'C:/Users/me/flinki-v2' } }, claudeDirs: ['C:/second'],
  pipeline: { qa: 'QA', maxReworks: 2 }, levels: { work: 'followup' }, pr: { enabled: false, bases: ['dev'] },
  factory: { collections: [{ id: 'prod' }], me: 'me-id', chat: { name: 'Independent', forkFrom: 'sess', model: 'claude-opus-5-5' }, relayModel: 'm' },
}
const STORE = {
  active: 'flinki-v2',
  projects: [
    { id: 'flinki-v2', name: 'Flinki v2', primary: true, config: {} },
    { id: 'dash', name: 'Dashboard', config: { repo: 'C:/Users/me/agent-dashboard', sessionCwdMatch: 'agent-dashboard', coordinator: 'Lead', codingAgents: { Lead: 'Lead' } } },
  ],
}
const tmp = () => fs.mkdtempSync(path.join(ROOT, 'f-'))

test('FACTORY_DATA_DIR is the root of everything: the data, projects.json and the project folders', () => {
  assert.equal(P.DATA_ROOT, ROOT)
  assert.equal(P.PROJECTS_FILE, path.join(ROOT, 'projects.json'))
  assert.equal(P.projectDataDir({ id: 'flinki-v2', primary: true }), ROOT)
  assert.equal(P.projectDataDir({ id: 'dash' }), path.join(ROOT, 'projects', 'dash'))
})

test('with no projects.json there is no project store, and the data folder is the root, as before', () => {
  assert.equal(P.PROJECTS, null)
  assert.equal(P.CURRENT_PROJECT, null)
  assert.equal(P.DATA_DIR, ROOT)
})

test('a well formed store is kept; the active id must name a project, else the primary one is active', () => {
  const s = P.cleanProjects(STORE)
  assert.equal(s.active, 'flinki-v2')
  assert.deepEqual(s.projects.map(p => [p.id, p.name, !!p.primary]), [['flinki-v2', 'Flinki v2', true], ['dash', 'Dashboard', false]])
  assert.equal(P.cleanProjects({ ...STORE, active: 'nope' }).active, 'flinki-v2')
  assert.equal(P.cleanProjects({ ...STORE, active: 'dash' }).active, 'dash')
})

test('a store without exactly one primary project is broken: the dashboard falls back to config.json alone', () => {
  // ⚠️ the primary project owns the root data folder: guessing it would show one project's data in another
  assert.equal(P.cleanProjects({ active: 'a', projects: [{ id: 'a', name: 'A', config: {} }] }), null)
  assert.equal(P.cleanProjects({ active: 'a', projects: [{ id: 'a', name: 'A', primary: true }, { id: 'b', name: 'B', primary: true }] }), null)
  assert.equal(P.cleanProjects({ active: 'a', projects: [{ id: 'A B', name: 'A', primary: true }] }), null)
  assert.equal(P.cleanProjects(null), null)
  assert.equal(P.cleanProjects({ projects: 'x' }), null)
  assert.equal(P.cleanProjects({ projects: [] }), null)
})

test('a bad second entry is left out; two entries with one id keep the first', () => {
  const s = P.cleanProjects({ active: 'a', projects: [{ id: 'a', name: 'A', primary: true }, { id: '../x', name: 'Bad' }, 7, { id: 'a', name: 'Again' }, { id: 'b', name: ' B ', config: [] }] })
  assert.deepEqual(s.projects.map(p => [p.id, p.name]), [['a', 'A'], ['b', 'B']])
  assert.deepEqual(s.projects[1].config, {}) // a config that is not an object reads as empty
})

test('a project id is a short slug: anything that could leave the projects folder is refused', () => {
  for (const ok of ['a', 'flinki-v2', 'x1-2-3']) assert.ok(P.PROJECT_ID.test(ok), ok)
  for (const bad of ['', '-a', 'A', 'a/b', '..', 'a b', 'a.b', 'x'.repeat(41), 'a\\b']) assert.ok(!P.PROJECT_ID.test(bad), bad)
})

test('readProjects: missing is null, broken JSON is null with one warning, a good file is cleaned', () => {
  const dir = tmp()
  const file = path.join(dir, 'projects.json')
  assert.equal(P.readProjects(file), null)
  fs.writeFileSync(file, '{ not json')
  const said = []
  assert.equal(P.readProjects(file, m => said.push(m)), null)
  assert.equal(said.length, 1)
  assert.match(said[0], /projects\.json/)
  P.writeProjects(STORE, file)
  assert.deepEqual(P.readProjects(file).projects.map(p => p.id), ['flinki-v2', 'dash'])
})

test('the primary project is config.json with its own overrides on top', () => {
  const s = P.cleanProjects(STORE)
  const raw = P.projectRaw(BASE, s, s.projects[0])
  assert.deepEqual(raw, BASE)
  const over = P.projectRaw(BASE, s, { ...s.projects[0], config: { coordinatorLabel: 'Boss', factory: { chat: { name: 'Helper' } } } })
  assert.equal(over.coordinatorLabel, 'Boss')
  assert.equal(over.factory.chat.name, 'Helper')
  assert.equal(over.factory.chat.model, 'claude-opus-5-5') // merged one level down, not replaced
  assert.deepEqual(over.factory.collections, [{ id: 'prod' }])
})

test('another project takes NOTHING of the first one: no repo, sessions, tickets, agents, pins or pipeline', () => {
  const s = P.cleanProjects(STORE)
  const raw = P.projectRaw(BASE, s, s.projects[1])
  assert.equal(raw.repo, 'C:/Users/me/agent-dashboard')
  assert.equal(raw.coordinator, 'Lead')
  assert.deepEqual(raw.codingAgents, { Lead: 'Lead' })
  for (const k of ['aliases', 'ticketPrefixes', 'pinnedAgents', 'pipeline', 'levels', 'coordinatorLabel']) assert.equal(raw[k], undefined, k)
  assert.equal(raw.factory.collections, undefined)
  assert.equal(raw.factory.me, undefined)
  assert.equal(raw.factory.chat.name, undefined)
  assert.equal(raw.factory.chat.forkFrom, undefined)
  // the machine settings stay shared
  assert.equal(raw.port, 4317)
  assert.deepEqual(raw.claudeDirs, ['C:/second'])
  assert.deepEqual(raw.pr, BASE.pr)
  assert.equal(raw.factory.chat.model, 'claude-opus-5-5')
  assert.equal(raw.factory.relayModel, 'm')
  assert.deepEqual(BASE.factory.collections, [{ id: 'prod' }]) // the base is never changed
})

test('no store: the raw config is config.json as it is', () => {
  assert.equal(P.projectRaw(BASE, null, null), BASE)
})

test('the server uses the active project; YZ_PROJECT names one outright', () => {
  const s = P.cleanProjects({ ...STORE, active: 'dash' })
  assert.equal(P.pickProject(s, { server: true, cwd: 'C:/Users/me/flinki-v2', env: {}, base: () => BASE }).id, 'dash')
  assert.equal(P.pickProject(s, { server: true, cwd: 'x', env: { YZ_PROJECT: 'flinki-v2' }, base: () => BASE }).id, 'flinki-v2')
  assert.equal(P.pickProject(s, { server: true, cwd: 'x', env: { YZ_PROJECT: 'gone' }, base: () => BASE }).id, 'dash')
  assert.equal(P.pickProject(null, { server: true, cwd: 'x', env: {}, base: () => BASE }), null)
})

test('a command run from inside a project repo writes to THAT project, whichever one the page shows', () => {
  // agents run tools/factory.mjs from their own worktree: a flow of Flinki must never land in another project
  const s = P.cleanProjects({ ...STORE, active: 'dash' })
  const pick = cwd => P.pickProject(s, { server: false, cwd, env: {}, base: () => BASE }).id
  assert.equal(pick('C:\\Users\\me\\flinki-v2\\.claude\\worktrees\\wave2'), 'flinki-v2')
  assert.equal(pick('c:/users/me/flinki-v2'), 'flinki-v2')
  assert.equal(pick('C:/Users/me/agent-dashboard/.worktrees/x'), 'dash')
  assert.equal(pick('D:/somewhere/else'), 'dash') // no match: the active one
})

test('the cwd match prefers the repo folder itself over a looser name match', () => {
  const s = P.cleanProjects({
    active: 'a',
    projects: [
      { id: 'a', name: 'A', primary: true },
      { id: 'b', name: 'B', config: { repo: 'C:/work/app-v2', sessionCwdMatch: 'app' } },
    ],
  })
  const base = { repo: 'C:/work/app', sessionCwdMatch: 'app' }
  const pick = cwd => P.pickProject(s, { server: false, cwd, env: {}, base: () => base }).id
  assert.equal(pick('C:/work/app-v2/src'), 'b')
  assert.equal(pick('C:/work/app/src'), 'a')
})

test('slugs and names for new projects', () => {
  assert.equal(P.slugOf('Flinki v2'), 'flinki-v2')
  assert.equal(P.slugOf('  Ünïcode & Co!  '), 'n-code-co')
  assert.equal(P.slugOf('***'), 'project')
  assert.equal(P.slugOf('x'.repeat(60)).length, 40)
  assert.equal(P.prettyName('C:/Users/me/flinki-v2'), 'Flinki v2')
  assert.equal(P.prettyName('C:/Users/me/agent_dashboard/'), 'Agent dashboard')
  assert.equal(P.prettyName(''), 'This project')
})

test('the store the page sees with no projects.json: the one project of config.json, active', () => {
  const s = P.effectiveStore(null, BASE)
  assert.deepEqual(s, { active: 'flinki-v2', projects: [{ id: 'flinki-v2', name: 'Flinki v2', primary: true, config: {} }] })
  assert.equal(P.effectiveStore(P.cleanProjects(STORE), BASE).projects.length, 2)
})
