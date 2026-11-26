// The Pull requests list on the page, the DOM half (the words, the HTML and what moves are prlist-view.js):
//
//   the Agents page   a small block under the Alerts line (agents-page.js puts the slot there); #/agents?prs scrolls to it
//   Home              the same block under the lines at the top (#homePrs in index.html)
//
// Slots: a page puts `data-prl` on an element and calls PrList.paint(root) after it draws; every load paints every
// slot again, and a slot whose HTML did not change is left alone. Nothing shows (the slot is hidden) while the list
// is empty. Data: GET /api/prs every 30 s while the tab is visible, and at once when it comes back (the server reads
// GitHub at most once a minute in the background, so a poll never waits on GitHub).
//
// ═══ THE MOVE UP ═══ When the keys change (prlist-view.js motionPlan), the slot is redrawn and then animated FLIP
// style: the one that left is drawn as a GHOST copy where it was (inert: no focus, not read out) and fades out,
// lifting a few pixels, in plan.leaveMs; each kept item starts where it was, at its old size (a scale) and its old
// opacity, waits plan.delay (until the ghost is gone, so no title is ever drawn over another) and then eases to its
// new place and step, the whole move in plan.ms; a new one fades in at the top. Under reduced motion, or for a slot not on show, the list
// simply redraws. A paint asked for while a move runs waits for it to end.
//
// Rules: no sound, no toast; the more line's open state lives in memory only; the focus stays on the same control
// across a redraw.
//
//   PrList.refresh(), paint(root), data
;(() => {
  const doc = window.document
  if (!doc) return
  const POLL_MS = 30_000
  const V = () => window.PrListView
  let data = null
  let open = false

  const reduced = () => {
    try {
      return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
    } catch {
      return false
    }
  }
  const keysOf = el => [...(el?.querySelectorAll('.prl-list > .prl-item[data-prl-key]') || [])].map(li => li.getAttribute('data-prl-key'))

  /** A selector for the focused control inside a slot, so a redraw puts the focus back on the same one. */
  function focusOf(el) {
    if (el.matches('[data-prl-more]')) return '[data-prl-more]'
    if (el.matches('.help')) return '.help'
    const li = el.closest('[data-prl-key]')
    if (!li) return null
    const part = el.matches('.prl-flow') ? '.prl-flow' : '.prl-title'
    return `[data-prl-key="${CSS.escape(li.getAttribute('data-prl-key'))}"] ${part}`
  }

  function draw(el, html) {
    const focusKey = doc.activeElement && el.contains(doc.activeElement) ? focusOf(doc.activeElement) : null
    el._prlHtml = html
    el.innerHTML = html
    el.hidden = !html
    const help = el.querySelector('.help')
    if (help) window.Help?.attach(help, V().HELP)
    if (focusKey) el.querySelector(focusKey)?.focus({ preventScroll: true })
  }

  /** The move: see the head of this file. `before` is what each old item was: its place, its top, a copy of it. */
  function animate(el, html, plan) {
    const oldList = el.querySelector('.prl-list')
    const before = new Map([...oldList.querySelectorAll(':scope > .prl-item[data-prl-key]')].map((li, i) => [li.getAttribute('data-prl-key'), { i, top: li.offsetTop, copy: li.cloneNode(true) }]))
    const ms = plan.ms
    el._prlBusy = true
    const done = () => {
      el._prlBusy = false
      if (el._prlAgain) {
        el._prlAgain = false
        paint()
      }
    }
    if (!html) {
      // the last one leaves: it fades up and out, then the block goes
      for (const li of oldList.querySelectorAll('.prl-item')) li.classList.add('prl-ghost')
      window.requestAnimationFrame(() => oldList.querySelectorAll('.prl-item').forEach(li => li.classList.add('is-gone')))
      setTimeout(() => {
        draw(el, '')
        done()
      }, ms)
      return
    }
    const fromHeight = el.offsetHeight
    draw(el, html)
    const list = el.querySelector('.prl-list')
    // the block eases to its new height too, so the page under it glides instead of jumping
    const toHeight = el.offsetHeight
    if (fromHeight !== toHeight) {
      el.style.height = `${fromHeight}px`
      el.style.overflow = 'clip'
    }
    for (const key of plan.left) {
      const was = before.get(key)
      if (!was) continue
      const ghost = was.copy
      ghost.removeAttribute('data-prl-key')
      ghost.setAttribute('inert', '')
      ghost.classList.add('prl-ghost')
      ghost.style.top = `${was.top}px`
      list.appendChild(ghost)
    }
    const moving = []
    const lines = []
    for (const k of plan.kept) {
      const li = list.querySelector(`:scope > [data-prl-key="${CSS.escape(k.key)}"]`)
      const was = before.get(k.key)
      if (!li || !was) continue
      li.style.transition = 'none'
      li.style.transform = `translateY(${was.top - li.offsetTop}px) scale(${V().scaleFrom(k.from, k.to)})`
      li.style.opacity = String(V().fogStep(k.from).opacity)
      // the new first item's small line was not there before: it fades in late in the rise (plan.metaAt)
      const meta = k.from > 0 && k.to === 0 ? li.querySelector('.prl-meta') : null
      if (meta) {
        meta.style.transition = 'none'
        meta.style.opacity = '0'
        lines.push(meta)
      }
      moving.push(li)
    }
    for (const key of plan.entered) list.querySelector(`:scope > [data-prl-key="${CSS.escape(key)}"]`)?.classList.add('prl-entering')
    void list.offsetHeight // the start positions are laid out before the transitions begin
    window.requestAnimationFrame(() => {
      const rise = ms - plan.delay
      if (el.style.height) {
        el.style.transition = `height ${rise}ms var(--prl-ease) ${plan.delay}ms`
        el.style.height = `${toHeight}px`
      }
      for (const ghost of list.querySelectorAll('.prl-ghost')) {
        ghost.style.transition = `opacity ${plan.leaveMs}ms ease-out, transform ${plan.leaveMs}ms ease-out`
        ghost.classList.add('is-gone')
      }
      for (const li of moving) {
        li.style.transition = `transform ${rise}ms var(--prl-ease) ${plan.delay}ms, opacity ${rise}ms var(--prl-ease) ${plan.delay}ms`
        li.style.transform = ''
        li.style.opacity = ''
      }
      for (const meta of lines) {
        meta.style.transition = `opacity ${plan.metaMs}ms ease-out ${plan.metaAt}ms`
        meta.style.opacity = ''
      }
    })
    setTimeout(() => {
      list.querySelectorAll('.prl-ghost').forEach(g => g.remove())
      for (const li of moving) li.style.transition = ''
      for (const meta of lines) meta.style.transition = ''
      for (const p of ['height', 'overflow', 'transition']) el.style[p] = ''
      list.querySelectorAll('.prl-entering').forEach(li => li.classList.remove('prl-entering'))
      done()
    }, ms + 40)
  }

  /** Fill every slot under `root` whose HTML changed: moving what moved, unless motion is reduced. */
  function paint(root = doc) {
    if (!V()) return
    const now = Date.now()
    const slots = root.matches?.('[data-prl]') ? [root] : [...(root.querySelectorAll?.('[data-prl]') || [])]
    for (const el of slots) {
      const where = el.id === 'homePrs' ? 'home' : 'agents'
      const html = V().blockHtml(data, { open, now, where })
      if (el._prlHtml === html) continue
      if (el._prlBusy) {
        el._prlAgain = true
        continue
      }
      const nextKeys = V().plan(data?.items, { open }).shown.map(i => i.key || i.url)
      const shown = !el.hidden && el.offsetParent !== null
      const plan = V().motionPlan(shown ? keysOf(el) : [], nextKeys, { reduced: reduced() })
      if (plan.mode === 'animate' && el.querySelector('.prl-list')) animate(el, html, plan)
      else draw(el, html)
    }
  }

  async function refresh() {
    try {
      const r = await fetch('/api/prs')
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || r.status)
      data = j
    } catch {
      return // the last list stays; the next poll tries again
    }
    paint()
  }

  doc.addEventListener('click', e => {
    const more = e.target?.closest?.('[data-prl-more]')
    if (!more) return
    open = !open
    paint()
  })

  // `#/agents?prs`: the block scrolls into view once the page has drawn it
  window.Shell?.onRoute?.(r => {
    if (r.view !== 'agents' || !r.params?.query || !('prs' in r.params.query)) return
    window.Shell.whenReady('#agentsView [data-prl]:not([hidden])', el => el.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' }), 8000)
  })

  // every 30 s while the tab is on show, and at once when it comes back
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'visible') refresh()
  })
  doc.addEventListener('DOMContentLoaded', () => refresh())
  setInterval(() => {
    if (doc.visibilityState !== 'hidden') refresh()
  }, POLL_MS)

  const api = { refresh, paint }
  Object.defineProperty(api, 'data', { get: () => data })
  window.PrList = api
})()
