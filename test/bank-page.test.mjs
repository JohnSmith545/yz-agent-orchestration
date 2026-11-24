// Tests for public/bank-page.js (the Orchestration bank page) and its place in the shell: the route #/bank, one
// entry #/bank/<id> and its Use confirmation #/bank/<id>/use, the rail link and the palette. Browser scripts in a
// vm with a bare window: only the pure half runs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8')
const w = {}
vm.runInNewContext(read('bank-page.js'), { window: w })
const P = w.BankPage
const shellWindow = {}
vm.runInNewContext(read('shell.js'), { window: shellWindow })
const resolve = h => JSON.parse(JSON.stringify(shellWindow.Shell.resolve(h)))

const ENTRIES = [
  { id: 'o00000002', name: 'Careful <two>', savedAt: '2026-11-25T09:05:00.000Z', from: { id: 'dash', name: 'Dash' }, summary: 'Master hands to 2 agents, QA tests, 4 rules' },
  { id: 'o00000001', name: 'Flinki default', savedAt: '2026-11-24T09:05:00.000Z', from: { id: 'flinki-v2', name: 'Flinki v2' }, summary: 'Master hands to 3 agents, QA tests, 6 rules' },
]
const VIEW = {
  graph: { nodes: [], edges: [] },
  summary: 'Master hands to 2 agents, QA tests, 3 rules',
  agents: [
    { label: 'Master', role: 'coordinator', spec: '', rules: [] },
    { label: 'Agent 1', role: 'producer', spec: 'Builds <web>.', rules: ['One.', 'Two.'] },
    { label: 'Agent 2', role: 'producer', spec: '', rules: [] },
    { label: 'Independent', role: 'chat', spec: '', rules: [] },
    { label: 'QA', role: 'qa', spec: '', rules: ['Push what you tested.'] },
  ],
}

test('the routes: #/bank, one entry, its Use confirmation', () => {
  assert.deepEqual(resolve('#/bank'), { view: 'bank', params: {}, redirect: null })
  assert.deepEqual(resolve('#/bank/o00000001'), { view: 'bank', params: { id: 'o00000001', mode: null }, redirect: null })
  assert.deepEqual(resolve('#/bank/o00000001/use'), { view: 'bank', params: { id: 'o00000001', mode: 'use' }, redirect: null })
})

