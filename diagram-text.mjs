// The small arrow language an agent draws a diagram with, in one line:
//
//   node tools/factory.mjs flow diagram <flow> "[actor] User -> Settings page: clicks the moon; Settings page -> [store] Browser storage"
//
// Statements are split on `;` or a new line. Each is `A -> B`, a chain
// `A -> B -> C`, or a lone `A` that only declares a box. A part after an arrow
// may end in `: label`, the label of the arrow that ENTERS it; a colon in the
// first part stays in that box's label (`Step 1: build -> Deploy`). A part may
// start with a kind in square brackets: box (the default), actor (a person or
// an outside system), store (data at rest) or decision.
//
// The same label is the same box, ignoring case and runs of spaces: the first
// spelling is kept, and the first kind given wins. Ids are slugs of the label
// (`settings-page`), made unique with -2, -3; a label with no letters or
// digits gets n<its index>.
//
// parseDiagram is PURE and never throws: { diagram: { nodes, edges }, errors: [] },
// or { diagram: null, errors: ['statement 3: nothing after ->', ...] }. flows.mjs
// validateOutput holds a stored diagram to the same limits (DIAGRAM_MAX).

export const DIAGRAM_KINDS = ['box', 'actor', 'store', 'decision']
// HIGH LEVEL on purpose (the owner: easy to understand at a glance): the big picture in a few
// boxes with short names, never file names or commit subjects. A longer diagram is refused, saying why.
export const DIAGRAM_MAX = { nodes: 8, edges: 10, label: 32, edgeLabel: 24 }

const SLUG_MAX = 40
const NOTHING = 'nothing to draw: write A -> B; B -> C'

/** `Build & test!` → `build-test`; '' when the label has no ascii letter or digit. */
export function slug(label) {
  return String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, SLUG_MAX).replace(/-+$/, '')
}

/** One part of a statement: `[kind] label` (the edge label already split off). */
function readPart(raw) {
  const m = /^\[\s*([^\]]*?)\s*\]\s*(.*)$/s.exec(raw)
  if (!m) return { label: raw.trim(), kind: null }
  return { label: m[2].trim(), kind: m[1].toLowerCase(), bracket: m[1] }
}

export function parseDiagram(text) {
  const statements = (typeof text === 'string' ? text : '').split(/[;\n]/).map(s => s.trim()).filter(Boolean)
  if (!statements.length) return { diagram: null, errors: [NOTHING] }
  const errors = []
  const nodes = [] // { id, label, kind, explicit }
  const byKey = new Map() // normalised label -> node
  const edges = []
  const edgeAt = new Map() // `from>to` -> edge

  /** The box for `part`, made on first sight; an error string when the part cannot be one. */
  const box = ({ label, kind }) => {
    const key = label.replace(/\s+/g, ' ').toLowerCase()
    let n = byKey.get(key)
    if (!n) {
      n = { id: '', label: label.replace(/\s+/g, ' '), kind: kind || 'box', explicit: !!kind }
      byKey.set(key, n)
      nodes.push(n)
    } else if (kind && n.explicit && n.kind !== kind) return `${n.label} already has the kind ${n.kind}`
    else if (kind && !n.explicit) Object.assign(n, { kind, explicit: true })
    return n
  }

  statements.forEach((stmt, i) => {
    const at = `statement ${i + 1}:`
    const parts = stmt.split('->').map(s => s.trim())
    if (parts.length > 1 && !parts[0]) return errors.push(`${at} nothing before ->`)
    const chain = [] // [{ node, label }] where label is the arrow entering it
    for (let p = 0; p < parts.length; p++) {
      let raw = parts[p]
      let edgeLabel = ''
      if (p > 0) {
        const colon = raw.indexOf(':')
        if (colon >= 0) { edgeLabel = raw.slice(colon + 1).trim(); raw = raw.slice(0, colon).trim() }
      }
      if (!raw) return errors.push(p === parts.length - 1 ? `${at} nothing after ->` : `${at} nothing between two ->`)
      const part = readPart(raw)
      if (part.kind !== null && !DIAGRAM_KINDS.includes(part.kind)) return errors.push(`${at} unknown kind [${part.bracket}]: use ${DIAGRAM_KINDS.slice(0, -1).join(', ')} or ${DIAGRAM_KINDS.at(-1)}`)
      if (!part.label) return errors.push(`${at} [${part.bracket}] with no label after it`)
      if (part.label.length > DIAGRAM_MAX.label) return errors.push(`${at} keep it high level: a box label is at most ${DIAGRAM_MAX.label} characters (this has ${part.label.length})`)
      if (edgeLabel.length > DIAGRAM_MAX.edgeLabel) return errors.push(`${at} keep it high level: an arrow label is at most ${DIAGRAM_MAX.edgeLabel} characters (this has ${edgeLabel.length})`)
      const n = box(part)
      if (typeof n === 'string') return errors.push(`${at} ${n}`)
      if (p > 0 && chain.at(-1).node === n) return errors.push(`${at} an arrow from ${n.label} to itself`)
      chain.push({ node: n, label: edgeLabel })
    }
    for (let p = 1; p < chain.length; p++) {
      const from = chain[p - 1].node
      const to = chain[p].node
      const key = `${nodes.indexOf(from)}>${nodes.indexOf(to)}`
      const seen = edgeAt.get(key)
      if (seen) { seen.label ||= chain[p].label; continue }
      const e = { from, to, label: chain[p].label }
      edgeAt.set(key, e)
      edges.push(e)
    }
  })

  if (nodes.length > DIAGRAM_MAX.nodes) errors.push(`keep it high level: at most ${DIAGRAM_MAX.nodes} boxes (this has ${nodes.length})`)
  if (edges.length > DIAGRAM_MAX.edges) errors.push(`keep it high level: at most ${DIAGRAM_MAX.edges} arrows (this has ${edges.length})`)
  if (errors.length) return { diagram: null, errors }

  // ids: a slug of the label, unique; n<index> when the label slugs to nothing
  const taken = new Set()
  nodes.forEach((n, i) => {
    const base = slug(n.label) || `n${i + 1}`
    let id = base
    for (let k = 2; taken.has(id); k++) id = `${base}-${k}`
    taken.add(id)
    n.id = id
  })
  return {
    diagram: {
      nodes: nodes.map(({ id, label, kind }) => ({ id, label, kind })),
      edges: edges.map(e => ({ from: e.from.id, to: e.to.id, label: e.label })),
    },
    errors: [],
  }
}
