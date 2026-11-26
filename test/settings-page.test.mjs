// Tests for public/settings-page.js, the Settings page: Sending (on or off, the
// branches, the send PIN in its three states) and a read-only Your setup, plus
// its place in the shell (route, rail, palette). Browser scripts in a vm with a
// recording fetch and a stub root for the clicks.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, '..', 'public')
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8')

const fetched = []
let answer = () => ({ ok: true, status: 200, body: {} })
const fetchStub = async (url, opts = {}) => {
  fetched.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null })
  const a = await answer(url, opts)
  return { ok: a.ok, status: a.status, json: async () => a.body }
}
const window = {}
vm.runInNewContext(read('settings-page.js'), { window, fetch: fetchStub })
const P = window.SettingsPage

const SETUP = { repo: 'C:/path/to/your-repo', configPath: 'C:/path/to/yz-agent-orchestration/config.json', coordinator: 'Coordinator', codingAgents: ['Coordinator', 'Agent 1'],
  chat: { name: 'Independent', model: 'claude-opus-5-5', mode: 'brief' }, ticketPrefixes: ['ABC'], reminders: [{ at: '17:55', days: 'weekdays', text: 'Wrap up.' }] }
const PR = { enabled: false, wanted: false, bases: ['dev'], remote: 'origin', hasPin: false }
const view = (over = {}) => ({ setup: SETUP, pr: { ...PR, ...(over.pr || {}) }, status: { send: '', pin: '', ...(over.status || {}) }, pinMode: over.pinMode || null })
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
const settle = () => new Promise(r => setTimeout(r, 0))

// ═══ what the page shows ═══

test('two sections only: Sending and Your setup', () => {
  const h = P.html(view())
  assert.deepEqual([...h.matchAll(/<h3 class="set-h">([^<]+)<\/h3>/g)].map(m => m[1]), ['Sending', 'Your setup'])
})

test('Sending: a switch Send to <base>, the branches field, and with no PIN two fields and Set PIN', () => {
  const h = P.html(view())
  assert.match(h, /<input type="checkbox" role="switch" data-set-enabled aria-label="Send to dev"\s*>/)
  assert.match(text(h), /Send to dev/)
  assert.match(h, /<input id="set-bases" data-set-bases value="dev" [^>]*>/)
  assert.match(text(h), /Branches it may open pull requests into/)
  assert.equal((h.match(/type="password"/g) || []).length, 2)
  assert.match(h, /data-set-pin-next[^>]*autocomplete="new-password"/)
  assert.match(h, /<button type="button" class="primary" data-set-pin>Set PIN<\/button>/)
  assert.doesNotMatch(h, /Forgot it|Change PIN/)
  assert.match(P.html(view({ pr: { enabled: true, wanted: true, hasPin: true } })), /data-set-enabled aria-label="Send to dev" checked>/)
})

test('a PIN set: Change PIN with the current one and the new one twice, and Forgot it? Reset; reset mode: the new one twice and Reset PIN', () => {
  const h = P.html(view({ pr: { hasPin: true } }))
  assert.equal((h.match(/type="password"/g) || []).length, 3)
  assert.match(h, /data-set-pin-current/)
  assert.match(h, /<button type="button" class="primary" data-set-pin>Change PIN<\/button>/)
  assert.match(h, /<button type="button" class="link" data-set-forgot>Forgot it\? Reset<\/button>/)
  const r = P.html(view({ pr: { hasPin: true }, pinMode: 'reset' }))
  assert.equal((r.match(/type="password"/g) || []).length, 2)
  assert.doesNotMatch(r, /data-set-pin-current/)
  assert.match(r, /<button type="button" class="primary" data-set-pin>Reset PIN<\/button>/)
})

test('Your setup is read-only, says where to change it, and shows no secret', () => {
  const h = P.html(view({ pr: { hasPin: true } }))
  const setupBlock = h.slice(h.indexOf('Your setup'))
  for (const s of ['C:/path/to/your-repo', 'C:/path/to/yz-agent-orchestration/config.json', 'Coordinator', 'Agent 1', 'Independent', 'claude-opus-5-5', 'ABC', '17:55']) assert.ok(setupBlock.includes(s), s)
  assert.match(text(h), /Change these in config\.json, then restart the dashboard\./)
  assert.doesNotMatch(setupBlock, /<input|<button/)
  assert.doesNotMatch(h, /scrypt|pinHash/)
})

test('every value is escaped, and statuses are one plain line', () => {
  const nasty = '<img src=x onerror=alert(1)>'
  const h = P.html({ setup: { ...SETUP, repo: nasty, codingAgents: [nasty], reminders: [{ at: '1', days: 'daily', text: nasty }] }, pr: { ...PR, bases: ['dev'] }, status: { send: nasty, pin: 'Saved.' }, pinMode: null })
  assert.doesNotMatch(h, /<img src=x/)
  assert.match(h, /<p class="set-status" role="status">Saved\.<\/p>/)
})

// ═══ what the page sends ═══

