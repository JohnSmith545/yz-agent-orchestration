// Tests for the agent window on the Agents page, the pure half (public/agent-window-view.js) in a vm: the green
// pill on a box, the Model section (a choice, the fixed Opus line for the planner and Security with a warning when
// the session is not on Opus, the chat agent's config model), the Subagents list, the Files list and the checks a
// file or note gets in the browser, the merged Changes; and the wiring greps (the page loads the files, the box
// draws the pill, the address opens the window, npm run check lists the files).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = f => fs.readFileSync(path.join(HERE, '..', f), 'utf8')
const ctx = vm.createContext({ window: {} })
for (const f of ['shell.js', 'app.js', 'pipeline-tickets.js', 'pipeline-details.js', 'agent-window-view.js', 'pipeline-view.js']) vm.runInContext(read(`public/${f}`), ctx)
const V = ctx.window.AgentWindowView
const NOW = Date.parse('2026-11-24T12:00:00Z')
const sub = (state, more = {}) => ({ id: 's', description: 'Write the tests', agentType: 'general-purpose', state, startedAt: '2026-11-24T11:48:00Z', updatedAt: '2026-11-24T11:59:00Z', ...more })

// ═══ the pill ═══

test('running: started and not finished; idle and done do not count', () => {
  assert.equal(V.running({ subagents: [sub('active'), sub('waiting'), sub('stuck'), sub('idle'), sub('done')] }).length, 3)
  assert.equal(V.running(null).length, 0)
  assert.equal(V.running({}).length, 0)
})

test('the pill says "3 running" and, for a reader, how many subagents run under which agent; none for none', () => {
  assert.equal(V.pillHtml(0, 'Agent 1'), '')
  const three = V.pillHtml(3, 'Agent 1')
  assert.match(three, /class="pl-pill" role="img" aria-label="3 subagents running under Agent 1"/)
  assert.match(three, /<span class="pl-pill-n">3<\/span><span class="pl-pill-w">running<\/span>/)
  assert.match(V.pillHtml(1, 'Agent <1>'), /aria-label="1 subagent running under Agent &lt;1&gt;"/)
})

test('the box draws the pill only when something runs under it', () => {
  const P = ctx.window.PipelineView
  const node = { id: 'agent-1', label: 'Agent 1', kind: 'agent', role: 'producer' }
  assert.doesNotMatch(P.nodeInner(node, {}), /pl-pill/)
  assert.match(P.nodeInner(node, { running: 2 }), /aria-label="2 subagents running under Agent 1"/)
})

// ═══ Model ═══

test('a producer gets the model and effort choices, the honest line, and a note when the session runs on another model', () => {
  const html = V.modelHtml({ label: 'Agent 1', role: 'producer', entry: { model: 'claude-sonnet-5-5', effort: 'medium' }, session: 'claude-opus-5-5' })
  assert.match(html, /<option value="claude-sonnet-5-5" selected>Sonnet 5\.5<\/option>/)
  assert.match(html, /<option value="medium" selected>Medium<\/option>/)
  for (const name of ['Fable 5.2', 'Opus 5.5', 'Haiku 5.5', 'Not chosen']) assert.ok(html.includes(`>${name}</option>`), name)
  assert.match(html, /The dashboard cannot switch a session that is open in the editor\./)
  assert.match(html, /This session is running on Opus 5\.5\. Switch it in the editor to use Sonnet 5\.5\./)
  assert.doesNotMatch(V.modelHtml({ role: 'producer', entry: {}, session: 'claude-opus-5-5' }), /aw-warn/, 'nothing chosen: nothing to warn about')
})

test('the planner and Security show Opus at high effort with no control, and warn when the session is not Opus', () => {
  for (const role of ['planner', 'security', 'senior']) {
    const html = V.modelHtml({ label: 'X', role, entry: { fixed: true } })
    assert.match(html, /<b>Opus 5\.5, high effort<\/b>/)
    assert.doesNotMatch(html, /<select/)
    assert.match(html, /always runs on Opus at high effort/)
    assert.doesNotMatch(html, /aw-warn/)
  }
  assert.match(V.modelHtml({ role: 'security', entry: { fixed: true }, session: 'claude-haiku-5-5' }), /This session is running on Haiku 5\.5, not Opus\. Switch it to Opus in the editor\./)
})

