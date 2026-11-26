// The phone page's pure logic (public/phone.html): the words and the small decisions, kept apart from the DOM so the
// tests run them in a vm. phone-view.js turns them into markup; phone-app.js does the fetching and the clicks.
//
//   needsLine(n)                  'Nothing needs you' | '1 thing needs you' | 'N things need you'
//   countParts(needs)             the three counts under it: questions, by hand, outputs to sign off
//   agentWord(a)                  'Busy' | 'Idle'
//   clock(at) / when(at, now)     '14:05' / today '14:05', another day '24 Nov' (times as on a clock: the desktop's one
//                                 relative-time helper, Shell.ago, is not loaded on the phone listener)
//   threadItems(talk)             the user's messages and the coordinator's replies, one list, oldest first
//   messageWord(m, label)         'Sending…' | 'Sent to Master' | 'Not sent: <why>'
//   draftBack(before, after, sentId)   the text to put back in the box when the message just sent failed, else null
//   pinProblem(pin)               why the typed PIN cannot be sent yet, or null (8 to 12 digits, as phone-auth.mjs)
//   failureOf(status)             'signedOut' (401) | 'offline' (no answer) | 'error'
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

  const agentWord = a => (a && a.busy ? 'Busy' : 'Idle')

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

  /** Oldest first; a message or reply with no time goes last, in the order given. */
  function threadItems(talk) {
    const t = talk || {}
    const mine = (Array.isArray(t.messages) ? t.messages : []).map(m => ({ who: 'you', at: m.at, text: String(m.text || ''), state: m.state, error: m.error || '', id: m.id }))
    const theirs = (Array.isArray(t.replies) ? t.replies : []).map(r => ({ who: 'them', at: r.at, text: String(r.text || '') }))
    const key = x => (Number.isNaN(Date.parse(x.at)) ? Infinity : Date.parse(x.at))
    return [...mine, ...theirs].map((x, i) => ({ x, i })).sort((a, b) => key(a.x) - key(b.x) || a.i - b.i).map(({ x }) => x)
  }

  function messageWord(m, label) {
    if (!m) return ''
    if (m.state === 'sending') return 'Sending…'
    if (m.state === 'sent') return `Sent to ${label || 'Master'}`
    return `Not sent: ${m.error || 'it did not go'}`
  }

  /** When the message `sentId` was sending before and has failed now, its text goes back in the box. */
  function draftBack(before, after, sentId) {
    if (!sentId) return null
    const was = (before || []).find(m => m.id === sentId)
    const now = (after || []).find(m => m.id === sentId)
    if (!now || now.state !== 'failed' || (was && was.state === 'failed')) return null
    return now.text
  }

  function pinProblem(pin) {
    const p = String(pin ?? '')
    if (!/^[0-9]*$/.test(p)) return 'Only digits.'
    if (p.length < 8) return 'At least 8 digits.'
    if (p.length > 12) return 'At most 12 digits.'
    return null
  }

  const failureOf = status => (status === 401 ? 'signedOut' : !status ? 'offline' : 'error')

  window.PhoneState = { needsLine, countParts, agentWord, clock, when, threadItems, messageWord, draftBack, pinProblem, failureOf }
})()
