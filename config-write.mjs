// Writes to config.json's "pr" block only: the Settings page and `factory.mjs pr-pin`
// change the send settings (enabled, bases, pinHash) and nothing else. Every byte
// outside that block stays as it was; inside it, a key that is there gets its new
// value in place and a new key goes at the top of the block, in its indentation.
// If the result would not parse to exactly that change, the whole file is written
// out again as JSON (same values, two-space indent) rather than risk a wrong one.
//
//   withPrKeys(text, changes)    the new text
//   writePrKeys(file, changes)   read, change, write atomically
//
// The Orchestration bank (orchestration-parts.mjs) writes a saved style into a project's config the same
// careful way, by dotted path ({ pipeline: {...}, 'factory.chat.name': 'Ask' }): each value is replaced where
// it stands, at its own indentation; a missing key is added at the end of its parent object; a parent that is
// not there, or a result that would not parse to exactly that change, writes the whole file again as JSON.
//
//   withConfigKeys(text, changes)    the new text
//   writeConfigKeys(file, changes)   read, change, write atomically
//   setKeys(object, changes)         the same change on a plain object (a project kept in projects.json)

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

// ═══ any key, by dotted path (the Orchestration bank) ═══

/**
 * Where each object member's value sits in `text`, by dotted path ('pipeline', 'factory.chat.name'), and where
 * each object's braces and last member end ('' is the whole file). Members of objects inside a list get a path
 * with `[]` in it, so no change ever matches them. `text` must be valid JSON (the caller parsed it first).
 */
function layout(text) {
  const members = new Map() // path -> { start, end, keyAt }
  const objects = new Map() // path -> { open, close, lastEnd }
  let i = 0
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++ }
  const str = () => {
    const s = i
    for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++
    i++
    return JSON.parse(text.slice(s, i))
  }
  function value(at) {
    ws()
    const c = text[i]
    if (c === '{') {
      const obj = { open: i, close: -1, lastEnd: -1 }
      i++
      ws()
      while (text[i] !== '}') {
        const keyAt = i
        const key = str()
        ws()
        i++ // the colon
        ws()
        const start = i
        const p = at === '' ? key : `${at}.${key}`
        value(p)
        members.set(p, { start, end: i, keyAt })
        obj.lastEnd = i
        ws()
        if (text[i] === ',') i++
        ws()
      }
      obj.close = i++
      if (!objects.has(at)) objects.set(at, obj)
      return
    }
    if (c === '[') {
      i++
      ws()
      while (text[i] !== ']') {
        value(`${at}[]`)
        ws()
        if (text[i] === ',') i++
        ws()
      }
      i++
      return
    }
    if (c === '"') return void str()
    while (i < text.length && !/[\s,}\]]/.test(text[i])) i++
  }
  value('')
  return { members, objects }
}

/** The spaces before the first character of the line `at` is on. */
const indentAt = (text, at) => /[ \t]*/.exec(text.slice(text.lastIndexOf('\n', at - 1) + 1))[0]
const pretty = (value, indent, nl) => JSON.stringify(value, null, 2).split('\n').join(`${nl}${indent}`)

/** One change on the text, or null when its parent object is not there. */
function withOneKey(text, p, value, nl) {
  const { members, objects } = layout(text)
  const at = members.get(p)
  if (at) return text.slice(0, at.start) + pretty(value, indentAt(text, at.keyAt), nl) + text.slice(at.end)
  const dot = p.lastIndexOf('.')
  const [parentPath, key] = dot < 0 ? ['', p] : [p.slice(0, dot), p.slice(dot + 1)]
  const parent = objects.get(parentPath)
  if (!parent) return null
  if (parent.lastEnd < 0) {
    const outer = indentAt(text, parent.open)
    const inner = `${outer}  `
    return `${text.slice(0, parent.open)}{${nl}${inner}${JSON.stringify(key)}: ${pretty(value, inner, nl)}${nl}${outer}}${text.slice(parent.close + 1)}`
  }
  const first = [...members].find(([k]) => (dot < 0 ? !k.includes('.') && !k.includes('[') : k.startsWith(`${parentPath}.`) && !k.slice(parentPath.length + 1).includes('.')))
  const indent = first ? indentAt(text, first[1].keyAt) : `${indentAt(text, parent.open)}  `
  const sameLine = first && text.slice(parent.open, first[1].keyAt).indexOf('\n') < 0
  const lead = sameLine ? ', ' : `,${nl}${indent}`
  return text.slice(0, parent.lastEnd) + lead + `${JSON.stringify(key)}: ${pretty(value, indent, nl)}` + text.slice(parent.lastEnd)
}

/** `obj` with each dotted path set to its value; the parents a path needs are made; `obj` is not changed. */
export function setKeys(obj, changes) {
  const out = structuredClone(obj ?? {})
  for (const [p, value] of Object.entries(changes)) {
    const keys = p.split('.')
    let o = out
    for (const k of keys.slice(0, -1)) {
      if (!o[k] || typeof o[k] !== 'object' || Array.isArray(o[k])) o[k] = {}
      o = o[k]
    }
    o[keys.at(-1)] = structuredClone(value)
  }
  return out
}

export function withConfigKeys(text, changes) {
  const want = setKeys(JSON.parse(text), changes)
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  let out = text
  for (const [p, value] of Object.entries(changes)) {
    out = withOneKey(out, p, value, nl)
    if (out === null) break
  }
  try {
    if (out !== null && same(JSON.parse(out), want)) return out
  } catch {}
  return `${JSON.stringify(want, null, 2)}${nl}`
}

export function writeConfigKeys(file, changes) {
  writeAtomic(file, withConfigKeys(readFileSync(file, 'utf8'), changes))
}