test('the chat agent shows its config model, read only', () => {
  const html = V.modelHtml({ role: 'chat', chatModel: 'claude-opus-5-5' })
  assert.match(html, /<b>Opus 5\.5<\/b>/)
  assert.match(html, /factory\.chat\.model/)
  assert.doesNotMatch(html, /<select/)
})

// ═══ Subagents ═══

test('the subagents running now with their kind and how long; an honest line for none, a stopped agent and the chat agent', () => {
  const html = V.subagentsHtml({ subagents: [sub('active', { description: 'Fix <it>' }), sub('done')] }, 'Agent 1', { now: NOW })
  assert.match(html, /<span class="aw-sub-name">Fix &lt;it&gt;<\/span><span class="aw-sub-meta">general-purpose · running 12 min<\/span>/)
  assert.equal((html.match(/<li>/g) || []).length, 1)
  assert.match(V.subagentsHtml({ subagents: [] }, 'Agent 1'), /No subagents are running under Agent 1 right now\./)
  assert.match(V.subagentsHtml(null, 'QA'), /QA is not running/)
  assert.match(V.subagentsHtml(null, 'Independent', { role: 'chat' }), /run by the dashboard/)
  assert.equal(V.howLong('2026-11-24T10:55:00Z', NOW), '1 h 5 min')
  assert.equal(V.howLong('2026-11-24T11:59:40Z', NOW), 'under a minute')
})

// ═══ Files and context ═══

test('the files list: each with its switch and Remove, the totals; an empty line that says what to do', () => {
  const html = V.filesListHtml({ files: [{ id: 'f1', title: 'Spec <1>', kind: 'file', name: 'spec.md', chars: 1234, on: true }, { id: 'f2', title: 'Tip', kind: 'note', chars: 10, on: false }] }, V.LIMITS, 'Agent 1')
  assert.match(html, /<span class="aw-file-title">Spec &lt;1&gt;<\/span><span class="aw-file-meta">File spec\.md · 1,234 characters<\/span>/)
  assert.match(html, /role="switch" aria-checked="true"/)
  assert.match(html, /class="aw-file is-off" data-aw-file="f2"[\s\S]*aria-checked="false"[\s\S]*>Off</)
  assert.match(html, /aria-label="Remove Tip"/)
  assert.match(html, /2 of 20 · 1,244 of 60,000 characters/)
  assert.match(V.filesListHtml({}, V.LIMITS, 'QA'), /Nothing added yet\. Add a text file or a note, and QA reads it with its rules\./)
})

test('a picked file that is binary, unreadable, empty or too long is refused with a sentence before anything is sent', () => {
  const f = { name: 'shot.png', size: 100 }
  assert.equal(V.readProblem(f, 'PNG\u0000\u0001'), 'shot.png is not a text file, so it cannot be added. Add a text file such as .md or .txt.')
  assert.equal(V.readProblem(f, 'x'.repeat(50) + '�'.repeat(5)), 'shot.png is not a text file, so it cannot be added. Add a text file such as .md or .txt.')
  assert.equal(V.readProblem({ name: 'a.md' }, null), 'a.md could not be read as text.')
  assert.equal(V.readProblem({ name: 'a.md' }, '  '), 'a.md is empty.')
  assert.equal(V.readProblem({ name: 'a.md' }, 'x'.repeat(20001)), 'a.md is too long. Keep each file or note to 20,000 characters.')
  assert.equal(V.readProblem({ name: 'a.md' }, '# Fine\n'), '')
  assert.equal(V.tooBig({ size: 80001 }), true)
  assert.equal(V.tooBig({ size: 80000 }), false)
})

test('a note is checked as the server checks it, sooner', () => {
  assert.equal(V.noteProblem('', 'x'), 'Give it a title.')
  assert.equal(V.noteProblem('t'.repeat(101), 'x'), 'The title is too long. Keep it to 100 characters.')
  assert.equal(V.noteProblem('T', ' '), 'The note is empty. Write something first.')
  assert.equal(V.noteProblem('T', 'x'.repeat(20001)), 'That is too long. Keep each file or note to 20,000 characters.')
  const full = { files: Array.from({ length: 20 }, () => ({ chars: 1 })) }
  assert.match(V.noteProblem('T', 'x', V.LIMITS, full), /20 files and notes/)
  assert.match(V.noteProblem('T', 'x'.repeat(10), V.LIMITS, { files: [{ chars: 59995 }] }), /past 60,000 characters/)
  assert.equal(V.noteProblem('T', 'fine'), '')
})

