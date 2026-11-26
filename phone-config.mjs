// The two writes to config.json's `remote` block, in one place, each changing only its own keys and leaving every
// other byte as it was (config-write.mjs):
//
//   withRemote(text, changes)    the file's text with these keys of the block set: in place when the block is there,
//                                else a whole new block (off), for phone-pin and phone-setup (tools/phone-cli.mjs)
//   turnPhoneOff(file)           remote.enabled false: the desktop's Turn phone access off (phone-desktop-routes.mjs)
//                                and the ESCALATION after repeated lockouts (phone-auth.mjs ESCALATE, phone-wiring.mjs).
//                                { ok, changed }; a config with no remote block, or one already off, is left alone.
//
// Nothing here turns phone access ON: that is phone-setup, in a terminal, after a typed yes.

import { readFileSync } from 'node:fs'

import { withConfigKeys, writeConfigKeys } from './config-write.mjs'
import { REMOTE_DEFAULTS } from './phone-bind.mjs'

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)

export function withRemote(text, changes) {
  const obj = JSON.parse(text)
  if (isObject(obj.remote)) return withConfigKeys(text, Object.fromEntries(Object.entries(changes).map(([k, v]) => [`remote.${k}`, v])))
  const { pinSetAt: _, ...base } = REMOTE_DEFAULTS
  return withConfigKeys(text, { remote: { ...base, ...changes } })
}

export function turnPhoneOff(file) {
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')).remote
  } catch {
    return { ok: false, error: 'config.json could not be read.' }
  }
  if (!isObject(raw) || raw.enabled === false) return { ok: true, changed: false }
  writeConfigKeys(file, { 'remote.enabled': false })
  return { ok: true, changed: true }
}
