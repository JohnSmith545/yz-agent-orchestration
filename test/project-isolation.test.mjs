// One project's data never shows in another (project-store.mjs). Each check runs in a FRESH node process,
// because config.mjs and the stores fix their project when they are first imported, exactly as the server
// does after a switch restarts it. FACTORY_DATA_DIR is a temp folder: projects.json and every project folder
// live under it, so nothing here reads or writes the real data/ folder or a real projects.json.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.dirname(HERE)
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'project-isolation-'))
after(() => fs.rmSync(ROOT, { recursive: true, force: true }))
const PROJECTS = path.join(ROOT, 'projects.json')
const url = f => pathToFileURL(path.join(APP, f)).href

/** Runs `body` (module code with F = flows.mjs, C = config.mjs, S = factory-state.mjs, R = agent-rules.mjs) in a fresh process; its JSON line back. */
function inFresh(body, env = {}) {
  const code = `const F = await import(${JSON.stringify(url('flows.mjs'))}); const C = await import(${JSON.stringify(url('config.mjs'))});` +
    `const S = await import(${JSON.stringify(url('factory-state.mjs'))}); const R = await import(${JSON.stringify(url('agent-rules.mjs'))});` +
    `const out = await (async () => { ${body} })(); console.log(JSON.stringify(out))`
  const env2 = { ...process.env }
  delete env2.YZ_PROJECT // only the test's own `env` may name a project
  Object.assign(env2, { FACTORY_DATA_DIR: ROOT }, env)
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: os.tmpdir(), env: env2, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout.trim().split('\n').pop())
}
const setActive = active => fs.writeFileSync(PROJECTS, JSON.stringify({
  active,
  projects: [
    { id: 'first', name: 'First', primary: true, config: {} },
    { id: 'second', name: 'Second', config: { repo: 'C:/elsewhere/second-repo', coordinator: 'Lead', codingAgents: { Lead: 'Lead', Maker: 'Maker' } } },
  ],
}))
const fixture = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'dark-mode.json'), 'utf8'))

test('with no projects.json the data folder is the root and the config is config.json, as before', () => {
  const out = inFresh('return { dir: F.DATA_DIR, state: S.STATE_FILE, rules: R.RULES_FILE, project: C.CONFIG.project }')
  assert.equal(out.dir, ROOT)
  assert.equal(out.state, path.join(ROOT, 'factory-state.json'))
  assert.equal(out.rules, path.join(ROOT, 'agent-rules.json'))
  assert.equal(out.project, null)
})

test('a flow of the first project stays in the root folder and is not listed in the second', () => {
  setActive('first')
  const wrote = inFresh(`F.writeFlow(${JSON.stringify(fixture)}); return { ids: F.listFlows({ archived: 'any' }).flows.map(f => f.id), dir: F.DATA_DIR, repo: C.CONFIG.repo }`)
  assert.equal(wrote.dir, ROOT)
  assert.deepEqual(wrote.ids, [fixture.id])
  assert.ok(fs.existsSync(path.join(ROOT, 'flows', `${fixture.id}.json`)))

  setActive('second')
  const second = inFresh('return { ids: F.listFlows({ archived: "any" }).flows.map(f => f.id), dir: F.DATA_DIR, state: S.STATE_FILE, rules: R.RULES_FILE, repo: C.CONFIG.repo, coordinator: C.CONFIG.coordinator, agents: C.CONFIG.codingAgents, prefixes: C.CONFIG.ticketPrefixes ?? null, pins: C.CONFIG.pinnedAgents, project: C.CONFIG.project }')
  assert.deepEqual(second.ids, [])
  assert.equal(second.dir, path.join(ROOT, 'projects', 'second'))
  assert.equal(second.state, path.join(ROOT, 'projects', 'second', 'factory-state.json'))
  assert.equal(second.rules, path.join(ROOT, 'projects', 'second', 'agent-rules.json'))
  assert.equal(second.repo, 'C:/elsewhere/second-repo')
  assert.equal(second.coordinator, 'Lead')
  assert.deepEqual(second.agents, { Lead: 'Lead', Maker: 'Maker' })
  assert.equal(second.prefixes, null)
  assert.deepEqual(second.pins, {})
  assert.deepEqual(second.project, { id: 'second', name: 'Second' })

  setActive('first')
  const back = inFresh('return { ids: F.listFlows({ archived: "any" }).flows.map(f => f.id), project: C.CONFIG.project }')
  assert.deepEqual(back.ids, [fixture.id])
  assert.deepEqual(back.project, { id: 'first', name: 'First' })
})

test('YZ_PROJECT names the project outright, whatever is active', () => {
  setActive('first')
  const out = inFresh('return { dir: F.DATA_DIR }', { YZ_PROJECT: 'second' })
  assert.equal(out.dir, path.join(ROOT, 'projects', 'second'))
})

test('a broken projects.json falls back to the first project, never to a guess', () => {
  fs.writeFileSync(PROJECTS, JSON.stringify({ active: 'second', projects: [{ id: 'second', name: 'Second', config: {} }] }))
  const out = inFresh('return { dir: F.DATA_DIR, project: C.CONFIG.project }')
  assert.equal(out.dir, ROOT)
  assert.equal(out.project, null)
})
