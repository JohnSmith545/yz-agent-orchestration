// Tests for public/flow-route.js, the one place the pages draw a flow's route from Request to Output: the
// compact strip on a board card, the step line in an opened flow's head (each step a link to its detail),
// the Agents diagram's highlight and the Explain slide's path chart. Everything reads the server's `route`
// and `progress` (flow-route.mjs withRoute); nothing here works out a stage of its own. A browser script in a
// vm with a stub window; the progress comes from the real flow-route.mjs over a real graph.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-route-ui-test-'))
const { DEFAULT_PIPELINE, pipelineGraph } = await import('../pipeline.mjs')
const { withRoute } = await import('../flow-route.mjs')

const window = {}
vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', 'flow-route.js'), 'utf8'), { window })
const R = window.FlowRoute
const plain = v => JSON.parse(JSON.stringify(v))
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

const G = pipelineGraph({
  coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', 'Agent 2': 'Agent 2' },
  pipeline: { ...DEFAULT_PIPELINE }, factory: { chat: { name: 'Independent' } },
})
const BUILD = ['request', 'master', 'agent-1', 'qa', 'push', 'outcome']
const committed = [{ id: 'n1', type: 'step', title: 'x', status: 'done', evidence: [{ kind: 'commit', ref: 'abc1234' }] }]
const qa = (status, more = {}) => ({ status, attempt: 1, by: 'QA', at: '2026-11-24T10:00:00Z', ...more })
/** A flow as /api/flows sends it: its own fields, plus route and progress from the server. */
function flow(more = {}, steps = BUILD, type = 'build') {
  const f = { id: 'f1', title: 'T', agent: 'Agent 1', status: 'open', createdAt: '2026-11-24T09:00:00Z', nodes: [], route: { type, steps, at: '2026-11-24T09:00:00Z', by: 'Agent 1' }, ...more }
  if (f.route === null) delete f.route
  return { ...f, ...withRoute(f, G) }
}
const edgeIndex = (a, b) => G.edges.findIndex(e => e.from === a && e.to === b)

// ═══ where it stands ═══

test('at: the current step, else the Output once every step is done, else nothing (dropped)', () => {
  assert.equal(R.at(flow().progress), 'agent-1')
  assert.equal(R.at(flow({ status: 'done' }, ['request', 'master', 'agent-1', 'outcome'], 'ask').progress), 'outcome')
  assert.equal(R.at(flow({ status: 'dropped' }).progress), null)
  assert.equal(R.at(undefined), null)
})

test('nowLabel: the current step by its name, Output at the end, dropped when dropped', () => {
  assert.equal(R.nowLabel(flow({ nodes: committed, qa: qa('testing') })), 'QA')
  assert.equal(R.nowLabel(flow({ status: 'done' })), 'Output')
  assert.equal(R.nowLabel(flow({ status: 'dropped' })), 'dropped')
})

test('detailOf: an agent opens on Agents, QA and Push on the QA page, the Output on the Output tab, the Request nowhere', () => {
  assert.deepEqual(['coordinator', 'producer', 'chat', 'qa', 'push', 'outcome', 'request', null].map(R.detailOf), ['agents', 'agents', 'agents', 'qa', 'qa', 'output', null, null])
})

// ═══ the board card's strip ═══

