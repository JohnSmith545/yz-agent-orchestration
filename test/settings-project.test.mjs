// The Settings page names the file the current project's settings live in: config.json for the first project,
// projects.json for any other (project-store.mjs). The page text follows the path the server sends.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const window = {}
vm.runInNewContext(fs.readFileSync(path.join(PUBLIC, 'settings-page.js'), 'utf8'), { window })
const SETUP = { repo: 'C:/x', coordinator: 'M', codingAgents: [], chat: {}, ticketPrefixes: null, reminders: [] }
const PR = { enabled: false, wanted: false, bases: ['dev'], remote: 'origin', hasPin: false }
const html = configPath => window.SettingsPage.html({ setup: { ...SETUP, configPath }, pr: PR, status: {} })

test('the first project: change these in config.json', () => {
  assert.match(html('C:\\app\\config.json'), /Change these in config\.json, then restart the dashboard\./)
})

test('another project: change these in projects.json', () => {
  assert.match(html('C:/app/projects.json'), /Change these in projects\.json, then restart the dashboard\./)
})