// ═══ Changes ═══

test('rule changes and settings changes together, newest first, at most ten', () => {
  const rules = [{ at: '2026-11-24T09:00:00Z', text: 'Agent 1 got 1 new rule.' }]
  const settings = [{ at: '2026-11-24T10:00:00Z', text: 'Agent 1 is to run on Opus 5.5.' }, { at: 'nope', text: 'x' }]
  const merged = V.mergeChanges(rules, settings)
  assert.deepEqual(JSON.parse(JSON.stringify(merged.map(c => c.text))), ['Agent 1 is to run on Opus 5.5.', 'Agent 1 got 1 new rule.'])
  assert.equal(V.mergeChanges(Array.from({ length: 12 }, (_, i) => ({ at: `2026-11-${10 + i}T00:00:00Z`, text: `c${i}` }))).length, 10)
  assert.match(V.changesHtml(merged), /<ol class="aw-changes"><li><time datetime="2026-11-24T10:00:00Z">/)
  assert.match(V.changesHtml([]), /No changes saved yet\./)
})

// ═══ the wiring ═══

test('the page loads the window files, the address opens it, and npm run check lists them', () => {
  const index = read('public/index.html')
  assert.ok(index.includes('<link rel="stylesheet" href="agent-window.css">'))
  for (const f of ['agent-window-view.js', 'agent-window.js']) {
    assert.ok(index.includes(`<script src="${f}"></script>`), f)
    assert.ok(index.indexOf(`src="${f}"`) > index.indexOf('src="agent-rules.js"'), `${f} after agent-rules.js`)
  }
  const pkg = JSON.parse(read('package.json'))
  for (const f of ['public/agent-window-view.js', 'public/agent-window.js', 'agent-settings.mjs', 'agent-settings-routes.mjs']) assert.ok(pkg.checkList.includes(`node --check ${f}`), f)
  assert.equal(ctx.window.Shell?.resolve?.('#/agents?agent=Agent%201')?.view ?? 'agents', 'agents')
})

test('the window is a real modal dialog: showModal, aria-modal, labelled by its title, Esc and backdrop handled, no confirm()', () => {
  const src = read('public/agent-window.js')
  assert.match(src, /dlg\.showModal\(\)/)
  assert.match(src, /setAttribute\('aria-modal', 'true'\)/)
  assert.match(src, /setAttribute\('aria-labelledby', 'awTitle'\)/)
  assert.match(src, /addEventListener\('cancel'/)
  assert.match(src, /e\.target === dlg\) return close\(\)/)
  assert.doesNotMatch(src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n'), /confirm\(/, 'the window asks in itself')
  const css = read('public/agent-window.css')
  assert.match(css, /prefers-reduced-motion: reduce\)\s*\{\s*\.aw\[open\] \{ animation: aw-fade/)
  assert.match(css, /html\.aw-lock, html\.aw-lock body \{ overflow: hidden; \}/)
})

test('Remove asks first, in the window: the row offers Remove and Keep, and only then is the file removed', () => {
  const entry = { files: [{ id: 'f1', title: 'Spec', kind: 'file', name: 'spec.md', chars: 10, on: true }, { id: 'f2', title: 'Tip', kind: 'note', chars: 3, on: true }] }
  const asking = V.filesListHtml(entry, V.LIMITS, 'Agent 1', { confirm: 'f1' })
  assert.match(asking, /data-aw-file="f1"[\s\S]*<span class="aw-confirm" role="alert">Remove Spec\? Agent 1 will no longer read it\.<\/span><button type="button" class="aw-danger" data-aw-act="remove-yes">Remove<\/button><button type="button" data-aw-act="remove-no">Keep<\/button>/)
  assert.doesNotMatch(asking.split('data-aw-file="f2"')[1], /aw-confirm/, 'only the row asked about')
  assert.doesNotMatch(V.filesListHtml(entry, V.LIMITS, 'Agent 1'), /remove-yes/)
  const src = read('public/agent-window.js')
  assert.match(src, /'remove-yes'/)
  assert.match(src, /'remove-no'/)
})
