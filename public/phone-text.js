// The coordinator's replies on the phone, with simple formatting rendered SAFELY from text (public/phone-chat.js
// draws them). PURE: a string in, an HTML string out, so the tests run it in a vm.
//
// ⚠️ A reply is HOSTILE text: it is the coordinator's words, and it may quote whatever an agent, a ticket or a web
// page put in front of it. So nothing in it is ever taken as markup. The text is cut into pieces by a few fixed
// patterns, and EVERY piece of the reply is escaped (esc) before it is placed between tags this file writes itself:
//   blank line           a new paragraph (<p>)
//   line break           <br>
//   - item / * item      a bullet list (<ul>); `1.` or `1)` a numbered one (<ol>)
//   **bold**             <b>
//   `code`               <code>; a ``` fenced block is <pre><code>, its lines as they are
//   # Heading            the line in bold
//   [text](address)      a link ONLY when the address is https://github.com/... with nothing but plain address
//   https://...          characters (GITHUB): then <a target="_blank" rel="noopener noreferrer">. Any other
//                        address is said as text, `text (address)`: never a javascript:, data: or other link.
// isGithub(address) is that same test, for the other links the phone draws (phone-agents.js: pull requests).
// Nothing else becomes markup: no HTML, no images, no tables. The phone page's CSP (phone-server.mjs) allows no
// inline script or style either, so even a mistake here could not run a script.
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  /** The only addresses that become a link: GitHub over https, plain address characters only (no quote, space, <, >, \). */
  const GITHUB = /^https:\/\/github\.com\/[A-Za-z0-9._~/#?=&%+:@!$,;*-]*$/
  const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)|(https?:\/\/[^\s<>()"'`]+)/g
  const ITEM = /^\s*(?:[-*•]|(\d{1,3})[.)])\s+(.*)$/
  const HEAD = /^\s*#{1,6}\s+(.*)$/

  function link(address, label) {
    if (GITHUB.test(address)) return `<a href="${esc(address)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`
    return label === address ? esc(address) : `${esc(label)} (${esc(address)})`
  }

  /** One line's inline marks: each match placed by this file, everything between them escaped. */
  function inline(raw) {
    const s = String(raw)
    let out = ''
    let last = 0
    for (const m of s.matchAll(INLINE)) {
      out += esc(s.slice(last, m.index))
      last = m.index + m[0].length
      if (m[1] !== undefined) out += `<code>${esc(m[1])}</code>`
      else if (m[2] !== undefined) out += `<b>${esc(m[2])}</b>`
      else if (m[3] !== undefined) out += link(m[4], m[3])
      else {
        // a bare address: a full stop or comma after it ends the sentence, not the address
        const address = m[5].replace(/[.,;:!?]+$/, '')
        out += link(address, address) + esc(m[5].slice(address.length))
      }
    }
    return out + esc(s.slice(last))
  }

  /** One block (no blank line in it): runs of list items become a list, the other lines paragraphs with <br>. */
  function block(lines) {
    let out = ''
    let para = []
    let list = null // { tag, items }
    const flushPara = () => {
      if (para.length) out += `<p>${para.join('<br>')}</p>`
      para = []
    }
    const flushList = () => {
      if (list) out += `<${list.tag}>${list.items.map(i => `<li>${i}</li>`).join('')}</${list.tag}>`
      list = null
    }
    for (const line of lines) {
      const item = ITEM.exec(line)
      if (item) {
        flushPara()
        const tag = item[1] ? 'ol' : 'ul'
        if (list && list.tag !== tag) flushList()
        ;(list ||= { tag, items: [] }).items.push(inline(item[2]))
        continue
      }
      flushList()
      const head = HEAD.exec(line)
      para.push(head ? `<b>${inline(head[1])}</b>` : inline(line))
    }
    flushPara()
    flushList()
    return out
  }

  function render(text) {
    const s = String(text ?? '').replace(/\r\n?/g, '\n')
    let out = ''
    // fenced code first: inside a fence nothing is formatting
    const parts = s.split(/```[^\n`]*\n?([\s\S]*?)```/)
    parts.forEach((part, i) => {
      if (i % 2) {
        out += `<pre><code>${esc(part.replace(/\n$/, ''))}</code></pre>`
        return
      }
      for (const chunk of part.split(/\n\s*\n/)) {
        const lines = chunk.split('\n').filter(l => l.trim() !== '')
        if (lines.length) out += block(lines)
      }
    })
    return out
  }

  const isGithub = address => typeof address === 'string' && GITHUB.test(address)

  window.PhoneText = { render, esc, isGithub }
})()
