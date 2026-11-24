// The projects the dashboard can watch, and which one it watches now.
//
//   projects.json   { active, projects: [{ id, name, primary?, config: { ...per-project keys } }] }
//                   beside config.json and gitignored like it; with FACTORY_DATA_DIR set (tests, previews) it
//                   lives in THAT folder instead, so a test or a preview never reads or writes the live one.
//
// ═══ WHY THIS FILE IS SO SMALL AND IMPORTS NOTHING OF OURS ═══ config.mjs, flows.mjs, factory-state.mjs and
// since-store.mjs fix their settings and their data folder when they are first imported, and nearly every
// module imports one of them. They all ask THIS file which project is current, once, at load. A switch
// therefore writes `active` and restarts the server (restart.mjs): every module loads fresh, and nothing can
// keep a path or a setting of the project before.
//
// Rules this file keeps:
// - No projects.json at all: no store, the data folder is the root (data/ or FACTORY_DATA_DIR) and config.json
//   is the whole config. Exactly what the dashboard did before projects existed.
// - ⚠️ The PRIMARY project is the one config.json describes, and its data folder is the root ITSELF: the live
//   data never moves and is never copied. Every other project has data/projects/<id>/. The primary is marked
//   `primary: true`, never guessed from the order: a store with no primary or two is BROKEN, and a broken
//   store reads as no store (one warning), so one project's data can never be shown as another's.
// - A non-primary project takes nothing per-project from config.json (PROJECT_KEYS and the factory and chat
//   keys below): its repo, sessions, tickets, agents, pins and pipeline are its own or the defaults. The
//   machine settings (port, claudeDirs, claudeBin, stopHour, reminders, the Send settings `pr`, the models)
//   stay shared. The primary project is config.json with its own `config` on top.
// - The SERVER uses `active`. A command (tools/factory.mjs and the rest) run from inside a project's repo or
//   one of its worktrees uses THAT project, whichever one the page shows: agents narrate from their own
//   worktree, and a Flinki flow must never land in another project's folder. YZ_PROJECT=<id> names one outright.
// - Ids are short slugs (PROJECT_ID), checked before any path is built from them.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeAtomic } from './atomic-write.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT_ENV = process.env.FACTORY_DATA_DIR
/** The data root: data/ next to this file, or FACTORY_DATA_DIR. The primary project's data folder, and the bank's home. */
export const DATA_ROOT = ROOT_ENV || path.join(HERE, 'data')
/** projects.json: beside config.json, or in FACTORY_DATA_DIR when that is set. */
export const PROJECTS_FILE = ROOT_ENV ? path.join(ROOT_ENV, 'projects.json') : path.join(HERE, 'projects.json')
/** config.json, read here only to match a command's folder to the primary project (config.mjs owns it). */
export const CONFIG_JSON = path.join(HERE, 'config.json')

/** A project id: a lower-case slug of 1 to 40, starting with a letter or digit. Never a path. */
export const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
export const PROJECT_LIMITS = Object.freeze({ name: 40, projects: 20 })
/** The keys that belong to ONE project: a non-primary project never takes them from config.json. */
export const PROJECT_KEYS = Object.freeze(['repo', 'sessionCwdMatch', 'ticketPrefixes', 'coordinator', 'coordinatorLabel', 'codingAgents', 'aliases', 'pinnedAgents', 'pipeline', 'levels'])
const FACTORY_KEYS = ['collections', 'me']
const CHAT_KEYS = ['name', 'forkFrom']

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)

/** A store read from anywhere, cleaned: `{ active, projects }`, or null when it is not usable (see the rules above). */
export function cleanProjects(raw) {
  if (!isObj(raw) || !Array.isArray(raw.projects)) return null
  const seen = new Set()
  const projects = []
  for (const p of raw.projects) {
    if (!isObj(p) || typeof p.id !== 'string' || !PROJECT_ID.test(p.id) || seen.has(p.id)) continue
    if (projects.length >= PROJECT_LIMITS.projects) break
    seen.add(p.id)
    const name = (typeof p.name === 'string' ? p.name.trim() : '').slice(0, PROJECT_LIMITS.name) || p.id
    const entry = { id: p.id, name, ...(p.primary === true ? { primary: true } : {}), config: isObj(p.config) ? p.config : {} }
    projects.push(entry)
  }
  if (projects.filter(p => p.primary).length !== 1) return null
  const active = projects.some(p => p.id === raw.active) ? raw.active : projects.find(p => p.primary).id
  return { active, projects }
}

/** projects.json cleaned, or null when it is missing; a broken one is null with ONE warning (`warn`). */
export function readProjects(file = PROJECTS_FILE, warn = console.warn) {
  if (!existsSync(file)) return null
  let store = null
  try {
    store = cleanProjects(JSON.parse(readFileSync(file, 'utf8')))
  } catch {}
  if (!store) warn(`projects.json (${file}) could not be read; the dashboard shows the project in config.json only.`)
  return store
}

