// The phone's chat with the coordinator (the Master tab of public/phone.html), PURE: the states, the poll timing and
// the markup, so the tests run it in a vm. phone-app.js fetches GET /phone/api/talk, binds the clicks and keeps the
// composer above the on-screen keyboard; phone-text.js formats a reply safely.
//
// THE THREAD (phone-talk.mjs): the last 30 messages from any phone signed in with the PIN, oldest first, each with
// the coordinator's replies written after it. Your message on the right, its replies under it on the left, newest
// at the bottom, each with a short time. Only the coordinator's written words ever reach the phone.
//
// THE STATES, in plain words:
//   a message     Sending… -> Delivered to Master (the relay turn handed it over) | Not delivered: <why>, with a
//                 Try again that puts the text back in the box (it sends nothing by itself)
//   the thread    Master is working…, with a quiet animation (none under reduced motion), from delivery until a
//                 reply appears or WORKING_MS pass; then one line that there is no reply yet. Measured on the PC's
//                 clock (`now` in the thread), never the phone's.
//   the poll      every 5 s while a message is on its way or Master is working and the tab shows, else every 15 s;
//                 none while the page is hidden
//
//   messageWord(m, label)   status(thread, nowMs)   pollMs(thread, nowMs, visible)   canSend(text, sending)
//   replyCount(thread)      nearBottom({ scrollTop, clientHeight, scrollHeight })   onNewReplies(seen, count, near)
//   stamp(at, nowMs)        view(thread, ui, nowMs)   ui: { talkDraft, status: { talk } }
;(() => {
  const S = window.PhoneState
  const T = window.PhoneText
  const esc = T.esc
  const attr = (k, v) => ` ${k}="${esc(v)}"`

  const WORKING_MS = 10 * 60_000
  const FAST_MS = 5000
  const SLOW_MS = 15_000
  const NEAR_PX = 120
  const COST_FIXED = 'Each message costs a few cents.'

  const nameOf = th => String(th?.label || 'Master')
  const messagesOf = th => (Array.isArray(th?.messages) ? th.messages : [])
  const repliesOf = m => (Array.isArray(m?.replies) ? m.replies : [])

  function messageWord(m, label) {
    if (m?.state === 'sending') return 'Sending…'
    if (m?.state === 'sent') return `Delivered to ${label || 'Master'}`
    return m?.error ? `Not delivered: ${m.error}` : 'Not delivered.'
  }

  /** { kind: idle | sending | working | quiet, text }: what the whole thread is waiting on, by its LAST message. */
  function status(th, nowMs) {
    const label = nameOf(th)
    const last = messagesOf(th).at(-1)
    if (!last) return { kind: 'idle', text: '' }
    if (last.state === 'sending') return { kind: 'sending', text: '' }
    if (last.state !== 'sent' || repliesOf(last).length) return { kind: 'idle', text: '' }
    const since = Date.parse(last.deliveredAt || last.at)
    if (!Number.isNaN(since) && nowMs - since < WORKING_MS) return { kind: 'working', text: `${label} is working…` }
    return { kind: 'quiet', text: `No reply yet. ${label} may be busy with other work; its reply shows here when it comes.` }
  }

  function pollMs(th, nowMs, visible) {
    if (!visible) return null
    const k = status(th, nowMs).kind
    return k === 'sending' || k === 'working' ? FAST_MS : SLOW_MS
  }

  const canSend = (text, sending) => !sending && String(text ?? '').trim() !== ''
  const replyCount = th => messagesOf(th).reduce((n, m) => n + repliesOf(m).length, 0)
  const nearBottom = ({ scrollTop, clientHeight, scrollHeight }) => scrollHeight - (scrollTop + clientHeight) <= NEAR_PX
  /** After a poll: follow the new reply down when the reader is near the bottom (or on the first draw), else the pill. */
  const onNewReplies = (seen, count, near) => (seen < 0 ? 'follow' : count > seen ? (near ? 'follow' : 'pill') : 'none')

  /** A short time: the clock today, the day and the clock before today. */
  function stamp(at, nowMs) {
    const clock = S.clock(at)
    if (!clock) return ''
    const day = S.when(at, nowMs)
    return day === clock ? clock : `${day} ${clock}`
  }

  function youBubble(m, label, nowMs) {
    const failed = m.state === 'failed'
    const meta = [stamp(m.at, nowMs), failed ? '' : messageWord(m, label)].filter(Boolean).join(' · ')
    return `<div class="ph-bubble is-you${failed ? ' is-failed' : ''}"><p class="ph-bubble-text">${esc(m.text)}</p></div>` +
      `<p class="ph-meta is-you">${esc(meta)}</p>` +
      (failed
        ? `<div class="ph-failed"><p class="ph-failed-why">${esc(messageWord(m, label))}</p><button type="button" class="ph-retry"${attr('data-ph-retry', m.id)}>Try again</button></div>`
        : '')
  }

  const themBubble = (r, label, nowMs) =>
    `<div class="ph-bubble is-them"><div class="ph-md">${T.render(r.text)}</div></div>` +
    `<p class="ph-meta">${esc([label, stamp(r.at, nowMs)].filter(Boolean).join(' · '))}</p>`

  function help(label) {
    return '<details class="ph-help"><summary>How this works</summary>' +
      `<p>Your message goes to ${esc(label)} on your PC through a short paid turn. ${esc(label)} answers in its own time, and its replies show under your message. Your PC must be on.</p>` +
      `<p>This thread is the same on every phone signed in with your PIN: the last 30 messages, each with what ${esc(label)} wrote after it. What it wrote before your first phone message is never shown, and only its written words reach the phone, never its tools or files.</p>` +
      '</details>'
  }

  function view(th, ui = {}, nowMs = Date.now()) {
    if (!th) return '<p class="ph-muted ph-pad-top">Loading…</p>'
    const label = nameOf(th)
    const list = messagesOf(th)
    const st = status(th, nowMs)
    const sending = !!th.busy || st.kind === 'sending' || !!ui.busy?.talk
    const thread = list.length
      ? `<ol class="ph-thread" aria-label="${esc(`Messages with ${label}`)}">${list.map(m =>
        `<li class="ph-x">${youBubble(m, label, nowMs)}${repliesOf(m).map(r => themBubble(r, label, nowMs)).join('')}</li>`).join('')}</ol>`
      : `<div class="ph-empty"><h1 class="ph-big">Write to ${esc(label)}</h1><p class="ph-muted">Ask how things stand, or tell it what to do next. Its replies show here.</p></div>`
    const waiting = st.kind === 'working'
      ? `<p class="ph-working" role="status"><span class="ph-dots" aria-hidden="true"><i></i><i></i><i></i></span>${esc(st.text)}</p>`
      : st.kind === 'quiet' ? `<p class="ph-working is-quiet" role="status">${esc(st.text)}</p>` : ''
    const said = ui.status?.talk ? `<p class="ph-status" role="status" data-status="talk">${esc(ui.status.talk)}</p>` : ''
    const draft = ui.talkDraft ?? ''
    return `<section class="ph-chat" aria-label="${esc(`Talk to ${label}`)}">` + help(label) +
      (th.running === false ? `<p class="ph-note ph-warn-text">${esc(label)} has no session open on your PC, so a message would not be delivered. Open it at the PC first.</p>` : '') +
      thread + waiting + '</section>' +
      '<button type="button" class="ph-pill" data-ph-newreply hidden>New reply</button>' +
      '<form class="ph-composer" data-ph-talk novalidate>' +
      `<label class="ph-sr" for="phTalk">${esc(`Message to ${label}`)}</label>` +
      `<textarea id="phTalk" class="ph-input ph-compose-box" rows="1" maxlength="2000" data-draft="talk"${attr('placeholder', `Message ${label}`)}></textarea>` +
      `<button type="submit" class="primary ph-send-btn"${canSend(draft, sending) ? '' : ' disabled'}>${sending ? 'Sending…' : 'Send'}</button>` +
      `${said}<p class="ph-cost">${esc(th.cost || COST_FIXED)}</p></form>`
  }

  window.PhoneChat = { WORKING_MS, messageWord, status, pollMs, canSend, replyCount, nearBottom, onNewReplies, stamp, view }
})()
