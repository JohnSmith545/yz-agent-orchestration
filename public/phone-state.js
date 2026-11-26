// The phone page's pure logic (public/phone.html): the words and the small decisions, kept apart from the DOM so the
// tests run them in a vm. phone-view.js turns them into markup; phone-app.js does the fetching and the clicks.
//
//   needsLine(n)                  'Nothing needs you' | '1 thing needs you' | 'N things need you'
//   countParts(needs)             the three counts under it: questions, by hand, outputs to sign off
//   clock(at) / when(at, now)     '14:05' / today '14:05', another day '24 Nov' (times as on a clock: the desktop's one
//                                 relative-time helper, Shell.ago, is not loaded on the phone listener)
//   (the chat with the coordinator, its states and its words, is public/phone-chat.js)
//   pinProblem(pin)               why the typed PIN cannot be sent yet, or null (8 to 12 digits, as phone-auth.mjs)
//   failureOf(status)             'signedOut' (401) | 'offline' (no answer) | 'error'
//   routeOf(hash) / hashOf(tab)   the tab (or flow sheet) the address names, and the address of a tab
//   limitedAfter(n, status)       how many 429s in a row after this answer: +1 on a 429, kept when offline, else 0
//   backoffMs(baseMs, n)          a poll's wait after n 429s in a row: doubled each time, never past BACKOFF_MAX_MS,
//                                 so a refused phone slows down instead of hammering (phone-limits.mjs)
;(() => {
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

  function needsLine(n) {
    const k = Number(n) || 0
    return k === 0 ? 'Nothing needs you' : `${plural(k, 'thing needs', 'things need')} you`
  }

  function countParts(needs) {
    const n = needs || {}
    return [
      { key: 'asks', tab: 'needs', n: n.asks || 0, label: (n.asks || 0) === 1 ? 'question' : 'questions' },
      { key: 'hands', tab: 'needs', n: n.hands || 0, label: 'by hand' },
      { key: 'outputs', tab: 'outputs', n: n.outputs || 0, label: (n.outputs || 0) === 1 ? 'output to sign off' : 'outputs to sign off' },
    ]
  }

  const pad = x => String(x).padStart(2, '0')
  function clock(at) {
    const t = Date.parse(at)
    if (Number.isNaN(t)) return ''
    const d = new Date(t)
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  function when(at, now = Date.now()) {
    const t = Date.parse(at)
    if (Number.isNaN(t)) return ''
    const d = new Date(t)
    return d.toDateString() === new Date(now).toDateString() ? clock(at) : `${d.getDate()} ${MONTHS[d.getMonth()]}`
  }

  function pinProblem(pin) {
    const p = String(pin ?? '')
    if (!/^[0-9]*$/.test(p)) return 'Only digits.'
    if (p.length < 8) return 'At least 8 digits.'
    if (p.length > 12) return 'At most 12 digits.'
    return null
  }

  const failureOf = status => (status === 401 ? 'signedOut' : !status ? 'offline' : 'error')

  /** The bottom bar's tabs, the first is where the page opens. MUST CHANGE IN LOCKSTEP with phone-view.js nav. */
  const TABS = Object.freeze(['agents', 'needs', 'outputs', 'talk'])
  const FLOW_ID = /^[a-z0-9-]{1,80}$/
  /** The address's #tab or #flow=<id>: so a tab or a flow sheet can be opened, reloaded or kept on the home screen. */
  function routeOf(hash) {
    const h = String(hash ?? '').replace(/^#/, '')
    if (TABS.includes(h)) return { tab: h, flow: null }
    const m = /^flow=(.*)$/.exec(h)
    return { tab: TABS[0], flow: m && FLOW_ID.test(m[1]) ? m[1] : null }
  }
  const hashOf = tab => `#${tab}`

  const BACKOFF_MAX_MS = 60_000
  const limitedAfter = (n, status) => {
    const was = Number.isInteger(n) && n > 0 ? n : 0
    return status === 429 ? was + 1 : status === 0 ? was : 0
  }
  function backoffMs(baseMs, n) {
    const k = Number.isInteger(n) && n > 0 ? Math.min(n, 10) : 0 // 2^10 is far past the cap: no overflow
    return k ? Math.max(baseMs, Math.min(BACKOFF_MAX_MS, baseMs * 2 ** k)) : baseMs
  }

  window.PhoneState = { needsLine, countParts, clock, when, pinProblem, failureOf, TABS, routeOf, hashOf, limitedAfter, backoffMs, BACKOFF_MAX_MS }
})()
