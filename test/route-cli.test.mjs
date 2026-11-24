// Tests for the route commands (tools/route-cli.mjs, behind `node tools/factory.mjs flow …`): every request
// gets a flow FIRST, with its type, so `flow new` needs --type and a NEW flow written whole needs a route;
// a rewrite keeps the stored route; `flow route` is the one way to change it, and the old plan stays in its
// history; `decide` makes an ask flow; `flow show` says the route and where the flow is on it.
// FACTORY_DATA_DIR points at a fresh temp folder BEFORE the imports; the graph comes from a test config.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'route-cli-test-'))
const F = await import('../flows.mjs')
const { runFlow } = await import('../tools/flow-cli.mjs')
const { DEFAULT_PIPELINE } = await import('../pipeline.mjs')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'route-cli-files-'))
after(() => {
  fs.rmSync(F.DATA_DIR, { recursive: true, force: true })
  fs.rmSync(TMP, { recursive: true, force: true })
})

const config = {
  coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', 'Agent 2': 'Agent 2', 'Agent 3': 'Agent 3' },
  pipeline: { ...DEFAULT_PIPELINE }, factory: { chat: { name: 'Independent' } },
}
const as = by => (...argv) => runFlow(argv, { by, cwd: TMP, config })
const run = as('Agent 3')
const BUILD3 = ['request', 'master', 'agent-3', 'qa', 'push', 'outcome']
const writeFile = (name, body) => {
  const file = path.join(TMP, name)
  fs.writeFileSync(file, JSON.stringify(body))
  return file
}
const bare = id => ({ id, title: 'Plan', agent: 'Agent 3', status: 'open', nodes: [{ id: 'n1', type: 'step', title: 'Do it', status: 'todo' }] })

// ═══ flow new ═══

test('flow new without --type is refused in one line that names the three types, and writes nothing', () => {
  const r = run('new', 'untyped', 'No type')
  assert.equal(r.code, 1)
  assert.match(r.out, /^flow new needs --type build\|review\|ask: build for a code change/)
  assert.doesNotMatch(r.out, /\n/)
  assert.equal(F.readFlow('untyped'), null)
})

test('flow new --type build plans Request, the coordinator, the agent, QA, Push, Output, signed and timed', () => {
  assert.deepEqual(run('new', 'dark', 'Add a dark mode toggle', '--type', 'build', '--tickets', 'ABC-1'), { out: 'Flow dark created', code: 0 })
  const { route } = F.readFlow('dark')
  assert.equal(route.type, 'build')
  assert.deepEqual(route.steps, BUILD3)
  assert.equal(route.by, 'Agent 3')
  assert.ok(!Number.isNaN(Date.parse(route.at)))
  assert.equal(route.history, undefined)
})

test('flow new: the coordinator building its own change skips a producer; the chat agent asks and reviews', () => {
  assert.equal(as('Master')('new', 'own', 'Own change', '--type', 'build').code, 0)
  assert.deepEqual(F.readFlow('own').route.steps, ['request', 'master', 'qa', 'push', 'outcome'])
  assert.equal(as('Independent')('new', 'rev', 'Review ABC-2', '--type', 'review').code, 0)
  assert.deepEqual(F.readFlow('rev').route.steps, ['request', 'independent', 'outcome'])
  assert.equal(as('Agent 1')('new', 'why', 'Why is it slow?', '--type', 'ask').code, 0)
  assert.deepEqual(F.readFlow('why').route.steps, ['request', 'master', 'agent-1', 'outcome'])
})

