// Where the Brainstorming run (script.mjs) finds the brainstorming skill (/superpowers:brainstorming), and its
// text, read from the installed plugin at run time so the run can carry it (script.mjs says why it is carried in
// the system prompt rather than invoked as a slash command, with the measured costs).
//
//   SKILL                       the skill's name, as the plugin names it: <plugin>:<skill>
//   SKILL_MISSING               the Left out line the page shows when the skill is not there
//   SKILL_TOO_LONG, SKILL_TEXT_MAX   the reason, and the limit, when it is too long to send
//   claudeConfigDir(env, home)  the account folder the run uses: CLAUDE_CONFIG_DIR when the server runs under
//                               one, else ~/.claude (the run inherits the server's environment)
//   findSkill({ dir, readFile, exists })  -> { text, file } | { error } | null (not found)
//
// Rules this file keeps:
// - It reads the account folder's OWN record of installed plugins (plugins/installed_plugins.json), the file
//   the CLI writes on install, and never guesses a cache path. Any plugin named superpowers, from any
//   marketplace, counts; an install counts only when its skills/brainstorming/SKILL.md is on disk. Of those, the
//   newest (lastUpdated) wins.
// - ⚠️ The skill's text is READ AT RUN TIME from that file and never copied into this repository: an update of
//   the plugin is used from the next run. Only its front matter (name, description) is dropped.
// - Not found is null, never a throw, so the page still works on the built-in rules alone and says so in one
//   line. Over SKILL_TEXT_MAX it is refused whole, never cut: the system prompt goes in the command line, which
//   Windows caps at 32,767 characters.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SKILL = 'superpowers:brainstorming'
const PLUGIN = 'superpowers'
export const SKILL_TEXT_MAX = 20_000
export const SKILL_MISSING = Object.freeze({
  title: 'Brainstorming skill',
  why: 'It was not found on this machine, so only the built-in rules were used.',
})
export const SKILL_TOO_LONG = 'It is too long to send, so only the built-in rules were used.'

export function claudeConfigDir(env = process.env, home = os.homedir()) {
  return env?.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
}

const time = s => {
  const t = Date.parse(typeof s === 'string' ? s : '')
  return Number.isNaN(t) ? 0 : t
}
const skillFile = installPath => path.join(installPath, 'skills', 'brainstorming', 'SKILL.md')

export function findSkill({ dir = claudeConfigDir(), readFile = f => fs.readFileSync(f, 'utf8'), exists = fs.existsSync } = {}) {
  try {
    const plugins = JSON.parse(readFile(path.join(dir, 'plugins', 'installed_plugins.json')))?.plugins
    if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return null
    const newest = Object.entries(plugins)
      .filter(([key, list]) => key.split('@')[0] === PLUGIN && Array.isArray(list))
      .flatMap(([, list]) => list)
      .filter(i => i && typeof i.installPath === 'string' && i.installPath && exists(skillFile(i.installPath)))
      .sort((a, b) => time(b.lastUpdated) - time(a.lastUpdated))[0]
    if (!newest) return null
    const file = skillFile(newest.installPath)
    const text = String(readFile(file)).replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').trim()
    if (!text) return null
    return text.length > SKILL_TEXT_MAX ? { error: SKILL_TOO_LONG } : { text, file }
  } catch {
    return null
  }
}
