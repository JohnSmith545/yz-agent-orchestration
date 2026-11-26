// The phone page's live half (public/phone.html): it signs in, fetches, polls and binds the clicks; the words come
// from phone-state.js and the markup from phone-view.js and phone-chat.js. Everything it calls is on the phone listener
// (phone-server.mjs): /phone/login, /phone/logout and /phone/api/*. Every POST carries the session's CSRF token in
// X-Phone-CSRF; the session itself is an HttpOnly cookie this script never sees.
//
// Rules this file keeps:
// - The PIN is read once from its field when the user signs in, sent once and the field emptied. Nothing here
//   stores it, or anything else, in the browser (no web storage, no cookie it can read, no cache): there is no service worker.
// - Polling only while the page is visible: the summary every SUMMARY_MS and, on the coordinator's tab, the thread
//   on PhoneChat.pollMs (5 s while a message is on its way or the coordinator works, else 15 s). Hidden, it stops;
//   visible again, it refreshes at once.
// - A redraw keeps what the user is typing (every [data-draft] field) and where the focus is, so a poll never eats
//   an answer half written.
// - The chat: one message at a time (Send is off while the box is empty or one is in flight); the box empties once
//   the server has the message; a message that was not delivered has Try again, which puts its text back in the box
//   and sends nothing by itself. A new reply is followed down only when the reader is near the bottom, else the
//   New reply pill shows. The composer stays above the on-screen keyboard (phone-composer.js).
// - The address names the tab (#talk, #needs …), so a reload or a home-screen icon opens where the user was.
// - The PC unreachable: a quiet line at the top, and the page keeps trying. The session over (401): back to the PIN.
;(() => {
  const S = window.PhoneState
  const V = window.PhoneView
  const C = window.PhoneChat
  const K = window.PhoneComposer
  const doc = window.document
  const root = doc.getElementById('app')
  if (!root) return

  const SUMMARY_MS = 15_000
  const OFFLINE = 'Cannot reach your PC. It may be off or asleep; trying again.'
  const OFF = 'Phone access is off on your PC.'

  const first = S.routeOf(window.location.hash)
  const st = {
    signedIn: false, csrf: '', tab: first.tab, summary: null, thread: null, notice: '', pill: false,
    signIn: { status: '', busy: false }, ui: { status: {}, busy: {}, confirm: null, talkDraft: '' },
  }
  let timers = []
  let talkTimer = null
  let talkSeen = -1 // how many replies were on screen at the last draw of the chat (-1: none yet, open at the bottom)

  // ═══ the network ═══

  async function call(method, url, body) {
    let r
    try {
      r = await window.fetch(url, {
        method, credentials: 'same-origin', cache: 'no-store',
        headers: method === 'POST' ? { 'content-type': 'application/json', 'x-phone-csrf': st.csrf } : {},
        body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
      })
    } catch {
      st.notice = OFFLINE
      return { status: 0, json: {} }
    }
    const json = await r.json().catch(() => ({}))
    st.notice = r.status === 503 ? OFF : ''
    if (r.status === 401 && url !== '/phone/login' && url !== '/phone/api/me') signedOut('Your session ended. Sign in again.')
    return { status: r.status, json }
  }

  function signedOut(why) {
    stop()
    Object.assign(st, { signedIn: false, csrf: '', summary: null, thread: null, pill: false })
    st.signIn = { status: why || '', busy: false }
    draw()
  }

  async function loadSummary() {
    const r = await call('GET', '/phone/api/summary')
    if (r.status === 200) st.summary = r.json
    draw()
  }

  // ═══ the chat ═══

  const visible = () => doc.visibilityState !== 'hidden'
  const pcNow = () => Date.parse(st.thread?.now) || Date.now()
  const scrollState = () => ({ scrollTop: window.scrollY || 0, clientHeight: window.innerHeight || 0, scrollHeight: doc.documentElement.scrollHeight || 0 })
  const toBottom = () => window.scrollTo(0, doc.documentElement.scrollHeight)

  /** The next read of the thread, on the chat tab only: 5 s while something is on its way, else 15 s. */
  function scheduleTalk() {
    window.clearTimeout(talkTimer)
    talkTimer = null
    if (!st.signedIn || st.tab !== 'talk') return
    const ms = C.pollMs(st.thread, pcNow(), visible())
    if (ms) talkTimer = window.setTimeout(loadThread, ms)
  }

  async function loadThread({ follow = false } = {}) {
    const near = C.nearBottom(scrollState()) // measured BEFORE the redraw makes the page taller
    const r = await call('GET', '/phone/api/talk')
    if (r.status === 200) st.thread = r.json
    if (st.tab === 'talk' && st.thread) {
      const count = C.replyCount(st.thread)
      const what = follow ? 'follow' : C.onNewReplies(talkSeen, count, near)
      talkSeen = count
      if (what === 'pill') st.pill = true
      draw()
      if (what === 'follow') {
        st.pill = false
        showPill()
        toBottom()
      }
    } else draw()
    scheduleTalk()
  }

  function showPill() {
    const pill = root.querySelector('[data-ph-newreply]')
    if (pill) pill.hidden = !st.pill
  }

  /** Send on or off for the text in the box now (the server's own one-at-a-time refusal still stands behind it). */
  function updateSend() {
    const box = root.querySelector('#phTalk')
    const btn = root.querySelector('.ph-send-btn')
    if (!box || !btn) return
    const sending = !!st.thread?.busy || C.status(st.thread, pcNow()).kind === 'sending' || !!st.ui.busy.talk
    btn.disabled = !C.canSend(box.value, sending)
  }

  async function sendTalk(form) {
    const box = form.querySelector('[data-draft="talk"]')
    const text = box?.value || ''
    if (!text.trim()) return say('talk', 'Type a message first.')
    st.ui.busy.talk = true
    st.ui.status.talk = ''
    draw()
    const r = await call('POST', '/phone/api/talk', { text })
    delete st.ui.busy.talk
    if (r.status === 202) {
      st.ui.status.talk = ''
      draw({ talk: '' }) // the server has it now: the box empties
      return loadThread({ follow: true })
    }
    if (r.status !== 401) say('talk', r.status ? r.json.error || 'Not sent.' : `${OFFLINE} Your text is still in the box.`)
  }

  /** Try again: the message's text back in the box, ready to send; nothing is sent until the user presses Send. */
  function retry(id) {
    const m = (st.thread?.messages || []).find(x => x.id === id)
    const box = root.querySelector('#phTalk')
    if (!m || !box) return
    box.value = m.text
    st.ui.talkDraft = m.text
    K.grow(box)
    K.measure(root)
    updateSend()
    box.focus()
  }

  // ═══ polling, only while visible ═══

  function stop() {
    for (const t of timers) window.clearInterval(t)
    timers = []
    window.clearTimeout(talkTimer)
    talkTimer = null
  }
  function start() {
    stop()
    if (!st.signedIn || !visible()) return
    timers.push(window.setInterval(loadSummary, SUMMARY_MS))
    scheduleTalk()
  }
  doc.addEventListener('visibilitychange', () => {
    if (!visible()) return stop()
    if (!st.signedIn) return
    loadSummary()
    if (st.tab === 'talk') loadThread()
    start()
  })

  // ═══ drawing, keeping drafts and focus ═══

  /** A selector that finds the same control after a redraw: its id, or its tag and data- attributes. */
  function selectorOf(el) {
    if (!el || el === doc.body || !el.tagName) return ''
    if (el.id) return `#${el.id}`
    const data = [...el.attributes].filter(a => a.name.startsWith('data-')).map(a => `[${a.name}="${String(a.value).replace(/"/g, '\\"')}"]`).join('')
    return data ? `${el.tagName.toLowerCase()}${data}` : ''
  }

  function draw(put = {}) {
    const drafts = {}
    for (const f of root.querySelectorAll('[data-draft]')) drafts[f.getAttribute('data-draft')] = f.value
    Object.assign(drafts, put)
    if (drafts.talk !== undefined) st.ui.talkDraft = drafts.talk
    const focus = selectorOf(doc.activeElement)
    if (!st.signedIn) {
      root.innerHTML = V.signIn(st.signIn)
    } else {
      const label = st.summary?.coordinator || st.thread?.label || 'Master'
      const body = st.tab === 'needs' ? V.needs(st.summary, st.ui)
        : st.tab === 'outputs' ? V.outputs(st.summary, st.ui)
        : st.tab === 'talk' ? V.talk(st.thread, st.ui)
        : V.now(st.summary)
      root.innerHTML = '<div class="ph-app">' +
        `<header class="ph-top"><span class="ph-brand">${V.esc(V.tabTitle(st.tab, label))}</span><span class="ph-notice" role="status">${V.esc(st.notice)}</span>` +
        '<button type="button" class="link ph-out" data-ph-signout>Sign out</button></header>' +
        `<main class="ph-main${st.tab === 'talk' ? ' is-chat' : ''}" id="phMain">${body}</main>${V.nav(st.tab, st.summary, label)}</div>`
    }
    for (const f of root.querySelectorAll('[data-draft]')) {
      const k = f.getAttribute('data-draft')
      if (drafts[k] !== undefined) f.value = drafts[k]
    }
    if (st.tab === 'talk') {
      K.grow(root.querySelector('#phTalk'))
      K.measure(root)
      showPill()
    }
    if (focus) root.querySelector(focus)?.focus?.({ preventScroll: true })
  }

  const say = (key, text) => { st.ui.status[key] = text; draw() }

  // ═══ actions ═══

  async function signIn(form) {
    const field = form.querySelector('[data-ph-pin]')
    const pin = field?.value || ''
    if (field) field.value = '' // read once, never kept
    const problem = S.pinProblem(pin)
    if (problem) { st.signIn = { status: problem, busy: false }; return draw() }
    st.signIn = { status: '', busy: true }
    draw()
    const r = await call('POST', '/phone/login', { pin })
    if (r.status !== 200) {
      st.signIn = { status: r.status ? r.json.error || 'Sign-in failed.' : OFFLINE, busy: false }
      return draw()
    }
    Object.assign(st, { signedIn: true, csrf: r.json.csrf, signIn: { status: '', busy: false } })
    opened()
  }

  async function act(key, url, body, done) {
    st.ui.busy[key] = true
    st.ui.status[key] = 'Sending…'
    draw()
    const r = await call('POST', url, body)
    delete st.ui.busy[key]
    if (r.status === 401) return
    st.ui.status[key] = r.status === 200 ? done : r.status ? r.json.error || `Not done (${r.status}).` : OFFLINE
    if (r.status === 200) await loadSummary()
    else draw()
    return r
  }

  function answer(btn, value) {
    const flowId = btn.getAttribute('data-flow')
    const nodeId = btn.getAttribute('data-node')
    const key = `ask:${flowId}:${nodeId}`
    if (value === undefined) {
      value = root.querySelector(`[data-draft="${key}"]`)?.value || ''
      if (!value.trim()) return say(key, 'Type an answer first.')
    }
    return act(key, '/phone/api/answer', { flowId, nodeId, answer: value }, 'Answered. The agent hears it shortly.')
  }

  /** A refused tick redraws from the summary as it was, so the box goes back to what is stored. */
  function tick(box) {
    const flowId = box.getAttribute('data-flow')
    const on = !!box.checked
    return act(`hand:${flowId}`, '/phone/api/tick', { flowId, step: box.getAttribute('data-step'), done: on }, on ? 'Ticked.' : 'Unticked.')
  }

  async function complete(flowId) {
    const r = await act(`out:${flowId}`, '/phone/api/complete', { flowId }, 'Completed.')
    if (r?.status === 200) st.ui.confirm = null
    draw()
  }

  function go(tab) {
    st.tab = tab
    st.ui.confirm = null
    st.pill = false
    talkSeen = -1
    window.history?.replaceState?.(null, '', S.hashOf(tab))
    draw()
    window.scrollTo(0, 0)
    scheduleTalk()
    if (tab === 'talk') loadThread()
    else loadSummary()
  }

  /** Signed in (or a session already open): the summary, the tab the address named, and the polls. */
  async function opened() {
    draw()
    await loadSummary()
    if (st.tab === 'talk') await loadThread()
    start()
  }

  root.addEventListener('click', e => {
    const t = e.target?.closest ? e.target : null
    if (!t) return
    const key = t.closest('[data-ph-key]')
    if (key) {
      const field = root.querySelector('[data-ph-pin]')
      if (!field) return
      const k = key.getAttribute('data-ph-key')
      field.value = k === 'clear' ? '' : k === 'back' ? field.value.slice(0, -1) : (field.value + k).slice(0, 12)
      return
    }
    const tab = t.closest('[data-ph-tab]')
    if (tab) return go(tab.getAttribute('data-ph-tab'))
    const again = t.closest('[data-ph-retry]')
    if (again) return retry(again.getAttribute('data-ph-retry'))
    if (t.closest('[data-ph-newreply]')) {
      st.pill = false
      showPill()
      return toBottom()
    }
    const yn = t.closest('[data-ph-answer]')
    if (yn) return answer(yn, yn.getAttribute('data-ph-answer'))
    const txt = t.closest('[data-ph-answer-text]')
    if (txt) return answer(txt)
    const c = t.closest('[data-ph-complete]')
    if (c) {
      st.ui.confirm = c.getAttribute('data-flow')
      draw()
      return root.querySelector('[data-ph-complete-yes]')?.focus()
    }
    const yes = t.closest('[data-ph-complete-yes]')
    if (yes) return complete(yes.getAttribute('data-flow'))
    const no = t.closest('[data-ph-complete-no]')
    if (no) {
      const id = no.getAttribute('data-flow')
      st.ui.confirm = null
      draw()
      return root.querySelector(`[data-ph-complete][data-flow="${id}"]`)?.focus()
    }
    if (t.closest('[data-ph-signout]')) {
      return call('POST', '/phone/logout', {}).then(() => signedOut('Signed out.'))
    }
  })
  root.addEventListener('change', e => {
    if (e.target?.matches?.('[data-ph-tick]')) tick(e.target)
  })
  root.addEventListener('input', e => {
    if (e.target?.id !== 'phTalk') return
    st.ui.talkDraft = e.target.value
    K.grow(e.target)
    K.measure(root)
    updateSend()
  })
  root.addEventListener('submit', e => {
    e.preventDefault()
    if (e.target.matches('[data-ph-login]')) return signIn(e.target)
    if (e.target.matches('[data-ph-talk]')) return sendTalk(e.target)
  })
  root.addEventListener('keydown', e => {
    if (e.key === 'Escape' && st.ui.confirm) {
      const id = st.ui.confirm
      st.ui.confirm = null
      draw()
      root.querySelector(`[data-ph-complete][data-flow="${id}"]`)?.focus()
    }
  })
  window.addEventListener('scroll', () => {
    if (st.pill && C.nearBottom(scrollState())) {
      st.pill = false
      showPill()
    }
  }, { passive: true })
  K.watchKeyboard()

  // ═══ start: a session already open (the cookie) goes straight in ═══
  ;(async () => {
    const r = await call('GET', '/phone/api/me')
    if (r.status === 200) {
      Object.assign(st, { signedIn: true, csrf: r.json.csrf })
      await opened()
    } else {
      st.signedIn = false
      st.signIn.status = r.status === 0 ? OFFLINE : r.status === 503 ? OFF : ''
      draw()
      root.querySelector('[data-ph-pin]')?.focus()
    }
  })()
})()