export function writeProjects(store, file = PROJECTS_FILE) {
  writeAtomic(file, `${JSON.stringify(store, null, 2)}\n`)
}

/** Where a project keeps its flows, evidence, rules and the rest: the root for the primary, else projects/<id>. */
export function projectDataDir(project, root = DATA_ROOT) {
  return project?.primary ? root : path.join(root, 'projects', project.id)
}

function withoutProjectKeys(base) {
  const out = { ...base }
  for (const k of PROJECT_KEYS) delete out[k]
  if (isObj(base.factory)) {
    out.factory = { ...base.factory }
    for (const k of FACTORY_KEYS) delete out.factory[k]
    if (isObj(base.factory.chat)) {
      out.factory.chat = { ...base.factory.chat }
      for (const k of CHAT_KEYS) delete out.factory.chat[k]
    }
  }
  return out
}

/** `b` over `a`, with `factory` and `factory.chat` merged one level down (a project may set only the chat name). */
function mergeConfig(a, b) {
  const out = { ...a, ...b }
  if (isObj(a.factory) || isObj(b.factory)) {
    out.factory = { ...(isObj(a.factory) ? a.factory : {}), ...(isObj(b.factory) ? b.factory : {}) }
    const [ca, cb] = [a.factory?.chat, b.factory?.chat]
    if (isObj(ca) || isObj(cb)) out.factory.chat = { ...(isObj(ca) ? ca : {}), ...(isObj(cb) ? cb : {}) }
  }
  return out
}

/** The raw config of `project`: config.json (`base`) for the primary, without its per-project keys for any other, then the project's own keys. */
export function projectRaw(base, store, project) {
  if (!store || !project) return base
  return mergeConfig(project.primary ? { ...base } : withoutProjectKeys(base), project.config || {})
}

const norm = s => String(s ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** The project whose repo holds `cwd` (best), else whose session match `cwd` contains (longest), else null. */
export function projectForCwd(store, cwd, base) {
  const here = norm(cwd)
  let best = null
  let score = -1
  for (const p of store.projects) {
    const raw = projectRaw(base || {}, store, p)
    const repo = norm(raw.repo)
    const match = norm(raw.sessionCwdMatch || (repo ? repo.split('/').pop() : ''))
    const s = repo && (here === repo || here.startsWith(`${repo}/`)) ? 1000 + repo.length : match && here.includes(match) ? match.length : -1
    if (s > score) [best, score] = [p, s]
  }
  return best
}

/**
 * The project this process works for (see the rules above): YZ_PROJECT when it names one, then, for a command
 * (not the server), the project whose repo holds its folder, then the active one. `base()` reads config.json,
 * only when the folder is needed. null when there is no store.
 */
export function pickProject(store, { server, cwd, env = {}, base = () => ({}) }) {
  if (!store) return null
  const named = env.YZ_PROJECT && store.projects.find(p => p.id === env.YZ_PROJECT)
  if (named) return named
  if (!server) {
    const mine = projectForCwd(store, cwd, base())
    if (mine) return mine
  }
  return store.projects.find(p => p.id === store.active) || store.projects.find(p => p.primary)
}

/** `Flinki v2` -> `flinki-v2`: a project id; never empty, at most 40. */
export const slugOf = name => String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'project'

/** `C:/x/flinki-v2` -> `Flinki v2`: the name the primary project has until the user gives it one. */
export function prettyName(repo) {
  const base = String(repo ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop().replace(/[-_]+/g, ' ').trim()
  return base ? base[0].toUpperCase() + base.slice(1) : 'This project'
}

/** The store the page and the routes work on: projects.json, or with none the one project of config.json (`base`), active. */
export function effectiveStore(store, base) {
  if (store) return store
  const name = prettyName(base?.repo)
  const id = slugOf(String(base?.repo ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || name)
  return { active: id, projects: [{ id, name, primary: true, config: {} }] }
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/** The server is `node server.mjs`; anything else (a command, a test) is a command. */
const IS_SERVER = /(^|[\\/])server\.mjs$/i.test(process.argv[1] || '')
/** projects.json as it was when this process started (null: none). */
export const PROJECTS = readProjects()
/** The project this process works for, or null with no projects.json. */
export const CURRENT_PROJECT = pickProject(PROJECTS, { server: IS_SERVER, cwd: process.cwd(), env: process.env, base: () => readJsonSafe(CONFIG_JSON) })
/** THE data folder: every data file of the current project lives under it (flows.mjs, factory-state.mjs, since-store.mjs). */
export const DATA_DIR = CURRENT_PROJECT ? projectDataDir(CURRENT_PROJECT) : DATA_ROOT
