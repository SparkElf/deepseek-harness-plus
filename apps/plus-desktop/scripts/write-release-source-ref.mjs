import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
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

function pullRequestHead() {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request' || eventPath === undefined) return undefined
  const event = JSON.parse(readFileSync(eventPath, 'utf8'))
  const sha = event.pull_request?.head?.sha
  return typeof sha === 'string' && sha.length > 0 ? sha : undefined
}

const releaseSourceRef = pullRequestHead() ?? revision(process.env.GITHUB_EVENT_NAME === 'pull_request' ? 'HEAD^2' : 'HEAD')
const output = resolve(scriptDirectory, '../src/release-source.mjs')
writeFileSync(output, 'export const releaseSourceRef = ' + JSON.stringify(releaseSourceRef) + '\n')
