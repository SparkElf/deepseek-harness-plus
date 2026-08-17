import { writeFile } from 'node:fs/promises'
function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) continue
    values[key.slice(2)] = argv[index + 1]
    index += 1
  }
  return values
}

function errorStack(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error)
}

const args = parseArguments(process.argv.slice(2))
if (!args.manifest || !args.socket || !args['startup-error']) throw new Error('supervisor bootstrap requires --manifest, --socket, and --startup-error')

try {
  const { runSupervisor } = await import('./supervisor.mjs')
  await runSupervisor(args.manifest, args.socket)
} catch (error) {
  const detail = errorStack(error) + String.fromCharCode(10)
  try { await writeFile(args['startup-error'], detail, { mode: 0o600 }) }
  catch (writeError) { console.error('[supervisor-bootstrap] startup error file write failed', writeError) }
  console.error('[supervisor-bootstrap] Supervisor failed before startup', error)
  process.exitCode = 1
}
