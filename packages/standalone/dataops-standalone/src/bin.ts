#!/usr/bin/env node
/**
 * The installed command for a standalone DataOps workspace deployment.
 *
 * The CLI lives in \`@sparkelf/dsh-plus\`, but npm installs a command only for the
 * package that declares it: a dependency's \`bin\` becomes a nested entry the shell
 * cannot reach. This package is what a DataOps workspace installs, so it declares the
 * command and forwards every argument to the CLI, keeping one implementation of start,
 * stop, status, update, and doctor.
 *
 * The resolved profile name comes from this package's own \`dshPlusStandalone.profile\`,
 * which the CLI reads to materialize \`dataops-web\` rather than the public \`plus\` profile.
 *
 * @module @sparkelf/dsh-dataops-standalone/bin
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
