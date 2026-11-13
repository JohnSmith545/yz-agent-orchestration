// Finds the Claude Code binary to run headless turns with.
//
// The npm-installed `claude` on PATH can lag behind the IDE extension, and an
// old CLI refuses new models ("version X or newer is required"). The IDE
// extensions bundle a native binary that updates with the extension, so the
// newest of those wins; `config.claudeBin` overrides the search.

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { CONFIG } from './config.mjs'

const EXT_ROOTS = ['.antigravity-ide', '.vscode', '.cursor', '.windsurf'].map(d => path.join(os.homedir(), d, 'extensions'))
const BIN = process.platform === 'win32' ? 'claude.exe' : 'claude'

const versionOf = name => (/anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/.exec(name) || []).slice(1).map(Number)
const newer = (a, b) => {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return false
}

let cached = null

/** Absolute path of the newest bundled binary, or `claude` from PATH. */
export async function claudeBin() {
  if (CONFIG.claudeBin) return CONFIG.claudeBin
  if (cached) return cached
  let best = null
  for (const root of EXT_ROOTS) {
    let names = []
    try {
      names = await fs.readdir(root)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.startsWith('anthropic.claude-code-')) continue
      const file = path.join(root, name, 'resources', 'native-binary', BIN)
      try {
        await fs.access(file)
      } catch {
        continue
      }
      const v = versionOf(name)
      if (!best || newer(v, best.v)) best = { v, file }
    }
  }
  cached = best ? best.file : 'claude'
  return cached
}
