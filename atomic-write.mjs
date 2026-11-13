// One atomic file write for every data file the dashboard and its CLI share
// (flows, factory-state.json, ticket sources).
//
// Write a temp file next to the target, then rename it into place, so a
// reader never sees half a file. Two rules the plain version broke:
// - The temp name carries the pid, so two processes writing the same file
//   never share (and clobber, or rename away) one `<file>.tmp`.
// - ⚠️ On Windows a rename onto a file another process has open (the server
//   reading a flow while an agent writes it, or the reverse) fails with EPERM
//   (sometimes EACCES or EBUSY) until that reader closes it. Measured: nearly
//   every write failed under three busy writers. So the rename is retried
//   with a short SYNCHRONOUS backoff (Atomics.wait, about half a second in
//   all); callers are synchronous and stay so. Any other error, or the last
//   failed try, removes the temp file and throws.

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const TRIES = 10
const pause = new Int32Array(new SharedArrayBuffer(4))
/** 20, 30, 40, then 50 ms: about 440 ms over the ten tries. */
const waitMs = i => Math.min(50, 20 + 10 * i)

export function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, file)
      return
    } catch (err) {
      if (!RETRY_CODES.has(err.code) || i >= TRIES - 1) {
        rmSync(tmp, { force: true })
        throw err
      }
      Atomics.wait(pause, 0, 0, waitMs(i))
    }
  }
}
