// The phone listener open exactly while the live remote block says it should be (phone-wiring.mjs ticks it every
// few seconds, and the handler ticks it the moment it sees phone access off).
//
//   on, and nothing open            open one listener on the block's address and port
//   open on another address or port close it, then open the new one
//   off for any reason              close it: turned off on the desktop or in config.json, three lockouts in a day,
//                                   config.json that does not parse, or this PC no longer on the network phone access
//                                   was set up on (phone-bind.mjs networkProblem). When the block is good again (the
//                                   PC is back on that network), the next tick opens it again.
// Closing ends every open connection too, so a phone mid-request is cut off rather than served from a closed door.
// A listener that fails to open (the address went away between the check and the listen) is tried on the next tick.
//
//   makeDoor({ settings, open, log })   { tick(), close(), address() }; `open(settings)` returns a server

export function makeDoor({ settings, open, log = m => console.log(m) }) {
  let server = null
  let at = null // { bind, port } of the open listener

  function close(why) {
    if (!server) return
    const s = server
    server = null
    at = null
    try {
      s.close?.()
      s.closeAllConnections?.()
    } catch { /* already closed */ }
    if (why) log(`phone: the phone listener is closed: ${why}`)
  }

  function tick() {
    const s = settings()
    const want = s?.enabled ? { bind: s.bind, port: s.port } : null
    if (server && (!want || want.bind !== at.bind || want.port !== at.port)) close(s?.off || 'its address changed')
    if (server || !want) return
    try {
      const srv = open(s)
      server = srv
      at = want
      srv?.on?.('error', () => { if (server === srv) close() }) // it did not open after all: the next tick tries again
    } catch (err) {
      log(`phone: could not open the phone listener (${err?.code || err?.message || err}); trying again shortly`)
      server = null
      at = null
    }
  }

  return { tick, close: () => close(), address: () => (at ? { ...at } : null) }
}
