// The Project menu's routes, and the mount point of the Orchestration bank's (bank-routes.mjs). server.mjs makes
// ONE router with makeProjectRoutes and calls `route.track(req, res)` on every request, so a switch knows what is
// still running.
//
//   GET  /api/projects                   { current, bootId, projects: [{ id, name, primary, current, repo, sessionCwdMatch,
//                                        orchestration }], limits, restartError }. With no projects.json: the one
//                                        project of config.json. `bootId` changes on every start (the page waits for it).
//   POST /api/projects                   { name, repo, sessionCwdMatch?, start: 'same' | <bank entry id> }: add a project.
//                                        The first add writes projects.json, with the project of config.json first.
//   POST /api/projects/<id>/rename       { name }
//   POST /api/projects/<id>/remove       out of the list only: its data folder and its repo are never touched
//   POST /api/projects/<id>/switch       202 { switching, log }: writes `active`, answers, then restarts (restart.mjs)
//   /api/orchestrations…                 bank-routes.mjs
//
// ═══ SAFETY ═══
// - Every POST needs the page's OWN Origin (local-origin.mjs): a switch restarts the server and a style is printed
//   to every agent, so only the dashboard page may do either.
// - Ids are checked (PROJECT_ID, ENTRY_ID) before anything else, and long before a path is built from one.
// - A switch, and using a style, are REFUSED while something would be lost by a restart: a chat turn, an answer
//   on its way to an agent or waiting in the relay's queue (both live in memory only), or any other write still
//   being answered (a SCRIPT run, a Send push, a save): one plain sentence says what is still running.
// - The restart runs AFTER the answer has gone (`later`). If it fails, the old server keeps running, a switch
//   puts `active` back, and the next read says what happened (restartError).

import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { bankDelete, bankDuplicate, bankList, bankOne, bankRename, bankSave, bankUse } from './bank-routes.mjs'
import { originAllowed } from './local-origin.mjs'
import { BANK_FILE, ENTRY_ID, markUsed, readBank, usedBy, writeBank } from './orchestration-bank.mjs'
import { applySnapshot, checkSnapshot, projectTarget, STYLE_PARTS, takeSnapshot } from './orchestration-parts.mjs'
import {
  CONFIG_JSON, CURRENT_PROJECT, DATA_ROOT, effectiveStore, PROJECT_ID, PROJECT_LIMITS, PROJECTS_FILE, projectDataDir,
  projectRaw, readProjects, slugOf, writeProjects,
} from './project-store.mjs'
import { restartLogFile } from './restart.mjs'

const BODY_MAX = 20_000
const silent = () => {}
const answer = (status, body, after) => ({ status, body, ...(after ? { after } : {}) })
const unslash = p => String(p).replace(/\\/g, '/').replace(/\/+$/, '')

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  let raw = ''
  for await (const c of req) {
    raw += c
    if (raw.length > BODY_MAX) throw Object.assign(new Error('That is too long to send.'), { status: 413 })
  }
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    throw Object.assign(new Error('The request was not valid JSON.'), { status: 400 })
  }
}

