// The routing settings as config.json says NOW: its `routing` block, re-read whenever the file's time or size
// changes, so a rule saved on the Routing page takes effect without a restart, in the server and in every agent's
// `flow new` alike (like config.mjs makePrReader). A file that does not parse (half written) keeps the last good
// settings. The checks are routing-rules.mjs routingSettings: a bad rule list keeps the defaults with one warning,
// said once per change of the file, not on every read.
//
//   makeRoutingReader(file)          read() -> { rules, custom, intakeModel, warning }; read.invalidate()
//   routingNow                       the reader of this dashboard's config.json
//   writeRoutingRules(file, rules)   the rules into config.json's routing.rules, every other byte kept (config-write.mjs)

import { readFileSync, statSync } from 'node:fs'

import { CONFIG_FILE } from './config.mjs'
import { writeConfigKeys } from './config-write.mjs'
import { routingSettings } from './routing-rules.mjs'

export function makeRoutingReader(file, { warn = console.warn } = {}) {
  let key = null
  let value = null
  const read = () => {
    let st
    try {
      st = statSync(file)
    } catch {
      return value ?? routingSettings(undefined, warn)
    }
    const k = `${st.mtimeMs}:${st.size}`
    if (k !== key || !value) {
      try {
        value = routingSettings(JSON.parse(readFileSync(file, 'utf8')).routing, warn)
        key = k
      } catch {
        value ??= routingSettings(undefined, warn)
      }
    }
    return value
  }
  return Object.assign(read, { invalidate() { key = null } })
}

export const routingNow = makeRoutingReader(CONFIG_FILE)

/** Write `rules` (already checked) as config.json's routing.rules, atomically, the rest of the file as it was. */
export function writeRoutingRules(file, rules) {
  // a config with no routing block yet gets one whole, so the parent object is there and no other byte moves
  const has = JSON.parse(readFileSync(file, 'utf8')).routing
  writeConfigKeys(file, has && typeof has === 'object' && !Array.isArray(has) ? { 'routing.rules': rules } : { routing: { rules } })
}
