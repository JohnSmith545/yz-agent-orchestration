#!/usr/bin/env node
// A Claude Code Notification hook: records that a session stopped to wait on the user (a permission prompt, or an
// idle prompt after a reply that asked something) in data/waiting.json, for the dashboard to show (waiting.mjs).
// The hook runs this with its JSON on stdin:
//
//   { "session_id", "transcript_path", "cwd", "hook_event_name": "Notification", "notification_type", "message" }
//
// It FAILS OPEN: bad input, an unreadable transcript or any error ends with exit code 0 and no output, so a broken
// recorder never gets in a session's way. It prints nothing, ever.

import { lastReplyText, readWaits, recordWait, tailFrom, waitKind, writeWaits } from '../waiting.mjs' // the wait rules and the file

// Reads stdin and records the wait when there is one.
async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const input = JSON.parse(raw)
  if (!input?.session_id || !input.transcript_path) return
  const tail = tailFrom(input.transcript_path)
  if (!tail) return
  const wait = waitKind(input, lastReplyText(tail.text))
  if (!wait) return
  writeWaits(recordWait(readWaits(), input, wait, { size: tail.size }))
}

main()
  .catch(() => {})
  .finally(() => process.exit(0))
