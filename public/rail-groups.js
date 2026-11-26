// The rail's page links, in groups (the user, 2026-11-26: "Clean my agent orchestration sidebar, group them").
// The rail had grown one link at a time, each feature appending its own to the END with insertAdjacentHTML, until
// it was a long flat list with no order a person could learn. Now ONE definition here decides which page sits in
// which group and in what order, and the shell draws the rail from it (shell.js). The Ctrl K palette lists the same
// groups (palette.js), so the two never disagree.
//
//   Work      Home, Flows, Tickets, Generators            what you hand out and follow
//   Agents    Agents, Subagents, Orchestration bank, Routing   who does the work and how it is shared out
//   Quality   QA, Lessons, Learn                          checking the work and learning from it
//   History   Timeline, Flow archive, Glossary            what happened, and the words for it
//   (bottom)  Settings, with Ask, Alerts, Spend, Phone on and Theme around it (drawn by the shell, not here)
//
// A later feature adds its link by NAME, never by position:
//   RailGroups.add('agents', { view, href, label, icon }, { after: 'subagents' })
// `view` is the shell's view name (what lights the link), `href` its address (#/...), `label` the plain name on the
// rail, `icon` the inside of a 24-unit SVG (paths only; shell.css draws it at 20 px, 1.75 stroke). ⚠️ Without
// `after` a link goes to the end of ITS group; a group that does not exist puts it in a final More group with one
// console warning, so a typo shows on the page instead of quietly reordering the rail. A view that already has a
// link, or an entry that is not whole, is refused with a warning: every page has exactly ONE rail link
// (test/rail-groups.test.mjs fails when a new page in shell.js VIEWS has none).
//
// Under 720 px the rail is a bar along the bottom, with room for few icons: it shows only the pages in BAR (the most
// used), Ask and a More button; More opens a sheet (rail-more.js) listing every other page in its group, more().
//
//   PURE: groups(), foot(), linkFor(view), add(group, entry, { after }), navHtml(groups, current, idPrefix),
//         linkHtml(entry), bar(), more()
// No DOM here: the shell writes navHtml into the rail, and the tests run this file in a vm with a bare window.
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const svg = d => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`
  const LABEL_MAX = 40 // the open rail is 200 px: a longer name would only be cut off
  const VIEW = /^[a-z][a-z0-9-]*$/

  // ─── the icons of the pages defined here (the shell keeps Ask, Theme, the pin and close) ───
  const ICON = {
    home: '<path d="M4 11 12 4l8 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>',
    flows: '<circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="7" r="2.2"/><path d="M6 7.2v9.6"/><path d="M18 9.2c0 5-6 4.6-10.6 8.3"/>',
    tickets: '<path d="M3 7h18v3a2 2 0 0 0 0 4v3H3v-3a2 2 0 0 0 0-4Z"/><path d="M14.5 8v1.5M14.5 11.25v1.5M14.5 14.5V16"/>',
    // Generators: a page with three lines of writing and a small spark (a prompt or a stand-up, written for you)
    script: '<path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V11"/><path d="M8.5 10h5M8.5 13.5h7M8.5 17h5"/><path d="M18.5 2.5v5M16 5h5"/>',
    agents: '<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18 14.8c1.8.6 3 2.5 3 5.2"/>',
    // a subagent: one small figure with a spark beside it (work handed to it)
    subagents: '<circle cx="10" cy="8" r="3.5"/><path d="M4 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><path d="M18.5 3v4M16.5 5h4"/><path d="M19.5 10.5v2M18.5 11.5h2"/>',
    // QA: a circle with a tick in it (a test passed)
    qa: '<circle cx="12" cy="12" r="8.5"/><path d="m8.4 12.3 2.5 2.5 4.8-5.2"/>',
    timeline: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
    // the flow archive: a box with its lid and a slot to pull it open by
    archive: '<path d="M3.5 4.5h17v4h-17Z"/><path d="M5 8.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8.5"/><path d="M10 12.5h4"/>',
    glossary: '<path d="M5 5a2 2 0 0 1 2-2h12v14H7a2 2 0 0 0-2 2Z"/><path d="M5 19a2 2 0 0 0 2 2h12v-4"/><path d="M9 7.5h6M9 11h4"/>',
    // a gear: a ring with eight short teeth around a small hub
    settings: '<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2.2"/><path d="M12 3.5v2.5M12 18v2.5M3.5 12H6M18 12h2.5M6 6l1.8 1.8M16.2 16.2 18 18M6 18l1.8-1.8M16.2 7.8 18 6"/>',
  }
  const page = (view, href, label) => ({ view, href, label, icon: ICON[view] })

  // ═══ THE definition: the order here is the order on the rail, in the palette and in the Tab order ═══
  // The Orchestration bank, Routing, Lessons and Learn are added by name from shell.js, beside the rest of their wiring.
  const GROUPS = [
    { id: 'work', label: 'Work', entries: [page('home', '#/home', 'Home'), page('flows', '#/flows', 'Flows'), page('tickets', '#/tickets', 'Tickets'), page('script', '#/generators', 'Generators')] },
    { id: 'agents', label: 'Agents', entries: [page('agents', '#/agents', 'Agents'), page('subagents', '#/subagents', 'Subagents')] },
    { id: 'quality', label: 'Quality', entries: [page('qa', '#/qa', 'QA')] },
    { id: 'history', label: 'History', entries: [page('timeline', '#/timeline', 'Timeline'), page('archive', '#/archive', 'Flow archive'), page('glossary', '#/glossary', 'Glossary')] },
  ]
  // A link for a group nobody defined lands here, last, so it still shows and the warning says why.
  const MORE = { id: 'more', label: 'More', entries: [] }
  // The bottom block's one page link; the shell draws it between Phone on and Theme.
  const FOOT = [page('settings', '#/settings', 'Settings')]

  const copy = g => ({ id: g.id, label: g.label, entries: g.entries.map(e => ({ ...e })) })
  /** Every group with links, in rail order: More only once something is in it. Copies, so a caller cannot reorder the rail. */
  const groups = () => [...GROUPS, ...(MORE.entries.length ? [MORE] : [])].map(copy)
  /** The bottom block's page links (Settings). */
  const foot = () => FOOT.map(e => ({ ...e }))
  const all = () => [...GROUPS, MORE].flatMap(g => g.entries).concat(FOOT)
  /** The one rail entry for a view, or null. */
  function linkFor(view) {
    if (typeof view !== 'string') return null
    const e = all().find(x => x.view === view)
    return e ? { ...e } : null
  }

  const warn = msg => {
    try {
      console.warn(`RailGroups: ${msg}`)
    } catch {}
  }
  /** Why an entry cannot go on the rail, or '' when it is whole. */
  function fault(e) {
    if (!e || typeof e !== 'object') return 'the link is not an object'
    if (typeof e.view !== 'string' || !VIEW.test(e.view)) return 'the view must be a lower-case name such as bank'
    if (typeof e.href !== 'string' || !e.href.startsWith('#/')) return `the link for ${e.view} must be an address in the page, starting #/`
    if (typeof e.label !== 'string' || !e.label.trim()) return `the link for ${e.view} has no label`
    if (e.label.length > LABEL_MAX) return `the label for ${e.view} is longer than ${LABEL_MAX} characters`
    if (typeof e.icon !== 'string') return `the icon for ${e.view} must be SVG markup`
    return ''
  }

  /**
   * Add a feature's link to the rail, by group and by name. `after` names the link it follows in that group; without
   * it, the link ends its group. Returns true when the link was added, false (with a console warning) when refused.
   */
  function add(group, entry, { after } = {}) {
    const why = fault(entry)
    if (why) return warn(`${why}; it was not added.`), false
    if (linkFor(entry.view)) return warn(`${entry.view} already has a rail link; the second one was not added.`), false
    const link = { view: entry.view, href: entry.href, label: entry.label, icon: entry.icon }
    let into = GROUPS.find(g => g.id === group)
    if (!into) {
      warn(`there is no rail group called ${group}; the link for ${entry.view} went to More.`)
      into = MORE
    }
    const at = after == null ? -1 : into.entries.findIndex(e => e.view === after)
    if (after != null && at < 0 && into !== MORE) warn(`${after} is not in the ${into.label} group; ${entry.view} went to its end.`)
    if (at < 0) into.entries.push(link)
    else into.entries.splice(at + 1, 0, link)
    return true
  }

  /** One rail link: the icon in its box, the label beside it (shown when the rail is open). */
  const linkHtml = (e, current) =>
    `<a class="rail-item" href="${esc(e.href)}" data-view="${esc(e.view)}" title="${esc(e.label)}"${e.view === current ? ' aria-current="page"' : ''}>` +
    `<span class="rail-icon">${svg(e.icon)}</span><span class="rail-label">${esc(e.label)}</span></a>`

  /**
   * The page links in their groups. Each group is a role=group labelled by its own heading: the heading shows when
   * the rail is open and is read out either way; a thin line marks the group when the rail is closed (shell.css).
   * The links are in group order, so Tab walks the groups in order. `current` marks that view's link.
   */
  const navHtml = (list, current, idPrefix = 'rg-') =>
    (Array.isArray(list) ? list : [])
      .map(g => `<div class="rail-group" role="group" aria-labelledby="${esc(idPrefix)}${esc(g.id)}">` +
        `<div class="rail-group-head"><h2 class="rail-group-label" id="${esc(idPrefix)}${esc(g.id)}">${esc(g.label)}</h2></div>` +
        `${g.entries.map(e => linkHtml(e, current)).join('')}</div>`)
      .join('')

  // ═══ the phone-width bar: the most used pages, in rail order (so the Tab order matches what is seen) ═══
  const BAR = ['home', 'flows', 'tickets', 'agents']
  const bar = () => [...BAR]
  /** Every page link that is NOT in the bar, in its group and rail order; a group left empty is dropped. */
  const more = () => groups().map(g => ({ ...g, entries: g.entries.filter(e => !BAR.includes(e.view)) })).filter(g => g.entries.length)

  window.RailGroups = { groups, foot, linkFor, add, navHtml, linkHtml, bar, more }
})()
