#!/usr/bin/env node

import { runApply } from './apply.ts'

try {
  runApply(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
}
