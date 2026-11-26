// Rate limits for the phone listener (phone-server.mjs), in memory: a fixed window per key.
//
//   session  60 WRITES a minute per signed-in session (the POSTs of /phone/api/* and sign-out)
//   read     180 READS a minute per signed-in session (the GETs of /phone/api/*): one page load is three reads
//            and the tabs poll every 5 to 15 s, so 60 was used up by a few reloads; the page also backs off after
//            a 429 (phone-state.js backoffMs). The address limit below still caps one address at 120 a minute.
//   address  120 requests a minute per network address on anything the phone listener serves, except a 304
//   revalidate  1200 a minute per address: the 304s (a page file the browser already holds, phone-assets.mjs), kept
//            OFF the address limit so reloading the page never uses it up (a 429 on a script was a blank page). A
//            304 costs a stat and a compare; this ceiling only bounds a flood. Past it, a request counts as before.
//   login    10 sign-in tries a minute per address, before the PIN is even checked (scrypt is slow on purpose;
//            this keeps a flood from tying the server up, while the five-try lock in phone-auth.mjs is what
//            stops guessing)
//
// A restart forgets these counts; that is fine, because the lock that matters (wrong PINs) is kept on disk.
// The table of keys is capped (`keys`): the oldest windows go first, so a flood of addresses cannot grow it.
//
//   makeLimiter({ max, ms, now, keys })   { hit(key) -> { ok, retryAfter? }, size() }

export const PHONE_LIMITS = Object.freeze({
  session: Object.freeze({ max: 60, ms: 60_000 }),
  read: Object.freeze({ max: 180, ms: 60_000 }),
  address: Object.freeze({ max: 120, ms: 60_000 }),
  revalidate: Object.freeze({ max: 1200, ms: 60_000 }),
  login: Object.freeze({ max: 10, ms: 60_000 }),
})

export function makeLimiter({ max, ms, now = Date.now, keys = 1000 }) {
  const windows = new Map() // key -> { start, count }, oldest first (Map keeps insertion order)
  function hit(key) {
    const t = now()
    const k = String(key ?? '')
    let w = windows.get(k)
    if (!w || t - w.start >= ms) {
      windows.delete(k)
      w = { start: t, count: 0 }
      windows.set(k, w)
      while (windows.size > keys) windows.delete(windows.keys().next().value)
    }
    if (w.count >= max) return { ok: false, retryAfter: Math.max(1, Math.ceil((w.start + ms - t) / 1000)) }
    w.count += 1
    return { ok: true }
  }
  return { hit, size: () => windows.size }
}
