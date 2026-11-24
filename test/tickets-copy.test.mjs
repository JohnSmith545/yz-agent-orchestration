// The copy rules (spec 6) on the Tickets page: a button is a verb with its
// object in the tooltip, and a card head is a name and a number with no
// sentence after it. A grep over the files that draw the page.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = f => fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8')

/** Fails naming the file and line of each match, never dumping the whole file. */
function absent(file, re) {
  const hits = read(file)
    .split(/\r?\n/)
    .map((line, i) => (re.test(line) ? `${file}:${i + 1}: ${line.trim()}` : null))
    .filter(Boolean)
  assert.equal(hits.length, 0, `expected no match for ${re}:\n${hits.join('\n')}`)
}

for (const f of ['factory.js', 'orchestration.js']) {
  test(`${f}: no button says Refresh from Switchboard (the object goes in the title)`, () => absent(f, /Refresh from Switchboard/i))
  test(`${f}: no subtitle explains the grid after its name`, () => absent(f, /tickets with code, by who built them/i))
}

test('factory.js: the page mounts neither the flows nor the chat (they live on #/flows and in the drawer)', () => {
  absent('factory.js', /FlowsView\?*\.mount\(|FactoryChat\?*\.mount\(/)
  absent('factory.js', /fxWaiting|fxFlows|fxChat/)
})

// Nothing outside a defined flow: every action the page hands the chat agent names the flow type it starts.
const said = name => {
  const m = new RegExp(`function ${name}\\([^)]*\\) \\{([\\s\\S]*?)\\n  \\}`).exec(read('factory.js'))
  assert.ok(m, `factory.js has ${name}`)
  return m[1]
}

test('factory.js: review asks the chat agent for a review flow, explain for an ask flow, a pass for the agent to start a build flow', () => {
  assert.match(said('reviewTickets'), /--type review/)
  assert.match(said('explainTicket'), /--type ask/)
  const pass = said('passTo')
  assert.match(pass, /--type build/)
  assert.match(pass, /--by/)
  assert.match(pass, /follow its route/)
  assert.match(pass, /QA/)
})

test('factory.css: the page is one column, with no chat panel styles', () => {
  absent('factory.css', /grid-template-columns:\s*minmax\(0, 1fr\) 420px/)
  absent('factory.css', /\.fx-chat|\.fc-log|\.fc-msg/)
})
