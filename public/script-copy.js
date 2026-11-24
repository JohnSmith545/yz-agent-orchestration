// The SCRIPT page's Copy: put a text on the clipboard (script-page.js copies the prompt
// inside the code block, ScriptText.codeBlock, and nothing else).
//
//   ScriptCopy.copy(text) → Promise<boolean>   true when the text was copied. The async
//       clipboard first; without it (or without permission), a hidden textarea and
//       execCommand. Never throws.
;(() => {
  function fallback(text) {
    const doc = window.document
    const ta = doc.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0'
    doc.body.appendChild(ta)
    ta.select()
    let ok = false
    try {
      ok = doc.execCommand('copy')
    } catch {
      ok = false
    }
    ta.remove()
    return ok
  }

  async function copy(text) {
    try {
      await window.navigator.clipboard.writeText(text)
      return true
    } catch {
      return fallback(text)
    }
  }

  window.ScriptCopy = { copy }
})()
