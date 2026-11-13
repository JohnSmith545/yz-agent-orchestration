// One lightbox for the page: a screenshot at full size. The Output and Status
// views of an opened flow (flow-output.js, flow-status.js) both use it.
//
//   bind(root)               once per root: a plain click on a linked screenshot
//                            (FlowDrawer.evidenceBody's <a><img class="fl-shot">)
//                            opens it here, a modified click still opens a new tab,
//                            and a screenshot whose file is gone becomes one line
//   open(src, alt, backEl)   show `src`; focus goes back to `backEl` on close
//
// Escape, a click outside the image, or Close shuts it. While it is open, Tab
// moves between its two controls only.
;(() => {
  let box = null
  let back = null // what had focus, to return it on close

  function lightbox() {
    if (box) return box
    box = document.createElement('div')
    box.className = 'lb-box'
    box.hidden = true
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-modal', 'true')
    box.setAttribute('aria-label', 'Screenshot')
    box.innerHTML = '<div class="lb-bar"><a class="link" target="_blank" rel="noopener">Open in a new tab</a>' +
      '<button type="button" class="lb-close">Close</button></div><img alt="">'
    document.body.appendChild(box)
    box.addEventListener('click', e => { if (e.target === box || e.target.closest('.lb-close')) close() })
    // Capture, before the shell closes the chat drawer: one Escape closes one thing.
    document.addEventListener('keydown', e => {
      if (box.hidden) return
      if (e.key === 'Tab') {
        const stops = [box.querySelector('a'), box.querySelector('.lb-close')]
        const at = stops.indexOf(document.activeElement)
        e.preventDefault()
        stops[(at + (e.shiftKey ? stops.length - 1 : 1)) % stops.length].focus()
        return
      }
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      close()
    }, true)
    return box
  }

  /** Show `src` (already an /evidence/ URL, FlowDrawer.evidenceUrl) at full size. */
  function open(src, alt = '', backEl = null) {
    // A ? or explain popover left open would take the next Escape too: close them, so one Escape closes one thing.
    window.Help?.close?.()
    window.Explain?.close?.()
    const b = lightbox()
    const img = b.querySelector('img')
    img.src = src
    img.alt = alt
    b.querySelector('a').setAttribute('href', src)
    back = backEl
    b.hidden = false
    b.querySelector('.lb-close').focus()
  }

  function close() {
    box.hidden = true
    box.querySelector('img').removeAttribute('src')
    if (back?.isConnected) back.focus()
    back = null
  }

  const bound = new WeakSet()
  function bind(root) {
    if (!root || bound.has(root)) return
    bound.add(root)
    // error does not bubble, so capture: a screenshot whose file is gone reads as one line, not a
    // broken glyph, and its link goes with it, so the lightbox can never open on nothing.
    root.addEventListener('error', e => {
      const img = e.target
      if (!img?.matches?.('img.fl-shot')) return
      const gone = root.ownerDocument.createElement('p')
      gone.className = 'small faint lb-gone'
      gone.textContent = 'The screenshot file is missing.'
      ;(img.closest('a') || img).replaceWith(gone)
    }, true)
    root.addEventListener('click', e => {
      const a = e.target.closest('a')
      if (!a || !a.querySelector('img.fl-shot') || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
      e.preventDefault()
      open(a.getAttribute('href'), a.querySelector('img')?.alt || '', a)
    })
  }

  window.Lightbox = { open, bind }
})()