test('strip: every step by name in order, each with its state, the type and where it is now', () => {
  const h = R.strip(flow({ nodes: committed, qa: qa('testing') }))
  assert.match(text(h), /^build · at QA Request Master Agent 1 QA Push Output$/)
  assert.deepEqual([...h.matchAll(/class="rt-s (s-[a-z]+)/g)].map(m => m[1]), ['s-done', 's-done', 's-done', 's-current', 's-upcoming', 's-upcoming'])
  assert.match(h, /aria-label="Route: Request done, Master done, Agent 1 done, QA current, Push upcoming, Output upcoming"/)
})

test('strip: green and red only on the QA step, only for QA passed and failed; neutral everywhere else', () => {
  const passed = R.strip(flow({ status: 'done', nodes: committed, qa: qa('passed', { commit: 'abc1234' }) }))
  assert.equal((passed.match(/qa-ok/g) || []).length, 1)
  assert.match(passed, /rt-s s-done qa-ok"[^>]*>QA</)
  const failed = R.strip(flow({ nodes: committed, qa: qa('failed', { rework: { to: 'Agent 1' } }) }))
  assert.equal((failed.match(/qa-bad/g) || []).length, 1)
  assert.match(failed, /qa-bad"[^>]*>QA</)
  assert.doesNotMatch(R.strip(flow()), /qa-ok|qa-bad/)
})

test('strip: an open flow on an inferred route gets a quiet "route not set"; a set route, or a closed flow, does not', () => {
  assert.match(R.strip(flow({ route: null })), /<span class="rt-unset"[^>]*>route not set<\/span>/)
  assert.doesNotMatch(R.strip(flow()), /route not set/)
  assert.doesNotMatch(R.strip(flow({ route: null, status: 'done' })), /route not set/)
})

test('strip: nothing without progress, and labels are escaped', () => {
  assert.equal(R.strip({ id: 'x' }), '')
  const f = flow()
  f.progress = f.progress.map(s => (s.node === 'master' ? { ...s, label: '<b>M</b>' } : s))
  assert.match(R.strip(f), /&lt;b&gt;M&lt;\/b&gt;/)
})

// ═══ the opened flow's step line ═══

test('line: the full path, each step that has a detail a button naming its flow; the Request is plain; the current one is marked', () => {
  const h = R.line(flow({ nodes: committed, qa: qa('testing') }))
  assert.match(h, /^<nav class="rt-line" aria-label="Path from Request to Output">/)
  assert.deepEqual([...h.matchAll(/data-route-step="([a-z0-9-]+)"/g)].map(m => m[1]), ['master', 'agent-1', 'qa', 'push', 'outcome'])
  assert.ok(h.includes('data-route-flow="f1"'))
  assert.match(h, /<li class="rt-s s-current"[^>]*aria-current="step"/)
  assert.match(text(h), /build Request done Master done Agent 1 done QA current: testing Push upcoming Output upcoming/)
})

test('line: a rework loop shows on the step it went back to, as ×N', () => {
  const h = R.line(flow({ nodes: committed, qa: qa('failed', { rework: { to: 'Agent 1' } }) }))
  assert.match(h, /Agent 1<span class="rt-visits"[^>]*>×2<\/span>/)
})

// ═══ the Agents diagram ═══

test('highlight: done and current are lit with the edges between them; upcoming is the dashed next part', () => {
  const h = plain(R.highlight(G, flow({ nodes: committed, qa: qa('testing') }).progress))
  assert.deepEqual(h.nodes, ['request', 'master', 'agent-1', 'qa'])
  assert.deepEqual(h.edges, [edgeIndex('request', 'master'), edgeIndex('master', 'agent-1'), edgeIndex('agent-1', 'qa')].sort((a, b) => a - b))
  assert.deepEqual(h.next, { nodes: ['push', 'outcome'], edges: [edgeIndex('qa', 'push'), edgeIndex('push', 'outcome')].sort((a, b) => a - b) })
})

test('highlight: a rework lights the return arrow; a flow that skipped QA lights its skip edge; a finished one has no next', () => {
  const back = plain(R.highlight(G, flow({ nodes: committed, qa: qa('failed', { rework: { to: 'Agent 1' } }) }).progress))
  assert.ok(back.edges.includes(G.edges.findIndex(e => e.from === 'qa' && e.to === 'agent-1' && e.kind === 'rework')))
  const skipped = plain(R.highlight(G, flow({ status: 'done' }).progress))
  // the no code changes lane: past Human task (it did not stop there) to the Output
  assert.ok(skipped.edges.includes(edgeIndex('agent-1', 'human')))
  assert.ok(skipped.edges.includes(edgeIndex('human', 'outcome')))
  assert.ok(!skipped.nodes.includes('human'), 'a box it went past is not lit')
  assert.ok(!skipped.nodes.includes('qa'))
  assert.deepEqual(skipped.next, { nodes: [], edges: [] })
  assert.equal(R.highlight(G, undefined), null)
})

// ═══ the Explain slide ═══

test('chart: the steps it took and the ones ahead; the current one says its state, the ones ahead are dashed, skipped ones left out', () => {
  const c = plain(R.chart(flow({ nodes: committed, qa: qa('testing') })))
  assert.deepEqual(c.nodes.map(n => n.id), BUILD)
  assert.deepEqual(c.nodes.find(n => n.id === 'qa'), { id: 'qa', label: 'QA', kind: 'box', cls: 'xp-now', sub: 'now: testing' })
  assert.equal(c.nodes.find(n => n.id === 'push').cls, 'xp-next')
  assert.equal(c.nodes.find(n => n.id === 'request').kind, 'actor')
  assert.deepEqual(c.edges.map(e => `${e.from}>${e.to}${e.cls ? ':' + e.cls : ''}`), ['request>master', 'master>agent-1', 'agent-1>qa', 'qa>push:xp-next', 'push>outcome:xp-next'])
  const skipped = plain(R.chart(flow({ status: 'done' })))
  assert.deepEqual(skipped.nodes.map(n => n.id), ['request', 'master', 'agent-1', 'outcome'])
  assert.ok(skipped.edges.some(e => e.from === 'agent-1' && e.to === 'outcome'))
})

test('chart: a rework is a return arrow labelled failed, ×N when it went back more than once', () => {
  const once = plain(R.chart(flow({ nodes: committed, qa: qa('failed', { rework: { to: 'Agent 1' } }) })))
  assert.deepEqual(once.edges.find(e => e.from === 'qa' && e.to === 'agent-1'), { from: 'qa', to: 'agent-1', label: 'failed', cls: 'xp-rework' })
  const twice = flow({ nodes: committed, qa: qa('failed', { attempt: 2, rework: { to: 'Agent 1' }, attempts: [qa('failed', { rework: { to: 'Agent 1' } })] }) })
  assert.equal(plain(R.chart(twice)).edges.find(e => e.from === 'qa' && e.to === 'agent-1').label, 'failed ×2')
  assert.equal(R.chart({ id: 'x' }), null)
})

test('where: one line under the chart: where it is now and how often it went back, or that it reached the Output', () => {
  assert.equal(R.where(flow({ nodes: committed, qa: qa('testing') })), 'Now at QA · testing')
  assert.equal(R.where(flow({ nodes: committed, qa: qa('failed', { rework: { to: 'Agent 1' } }) })), 'Now at Agent 1 · rework · sent back once')
  assert.equal(R.where(flow({ status: 'done' })), 'Reached the Output')
})

// ═══ a click on a step ═══

test('go: an agent step opens that node on Agents with this flow selected, QA and Push the QA page, the Output the Output tab', () => {
  const calls = []
  window.AgentsPage = { showNode: (node, id) => calls.push(['agents', node, id]) }
  window.QaPage = { gotoFlow: id => calls.push(['qa', id]) }
  window.FlowsView = { gotoFlow: (id, node, as) => calls.push(['flows', id, node, as]) }
  R.go('f1', 'agent-1', 'producer')
  R.go('f1', 'push', 'push')
  R.go('f1', 'outcome', 'outcome')
  R.go('f1', 'request', 'request')
  assert.deepEqual(plain(calls), [['agents', 'agent-1', 'f1'], ['qa', 'f1'], ['flows', 'f1', null, 'output']])
})

// ═══ the Agents page reads progress too ═══

const PUB = path.join(HERE, '..', 'public')
const read = f => fs.readFileSync(path.join(PUB, f), 'utf8')

test('the side panel and the chips read progress: each row says the type and the current step; a chip sits where progress says', () => {
  const win = { FlowRoute: R }
  vm.runInNewContext(read('pipeline-tickets.js'), { window: win, location: { hash: '' } })
  const T = win.PipelineTickets
  const testing = { ...flow({ nodes: committed, qa: qa('testing') }), stage: { node: 'qa', status: 'testing', path: [] } }
  const done = { ...flow({ id: 'f2', status: 'done' }, ['request', 'master', 'agent-1', 'outcome'], 'ask'), id: 'f2', stage: { node: 'outcome', status: 'done', path: [] } }
  assert.deepEqual(Object.keys(plain(T.byNode([testing, done]))).sort(), ['outcome', 'qa'])
  const rows = T.ticketsHtml([testing, done], { labels: T.labelsOf(G) })
  assert.match(rows, /<span class="pl-row-stage">build · QA<\/span>/)
  assert.match(rows, /<span class="pl-row-stage">ask · Output<\/span>/)
  // a stage that left the route: the chip follows progress, not the stage
  const off = { ...testing, id: 'f3', stage: { node: 'agent-2', status: 'working', path: [] } }
  assert.deepEqual(Object.keys(plain(T.byNode([off]))), ['qa'])
})

test('the Agents page lights a selected flow with FlowRoute.highlight over its progress; the old stage-path highlight is gone', () => {
  const page = read('agents-page.js')
  assert.match(page, /view\.setPath\(ticket \? window\.FlowRoute\.highlight\(graph, ticket\.progress\) : null\)/)
  assert.doesNotMatch(page, /stage\?\.path/)
  assert.match(page, /showNode\(/, 'a step clicked in a flow head opens its node here')
  assert.doesNotMatch(read('pipeline-layout.js'), /function highlight/)
  const view = read('pipeline-view.js')
  assert.match(view, /classList\.toggle\('next'/, 'the steps ahead get their own class')
  const css = read('pipeline.css')
  assert.match(css, /\.pl-node\.next\s*\{[^}]*dashed[^}]*var\(--accent\)/, 'upcoming: a dashed accent outline')
  assert.match(css, /\.pl-edge\.next \.pl-line\s*\{[^}]*stroke-dasharray/)
})

test('the route script loads before every page that draws a route, and npm run check covers the new files', () => {
  const html = read('index.html')
  const at = s => html.indexOf(`<script src="${s}"></script>`)
  assert.ok(at('flow-route.js') > 0)
  for (const f of ['pipeline-tickets.js', 'agents-page.js', 'flow-board.js', 'flow-head.js', 'flow-explain.js', 'qa-view.js']) assert.ok(at('flow-route.js') < at(f), f)
  assert.match(html, /<link rel="stylesheet" href="flow-route\.css">/)
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
  for (const f of ['flow-route.mjs', 'tools/route-cli.mjs', 'public/flow-route.js']) assert.ok(pkg.checkList.includes(`node --check ${f}`), f)
})

test('flow-route.css: the current step in the accent, done neutral filled, upcoming outlined, green and red only for QA', () => {
  const css = read('flow-route.css')
  assert.match(css, /\.rt-s\.s-current[^{]*\{[^}]*var\(--accent\)/)
  assert.match(css, /\.rt-s\.s-done[^{]*\{[^}]*background:\s*var\(--surface-3\)/)
  assert.match(css, /\.rt-s\.s-upcoming[^{]*\{[^}]*border:\s*1px solid var\(--line-strong\)/)
  const colours = [...css.matchAll(/var\(--(ok|bad)\)/g)].length
  assert.ok(colours >= 2)
  for (const rule of css.split('}')) if (/var\(--(ok|bad)\)/.test(rule)) assert.match(rule, /\.qa-(ok|bad)/, rule)
  assert.match(css, /\.rt-sr\s*\{[^}]*position:\s*absolute/, 'the state words are for screen readers')
})