test('flow new refuses a type the agent has no route for, or a type that does not exist', () => {
  for (const [by, type, why] of [['Agent 3', 'review', /a review is Independent's/], ['Independent', 'build', /makes no code changes/], ['Agent 3', 'fix', /--type build\|review\|ask/]]) {
    const r = as(by)('new', `no-${type}`, 'X', '--type', type)
    assert.equal(r.code, 1, `${by} ${type}`)
    assert.match(r.out, why)
    assert.equal(F.readFlow(`no-${type}`), null)
  }
})

// ═══ flow route ═══

test('flow route changes the plan on purpose: the old route goes into history and the line says what it was', () => {
  run('new', 'swap', 'Look into it', '--type', 'ask')
  const r = run('route', 'swap', '--type', 'build')
  assert.equal(r.code, 0)
  assert.match(r.out, /^Flow swap route: build, Request -> Master -> Agent 3 -> QA -> Push -> Output; was ask$/)
  const { route } = F.readFlow('swap')
  assert.deepEqual(route.steps, BUILD3)
  assert.equal(route.history.length, 1)
  assert.equal(route.history[0].type, 'ask')
})

test('flow route with the same plan changes nothing; with no --type or no name it says what is missing', () => {
  const before = F.readFlow('swap').route
  assert.match(run('route', 'swap', '--type', 'build').out, /route unchanged/)
  assert.deepEqual(F.readFlow('swap').route, before)
  assert.match(run('route', 'swap').out, /flow route needs --type build\|review\|ask/)
  assert.match(as('')('route', 'swap', '--type', 'ask').out, /say who you are/)
  assert.match(run('route', 'swap', '--type', 'review').out, /a review is Independent's/)
})

test('flow route sets a route on a flow written before routes, with no history', () => {
  F.writeFlow(bare('legacy'))
  assert.equal(run('route', 'legacy', '--type', 'build').code, 0)
  assert.equal(F.readFlow('legacy').route.history, undefined)
})

// ═══ flow write ═══

test('flow write of a NEW flow with no route is refused and says how to give one', () => {
  const r = run('write', writeFile('n.json', bare('new-plain')))
  assert.equal(r.code, 1)
  assert.match(r.out, /a new flow needs a route: add "route": \{ "type": "build" \}/)
  assert.equal(F.readFlow('new-plain'), null)
})

test('flow write of a new flow with route { type } plans the steps for its agent; given steps must fit the pipeline', () => {
  assert.equal(run('write', writeFile('t.json', { ...bare('typed'), route: { type: 'build' } })).code, 0)
  const { route } = F.readFlow('typed')
  assert.deepEqual([route.type, route.steps, route.by], ['build', BUILD3, 'Agent 3'])
  const off = run('write', writeFile('o.json', { ...bare('off'), route: { type: 'ask', steps: ['request', 'agent-3', 'outcome'] } }))
  assert.equal(off.code, 1)
  assert.match(off.out, /from request to agent-3/)
  const fits = run('write', writeFile('s.json', { ...bare('fits'), route: { type: 'ask', steps: ['request', 'master', 'agent-3', 'outcome'] } }))
  assert.equal(fits.code, 0, fits.out)
})

test('a rewrite keeps the stored route: with none in the file silently, with another one and a warning to use flow route', () => {
  const stored = F.readFlow('typed').route
  assert.deepEqual(run('write', writeFile('r1.json', { ...bare('typed'), title: 'Plan again' })), { out: 'Flow typed written', code: 0 })
  assert.deepEqual(F.readFlow('typed').route, stored)
  const r = run('write', writeFile('r2.json', { ...bare('typed'), route: { type: 'ask' } }))
  assert.equal(r.code, 0)
  assert.match(r.err, /route kept: change it with flow route typed --type/)
  assert.deepEqual(F.readFlow('typed').route, stored)
})

test('a rewrite of a flow from before routes needs none, and may give one', () => {
  F.writeFlow(bare('old'))
  assert.equal(run('write', writeFile('old.json', { ...bare('old'), title: 'Still old' })).code, 0)
  assert.equal(F.readFlow('old').route, undefined)
  assert.equal(run('write', writeFile('old2.json', { ...bare('old'), route: { type: 'ask' } })).code, 0)
  assert.equal(F.readFlow('old').route.type, 'ask')
})

// ═══ show and decide ═══

test('flow show says the route on stderr and where the flow is on it; an inferred one says to set it', () => {
  const shown = run('show', 'dark')
  assert.match(shown.err, /route: build, Request -> Master -> Agent 3 -> QA -> Push -> Output; now at Agent 3 \(working\)/)
  F.writeFlow(bare('guess'))
  assert.match(run('show', 'guess').err, /route: ask \(inferred: set it with flow route guess --type build\|review\|ask\)/)
})

test('decide makes an ask flow', () => {
  const r = spawnSync(process.execPath, ['tools/factory.mjs', 'decide', '--question', 'Go ahead?', '--why', 'It unblocks the deploy', '--by', 'Agent 2'], {
    cwd: ROOT, env: { ...process.env, FACTORY_DATA_DIR: F.DATA_DIR }, encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  const made = F.listFlows().flows.find(f => f.title === 'Go ahead?')
  assert.equal(made.route.type, 'ask')
  assert.equal(made.route.steps.at(-1), 'outcome')
})

// ═══ the brief agents get says it ═══

test('the agent brief, the user guide and the README tell every agent: a flow first, with --type, following its route', () => {
  const doc = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\s*\n>?\s*/g, ' ')
  for (const f of ['docs/agent-brief.md', 'docs/USER_GUIDE.md', 'README.md']) {
    const d = doc(f)
    assert.match(d, /Every request gets a flow FIRST, before you change anything: `flow new <id> "<title>" --type build\|review\|ask`/, f)
    assert.match(d, /`flow route <flow> --type \.\.\.`/, f)
    assert.match(d, /Start with `flow new --type` or `flow write`/, f)
    assert.doesNotMatch(d, /flow new [a-z0-9-]+ "[^"]+" --tickets/, `${f}: every example says its type`)
  }
  const readme = doc('README.md')
  assert.match(readme, /### Flow types and routes/)
  assert.match(readme, /flow route <flow> --type build\|review\|ask/)
  assert.match(readme, /`#\/` opens Flows/)
  assert.doesNotMatch(readme, /Outcome/, 'the end of the pipeline reads Output everywhere')
  for (const f of ['docs/qa-agent-brief.md', 'docs/USER_GUIDE.md']) assert.doesNotMatch(doc(f), /Outcome/, f)
})
