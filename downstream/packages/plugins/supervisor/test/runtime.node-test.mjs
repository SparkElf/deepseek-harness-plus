import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readSupervisorManifest, writeSupervisorManifest } from '../runtime/manifest.mjs'
import { decodeProcessOutput } from '../runtime/process-output-encoding.mjs'

test('publishes and reads one complete manifest atomically', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-supervisor-manifest-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'runtime.json')
  const value = { dshHome: directory, port: 3080, supervisorPort: 3082, socketPath: join(directory, 'runtime.sock') }

  writeSupervisorManifest(path, JSON.stringify(value))

  assert.deepEqual(await readSupervisorManifest(path), value)
  assert.equal(existsSync(path + '.next'), false)
  assert.equal(JSON.parse(await readFile(path, 'utf8')).port, 3080)
})

test('decodes UTF-8 and UTF-16 process output', () => {
  assert.equal(decodeProcessOutput(Buffer.from('启动完成', 'utf8')), '启动完成')
  assert.equal(decodeProcessOutput(Buffer.from('ready', 'utf16le')), 'ready')
})