test('the shell wires it: a title, a section, the page object, an icon, a rail link after Agents, and the palette', () => {
  const shell = read('shell.js')
  assert.match(shell, /bank: 'Orchestration bank'/)
  assert.match(shell, /bank: 'bankView'/)
  assert.match(shell, /bank: 'BankPage'/)
  assert.match(shell, /bank: svg\(/)
  assert.match(shell, /a\.rail-item\[data-view="agents"\]'\)\?\.insertAdjacentHTML\?\.\('afterend', link\('bank', '#\/bank', 'Orchestration bank'\)\)/)
  assert.match(read('index.html'), /<section id="bankView" aria-label="Orchestration bank" hidden><\/section>/)
  assert.match(read('index.html'), /<script src="bank-page\.js"><\/script>/)
  assert.match(read('palette.js'), /\['Orchestration bank', '#\/bank'\]/)
})

test('the list: each saved style with its name, time, project and summary, newest first as given, escaped', () => {
  const html = P.listHtml({ entries: ENTRIES, used: { id: 'o00000001', name: 'Flinki default' }, current: { id: 'flinki-v2', name: 'Flinki v2' } })
  assert.ok(html.indexOf('Careful &lt;two&gt;') < html.indexOf('Flinki default'))
  assert.match(html, /Saved \d{1,2} Nov 2026, \d{2}:\d{2} from Dash/)
  assert.match(html, /Master hands to 3 agents, QA tests, 6 rules/)
  assert.equal((html.match(/In use here/g) || []).length, 1)
  for (const a of ['Open', 'Rename', 'Duplicate', 'Delete', 'Use on this project']) assert.match(html, new RegExp(`>${a}<`))
  assert.match(html, /href="#\/bank\/o00000002\/use"/)
  assert.match(html, /data-bk-save>Save the current orchestration…/)
})

test('an empty bank says what to do; the seeded entry is named once', () => {
  assert.match(P.listHtml({ entries: [], current: { name: 'Flinki v2' } }), /Nothing saved yet/)
  assert.match(P.listHtml({ entries: ENTRIES, seeded: { id: 'o00000001', name: 'Flinki v2, 25 Nov 2026' } }), /was saved here as <b>Flinki v2, 25 Nov 2026<\/b>/)
})

test('rename in place, and delete asks on the page that no project changes', () => {
  const r = P.listHtml({ entries: ENTRIES, renaming: 'o00000002', draft: 'New name' })
  assert.match(r, /data-bk-rename-form="o00000002"/)
  assert.match(r, /value="New name"/)
  const d = P.listHtml({ entries: ENTRIES, deleting: 'o00000001' })
  assert.match(d, /Delete Flinki default\?/)
  assert.match(d, /Only the bank changes: no project loses its orchestration\./)
  assert.match(d, /data-bk-delete-yes="o00000001"/)
  assert.ok(!/confirm\(/.test(read('bank-page.js')), 'never window.confirm')
})

test('the save form starts from a dated name', () => {
  assert.match(P.listHtml({ entries: [], saving: true, saveName: 'Flinki v2, 25 Nov 2026, 10:05' }), /data-bk-save-form.*value="Flinki v2, 25 Nov 2026, 10:05"/)
})

test('one entry opened: the diagram box and each agent with its role, specification and rules', () => {
  const html = P.entryHtml({ entry: ENTRIES[0], view: VIEW, noSession: [], current: { summary: 'x' }, inUse: false })
  assert.match(html, /data-bk-diagram/)
  assert.match(html, /<h3>Agent 1 <span class="bk-role">writes code<\/span><\/h3><p class="bk-spec">Builds &lt;web&gt;\.<\/p><ol><li>One\.<\/li><li>Two\.<\/li><\/ol>/)
  assert.match(html, /<h3>QA <span class="bk-role">tests, then pushes<\/span>/)
  assert.match(html, /No specification or rules\./)
  assert.match(html, /href="#\/bank\/o00000002\/use">Use on this project/)
})

test('the Use confirmation says what changes, that the style in use is saved first, and which agents have no session', () => {
  const html = P.confirmHtml({ entry: ENTRIES[0], view: VIEW, noSession: ['Agent 2', 'QA'], current: { summary: 'Master hands to 3 agents, QA tests, 6 rules' }, project: { name: 'Flinki v2' } })
  assert.match(html, /Use Careful &lt;two&gt; on Flinki v2\?/)
  assert.match(html, /Master hands work to Agent 1 and Agent 2; QA tests and pushes; Independent answers in Ask\./)
  assert.match(html, /Their saved specifications and rules \(3 rules for 2 agents\) replace the ones they have now\./)
  assert.match(html, /The orchestration in use now \(Master hands to 3 agents, QA tests, 6 rules\) is saved to the bank first, under a dated name, so you can switch back\./)
  assert.match(html, /Agent 2 and QA have no session in Flinki v2 yet\. They are set up all the same/)
  assert.match(html, /The dashboard restarts to load it/)
  assert.match(html, /data-bk-use-yes="o00000002">Use Careful &lt;two&gt;/)
  assert.match(html, /href="#\/bank\/o00000002">Cancel/)
  const one = P.confirmHtml({ entry: ENTRIES[0], view: { ...VIEW, agents: VIEW.agents.map(a => ({ ...a, spec: '', rules: [] })) }, noSession: ['QA'], current: {}, project: { name: 'X' } })
  assert.match(one, /QA has no session in X yet\. It is set up all the same/)
  assert.match(one, /These agents get no specification and no rules; any they have now are cleared\./)
  assert.match(P.confirmHtml({ entry: ENTRIES[0], view: VIEW, noSession: [], current: {}, project: {}, using: true }), /disabled>Saving…/)
})

test('times read short and local; nonsense reads as nothing', () => {
  const d = new Date(2026, 10, 25, 9, 5)
  assert.equal(P.whenText(d.toISOString()), '25 Nov 2026, 09:05')
  assert.equal(P.whenText('nope'), '')
  assert.equal(P.whenText(null), '')
})
