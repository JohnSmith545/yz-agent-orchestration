// Where the Brainstorming run (script.mjs) finds the brainstorming skill (/superpowers:brainstorming), so the
// turn can invoke it the supported way: the CLI loads the installed plugin with --plugin-dir, and the user turn
// starts with the skill's slash command (script.mjs says why this way and what it costs).
//
//   SKILL                       the slash command's name, as the CLI resolves it: <plugin>:<skill>
//   SKILL_MISSING               the Left out line the page shows when the skill is not there
//   claudeConfigDir(env, home)  the account folder the run uses: CLAUDE_CONFIG_DIR when the server runs under
//                               one, else ~/.claude (the run inherits the server's environment)
//   findSkill({ dir, readFile, exists })  -> { pluginDir } | null
//
// Rules this file keeps:
// - It reads the account folder's OWN record of installed plugins (plugins/installed_plugins.json), the file
//   the CLI writes on install, and never guesses a cache path. Any plugin named superpowers, from any
//   marketplace, counts; an install counts only when its skills/brainstorming/SKILL.md is on disk. Of those, the
//   newest (lastUpdated) wins.
// - ⚠️ It never copies or reads the skill's text: the CLI reads it from the plugin at run time. Not found is
//   null, never a throw, so the page still works on the built-in rules alone and says so in one line.
// - It is read on every run (one small file), so installing or removing the plugin counts from the next run.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SKILL = 'superpowers:brainstorming'
const PLUGIN = 'superpowers'
export const SKILL_MISSING = Object.freeze({
  title: 'Brainstorming skill',
  why: 'It was not found on this machine, so only the built-in rules were used.',
})

export function claudeConfigDir(env = process.env, home = os.homedir()) {
  return env?.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
}

const time = s => {
  const t = Date.parse(typeof s === 'string' ? s : '')
  return Number.isNaN(t) ? 0 : t
}

export function findSkill({ dir = claudeConfigDir(), readFile = f => fs.readFileSync(f, 'utf8'), exists = fs.existsSync } = {}) {
  try {
    const plugins = JSON.parse(readFile(path.join(dir, 'plugins', 'installed_plugins.json')))?.plugins
    if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return null
    const installs = Object.entries(plugins)
      .filter(([key, list]) => key.split('@')[0] === PLUGIN && Array.isArray(list))
      .flatMap(([, list]) => list)
      .filter(i => i && typeof i.installPath === 'string' && i.installPath && exists(path.join(i.installPath, 'skills', 'brainstorming', 'SKILL.md')))
      .sort((a, b) => time(b.lastUpdated) - time(a.lastUpdated))
    return installs.length ? { pluginDir: installs[0].installPath } : null
  } catch {
    return null
  }
}
