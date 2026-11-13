// Writes to config.json's "pr" block only: the Settings page and `factory.mjs pr-pin`
// change the send settings (enabled, bases, pinHash) and nothing else. Every byte
// outside that block stays as it was; inside it, a key that is there gets its new
// value in place and a new key goes at the top of the block, in its indentation.
// If the result would not parse to exactly that change, the whole file is written
// out again as JSON (same values, two-space indent) rather than risk a wrong one.
//
//   withPrKeys(text, changes)    the new text
//   writePrKeys(file, changes)   read, change, write atomically

import { readFileSync } from 'node:fs'
import { writeAtomic } from './atomic-write.mjs'

/** A JSON value with no nested object: a string, a number, true, false, null or a flat list. */
const VALUE = String.raw`"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null|\[[^\[\]{}]*\]`

/** [start, end) of the "pr" object's braces in `text`, or null. Strings are skipped, so a } inside one never ends it. */
function prBlock(text) {
  const m = /"pr"\s*:\s*\{/.exec(text)
  if (!m) return null
  let depth = 0
  for (let i = m.index + m[0].length - 1; i < text.length; i++) {
    const c = text[i]
    if (c === '"') { for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++; continue }
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return [m.index + m[0].length - 1, i + 1]
  }
  return null
}

const same = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]))
  return v
}

export function withPrKeys(text, changes) {
  const obj = JSON.parse(text)
  const want = { ...obj, pr: { ...(obj.pr || {}), ...changes } }
  let out
  const at = prBlock(text)
  if (!at) {
    const end = text.lastIndexOf('}')
    const head = text.slice(0, end).replace(/\s*$/, '')
    out = `${head}${head.endsWith('{') ? '' : ','}\n  "pr": ${JSON.stringify(changes)}\n${text.slice(end)}`
  } else {
    let block = text.slice(at[0], at[1])
    const added = []
    for (const [key, value] of Object.entries(changes)) {
      const re = new RegExp(`("${key}"\\s*:\\s*)(?:${VALUE})`)
      if (re.test(block)) block = block.replace(re, (_, k) => `${k}${JSON.stringify(value)}`)
      else added.push(`"${key}": ${JSON.stringify(value)}`)
    }
    if (added.length) {
      const indent = /^\{\s*\n([ \t]*)\S/.exec(block)?.[1]
      const empty = /^\{\s*\}$/.test(block)
      block = empty ? `{ ${added.join(', ')} }`
        : indent !== undefined ? `{\n${added.map(a => `${indent}${a},`).join('\n')}${block.slice(1)}`
        : `{ ${added.join(', ')},${block.slice(1)}`
    }
    out = text.slice(0, at[0]) + block + text.slice(at[1])
  }
  try {
    if (same(JSON.parse(out), want)) return out
  } catch {}
  return `${JSON.stringify(want, null, 2)}\n`
}

export function writePrKeys(file, changes) {
  writeAtomic(file, withPrKeys(readFileSync(file, 'utf8'), changes))
}
