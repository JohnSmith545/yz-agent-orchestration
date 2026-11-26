// The areas a lesson belongs to, and which areas a task touches. A lesson is tagged with ONE area when it is made
// (quality-lessons.mjs); a task gets every area its words, its tickets' labels or its files point at (taskAreas), and
// the lessons of those areas are the ones printed in its brief (lessonsFor).
//
// The areas come from the shape of the repos the dashboard watches: tests, the pages (ui), the server routes, the
// stored data, the docs, the way of working (process) and the machine and its settings (infra), plus `general` for a
// lesson that fits any task. config.json `quality.areas` may add more (quality-config.mjs); an added area is matched
// by its own name as a word.
//
// ⚠️ `general` is never MATCHED: it is the fallback after the matched areas, so a task always gets the lessons that
// fit any task once the matched ones are in. PURE: no file, no config.

export const DEFAULT_AREAS = Object.freeze(['tests', 'ui', 'routes', 'data', 'docs', 'process', 'infra', 'general'])

/** What each built-in area is recognised by: whole words of the task, and pieces of the paths it touches. */
export const AREA_HINTS = Object.freeze({
  tests: { words: ['test', 'tests', 'testing', 'failing test', 'regression', 'assert', 'coverage', 'tdd'], paths: ['test/', '.test.', '.spec.', '__tests__', '_test.'] },
  ui: { words: ['page', 'pages', 'screen', 'screens', 'button', 'buttons', 'css', 'layout', 'dark mode', 'dark theme', 'light theme', 'theme', 'card', 'cards', 'chip', 'tooltip', 'screenshot', 'screenshots', 'phone width', 'mobile', 'ui', 'drawer', 'menu', 'modal', 'widget'], paths: ['public/', '.css', '.html', '/widgets/', '/pages/', '.tsx', '.jsx'] },
  routes: { words: ['route', 'routes', 'endpoint', 'endpoints', 'api', 'origin', 'request body', 'post', 'server'], paths: ['-routes.', 'routes/', 'server.mjs', '/api/'] },
  data: { words: ['data', 'store', 'json file', 'flow file', 'database', 'schema', 'migration', 'record', 'records', 'storage'], paths: ['data/', 'db/', '.sql', 'store.', '-store.'] },
  docs: { words: ['readme', 'guide', 'docs', 'documentation', 'help text', 'brief', 'changelog', 'user guide'], paths: ['docs/', 'readme', '.md'] },
  process: { words: ['commit', 'commits', 'branch', 'branches', 'merge', 'worktree', 'pull request', 'hand over', 'handover', 'rebase', 'process'], paths: [] },
  infra: { words: ['config', 'configuration', 'ci', 'deploy', 'port', 'terraform', 'infrastructure', 'background process', 'preview server', 'cloud'], paths: ['config', '.github/', 'infra/', 'tools/', 'package.json', 'dockerfile'] },
})

const isText = v => typeof v === 'string' && v.trim() !== ''
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const wordRe = w => new RegExp(`(?:^|[^a-z0-9])${escape(w.toLowerCase()).replace(/\s+/g, '[\\s_-]+')}(?=$|[^a-z0-9])`, 'i')
const hintsOf = area => AREA_HINTS[area] || { words: [area], paths: [] }

/**
 * The areas a task touches, as a Map area -> why (one short phrase), in `areas` order: `the task names "page"`,
 * `it touches test/a.test.mjs`, `a ticket label says Docs`. `task` is { title, text, labels, files } (text: the why,
 * the steps, the plan). `general` is never in it.
 */
export function taskAreas({ title = '', text = '', labels = [], files = [] } = {}, areas = DEFAULT_AREAS) {
  const words = [title, text].filter(isText).join('\n')
  const fileList = (Array.isArray(files) ? files : []).filter(isText).map(f => f.replace(/\\/g, '/'))
  const labelList = (Array.isArray(labels) ? labels : []).filter(isText)
  const out = new Map()
  for (const area of areas) {
    if (area === 'general') continue
    const h = hintsOf(area)
    const word = h.words.find(w => wordRe(w).test(words))
    if (word) { out.set(area, `the task names "${word}"`); continue }
    const file = fileList.find(f => h.paths.some(p => f.toLowerCase().includes(p)))
    if (file) { out.set(area, `it touches ${file}`); continue }
    const label = labelList.find(l => h.words.some(w => wordRe(w).test(l)) || l.toLowerCase().includes(area))
    if (label) out.set(area, `a ticket label says ${label}`)
  }
  return out
}
