#!/usr/bin/env node

import { runApply } from './apply.ts'
import { runStandaloneCli } from './standalone-cli.ts'

/**
 * Dispatch the command line.
 *
 * `apply` remains the materialization command a source-based installation runs; every
 * other word is a standalone lifecycle command. Reaching the dispatcher first keeps
 * one executable for both, so a user who installed the distribution from the registry
 * never needs to know which half owns a command.
 *
 * @returns the process exit code.
 */
async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const first = argv[0]
  if (first === 'apply') {
    runApply(argv.slice(1))
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
