// The live agent view (public/agent.js) shows edited files relative to the
// watched repo, by that repo's own folder name (sent as repoName by
// /api/agent), and the orchestration grid (public/orchestration.js) shortens a
// chip to its number only for the collection's own prefix (sent as prefix by
// /api/orchestration). Both are browser scripts, run here in vm contexts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const pub = f => fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8')

const ctx = vm.createContext({ window: {} })
for (const f of ['shell.js', 'app.js', 'agent.js']) vm.runInContext(pub(f), ctx)
const { shortPath } = ctx.window.AgentView

const el = () => ({ addEventListener() {}, appendChild() {}, querySelector: () => el(), style: {} })
const orch = {}
vm.runInNewContext(pub('orchestration.js'), { window: orch, document: { ...el(), body: el(), createElement: el } })
const { chipLabel } = orch.OrchestrationGrid

test('agent view: a path inside the repo loses everything up to the repo folder', () => {
  assert.equal(shortPath('C:\\path\\to\\acme-app\\src\\a.js', 'acme-app'), 'src/a.js')
  assert.equal(shortPath('/home/dev/widgets/lib/b.ts', 'widgets'), 'lib/b.ts')
})

test('agent view: a worktree path keeps its worktree name, as before', () => {
  assert.equal(shortPath('C:/path/to/acme-app/.claude/worktrees/abc-1-x/src/a.js', 'acme-app'), 'abc-1-x/src/a.js')
})

test('agent view: without a repo name, or outside the repo, the path stays whole', () => {
  assert.equal(shortPath('C:\\path\\to\\acme-app\\a.js', ''), 'C:/path/to/acme-app/a.js')
  assert.equal(shortPath('C:\\elsewhere\\a.js', 'acme-app'), 'C:/elsewhere/a.js')
  assert.equal(shortPath('/x/myXrepo/a.js', 'my.repo'), '/x/myXrepo/a.js')
})

test('grid chip: the collection prefix is dropped, any other prefix is kept', () => {
  assert.equal(chipLabel('ABC-101', 'ABC'), '101')
  assert.equal(chipLabel('XYZ-10', 'ABC'), 'XYZ-10')
  assert.equal(chipLabel('OPS-7', 'OPS'), '7')
  assert.equal(chipLabel('ABC-101', ''), 'ABC-101')
})

test('the way back from the live view: All subagents for a subagent, All agents for a session', () => {
  const { backLink } = ctx.window.AgentView
  assert.deepEqual({ ...backLink('sub-1') }, { href: '#/subagents', text: '← All subagents' })
  assert.deepEqual({ ...backLink(null) }, { href: '#/agents', text: '← All agents' })
  assert.deepEqual({ ...backLink('') }, { href: '#/agents', text: '← All agents' })
})
