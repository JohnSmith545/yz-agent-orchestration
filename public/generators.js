// The Generators page's tool switch (#/generators): two pills at the top, Prompt generator | Standup creator.
// The Prompt generator is the page that was Brainstorming (script-page.js, unchanged); the Standup creator is
// standup-page.js. script-page.js calls Generators.open on every open, and this file shows one tool.
//
//   Generators.toolOf(query)       'standup' for ?tool=standup, else 'prompt': the page ALWAYS opens on the Prompt
//                                  generator, except from that address (a link for the user, and for screenshots)
//   Generators.hashFor(tool)       the address of a tool
//   Generators.html(tool)          the switch's markup
//   Generators.pickIndex(key, i, n)  where an arrow, Home or End moves in a pill group, or -1
//   Generators.wirePills(group, onPick)  one keyboard and click wiring for any radio group of pills (this switch,
//                                  and the Standup creator's Daily | This week)
//   Generators.open(view, query, { prompt })  mounts the switch and the Standup creator's section once, then shows the
//                                  tool the address asks for; returns it. `prompt()` is the Prompt generator's own open.
//
// Rules this file keeps:
// - A radio group: one tab stop (the checked pill), arrows move AND pick, as a radio group does; Space and Enter on
//   a pill pick it too (it is a button).
// - Switching keeps the address true with history.replaceState (no hashchange, so nothing re-opens): a reload
//   shows the tool you were on, and the rail's plain #/generators always opens the Prompt generator.
// - Leaving a tool never stops its run: the tool is only hidden.
;(() => {
  const TOOLS = [['prompt', 'Prompt generator'], ['standup', 'Standup creator']]
  const toolOf = query => (query && query.tool === 'standup' ? 'standup' : 'prompt')
  const hashFor = tool => (tool === 'standup' ? '#/generators?tool=standup' : '#/generators')

  /** A pill group's buttons: the checked one is the group's one tab stop. */
  const pills = (items, picked, attr) => items.map(([key, label]) =>
    `<button type="button" role="radio" ${attr}="${key}" aria-checked="${key === picked}" tabindex="${key === picked ? 0 : -1}">${label}</button>`).join('')

  function html(tool) {
    return `<div class="gen-switch" role="radiogroup" aria-label="Tool">${pills(TOOLS, tool, 'data-tool')}</div>`
  }

  function pickIndex(key, i, n) {
    if (key === 'ArrowRight' || key === 'ArrowDown') return (i + 1) % n
    if (key === 'ArrowLeft' || key === 'ArrowUp') return (i - 1 + n) % n
    if (key === 'Home') return 0
    if (key === 'End') return n - 1
    return -1
  }

  /** Check `btn` in its group: aria-checked and the roving tab stop. */
  function check(group, btn) {
    for (const b of group.querySelectorAll('[role="radio"]')) {
      const on = b === btn
      b.setAttribute('aria-checked', String(on))
      b.tabIndex = on ? 0 : -1
    }
  }

  function wirePills(group, onPick) {
    const all = () => [...group.querySelectorAll('[role="radio"]')]
    group.addEventListener('click', e => {
      const b = e.target.closest?.('[role="radio"]')
      if (!b || !group.contains(b)) return
      check(group, b)
      onPick(b)
    })
    group.addEventListener('keydown', e => {
      const list = all()
      const at = pickIndex(e.key, list.indexOf(e.target), list.length)
      if (at < 0) return
      e.preventDefault()
      check(group, list[at])
      list[at].focus()
      onPick(list[at])
    })
    return { check: btn => check(group, btn) }
  }

  const api = { TOOLS, toolOf, hashFor, html, pickIndex, wirePills, open: () => 'prompt' }
  window.Generators = api
  if (!window.document) return

  let mounted = null // { view, group, standup }
  let hooks = { prompt: () => {} }

  function mount(view) {
    const page = view.querySelector('.sc-page')
    page.insertAdjacentHTML('beforebegin', html('prompt'))
    page.insertAdjacentHTML('afterend', '<div class="su-page" id="standupView" hidden></div>')
    const group = view.querySelector('.gen-switch')
    mounted = { view, page, group, standup: view.querySelector('#standupView') }
    wirePills(group, b => show(b.dataset.tool, true))
  }

  /** Show one tool; `user` when the user switched (the address then follows). */
  function show(tool, user) {
    const { page, group, standup } = mounted
    check(group, group.querySelector(`[data-tool="${tool}"]`))
    page.hidden = tool !== 'prompt'
    standup.hidden = tool !== 'standup'
    if (user && /^#\/generators\b/.test(window.location.hash) && window.location.hash !== hashFor(tool)) {
      try {
        window.history.replaceState(null, '', hashFor(tool))
      } catch {
        /* the address stays as it was; the page still switched */
      }
    }
    if (tool === 'standup') window.StandupPage?.open(standup, user ? {} : lastQuery)
    else hooks.prompt()
  }

  let lastQuery = {}
  api.open = (view, query = {}, h = {}) => {
    hooks = { ...hooks, ...h }
    if (!mounted) mount(view)
    lastQuery = query || {}
    const tool = toolOf(query)
    show(tool, false)
    return tool
  }
})()
