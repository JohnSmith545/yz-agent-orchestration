// The chat's live half (the Master tab): reading the thread on PhoneChat.pollMs, following a new reply down or
// showing the New reply pill, Send on or off, sending, and Try again. phone-app.js makes ONE of these with its own
// state and network call and redraws through its own draw; the markup and the rules are public/phone-chat.js.
//
// Rules this file keeps:
// - The thread is read only on the chat tab and only while the page shows: every 5 s while a message is on its way
//   or the coordinator works, else every 15 s (PhoneChat.pollMs, on the PC's clock from the thread).
// - Whether the reader was near the bottom is measured BEFORE the redraw makes the page taller; a new reply is then
//   followed down, or the pill shows until they scroll down or tap it. Their own message is always followed.
// - One message at a time: Send is off while the box is empty or one is in flight; the box empties only once the
//   server has the message (202), so a refusal or a lost network leaves the text where it was.
// - Try again puts the text of a message that was not delivered back in the box, and sends nothing by itself.
//
//   PhoneChatLive.make({ root, st, call, draw, say, offline }) ->
//     { load({ follow }), schedule(), stop(), reset(), send(form), retry(id), updateSend(), showPill(), onScroll() }
;(() => {
  const C = window.PhoneChat
  const K = window.PhoneComposer
  const doc = window.document

  function make({ root, st, call, draw, say, offline }) {
    let timer = null
    let seen = -1 // replies on screen at the last draw of the chat (-1: none yet, so it opens at the bottom)

    const visible = () => doc.visibilityState !== 'hidden'
    const pcNow = () => Date.parse(st.thread?.now) || Date.now()
    const scrollState = () => ({ scrollTop: window.scrollY || 0, clientHeight: window.innerHeight || 0, scrollHeight: doc.documentElement.scrollHeight || 0 })
    const toBottom = () => window.scrollTo(0, doc.documentElement.scrollHeight)

    function stop() {
      window.clearTimeout(timer)
      timer = null
    }

    /** The next read of the thread, on the chat tab only. */
    function schedule() {
      stop()
      if (!st.signedIn || st.tab !== 'talk') return
      const ms = C.pollMs(st.thread, pcNow(), visible())
      if (ms) timer = window.setTimeout(load, ms)
    }

    function showPill() {
      const pill = root.querySelector('[data-ph-newreply]')
      if (pill) pill.hidden = !st.pill
    }

    async function load({ follow = false } = {}) {
      const near = C.nearBottom(scrollState())
      const r = await call('GET', '/phone/api/talk')
      if (r.status === 200) st.thread = r.json
      if (st.tab === 'talk' && st.thread) {
        const count = C.replyCount(st.thread)
        const what = follow ? 'follow' : C.onNewReplies(seen, count, near)
        seen = count
        if (what === 'pill') st.pill = true
        draw()
        if (what === 'follow') {
          st.pill = false
          showPill()
          toBottom()
        }
      } else draw()
      schedule()
    }

    /** Send on or off for the text in the box now (the server's own one-at-a-time refusal still stands behind it). */
    function updateSend() {
      const box = root.querySelector('#phTalk')
      const btn = root.querySelector('.ph-send-btn')
      if (!box || !btn) return
      const sending = !!st.thread?.busy || C.status(st.thread, pcNow()).kind === 'sending' || !!st.ui.busy.talk
      btn.disabled = !C.canSend(box.value, sending)
    }

    async function send(form) {
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
        return load({ follow: true })
      }
      if (r.status !== 401) say('talk', r.status ? r.json.error || 'Not sent.' : `${offline} Your text is still in the box.`)
    }

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

    function onScroll() {
      if (st.pill && C.nearBottom(scrollState())) {
        st.pill = false
        showPill()
      }
    }

    /** A new visit to the tab opens at the bottom again, with no pill. */
    function reset() {
      seen = -1
      st.pill = false
    }

    return { load, schedule, stop, reset, send, retry, updateSend, showPill, onScroll }
  }

  window.PhoneChatLive = { make }
})()
