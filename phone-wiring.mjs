// Phone access, wired to the running server (server.mjs calls startPhone once, after its own 127.0.0.1 listener is
// up). Everything real is built here and nowhere else: the live remote block (phone-bind.mjs), the sign-in store
// (phone-auth.mjs), Talk to Master (phone-talk.mjs, sending through the relay's own headless turn), the allowlist
// (phone-actions.mjs), the listener (phone-server.mjs) and the door that opens and closes it (phone-door.mjs).
//
// With no `remote` block in config.json, or one that is off when the dashboard starts, this does NOTHING: no store
// is opened, no server is created, no watcher runs, nothing new listens, and nothing is printed (remoteSettings has
// already said why, once, for a block that is off). Turning it on is phone-setup, then a restart.
//
// Once it started on, the WATCHER ticks the door every CHECK_MS: the listener closes on any change (turned off on
// the desktop or in config.json, three lockouts in a day, a config.json that does not parse, this PC off the network
// it was set up on) and opens again when the block is good again, such as when the PC is back on that network.
//
//   startPhone({ getStatus, relay, run, sessions, transcriptFile }, { reader?, configFile? })   { door, stop() } or null

import { CONFIG, CONFIG_FILE } from './config.mjs'
import { makePhoneActions } from './phone-actions.mjs'
import { makeAuthStore } from './phone-auth.mjs'
import { makeRemoteReader } from './phone-bind.mjs'
import { turnPhoneOff } from './phone-config.mjs'
import { makeDoor } from './phone-door.mjs'
import { makePhoneHandler, startPhoneListener } from './phone-server.mjs'
import { makeTalk } from './phone-talk.mjs'

/** The remote block as config.json and the network say now: one reader for the listener and the desktop Settings card. */
export const remoteNow = makeRemoteReader(CONFIG_FILE, { mainPort: CONFIG.port })

/** How often the door is checked against the block and the network, when no phone is asking. */
const CHECK_MS = 5000

/** The coordinator's session, live or pinned, by its session name (config coordinator). */
const coordinatorOf = async sessions => (await sessions()).find(s => s.name === CONFIG.coordinator) || null

export function startPhone({ getStatus, relay, run, sessions, transcriptFile }, { reader = remoteNow, configFile = CONFIG_FILE } = {}) {
  if (!reader().enabled) return null
  const talk = makeTalk({
    agent: CONFIG.coordinator,
    label: CONFIG.coordinatorLabel,
    run,
    transcript: async () => {
      const s = await coordinatorOf(sessions)
      return s ? transcriptFile(s) : null
    },
    running: async () => {
      const s = await coordinatorOf(sessions)
      return !!s && !s.pinned // a pinned session that is closed is history, not running
    },
  })
  const lost = talk.sweep()
  if (lost) console.log(`phone: ${lost} message(s) to ${CONFIG.coordinatorLabel} were on their way when the dashboard stopped; the phone shows them as not sent`)
  const auth = makeAuthStore()
  const actions = makePhoneActions({ relay, talk, getStatus })
  let door = null
  // 3 lockouts in 24 hours (phone-auth.mjs ESCALATE): phone access OFF in config.json, the same write as Turn phone access off
  const onEscalate = () => {
    turnPhoneOff(configFile)
    reader.invalidate()
    door.tick()
  }
  door = makeDoor({
    settings: reader,
    open: s => startPhoneListener({
      settings: s,
      handler: makePhoneHandler({ settings: reader, own: () => ({ bind: s.bind, port: s.port }), auth, actions, onOff: () => door.tick(), onEscalate }),
    }),
  })
  door.tick()
  const watch = setInterval(() => door.tick(), CHECK_MS)
  watch.unref()
  return { door, stop() { clearInterval(watch); door.close() } }
}
