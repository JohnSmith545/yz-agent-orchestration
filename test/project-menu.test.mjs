// Tests for public/project-menu.js (the Project menu at the top of the rail) and its place in the page. The file is
// a browser script: its pure half attaches to window.ProjectMenu and it returns before touching the DOM when there
// is no document, so it runs here in a vm with a bare window.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8')
const window = {}
vm.runInNewContext(read('project-menu.js'), { window, URLSearchParams })
const M = window.ProjectMenu

const DATA = {
  current: { id: 'flinki-v2', name: 'Flinki v2' },
  bootId: 'b1',
  projects: [
    { id: 'flinki-v2', name: 'Flinki v2', primary: true, current: true, repo: 'C:/Users/me/flinki-v2', orchestration: { id: 'o00000001', name: 'Flinki default' } },
    { id: 'dash', name: 'Dash <board>', primary: false, current: false, repo: 'C:/Users/me/agent-dashboard', orchestration: null },
  ],
}

test('the rail button: the name, a drawn chevron (no emoji), the orchestration under it, a full spoken label', () => {
  const html = M.buttonHtml(DATA)
  assert.match(html, /<span class="pm-name">Flinki v2<\/span><svg class="pm-chev"/)
  assert.match(html, /Orchestration: Flinki default/)
  assert.match(html, /pm-badge" aria-hidden="true">F</)
  assert.match(html, /Project: Flinki v2\. Orchestration: Flinki default\. Change project/)
  assert.ok(!/[⌄▾▼]/.test(html))
  assert.doesNotMatch(M.buttonHtml({ current: { name: 'X' }, projects: [] }), /Orchestration/)
})

test('the menu: one radio item per project, the current one checked, then Add a project… and Rename or remove…', () => {
  const html = M.menuHtml(DATA)
  const radios = [...html.matchAll(/role="menuitemradio" aria-checked="(true|false)"[^>]*data-pm-project="([^"]+)"/g)].map(m => [m[2], m[1]])
  assert.deepEqual(radios, [['flinki-v2', 'true'], ['dash', 'false']])
  assert.match(html, /role="separator"/)
  assert.match(html, /role="menuitem"[^>]*data-pm-add>.*Add a project…/)
  assert.match(html, /role="menuitem"[^>]*data-pm-manage>.*Rename or remove…/)
  assert.ok(html.indexOf('data-pm-add') > html.lastIndexOf('data-pm-project'), 'Add comes last, after the projects')
  assert.match(html, /Dash &lt;board&gt;/) // escaped
  assert.match(html, /C:\/Users\/me\/agent-dashboard/) // a project with no orchestration yet shows its folder
})

test('arrow keys move and wrap, Home and End jump, anything else does not move', () => {
  assert.equal(M.nextIndex('ArrowDown', 0, 4), 1)
  assert.equal(M.nextIndex('ArrowDown', 3, 4), 0)
  assert.equal(M.nextIndex('ArrowUp', 0, 4), 3)
  assert.equal(M.nextIndex('ArrowUp', -1, 4), 2)
  assert.equal(M.nextIndex('Home', 2, 4), 0)
  assert.equal(M.nextIndex('End', 0, 4), 3)
  assert.equal(M.nextIndex('Enter', 0, 4), -1)
  assert.equal(M.nextIndex('ArrowDown', 0, 0), -1)
})

test('the add form: name, folder, how sessions are recognised, and the start: the same as the current project by default', () => {
  const html = M.addHtml({ current: DATA.current, bank: [{ id: 'o00000001', name: 'Flinki default' }, { id: 'o00000002', name: 'Careful <one>' }], values: {} })
  assert.match(html, /<label for="pm-name">Name<\/label>/)
  assert.match(html, /<label for="pm-repo">Folder of its repository<\/label>/)
  assert.match(html, /<label for="pm-match">How its sessions are recognised<\/label>/)
  assert.match(html, /<option value="same" selected>The same as Flinki v2<\/option>/)
  assert.match(html, /<option value="o00000002">Careful &lt;one&gt;<\/option>/)
  assert.match(html, /Left empty, the folder name is used/)
  const again = M.addHtml({ current: DATA.current, bank: [{ id: 'o00000002', name: 'B' }], values: { name: 'X', repo: 'C:/x', start: 'o00000002' }, status: 'C:/x is not a git repository.' })
  assert.match(again, /value="X"/)
  assert.match(again, /<option value="o00000002" selected>/)
  assert.match(again, /role="status">C:\/x is not a git repository\./)
  assert.match(M.addHtml({ current: DATA.current, values: {}, saving: true }), /disabled>Adding…/)
})

test('after adding: what it starts with, and Switch to it or Stay here', () => {
  const html = M.addHtml({ added: { id: 'dash', name: 'Dash', startName: 'Flinki default' } })
  assert.match(html, /Added Dash/)
  assert.match(html, /It starts with Flinki default\./)
  assert.match(html, /data-pm-switch="dash">Switch to Dash/)
  assert.match(html, /data-pm-close>Stay here/)
})

test('rename or remove: the current and the first project have no Remove, and removing asks on the page', () => {
  const html = M.manageHtml({ projects: DATA.projects })
  assert.ok(!html.includes('data-pm-remove="flinki-v2"'))
  assert.match(html, /data-pm-remove="dash"/)
  assert.match(html, /Shown now/)
  const elsewhere = M.manageHtml({ projects: DATA.projects.map(p => ({ ...p, current: p.id === 'dash' })) })
  assert.match(elsewhere, /First project/)
  assert.doesNotMatch(html + elsewhere, /config\.json/, 'a file name is not words for a person')
  const asking = M.manageHtml({ projects: DATA.projects, removing: 'dash' })
  assert.match(asking, /Remove Dash &lt;board&gt; from the list\?/)
  assert.match(asking, /its flows, rules and evidence stay on disk, and its repository is not touched/)
  assert.match(asking, /data-pm-remove-yes="dash"/)
  const renaming = M.manageHtml({ projects: DATA.projects, renaming: 'dash', draft: 'New' })
  assert.match(renaming, /<label class="pm-sr" for="pm-rename">New name for Dash &lt;board&gt;<\/label>/)
  assert.match(renaming, /value="New"/)
})

test('the waiting screen: switching, refused with the reason, and too late with what to do', () => {
  assert.match(M.switchingHtml({ state: 'wait', title: 'Switching to Dash…' }), /<h2 id="pm-wait-title">Switching to Dash…<\/h2>.*reloads by itself/)
  const no = M.switchingHtml({ state: 'refused', error: 'Not now: the Ask chat is answering.' })
  assert.match(no, /Not switched/)
  assert.match(no, /Not now: the Ask chat is answering\./)
  const late = M.switchingHtml({ state: 'late', lateTitle: 'Dash did not come back within 45 seconds', log: 'C:/logs/server.log' })
  assert.match(late, /Dash did not come back within 45 seconds/)
  assert.match(late, /npm start/)
  assert.match(late, /C:\/logs\/server\.log/)
  assert.match(late, /data-pm-reload>Try again/)
})

test('the address can open the menu, the add form, the list, or the waiting screen', () => {
  const s = v => JSON.parse(JSON.stringify(M.fromSearch(v)))
  assert.deepEqual(s('?project=menu'), { open: 'menu', to: '' })
  assert.deepEqual(s('?project=add'), { open: 'add', to: '' })
  assert.deepEqual(s('project=manage'), { open: 'manage', to: '' })
  assert.deepEqual(s('?project=switching&to=dash'), { open: 'switching', to: 'dash' })
  assert.deepEqual(s('?project=evil'), { open: null, to: '' })
  assert.deepEqual(s(''), { open: null, to: '' })
})

test('the switch is done only when the server answers with a NEW boot and the project waited for', () => {
  assert.equal(M.switchDone({ bootId: 'b2', current: { id: 'dash' } }, 'dash', 'b1'), true)
  assert.equal(M.switchDone({ bootId: 'b1', current: { id: 'dash' } }, 'dash', 'b1'), false)
  assert.equal(M.switchDone({ bootId: 'b2', current: { id: 'flinki-v2' } }, 'dash', 'b1'), false)
  assert.equal(M.switchDone({ bootId: 'b2', current: { id: 'flinki-v2' } }, '', 'b1'), true) // a restart for a style: any project
  assert.equal(M.switchDone(null, 'dash', 'b1'), false)
})

test('the page loads it: the stylesheet, the script after the shell, and the rail slot the shell adds', () => {
  const index = read('index.html')
  assert.match(index, /<link rel="stylesheet" href="projects\.css">/)
  assert.ok(index.indexOf('src="project-menu.js"') > index.indexOf('src="shell.js"'))
  const shell = read('shell.js')
  assert.match(shell, /id="railProject"/)
  assert.ok(shell.indexOf('id="railProject"') > shell.indexOf('class="rail-top"'), 'under the brand, at the top of the rail')
})
