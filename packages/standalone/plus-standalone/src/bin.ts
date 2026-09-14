#!/usr/bin/env node
/**
 * The installed command for a standalone Plus deployment.
 *
 * The CLI lives in \`@sparkelf/dsh-plus\`, but npm installs a command only for the
 * package that declares it: a dependency's \`bin\` becomes a nested entry the shell
 * cannot reach. This package is what a user installs, so it declares the command and
 * forwards every argument to the CLI, keeping one implementation of start, stop,
 * status, update, and doctor.
 *
 * The CLI path comes from that package's own \`bin\` field rather than a literal path,
 * because the package's \`exports\` map does not publish its executable file — only the
 * manifest is reachable by specifier. The resolved file is imported rather than
 * re-executed in a child process, so the CLI runs in this process and its exit code
 * is this exit code.
 *
 * @module @sparkelf/dsh-plus-standalone/bin
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const manifestPath = require.resolve('@sparkelf/dsh-plus/package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin?: Record<string, string> }
const declared = manifest.bin?.['dsh-plus']
if (declared === undefined) throw new Error('@sparkelf/dsh-plus declares no dsh-plus command')
await import(pathToFileURL(join(dirname(manifestPath), declared)).href)
