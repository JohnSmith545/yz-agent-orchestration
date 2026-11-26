// The chat composer's DOM helpers (public/phone-chat.js draws it, phone-app.js calls these): the box grows with
// what is typed up to a few lines, and the composer stays above the on-screen keyboard.
//
// ⚠️ THE KEYBOARD: on a phone the keyboard shrinks the VISUAL viewport, not the layout one, so a box fixed to the
// bottom of the page would sit under it. The gap the keyboard takes is innerHeight - visualViewport.height -
// visualViewport.offsetTop; it goes to the CSS variable --kb and the class kb-open on <html>, and phone.css lifts the
// composer by that much. A browser that resizes the page itself instead reports no gap, and nothing moves.
// The sizes are set through the CSSOM (style.setProperty), which the page's CSP allows: there is no inline style
// attribute anywhere (phone-server.mjs SECURITY_HEADERS).
//
//   PhoneComposer.grow(box)        the box as tall as its text, at most MAX_PX (then it scrolls)
//   PhoneComposer.measure(root)    --composer-h: the composer's height, so the thread can scroll clear of it
//   PhoneComposer.watchKeyboard()  follows the visual viewport (once, at start)
;(() => {
  const doc = window.document
  const MAX_PX = 132 // about five lines at 16 px
  const OPEN_PX = 60 // a gap smaller than this is a browser bar, not a keyboard

  function grow(box) {
    if (!box?.style) return
    box.style.height = 'auto'
    box.style.height = `${Math.min(box.scrollHeight, MAX_PX)}px`
  }

  function measure(root) {
    const form = root?.querySelector?.('.ph-composer')
    if (form) doc.documentElement.style.setProperty('--composer-h', `${Math.ceil(form.getBoundingClientRect().height)}px`)
  }

  function watchKeyboard() {
    const vv = window.visualViewport
    if (!vv) return
    const follow = () => {
      const gap = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
      doc.documentElement.style.setProperty('--kb', `${gap}px`)
      doc.documentElement.classList.toggle('kb-open', gap > OPEN_PX)
    }
    vv.addEventListener('resize', follow)
    vv.addEventListener('scroll', follow)
    follow()
  }

  window.PhoneComposer = { grow, measure, watchKeyboard }
})()
