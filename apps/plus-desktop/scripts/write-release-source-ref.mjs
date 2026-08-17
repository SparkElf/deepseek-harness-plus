import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(scriptDirectory, '../../..')

function revision(reference) {
  try {
    return execFileSync('git', ['rev-parse', reference], { cwd: workspaceRoot, encoding: 'utf8' }).trim()
  } catch (error) {
    if (reference === 'HEAD^2') return revision('HEAD')
    throw error
  }
}

const releaseSourceRef = revision(process.env.GITHUB_EVENT_NAME === 'pull_request' ? 'HEAD^2' : 'HEAD')
const output = resolve(scriptDirectory, '../src/release-source.mjs')
writeFileSync(output, 'export const releaseSourceRef = ' + JSON.stringify(releaseSourceRef) + '\n')
