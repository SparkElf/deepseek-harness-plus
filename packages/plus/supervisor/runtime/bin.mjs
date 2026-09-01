#!/usr/bin/env node
/** Command-line entry for serving or controlling one Plus Supervisor. */

import { readSupervisorManifest } from './manifest.mjs'
import { sendSupervisorCommand } from './client.mjs'
import { runSupervisor } from './supervisor.mjs'

function parse(argv) {
  const values = { positionals: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) {
      values.positionals.push(value)
      continue
    }
    values[value.slice(2)] = argv[index + 1]
    index += 1
  }
  return values
}

const args = parse(process.argv.slice(2))
if (typeof args.manifest !== 'string') throw new Error('dsh-plus-supervisor requires --manifest <path>')
const action = args.positionals[0] ?? 'serve'
if (action === 'serve') {
  await runSupervisor(args.manifest)
} else {
  const manifest = await readSupervisorManifest(args.manifest)
  const result = await sendSupervisorCommand(manifest.socketPath, action, phase => {
    process.stdout.write(JSON.stringify({ event: 'progress', phase }) + String.fromCharCode(10))
  })
  process.stdout.write(JSON.stringify(result, null, 2) + String.fromCharCode(10))
}
