/**
 * The four rules first-run provisioning has to satisfy.
 *
 * A knowledge base that has never been used has no buckets, and the reader finds a
 * tree that can hold nothing. Provisioning therefore has to be idempotent (a restart
 * must not repeat work), self-healing (a bucket someone deleted must come back),
 * write-once for the tutorial (an edit outranks a newer built-in version), and safe
 * under concurrency (the boot trigger and the first page load can overlap).
 *
 * These run against a fake tree rather than a NAS: the rules are about which calls are
 * made and what the caller is told, and a real filesystem cannot be made to fail on
 * demand for the failure cases.
 */
import { describe, expect, it } from 'vitest'
import {
  KNOWLEDGE_BUCKETS,
  TUTORIAL_REL_PATH,
  createInitializer,
  type InitIo,
  type InitLogLine,
} from '../src/initialize.ts'

/** An in-memory stand-in for the authoritative tree. */
function fakeTree(): InitIo & {
  directories: Set<string>
  documents: Map<string, string>
  /** Remove a bucket as a user might, to prove the next run repairs it. */
  removeDirectory: (name: string) => void
  /** Pretend the whole root is unreachable, as an unmounted share would look. */
  setRootUnreachable: (value: boolean) => void
} {
  const directories = new Set<string>()
  const documents = new Map<string, string>()
  let rootUnreachable = false
  /** The exclusive-write refusal the real path raises, matched by `code`. */
  const alreadyExists = (what: string): Error =>
    Object.assign(new Error('a document or folder already exists at ' + what), { code: 'exists' })

  return {
    directories,
    documents,
    removeDirectory: name => directories.delete(name),
    setRootUnreachable: value => { rootUnreachable = value },
    isStorageReady: async () => !rootUnreachable,
    createDirectory: async relPath => {
      if (rootUnreachable) throw new Error('ENOENT: the share is not mounted')
      if (directories.has(relPath)) throw alreadyExists(relPath)
      directories.add(relPath)
    },
    createDocument: async (relPath, content) => {
      if (rootUnreachable) throw new Error('ENOENT: the share is not mounted')
      if (documents.has(relPath)) throw alreadyExists(relPath)
      documents.set(relPath, content)
    },
    tutorialHtml: () => '<html>tutorial</html>',
  }
}

/** Collect the per-item log so the report can be checked line by line. */
function collector(): { lines: InitLogLine[]; log: (line: InitLogLine) => void } {
  const lines: InitLogLine[] = []
  return { lines, log: line => { lines.push(line) } }
}