const joinAnd = parts => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`)

/** What an unfinished write is, by its path, for the refusal sentence. */
function writeKind(p) {
  if (p.startsWith('/api/script')) return 'a SCRIPT run is still writing'
  if (/^\/api\/flows\/[^/]+\/pr$/.test(p)) return 'a Send is still pushing a branch'
  return 'a change is still being saved'
}

/** A project name: `{ name }` or `{ error }`; unique in `store` (but for `self`). */
function checkProjectName(name, store, self = null) {
  const n = typeof name === 'string' ? name.trim() : ''
  if (!n) return { error: 'Give the project a name.' }
  if (/[\r\n]/.test(n)) return { error: 'Keep the name on one line.' }
  if (n.length > PROJECT_LIMITS.name) return { error: `That name is too long. Keep it to ${PROJECT_LIMITS.name} characters.` }
  if (store.projects.some(p => p.id !== self && p.name.toLowerCase() === n.toLowerCase())) return { error: `There is already a project called ${n}.` }
  return { name: n }
}

/**
 * deps: { port (number or () => number), running?, files?, restart, later?, gitTop, relay?, chatBusy?, sessionNames?,
 * bootId?, parts?, now? }. `running` is the project this process loaded (project-store.mjs CURRENT_PROJECT, or the
 * one of config.json); `files` { projectsFile, configFile, root, bankFile } default to the real ones; `gitTop(dir)`
 * resolves the top folder of the git repository holding `dir`, or null.
 */
export function makeProjectRoutes(deps) {
  const files = { projectsFile: PROJECTS_FILE, configFile: CONFIG_JSON, root: DATA_ROOT, bankFile: BANK_FILE, ...(deps.files || {}) }
  const portOf = () => (typeof deps.port === 'function' ? deps.port() : deps.port)
  const later = deps.later || (fn => setTimeout(fn, 150))
  const parts = deps.parts || STYLE_PARTS
  const now = deps.now || (() => new Date())
  const sessionNames = deps.sessionNames || (async () => [])
  const bootId = deps.bootId || `${process.pid}-${Date.now().toString(36)}`
  const running = deps.running || CURRENT_PROJECT || effectiveStore(null, readJson(files.configFile)).projects[0]
  const inflight = new Map() // a request object -> its path, for every write still being answered
  let restartError = null

  /** The files as they are NOW: config.json, the store (projects.json, or the one project of config.json), this process's project. */
  function context() {
    const base = readJson(files.configFile)
    const store = effectiveStore(readProjects(files.projectsFile, silent), base)
    const current = store.projects.find(p => p.id === running.id) || running
    return { base, store, current, files, parts, now, target: projectTarget(current, files) }
  }

  /** The refusal sentence while a restart would lose something, else null. */
  function busy() {
    const what = []
    if (deps.chatBusy?.()) what.push('the Ask chat is answering')
    const relay = deps.relay?.status?.() || {}
    if (relay.running) what.push('an answer is being sent to an agent')
    const waiting = relay.pending?.length || 0
    if (waiting) what.push(waiting === 1 ? 'an answer is waiting to be sent' : `${waiting} answers are waiting to be sent`)
    for (const kind of new Set(inflight.values())) what.push(writeKind(kind))
    if (!what.length) return null
    return `Not now: ${joinAnd(what)}. Try again once ${what.length === 1 && !(waiting > 1 && !relay.running) ? 'it has' : 'they have'} finished.`
  }

  /** The restart, after the answer: on failure the old server keeps running, `undo` runs, and the next read says so. */
  const restartAfter = undo => async () => {
    const r = await deps.restart()
    if (!r?.ok) {
      restartError = r?.error || 'The dashboard could not restart.'
      undo?.()
    }
  }

  // ═══ the projects ═══

  function list() {
    const { store, current, base } = context()
    const bank = readBank(files.bankFile)
    return answer(200, {
      current: { id: current.id, name: current.name },
      bootId,
      projects: store.projects.map(p => {
        const raw = projectRaw(base, store, p)
        return {
          id: p.id, name: p.name, primary: !!p.primary, current: p.id === current.id,
          repo: unslash(raw.repo || ''), sessionCwdMatch: raw.sessionCwdMatch || path.basename(unslash(raw.repo || '')),
          orchestration: usedBy(bank, p.id),
        }
      }),
      limits: { ...PROJECT_LIMITS },
      restartError,
    })
  }

  async function add(b) {
    const ctx = context()
    const { store, base } = ctx
    const name = checkProjectName(b?.name, store)
    if (name.error) return answer(400, name)
    if (typeof b.repo !== 'string' || !b.repo.trim()) return answer(400, { error: 'Give the folder of the project repository.' })
    const repo = unslash(b.repo.trim())
    if (repo.length > 400 || /[\r\n]/.test(repo) || !path.isAbsolute(repo)) return answer(400, { error: 'Give the full path of the folder, such as C:/work/my-repo.' })
    let isDir = false
    try {
      isDir = statSync(repo).isDirectory()
    } catch {}
    if (!isDir) return answer(400, { error: `There is no folder at ${repo}.` })
    const top = await deps.gitTop(repo)
    if (!top) return answer(400, { error: `${repo} is not a git repository.` })
    if (unslash(top).toLowerCase() !== repo.toLowerCase()) return answer(400, { error: `That folder is inside the git repository ${unslash(top)}. Use ${unslash(top)}.` })
    const twin = store.projects.find(p => unslash(projectRaw(base, store, p).repo || '').toLowerCase() === repo.toLowerCase())
    if (twin) return answer(400, { error: `That folder is already the project ${twin.name}.` })
    const match = b.sessionCwdMatch === undefined || b.sessionCwdMatch === '' ? path.basename(repo) : b.sessionCwdMatch
    if (typeof match !== 'string' || !match.trim() || match.length > 100 || /[\r\n]/.test(match)) return answer(400, { error: 'How sessions are recognised must be one line of at most 100 characters.' })
    if (store.projects.length >= PROJECT_LIMITS.projects) return answer(400, { error: `The list keeps ${PROJECT_LIMITS.projects} projects. Remove one first.` })

    const bank = readBank(files.bankFile)
    let snapshot
    let used = null
    if (b.start === 'same' || b.start === undefined) {
      snapshot = takeSnapshot(ctx.target, parts)
      used = usedBy(bank, ctx.current.id)
    } else if (typeof b.start === 'string' && ENTRY_ID.test(b.start)) {
      const e = bank.entries.find(x => x.id === b.start)
      if (!e) return answer(400, { error: 'That orchestration is not in the bank.' })
      snapshot = e.snapshot
      used = e
    } else return answer(400, { error: 'Choose how the project starts: the same orchestration, or one from the bank.' })
    const why = checkSnapshot(snapshot, parts)
    if (why) return answer(400, { error: `That orchestration cannot be used: ${why}` })

    // a fresh id: not in the list, and not the folder of a project removed earlier (its data stays its own)
    let id = slugOf(name.name)
    for (let k = 2; store.projects.some(p => p.id === id) || existsSync(projectDataDir({ id }, files.root)); k++) id = `${slugOf(name.name).slice(0, 36)}-${k}`
    const project = { id, name: name.name, config: { repo, sessionCwdMatch: match.trim() } }
    const next = { active: store.active, projects: [...store.projects, project] }
    writeProjects(next, files.projectsFile)
    try {
      applySnapshot(snapshot, projectTarget(project, files), parts)
    } catch (err) {
      writeProjects(store, files.projectsFile) // a project half set up is not left in the list
      return answer(500, { error: `The project could not be set up: ${err?.message || err}` })
    }
    if (used && !used.removed) writeBank(markUsed(bank, id, used), files.bankFile)
    return answer(201, { ok: true, project: { id, name: name.name } })
  }

  function rename(id, b) {
    const { store } = context()
    const p = store.projects.find(x => x.id === id)
    if (!p) return answer(404, { error: 'That project is not in the list.' })
    const name = checkProjectName(b?.name, store, id)
    if (name.error) return answer(400, name)
    p.name = name.name
    writeProjects(store, files.projectsFile)
    return answer(200, { ok: true, project: { id, name: p.name } })
  }

  function remove(id) {
    const { store, current } = context()
    const p = store.projects.find(x => x.id === id)
    if (!p) return answer(404, { error: 'That project is not in the list.' })
    if (p.id === current.id) return answer(409, { error: 'This is the project the dashboard shows now. Switch to another one first.' })
    if (p.primary) return answer(409, { error: 'The first project comes from config.json and cannot be removed.' })
    writeProjects({ active: store.active === id ? current.id : store.active, projects: store.projects.filter(x => x.id !== id) }, files.projectsFile)
    return answer(200, { ok: true, kept: projectDataDir(p, files.root) })
  }

  function switchTo(id) {
    const { store, current, base } = context()
    const p = store.projects.find(x => x.id === id)
    if (!p) return answer(404, { error: 'That project is not in the list.' })
    if (p.id === current.id) return answer(200, { ok: true, already: true })
    const repo = unslash(projectRaw(base, store, p).repo || '')
    if (!repo || !existsSync(repo)) return answer(409, { error: `The folder of ${p.name} is not there any more: ${repo || 'none is set'}. Add the project again with its new folder.` })
    const refusal = busy()
    if (refusal) return answer(409, { error: refusal })
    const before = store.active
    writeProjects({ ...store, active: id }, files.projectsFile)
    restartError = null
    const undo = () => {
      const s = readProjects(files.projectsFile, silent)
      if (s?.active === id) writeProjects({ ...s, active: before }, files.projectsFile)
    }
    return answer(202, { ok: true, switching: { id, name: p.name }, log: restartLogFile() }, restartAfter(undo))
  }

  // ═══ the router ═══

  async function handle(req, url) {
    const p = url.pathname
    const post = req.method === 'POST'
    if (post && !originAllowed(req.headers.origin, portOf())) return answer(403, { error: 'Projects and orchestrations are changed only from the dashboard page.' })
    const b = post ? await readBody(req) : null
    if (p === '/api/projects') return post ? add(b) : list()
    if (p === '/api/orchestrations') {
      if (post) return bankSave(context(), b)
      return bankList(context())
    }
    const proj = /^\/api\/projects\/([^/]+)\/(rename|remove|switch)$/.exec(p)
    if (proj && post) {
      const id = decodeURIComponent(proj[1])
      if (!PROJECT_ID.test(id)) return answer(400, { error: 'That is not a project id.' })
      return proj[2] === 'rename' ? rename(id, b) : proj[2] === 'remove' ? remove(id) : switchTo(id)
    }
    const orch = /^\/api\/orchestrations\/([^/]+)(?:\/(rename|duplicate|delete|use))?$/.exec(p)
    if (orch) {
      const id = decodeURIComponent(orch[1])
      if (!ENTRY_ID.test(id)) return answer(400, { error: 'That is not an orchestration id.' })
      const ctx = context()
      if (!orch[2] && !post) return bankOne(ctx, id, sessionNames)
      if (post && orch[2] === 'rename') return bankRename(ctx, id, b)
      if (post && orch[2] === 'duplicate') return bankDuplicate(ctx, id)
      if (post && orch[2] === 'delete') return bankDelete(ctx, id)
      if (post && orch[2] === 'use') return bankUse(ctx, id, { busy, sessionNames, restart: restartAfter(null) })
    }
    return answer(405, { error: 'Not a route here.' })
  }

  async function route(req, res, url) {
    if (!url.pathname.startsWith('/api/projects') && !url.pathname.startsWith('/api/orchestrations')) return false
    let r
    try {
      r = await handle(req, url)
    } catch (err) {
      r = answer(err?.status || 500, { error: err?.status ? err.message : `Something went wrong: ${err?.message || err}` })
    }
    json(res, r.status, r.body)
    if (r.after) later(r.after)
    return true
  }

  /** Every request passes here first: a write still being answered (not these routes' own) holds a switch back. */
  route.track = (req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return
    const p = String(req.url || '').split('?')[0]
    if (p.startsWith('/api/projects') || p.startsWith('/api/orchestrations')) return
    inflight.set(req, p)
    res.on('close', () => inflight.delete(req))
  }
  route.busy = busy
  return route
}