/** A stub root: fields by data attribute, listeners recorded, a click finds `attr`. */
function stubRoot(fields = {}) {
  const on = {}
  const els = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === 'object' ? v : { value: v }]))
  return {
    els,
    innerHTML: '',
    addEventListener: (t, fn) => { (on[t] ||= []).push(fn) },
    querySelector: sel => els[/\[([a-z-]+)\]/.exec(sel)?.[1]] || null,
    fire: (type, attr, extra = {}) => Promise.all((on[type] || []).map(fn => fn({ target: { closest: sel => (sel.includes(attr) ? {} : null), ...extra } }))),
  }
}

test('Set PIN: two that differ are refused here; the same two POST { next } and say the system window is waiting', async () => {
  const root = stubRoot({ 'data-set-pin-next': '246810', 'data-set-pin-again': '246811' })
  const s = P.mount(root, view())
  fetched.length = 0
  await root.fire('click', 'data-set-pin')
  assert.deepEqual(fetched, [])
  assert.equal(s.status.pin, 'The two PINs differ.')
  root.els['data-set-pin-again'].value = '246810'
  let release
  answer = () => new Promise(r => { release = () => r({ ok: true, status: 200, body: { ok: true, pr: { ...PR, hasPin: true } } }) })
  const done = root.fire('click', 'data-set-pin')
  await settle()
  assert.equal(s.status.pin, 'Waiting for you to confirm in the window that just opened…')
  assert.deepEqual(fetched.map(f => [f.url, f.method, f.body]), [['/api/settings/pin', 'POST', { next: '246810' }]])
  release()
  await done
  await settle()
  assert.equal(s.status.pin, 'Saved.')
  assert.equal(s.pr.hasPin, true)
  assert.equal(root.els['data-set-pin-next'].value, '', 'the fields are emptied')
})

test('Change PIN sends the current one and needs no window; a wrong one says so; Declined is said plainly', async () => {
  const root = stubRoot({ 'data-set-pin-current': '246810', 'data-set-pin-next': '135799', 'data-set-pin-again': '135799' })
  const s = P.mount(root, view({ pr: { hasPin: true } }))
  answer = () => ({ ok: false, status: 403, body: { error: 'Wrong current PIN.' } })
  fetched.length = 0
  await root.fire('click', 'data-set-pin')
  await settle()
  assert.deepEqual(fetched[0].body, { current: '246810', next: '135799' })
  assert.equal(s.status.pin, 'Wrong current PIN.')
  s.pinMode = 'reset'
  Object.assign(root.els['data-set-pin-next'], { value: '111111' })
  Object.assign(root.els['data-set-pin-again'], { value: '111111' })
  answer = () => ({ ok: false, status: 409, body: { error: 'Declined.' } })
  await root.fire('click', 'data-set-pin')
  await settle()
  assert.deepEqual(fetched.at(-1).body, { reset: true, next: '111111' })
  assert.equal(s.status.pin, 'Declined.')
})

test('the switch: on POSTs { enabled: true } and waits for the window; off needs none; the branches POST a clean list', async () => {
  const root = stubRoot({ 'data-set-bases': ' dev, release-train ,, ' })
  const s = P.mount(root, view())
  answer = () => ({ ok: true, status: 200, body: { ok: true, pr: { ...PR, enabled: true, wanted: true } } })
  fetched.length = 0
  await root.fire('change', 'data-set-enabled', { checked: true, matches: sel => sel.includes('data-set-enabled') })
  await settle()
  assert.deepEqual(fetched[0].body, { enabled: true })
  assert.equal(s.status.send, 'Saved.')
  await root.fire('change', 'data-set-enabled', { checked: false, matches: sel => sel.includes('data-set-enabled') })
  await settle()
  assert.deepEqual(fetched[1].body, { enabled: false })
  await root.fire('click', 'data-set-save-bases')
  await settle()
  assert.deepEqual(fetched[2].body, { bases: ['dev', 'release-train'] })
})

// ═══ its place in the shell ═══

test('the shell: #/settings is a route, the rail has Settings above Theme, the palette lists it, and the page is wired', () => {
  const w = {}
  vm.runInNewContext(read('shell.js'), { window: w, setTimeout, clearTimeout })
  assert.deepEqual(JSON.parse(JSON.stringify(w.Shell.resolve('#/settings'))), { view: 'settings', params: {}, redirect: null })
  const shell = read('shell.js')
  assert.match(shell, /settings: 'SettingsPage'/)
  assert.ok(shell.indexOf("R.linkHtml(R.linkFor('settings'))") < shell.indexOf('id="themeToggle"'), 'above Theme')
  const rail = { window: {} }
  vm.runInNewContext(read('rail-groups.js'), rail)
  assert.equal(rail.window.RailGroups.linkFor('settings').href, '#/settings')
  assert.match(rail.window.RailGroups.linkFor('settings').icon, /<circle/, 'the gear')
  assert.match(read('palette.js'), /\['Settings', '#\/settings'\]/)
  const html = read('index.html')
  assert.match(html, /<section id="settingsView" aria-label="Settings" hidden><\/section>/)
  assert.match(html, /<script src="settings-page\.js"><\/script>/)
  assert.match(html, /<link rel="stylesheet" href="settings\.css">/)
})