describe('first-run provisioning', () => {
  it('creates all three buckets and the tutorial once', async () => {
    const io = fakeTree()
    const { log, lines } = collector()
    const init = createInitializer(io, log)

    const report = await init.ensure()

    expect([...io.directories].sort()).toEqual([...KNOWLEDGE_BUCKETS].sort())
    expect(io.documents.get(TUTORIAL_REL_PATH)).toBe('<html>tutorial</html>')
    expect(report.buckets.map(entry => entry.outcome)).toEqual(['created', 'created', 'created'])
    expect(report.tutorial).toBe('written')
    // One line per bucket plus one for the tutorial: a deployment that comes up wrong
    // has to say which item failed, not only that something did.
    expect(lines).toEqual([
      { item: 'bucket:global', outcome: 'created' },
      { item: 'bucket:department', outcome: 'created' },
      { item: 'bucket:personal', outcome: 'created' },
      { item: 'tutorial', outcome: 'written' },
    ])
  })

  it('personal mode creates only the root and never seeds buckets or the tutorial', async () => {
    const io = fakeTree()
    let rootCreates = 0
    io.ensureRoot = async () => { rootCreates += 1 }
    const { log } = collector()
    const init = createInitializer(io, log, { personal: true })

    const report = await init.ensure()

    expect(rootCreates).toBe(1)
    expect(io.directories.size).toBe(0)
    expect(io.documents.size).toBe(0)
    expect(report.buckets).toEqual([])
    expect(report.tutorial).toBe('skipped')
  })

  it('is idempotent: a second run creates nothing and leaves the tutorial alone', async () => {
    const io = fakeTree()
    const { log } = collector()
    const init = createInitializer(io, log)

    await init.ensure()
    const report = await init.ensure()

    expect(report.buckets.map(entry => entry.outcome)).toEqual(['exists', 'exists', 'exists'])
    // An existing tutorial is the SUCCESS case: the reader may have edited it, and their
    // version outranks the built-in one.
    expect(report.tutorial).toBe('skipped')
    expect(io.documents.get(TUTORIAL_REL_PATH)).toBe('<html>tutorial</html>')
  })

  it('does not overwrite a tutorial the reader edited', async () => {
    const io = fakeTree()
    const { log } = collector()
    const init = createInitializer(io, log)

    await init.ensure()
    io.documents.set(TUTORIAL_REL_PATH, '<html>my own notes</html>')
    await init.ensure()

    expect(io.documents.get(TUTORIAL_REL_PATH)).toBe('<html>my own notes</html>')
  })

  it('re-creates a bucket that was deleted between runs', async () => {
    const io = fakeTree()
    const { log } = collector()
    const init = createInitializer(io, log)

    await init.ensure()
    // A bucket removed by hand must come back on the next start, which is why the
    // initialiser cannot treat "already ran" as "nothing left to do".
    io.removeDirectory('global')
    const report = await init.ensure()

    expect(io.directories.has('global')).toBe(true)
    expect(report.buckets).toEqual([
      { bucket: 'global', outcome: 'created' },
      { bucket: 'department', outcome: 'exists' },
      { bucket: 'personal', outcome: 'exists' },
    ])
    // Repairing a bucket must not rewrite the tutorial over the reader's edits.
    expect(report.tutorial).toBe('skipped')
  })

  it('shares one run between concurrent callers', async () => {
    const io = fakeTree()
    const { log, lines } = collector()
    const init = createInitializer(io, log)

    // The boot trigger and the first page load can overlap. Two runs would both call
    // `createDirectory` and the second would report a bucket as `exists` when it was
    // this process that created it, and the tutorial write would be reported as the
    // loser's `skipped` rather than the writer's `written`.
    const [first, second, third] = await Promise.all([init.ensure(), init.ensure(), init.ensure()])

    expect(first).toEqual(second)
    expect(second).toEqual(third)
    expect(first.buckets.map(entry => entry.outcome)).toEqual(['created', 'created', 'created'])
    expect(first.tutorial).toBe('written')
    // Exactly one run's worth of lines: three callers, four items.
    expect(lines).toHaveLength(4)
  })

  it('reports a run that could not reach the tree without throwing', async () => {
    const io = fakeTree()
    const { log, lines } = collector()
    const init = createInitializer(io, log)
    io.setRootUnreachable(true)

    // `apply()` calls this, so an unmounted share must not throw: the plugin still has to
    // register, and the status route retries once the share appears.
    const report = await init.ensure()

    expect(report.error).toBeDefined()
    expect(report.buckets.every(entry => entry.outcome === 'failed')).toBe(true)
    expect(report.tutorial).toBe('failed')
    expect(init.hasSucceeded()).toBe(false)
    expect(lines.every(line => line.outcome === 'failed')).toBe(true)
  })

  it('retries after a failed run instead of awaiting the settled one forever', async () => {
    const io = fakeTree()
    const { log } = collector()
    const init = createInitializer(io, log)

    io.setRootUnreachable(true)
    await init.ensure()
    expect(init.hasSucceeded()).toBe(false)

    // The share mounts a moment later; the status route's retry must do real work rather
    // than reuse the settled promise from the failed attempt.
    io.setRootUnreachable(false)
    const recovered = await init.ensure()

    expect(recovered.buckets.map(entry => entry.outcome)).toEqual(['created', 'created', 'created'])
    expect(recovered.tutorial).toBe('written')
    expect(init.hasSucceeded()).toBe(true)
  })
})
