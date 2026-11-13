// CardStack: a vertical list of cards you can drag to reorder. The card you
// hold lifts, tilts with your movement and follows the pointer on a spring;
// the other cards spring out of the way to open a gap where it will land.
//
// A plain-JS port of the stack and drag half of a React "Shredder" component.
// The shredder itself (the slit, the paper strips, deleting by feeding a card
// in) is deliberately left out: cards here are only reordered, never removed
// by the user.
//
// ═══ USAGE ═══
//   const stack = CardStack.mount(el, {
//     key: item => item.id,            // stable id per item (required)
//     render: item => '<div>…</div>',  // HTML string for the card body (required)
//     label: item => item.name,        // name read out by screen readers
//     order: ['b', 'a'],               // a saved order to start from
//     onReorder: ids => save(ids),     // after a drop or key move that changed the order
//     onOpen: (item, target) => …,     // a click (not a drag), Enter or Space
//     gap: 10, dragTilt: 6, lift: 1.03,
//   })
//   stack.update(items)                // call again whenever the data changes
//   stack.destroy()
//
// Mouse or touch: press and move more than 4 px to drag; a press without a
// move is a click. Keyboard: Tab to a card, Alt+Up / Alt+Down moves it,
// Enter or Space opens it. Respects prefers-reduced-motion (no springs).
//
// ⚠️ update() while a card is held is deferred until it lands, so a data
// refresh never yanks a card out from under the pointer.
;(function () {
  const FOLLOW = 30 // spring rate while the card follows the pointer
  const SETTLE = 16 // spring rate when it flies into its new slot
  const STACK_K = 320 // stiffness of the other cards making room
  const STACK_C = 22 // and their damping
  const STAGGER = 0.035 // seconds between neighbours when a gap closes
  const ENTER = 22 // a new card drops in from this many px above
  const HYSTERESIS = 6 // px past the swap line before neighbours swap
  const START = 4 // px of movement before a press becomes a drag

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
  const ease = (from, to, dt, tau) => from + (to - from) * (1 - Math.exp(-dt / tau))
  const reduced = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  // Critically damped spring: position p with velocity v towards target.
  const spring = (p, v, target, dt, omega) => {
    const offset = p - target
    const term = v + omega * offset
    const decay = Math.exp(-omega * dt)
    return [target + (offset + term * dt) * decay, (v - omega * term * dt) * decay]
  }

  function mount(root, opts) {
    const o = { gap: 10, dragTilt: 6, lift: 1.03, label: () => '', ...opts }
    root.classList.add('cs')
    root.style.setProperty('--cs-gap', `${o.gap}px`)
    const list = document.createElement('ul')
    list.className = 'cs-list'
    const live = document.createElement('div')
    live.className = 'cs-sr'
    live.setAttribute('aria-live', 'polite')
    root.replaceChildren(list, live)

    let items = new Map() // id -> item
    let order = (o.order || []).slice() // ids, always in DOM order once mounted
    const slots = new Map() // id -> { slot, el, html }
    const s = {
      raf: 0,
      last: 0,
      drag: null, // the card being held or flying home
      press: null, // a press that is not a drag yet
      shifts: new Map(), // slot -> spring offset of a card making room
      tops: new Map(), // slot -> its natural top, without any shift
      pending: null, // an update() that arrived mid drag
      dead: false,
    }

    // ─── geometry: everything is relative to the list's top-left corner ──────

    const origin = () => list.getBoundingClientRect()
    const at = el => {
      const L = origin()
      const r = el.getBoundingClientRect()
      return { x: r.left - L.left, y: r.top - L.top }
    }
    const local = e => {
      const L = origin()
      return { x: e.clientX - L.left, y: e.clientY - L.top }
    }

    const run = () => {
      if (s.raf || s.dead) return
      s.last = performance.now()
      s.raf = requestAnimationFrame(tick)
    }

    const shiftOf = slot => {
      let sh = s.shifts.get(slot)
      if (!sh) {
        sh = { y: 0, v: 0, target: 0, delay: 0, fade: null }
        s.shifts.set(slot, sh)
      }
      return sh
    }

    const announce = text => {
      live.textContent = text
    }

    // ═══ FLIP: after any layout change, keep every card where it was on screen
    // and let its spring carry it to the new place. `from` staggers the cards
    // below a closing gap; `entering` cards drop in and fade up.
    const settle = (from, entering) => {
      const next = new Map()
      const still = reduced()
      const active = s.drag ? s.drag.slot : null
      let born = 0
      order.forEach((id, idx) => {
        const rec = slots.get(id)
        if (!rec) return
        const slot = rec.slot
        const sh = s.shifts.get(slot)
        const top = at(slot).y - (sh ? sh.y : 0)
        const prev = s.tops.get(slot)
        next.set(slot, top)
        if (slot === active || still) return
        if (entering && entering.has(slot)) {
          const r = shiftOf(slot)
          r.y = -ENTER
          r.v = 0
          r.target = 0
          r.delay = born * 0.05
          r.fade = rec.el
          born += 1
          rec.el.style.opacity = '0'
          slot.style.transform = `translateY(${r.y}px)`
          return
        }
        if (prev === undefined) return
        const delta = prev - top
        if (Math.abs(delta) < 0.5) return
        const r = shiftOf(slot)
        r.y += delta
        if (from >= 0) r.delay = Math.max(0, idx - from - 1) * STAGGER
        slot.style.transform = `translateY(${r.y}px)`
      })
      s.tops = next
      run()
    }

    // Put the slot elements in `order`, moving only the ones out of place.
    const placeDom = () => {
      order.forEach((id, i) => {
        const slot = slots.get(id)?.slot
        if (slot && list.children[i] !== slot) list.insertBefore(slot, list.children[i] || null)
      })
    }

    // ═══ WHERE WOULD IT LAND: the held card's centre against each other
    // card's swap line, halfway through the move that would swap them. Cards
    // at or below the landing index shift down by one card plus the gap.
    const aim = d => {
      const rows = []
      order.forEach(id => {
        if (id === d.key) return
        const slot = slots.get(id).slot
        const top = s.tops.get(slot)
        if (top !== undefined) rows.push({ slot, line: top + (d.H + slot.offsetHeight + o.gap) / 2 })
      })
      const cy = d.ry + d.H / 2
      let n = 0
      rows.forEach(r => {
        if (r.line < cy) n += 1
      })
      if (d.j >= 0 && n !== d.j) {
        const edge = rows[n > d.j ? n - 1 : n]
        if (edge && Math.abs(edge.line - cy) < HYSTERESIS) n = d.j
      }
      if (n === d.j) return
      d.j = n
      rows.forEach((r, k) => {
        shiftOf(r.slot).target = k >= n ? d.H + o.gap : 0
      })
    }

    const place = (d, sp) => {
      d.el.style.transform = `translate(${d.rx - sp.x}px, ${d.ry - sp.y}px) rotate(${d.tilt}deg) scale(${d.lift})`
    }

    // ─── pick up, drop, land ─────────────────────────────────────────────────

    const begin = (id, p, pid) => {
      const rec = slots.get(id)
      if (!rec || s.drag) return
      const { slot, el } = rec
      const sp = at(slot)
      const W = slot.offsetWidth
      const H = slot.offsetHeight
      const d = {
        key: id,
        el,
        slot,
        W,
        H,
        rx: sp.x,
        ry: sp.y,
        vx: 0,
        vy: 0,
        tx: sp.x,
        ty: sp.y,
        tilt: 0,
        lift: 1,
        gx: p.x - sp.x,
        gy: p.y - sp.y,
        px: p.x,
        py: p.y,
        j: -1,
        phase: 'drag',
        pid,
      }
      s.drag = d
      s.shifts.delete(slot)
      slot.style.transform = ''
      // Collapse its slot (the others close up) and open a gap at the same
      // index in the same frame, so nothing visibly moves on pick up.
      slot.dataset.active = ''
      el.dataset.state = 'drag'
      slot.style.height = '0px'
      slot.style.marginBottom = '0px'
      settle(-1, null)
      aim(d)
      place(d, at(slot))
      run()
    }

    const drop = d => {
      const before = order.join('\n')
      const others = order.filter(id => id !== d.key)
      const index = clamp(d.j, 0, others.length)
      others.splice(index, 0, d.key)
      order = others
      s.shifts.forEach(sh => {
        sh.target = 0
      })
      d.slot.style.height = `${d.H}px`
      d.slot.style.marginBottom = ''
      placeDom()
      settle(-1, null)
      d.phase = 'return'
      if (order.join('\n') !== before) {
        o.onReorder?.(order.slice())
        announce(`${o.label(items.get(d.key))} moved to position ${index + 1} of ${order.length}`)
      }
    }

    const land = d => {
      d.el.style.transform = ''
      delete d.el.dataset.state
      delete d.slot.dataset.active
      d.slot.style.height = ''
      s.drag = null
      if (s.pending) update(s.pending)
      else settle(-1, null)
    }

    // ═══ ONE FRAME ═══
    const tick = now => {
      s.raf = 0
      if (s.dead) return
      const frame = () => {
        s.raf = requestAnimationFrame(tick)
      }
      const dt = clamp((now - s.last) / 1000, 0, 0.05)
      s.last = now
      let moving = false
      const d = s.drag
      if (d) {
        if (!d.el.isConnected) {
          s.drag = null
        } else {
          const sp = at(d.slot)
          if (d.phase === 'drag') {
            d.tx = d.px - d.gx
            d.ty = clamp(d.py - d.gy, -d.H / 2, list.offsetHeight - d.H / 2)
            aim(d)
          } else {
            d.tx = sp.x
            d.ty = sp.y
          }
          if (reduced()) {
            d.rx = d.tx
            d.ry = d.ty
            d.vx = d.vy = 0
          } else {
            const omega = d.phase === 'drag' ? FOLLOW : SETTLE
            ;[d.rx, d.vx] = spring(d.rx, d.vx, d.tx, dt, omega)
            ;[d.ry, d.vy] = spring(d.ry, d.vy, d.ty, dt, omega)
          }
          const lean = d.phase === 'drag' && !reduced() ? clamp(d.vx * 0.012, -o.dragTilt, o.dragTilt) : 0
          d.tilt = ease(d.tilt, lean, dt, 0.09)
          d.lift = ease(d.lift, d.phase === 'return' ? 1 : o.lift, dt, 0.12)
          place(d, sp)
          const still =
            Math.abs(d.rx - d.tx) < 0.2 && Math.abs(d.ry - d.ty) < 0.2 && Math.abs(d.vx) < 2 && Math.abs(d.vy) < 2
          if (d.phase === 'return' && (reduced() || (still && Math.abs(d.lift - 1) < 0.002 && Math.abs(d.tilt) < 0.05))) {
            land(d)
          }
        }
      }
      s.shifts.forEach((sh, slot) => {
        if (!slot.isConnected) {
          s.shifts.delete(slot)
          return
        }
        if (sh.delay > 0) {
          sh.delay -= dt
          moving = true
          return
        }
        if (sh.fade) {
          const el = sh.fade
          el.style.transition = 'opacity 280ms ease'
          el.style.opacity = ''
          setTimeout(() => {
            el.style.transition = ''
          }, 320)
          sh.fade = null
        }
        if (reduced()) {
          sh.y = sh.target
          sh.v = 0
        } else {
          // Sub-stepped damped spring, so a long frame cannot overshoot.
          const n = Math.ceil(dt * 240)
          const h = dt / n
          for (let k = 0; k < n; k += 1) {
            sh.v += (-STACK_K * (sh.y - sh.target) - STACK_C * sh.v) * h
            sh.y += sh.v * h
          }
        }
        if (Math.abs(sh.y - sh.target) < 0.15 && Math.abs(sh.v) < 4) {
          sh.y = sh.target
          sh.v = 0
          if (sh.target === 0) {
            slot.style.transform = ''
            s.shifts.delete(slot)
            return
          }
        } else {
          moving = true
        }
        slot.style.transform = `translateY(${sh.y}px)`
      })
      if (s.drag || moving) frame()
    }

    // ─── input ───────────────────────────────────────────────────────────────

    const onDown = (e, id) => {
      if (e.button !== 0 || s.drag || s.press) return
      // A button or link inside a card is its own control: no drag, no open,
      // and no pointer capture (which would steal its click).
      if (e.target.closest?.('button, a, input, select, textarea')) return
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {}
      s.press = { id, pid: e.pointerId, p: local(e), target: e.target }
    }

    const onMove = e => {
      const pr = s.press
      if (pr && pr.pid === e.pointerId && !s.drag) {
        const p = local(e)
        if (Math.hypot(p.x - pr.p.x, p.y - pr.p.y) > START) {
          s.press = null
          begin(pr.id, pr.p, e.pointerId)
        }
      }
      const d = s.drag
      if (d && d.phase === 'drag' && d.pid === e.pointerId) {
        const p = local(e)
        d.px = p.x
        d.py = p.y
      }
    }

    const onUp = e => {
      const pr = s.press
      if (pr && pr.pid === e.pointerId) {
        s.press = null
        if (e.type === 'pointerup') o.onOpen?.(items.get(pr.id), pr.target)
        if (s.pending && !s.drag) update(s.pending)
        return
      }
      const d = s.drag
      if (!d || d.phase !== 'drag' || d.pid !== e.pointerId) return
      try {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {}
      drop(d)
      run()
    }

    const onKey = (e, id) => {
      if (e.target !== e.currentTarget) return
      if ((e.key === 'Enter' || e.key === ' ') && !e.altKey) {
        e.preventDefault()
        o.onOpen?.(items.get(id), e.target)
        return
      }
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
      e.preventDefault()
      if (s.drag) return
      const i = order.indexOf(id)
      const to = clamp(i + (e.key === 'ArrowUp' ? -1 : 1), 0, order.length - 1)
      if (to === i) return
      order.splice(i, 1)
      order.splice(to, 0, id)
      placeDom()
      settle(-1, null)
      slots.get(id).el.focus({ preventScroll: true })
      o.onReorder?.(order.slice())
      announce(`${o.label(items.get(id))} moved to position ${to + 1} of ${order.length}`)
    }

    const make = id => {
      const slot = document.createElement('li')
      slot.className = 'cs-slot'
      const el = document.createElement('div')
      el.className = 'cs-item'
      el.tabIndex = 0
      el.setAttribute('role', 'button')
      el.setAttribute('aria-roledescription', 'draggable card')
      el.addEventListener('pointerdown', e => onDown(e, id))
      el.addEventListener('pointermove', onMove)
      el.addEventListener('pointerup', onUp)
      el.addEventListener('pointercancel', onUp)
      el.addEventListener('lostpointercapture', onUp)
      el.addEventListener('keydown', e => onKey(e, id))
      el.addEventListener('dragstart', e => e.preventDefault())
      slot.appendChild(el)
      return { slot, el, html: null }
    }

    // ═══ DATA IN ═══ Known ids keep their place, new ids join the end, gone
    // ids leave (the rest close up). Card bodies are only re-rendered when
    // their HTML changed.
    function update(next) {
      if (s.dead) return
      if (s.drag) {
        s.pending = next
        return
      }
      s.pending = null
      const ids = next.map(o.key)
      items = new Map(next.map((it, i) => [ids[i], it]))
      const known = order.filter(id => items.has(id))
      ids.forEach(id => {
        if (!known.includes(id)) known.push(id)
      })
      slots.forEach((rec, id) => {
        if (items.has(id)) return
        rec.slot.remove()
        slots.delete(id)
        s.shifts.delete(rec.slot)
        s.tops.delete(rec.slot)
      })
      const entering = new Set()
      known.forEach(id => {
        let rec = slots.get(id)
        if (!rec) {
          rec = make(id)
          slots.set(id, rec)
          if (s.tops.size) entering.add(rec.slot)
        }
        const html = o.render(items.get(id))
        if (html !== rec.html) {
          rec.el.innerHTML = html
          rec.html = html
        }
        rec.el.setAttribute('aria-label', `${o.label(items.get(id))}. Alt plus arrow keys to move.`)
      })
      order = known
      placeDom()
      settle(-1, entering)
    }

    // A width change re-wraps text, so re-measure without animating.
    let width = 0
    const ro =
      'ResizeObserver' in window
        ? new ResizeObserver(() => {
            if (s.drag || list.offsetWidth === width) return
            width = list.offsetWidth
            s.tops = new Map()
            settle(-1, null)
          })
        : null
    ro?.observe(list)

    return {
      update,
      order: () => order.slice(),
      destroy() {
        s.dead = true
        cancelAnimationFrame(s.raf)
        ro?.disconnect()
        root.replaceChildren()
        root.classList.remove('cs')
      },
    }
  }

  window.CardStack = { mount }
})()
