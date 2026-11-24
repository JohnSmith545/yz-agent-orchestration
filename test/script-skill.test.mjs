// Tests for script-skill.mjs: where the Brainstorming run finds the superpowers plugin that holds the
// brainstorming skill. It reads the account folder's own record of installed plugins
// (<config dir>/plugins/installed_plugins.json), keeps the installs that really have the skill file, and picks
// the newest; anything missing, unreadable or malformed is "not found" (null), never a throw. Every file read
// is injected, so nothing here touches the real ~/.claude.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

const K = await import('../script-skill.mjs')

const DIR = path.join('C:', 'acct')
const RECORD = path.join(DIR, 'plugins', 'installed_plugins.json')
const skillFile = p => path.join(p, 'skills', 'brainstorming', 'SKILL.md')

/** A fake disk: `files` maps a path to its text; exists() is true for those paths. */
function disk(files) {
  return {
    dir: DIR,
    readFile: f => {
      if (!(f in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return files[f]
    },
    exists: f => f in files,
  }
}
const record = plugins => JSON.stringify({ version: 2, plugins })

test('the skill and the plugin it lives in, as the CLI names them', () => {
  assert.equal(K.SKILL, 'superpowers:brainstorming')
  assert.equal(K.SKILL_MISSING.title, 'Brainstorming skill')
  assert.match(K.SKILL_MISSING.why, /not found/)
  assert.doesNotMatch(K.SKILL_MISSING.why, /[\\/]/, 'a plain sentence, no path')
})

test('the account folder: CLAUDE_CONFIG_DIR when the server runs under one, else ~/.claude', () => {
  assert.equal(K.claudeConfigDir({ CLAUDE_CONFIG_DIR: 'D:/second' }, 'C:/Users/me'), 'D:/second')
  assert.equal(K.claudeConfigDir({}, 'C:/Users/me'), path.join('C:/Users/me', '.claude'))
  assert.equal(K.claudeConfigDir({ CLAUDE_CONFIG_DIR: '' }, 'C:/Users/me'), path.join('C:/Users/me', '.claude'))
})

test('found: the install whose skill file is on disk, as { pluginDir }', () => {
  const p = path.join(DIR, 'plugins', 'cache', 'm', 'superpowers', '6.3.0')
  const d = disk({ [RECORD]: record({ 'superpowers@superpowers-marketplace': [{ installPath: p, lastUpdated: '2026-08-29T07:57:24Z' }] }), [skillFile(p)]: '---' })
  assert.deepEqual(K.findSkill(d), { pluginDir: p })
})

test('several installs or marketplaces: the newest one that has the skill wins', () => {
  const old = path.join(DIR, 'a', '6.3.0')
  const newer = path.join(DIR, 'b', '7.0.1')
  const broken = path.join(DIR, 'c', '8.0.0') // newest, but its skill folder is gone
  const d = disk({
    [RECORD]: record({
      'superpowers@superpowers-marketplace': [{ installPath: old, lastUpdated: '2026-08-29T00:00:00Z' }, { installPath: broken, lastUpdated: '2026-11-20T00:00:00Z' }],
      'superpowers@another-marketplace': [{ installPath: newer, lastUpdated: '2026-11-03T00:00:00Z' }],
      'other-plugin@x': [{ installPath: path.join(DIR, 'z'), lastUpdated: '2026-12-01T00:00:00Z' }],
    }),
    [skillFile(old)]: '---',
    [skillFile(newer)]: '---',
  })
  assert.deepEqual(K.findSkill(d), { pluginDir: newer })
})

test('not found, never a throw: no record, bad JSON, no superpowers, no skill file, odd shapes', () => {
  const p = path.join(DIR, 'p')
  const cases = [
    {},
    { [RECORD]: '{not json' },
    { [RECORD]: 'null' },
    { [RECORD]: record({}) },
    { [RECORD]: JSON.stringify({ plugins: [] }) },
    { [RECORD]: record({ 'superpowers@m': 'not a list' }) },
    { [RECORD]: record({ 'superpowers@m': [null, 42, { installPath: 7 }, { installPath: '' }] }) },
    { [RECORD]: record({ 'superpowers@m': [{ installPath: p }] }) }, // installed, but the skill file is missing
    { [RECORD]: record({ 'not-superpowers@m': [{ installPath: p }] }), [skillFile(p)]: '---' },
  ]
  for (const files of cases) assert.equal(K.findSkill(disk(files)), null, JSON.stringify(files).slice(0, 80))
  assert.equal(K.findSkill({ dir: DIR, readFile: () => { throw new Error('EACCES') }, exists: () => true }), null)
})
