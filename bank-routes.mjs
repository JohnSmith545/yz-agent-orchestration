// The Orchestration bank's routes (projects-routes.mjs mounts them, with the Origin rule and the busy check):
//
//   GET  /api/orchestrations                 { entries (newest first, with a summary), used, inUse, seeded, current, limits }.
//                                            `used` is the entry the project last took; `inUse` its id only while the
//                                            project's style still EQUALS it (an edit since makes it null).
//                                            The first read of an empty bank that was never seeded saves the style
//                                            in use now, named after the project and the date (`seeded` names it).
//   GET  /api/orchestrations/<id>            { entry, view (style-words.mjs styleView: route, roles, models), changes (what
//                                            using it would change, one sentence each), same (it equals the style in
//                                            use now: nothing to use), inUse, noSession, current: { summary } }
//   POST /api/orchestrations                 { name }: save the style in use now. 201 { ok, entry }
//   POST /api/orchestrations/<id>/rename     { name }
//   POST /api/orchestrations/<id>/duplicate  201 { ok, entry }: "<name> (copy)"
//   POST /api/orchestrations/<id>/delete     only the bank entry; no project changes
//   POST /api/orchestrations/<id>/use        replace this project's style with the entry's, after saving the style in
//                                            use now to the bank (unless the bank already holds that exact style), then
//                                            restart. 202 { ok, autosaved: { id, name, existing? }, noSession, entry }. An
//                                            entry that equals the style in use now is refused (409): Use twice is a no-op.
//
// Each handler takes `ctx` ({ files, current, target, parts, now }: built per request by projects-routes.mjs, from
// the files as they are NOW) and returns { status, body } (and `after` for a use: the restart, run once the answer
// has gone). Ids are checked (ENTRY_ID) by the router before a handler sees them.

import {
  addEntry, BANK_LIMITS, datedName, deleteEntry, duplicateEntry, listEntries, markUsed, readBank, renameEntry,
  seedIfEmpty, uniqueName, usedBy, writeBank,
} from './orchestration-bank.mjs'
import { applySnapshot, checkSnapshot, noSessionFor, sameStyle, takeSnapshot } from './orchestration-parts.mjs'
import { styleChanges, styleView, summaryOf } from './style-words.mjs'

const answer = (status, body, after) => ({ status, body, ...(after ? { after } : {}) })
const NOT_THERE = 'That orchestration is not in the bank.'
const brief = e => ({ id: e.id, name: e.name })
const snapshotNow = ctx => takeSnapshot(ctx.target, ctx.parts)
const fromNow = ctx => ({ id: ctx.current.id, name: ctx.current.name })

export function bankList(ctx) {
  let bank = readBank(ctx.files.bankFile)
  const seeded = seedIfEmpty(bank, () => ({ name: datedName(ctx.current.name, ctx.now()), from: fromNow(ctx), snapshot: snapshotNow(ctx) }))
  if (seeded.entry) {
    bank = markUsed(seeded.bank, ctx.current.id, seeded.entry) // the style it was copied from is the one in use
    writeBank(bank, ctx.files.bankFile)
  }
  const used = usedBy(bank, ctx.current.id)
  const usedEntry = used && bank.entries.find(x => x.id === used.id)
  return answer(200, {
    entries: listEntries(bank),
    used,
    inUse: usedEntry && sameStyle(usedEntry.snapshot, snapshotNow(ctx)) ? usedEntry.id : null,
    seeded: seeded.entry ? brief(seeded.entry) : null,
    current: fromNow(ctx),
    limits: { ...BANK_LIMITS },
  })
}

export async function bankOne(ctx, id, sessionNames) {
  const bank = readBank(ctx.files.bankFile)
  const e = bank.entries.find(x => x.id === id)
  if (!e) return answer(404, { error: NOT_THERE })
  const names = await sessionNames().catch(() => [])
  const now = snapshotNow(ctx)
  const same = sameStyle(e.snapshot, now)
  return answer(200, {
    entry: { id: e.id, name: e.name, savedAt: e.savedAt, from: e.from },
    view: styleView(e.snapshot),
    changes: styleChanges(now, e.snapshot),
    same,
    inUse: same && usedBy(bank, ctx.current.id)?.id === e.id,
    noSession: noSessionFor(e.snapshot, names),
    current: { summary: summaryOf(now) },
  })
}

export function bankSave(ctx, b) {
  const r = addEntry(readBank(ctx.files.bankFile), { name: b?.name, from: fromNow(ctx), snapshot: snapshotNow(ctx) })
  if (r.error) return answer(400, { error: r.error })
  writeBank(r.bank, ctx.files.bankFile)
  return answer(201, { ok: true, entry: brief(r.entry) })
}

function changed(ctx, r, status = 200) {
  if (r.error) return answer(r.error === NOT_THERE ? 404 : 400, { error: r.error })
  writeBank(r.bank, ctx.files.bankFile)
  return answer(status, { ok: true, ...(r.entry ? { entry: brief(r.entry) } : {}) })
}

export const bankRename = (ctx, id, b) => changed(ctx, renameEntry(readBank(ctx.files.bankFile), id, b?.name))
export const bankDuplicate = (ctx, id) => changed(ctx, duplicateEntry(readBank(ctx.files.bankFile), id), 201)
export const bankDelete = (ctx, id) => changed(ctx, deleteEntry(readBank(ctx.files.bankFile), id))

/** `busy()` is the refusal sentence while something must not be interrupted, else null; `restart` runs after the answer. */
export async function bankUse(ctx, id, { busy, sessionNames, restart }) {
  let bank = readBank(ctx.files.bankFile)
  const e = bank.entries.find(x => x.id === id)
  if (!e) return answer(404, { error: NOT_THERE })
  const why = checkSnapshot(e.snapshot, ctx.parts)
  if (why) return answer(400, { error: `This orchestration cannot be used: ${why}` })
  // the same style twice would only save another dated copy and restart for nothing (the page came back on the
  // question after a Use, and Enter applied it again): refused, in words
  const now = snapshotNow(ctx)
  if (sameStyle(e.snapshot, now)) return answer(409, { error: `${e.name} is already the orchestration in use on ${ctx.current.name}. There is nothing to change.` })
  const refusal = busy()
  if (refusal) return answer(409, { error: refusal })

  // the style in use now goes to the bank FIRST, so a switch can always be undone
  const same = bank.entries.find(x => sameStyle(x.snapshot, now))
  let autosaved
  if (same) autosaved = { ...brief(same), existing: true }
  else {
    const r = addEntry(bank, { name: uniqueName(bank, datedName(ctx.current.name, ctx.now(), { time: true })), from: fromNow(ctx), snapshot: now })
    if (r.error) {
      const full = r.error.startsWith('The bank is full')
      return answer(409, { error: full ? 'The bank is full, so the orchestration in use now cannot be saved first. Delete one, then try again.' : `The orchestration in use now could not be saved first: ${r.error}` })
    }
    bank = r.bank
    autosaved = brief(r.entry)
  }
  writeBank(bank, ctx.files.bankFile)

  try {
    applySnapshot(e.snapshot, ctx.target, ctx.parts)
  } catch (err) {
    return answer(500, { error: `The orchestration could not be written: ${err?.message || err}. The one in use before is saved in the bank as ${autosaved.name}.` })
  }
  writeBank(markUsed(bank, ctx.current.id, e), ctx.files.bankFile)
  const names = await sessionNames().catch(() => [])
  return answer(202, { ok: true, entry: brief(e), autosaved, noSession: noSessionFor(e.snapshot, names) }, restart)
}
