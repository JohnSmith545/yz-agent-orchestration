// Phone access, wired to the running server (server.mjs calls startPhone once, after its own 127.0.0.1 listener is
// up). Everything real is built here and nowhere else: the live remote block (phone-bind.mjs), the sign-in store
// (phone-auth.mjs), Talk to Master (phone-talk.mjs, sending through the relay's own headless turn), the allowlist
// (phone-actions.mjs) and the listener (phone-server.mjs).
//
// With no `remote` block in config.json this does NOTHING: no store is opened, no server is created, nothing new
// listens, and nothing is printed. With a block that is off or wrong, remoteSettings has already said why, once.
//
//   startPhone({ getStatus, relay, run, sessions, transcriptFile })   the phone server, or null

import { CONFIG, CONFIG_FILE } from './config.mjs'
import { makePhoneActions } from './phone-actions.mjs'
import { makeAuthStore } from './phone-auth.mjs'
import { makeRemoteReader } from './phone-bind.mjs'
import { makePhoneHandler, startPhoneListener } from './phone-server.mjs'
import { makeTalk } from './phone-talk.mjs'

/** The remote block as config.json says now: one reader for the listener and the desktop Settings card. */
export const remoteNow = makeRemoteReader(CONFIG_FILE, { mainPort: CONFIG.port })

/** How often the running listener checks that phone access is still on, when no phone is asking. */
const OFF_CHECK_MS = 5000

/** The coordinator's session, live or pinned, by its session name (config coordinator). */
const coordinatorOf = async sessions => (await sessions()).find(s => s.name === CONFIG.coordinator) || null

export function startPhone({ getStatus, relay, run, sessions, transcriptFile }) {
  const settings = remoteNow()
  if (!settings.enabled) return null
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
  const own = { bind: settings.bind, port: settings.port }
  let server = null
  let watch = null
  let closed = false
  const onOff = () => {
    if (closed) return
    closed = true
    clearInterval(watch)
    console.log('phone: phone access was turned off in config.json; the phone listener is closed until the dashboard restarts')
    server?.close()
    server?.closeIdleConnections?.()
  }
  const handler = makePhoneHandler({ settings: remoteNow, own: () => own, auth: makeAuthStore(), actions: makePhoneActions({ relay, talk, getStatus }), onOff })
  server = startPhoneListener({ settings, handler })
  // Turned off with no phone asking (Settings, Turn phone access off; or config.json edited): the door closes within OFF_CHECK_MS
  watch = setInterval(() => {
    const now = remoteNow()
    if (!now.enabled || now.bind !== own.bind || now.port !== own.port) onOff()
  }, OFF_CHECK_MS)
  watch.unref()
  return server
}
