// Light, dark, or match the system. Loaded in <head> without defer, so the
// theme is on <html data-theme> before the first paint and the page never
// flashes the wrong colours. Then it wires the ONE rail button (#themeToggle,
// drawn by shell.js): it shows a sun in dark mode and a moon in light mode
// (shell.css picks the icon from data-theme), a small dot under it while the
// page follows the system, and each click moves one step along
// light → dark → system. The choice is remembered under the `theme` key
// (`light`, `dark`, absent = system); "system" follows the OS live.
;(() => {
  const KEY = 'theme'
  const ORDER = ['light', 'dark', 'system']
  const NAME = { light: 'Light', dark: 'Dark', system: 'System' }
  const root = document.documentElement
  const media = window.matchMedia('(prefers-color-scheme: dark)')

  /** Pure: the choice one click moves to. Anything unknown starts the cycle at light. */
  const next = c => ORDER[(ORDER.indexOf(c) + 1) % ORDER.length]

  const read = () => {
    try {
      const v = localStorage.getItem(KEY)
      return v === 'light' || v === 'dark' ? v : 'system'
    } catch {
      return 'system'
    }
  }
  let choice = read()

  const apply = () => {
    root.dataset.theme = choice === 'dark' || (choice === 'system' && media.matches) ? 'dark' : 'light'
    const btn = document.getElementById('themeToggle')
    if (!btn) return
    btn.dataset.choice = choice
    const label = `Theme: ${NAME[choice]}${choice === 'system' ? ` (${root.dataset.theme})` : ''}. Click for ${NAME[next(choice)]}.`
    btn.title = label
    btn.setAttribute('aria-label', label)
  }

  const set = c => {
    if (!ORDER.includes(c) || c === choice) return
    choice = c
    try {
      if (c === 'system') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, c)
    } catch {}
    // Colours cross-fade for a moment instead of snapping (off under reduced motion, see styles.css).
    root.classList.add('theme-fade')
    apply()
    setTimeout(() => root.classList.remove('theme-fade'), 320)
  }

  apply()
  media.addEventListener?.('change', () => choice === 'system' && apply())
  document.addEventListener('DOMContentLoaded', () => {
    document.addEventListener('click', e => {
      if (e.target.closest?.('#themeToggle')) set(next(choice))
    })
    apply()
  })

  window.Theme = { set, get: () => choice, next }
})()
