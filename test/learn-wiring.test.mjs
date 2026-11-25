// Tests for the two readers learn-wiring.mjs binds: a QA report read only by the path `flow qa` writes, and the token
// cost of a window from the Pipeline tokens index, left out (null) while the index is still being built. Temp files
// only: FACTORY_DATA_DIR points at a temp folder BEFORE the import.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-wiring-test-'))
process.env.FACTORY_DATA_DIR = TMP
const { readReport, tokenCost } = await import('../learn-wiring.mjs')
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

test('a QA report is read by the ref flow qa stores; any other path is refused before it is read', () => {
  const dir = path.join(TMP, 'evidence')
  fs.mkdirSync(path.join(dir, 'agent-rules'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'agent-rules', 'qa-1-report.md'), '# QA 1\nFAIL')
  fs.writeFileSync(path.join(dir, 'agent-rules', 'notes.md'), 'secret')
  assert.equal(readReport('agent-rules/qa-1-report.md', dir), '# QA 1\nFAIL')
  assert.equal(readReport('agent-rules/notes.md', dir), null)
  assert.equal(readReport('../config.json', dir), null)
  assert.equal(readReport('agent-rules/qa-9-report.md', dir), null) // missing
  assert.equal(readReport(null, dir), null)
})

test('the token cost: the index estimate for the window; null while it builds or when there is none', () => {
  const day = new Date(2026, 10, 24, 12)
  const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
  const files = [{ sessionId: 's', sub: false, days: { [key]: { 'claude-opus-5-5': [1_000_000, 0, 0, 0, 0, 1] } } }]
  const prices = { 'claude-opus-5-5': { input: 5, output: 25, cacheWrite: 6.25, cacheWrite1h: 10, cacheRead: 0.5 } }
  const to = new Date(2026, 10, 25, 12).getTime()
  const usd = tokenCost(() => ({ files, building: false }), prices)({ from: to - 7 * 86_400_000, to }).usd
  assert.equal(usd, 5)
  assert.equal(tokenCost(() => ({ files, building: true }), prices)({ from: 0, to }).usd, null)
  assert.equal(tokenCost(() => null, prices)({ from: 0, to }).usd, null)
})
