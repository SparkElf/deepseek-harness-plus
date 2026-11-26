import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isInternalMutation,
  markInternalMutation,
  resetInternalMutationsForTests,
  startExternalChangeWatcher,
  type ExternalChangeDetail,
} from '../src/externalChange.ts'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

let root = ''
let stop: (() => void) | undefined

beforeEach(async () => {
  resetInternalMutationsForTests()
  root = await mkdtemp(join(tmpdir(), 'kb-external-change-'))
})

afterEach(async () => {
  stop?.()
  stop = undefined
  await rm(root, { recursive: true, force: true })
})

const collect = () => {
  const events: Array<{ relPath: string; detail: ExternalChangeDetail }> = []
  stop = startExternalChangeWatcher({
    actualRoot: root,
    debounceMs: 100,
    retryMs: 100,
    onChange: (relPath, detail) => { events.push({ relPath, detail }) },
  })
  return events
}

describe('external change watcher', () => {
  it('reports an outside write as an external change', async () => {
    const events = collect()
    await writeFile(join(root, 'outside.md'), 'shell write')
    for (let attempt = 0; attempt < 20 && events.length === 0; attempt += 1) await sleep(100)
    expect(events.length).toBeGreaterThan(0)
    expect(events[0]).toMatchObject({ relPath: 'outside.md' })
  })

  it('ignores a write this process marked as internal', async () => {
    const events = collect()
    markInternalMutation('inside.md')
    expect(isInternalMutation('inside.md')).toBe(true)
    await writeFile(join(root, 'inside.md'), 'plugin write')
    await sleep(500)
    expect(events).toEqual([])
  })

  it('debounces several events for one path into one report', async () => {
    const events = collect()
    await writeFile(join(root, 'burst.md'), '1')
    await writeFile(join(root, 'burst.md'), '2')
    await writeFile(join(root, 'burst.md'), '3')
    await sleep(800)
    expect(events.filter(event => event.relPath === 'burst.md')).toHaveLength(1)
  })

  it('ignores dot-prefixed internal paths', async () => {
    const events = collect()
    await writeFile(join(root, '.kb-templates'), 'internal')
    await sleep(400)
    expect(events).toEqual([])
  })
})
