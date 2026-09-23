#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runApply } from './apply.ts'
import { runStandaloneCli } from './standalone-cli.ts'

/** This package's own manifest, read beside the built entry. */
const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))

/**
 * Dispatch the command line.
 *
 * `apply` remains the materialization command a source-based installation runs; every
 * other word is a standalone lifecycle command. Reaching the dispatcher first keeps
 * one executable for both, so a user who installed the distribution from the registry
 * never needs to know which half owns a command.
 *
 * `--version` answers with the installed distribution version. The release sequence
 * drives every family's entry through it to prove an installed artifact runs and reports
 * the version its tarball carried, so the standalone installer has to answer like the
 * official launcher does.
 *
 * @returns the process exit code.
 */
async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const first = argv[0]
  if (first === '--version' || first === '-v') {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }
    console.log(String(manifest.version))
    return 0
  }
  if (first === 'apply') {
    // `runApply` parses the command word itself, so it receives the arguments this
    // dispatcher already inspected rather than a slice that dropped it.
    runApply(argv)
    return 0
  }
  return await runStandaloneCli(argv)
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
