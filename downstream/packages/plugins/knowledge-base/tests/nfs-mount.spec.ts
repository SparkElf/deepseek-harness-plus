/**
 * Exercise the plugin's own view helpers over the real NFS mount, where the unit suite
 * uses a local temporary directory. The point is the network filesystem: hardlinks must
 * survive it, and an unchanged grant set must still write nothing. Skips when the mount
 * is absent so the suite stays runnable on a host without one.
 */
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dropView, pointMountAtView, syncView, viewPathFor } from '../src/views.ts'

/**
 * Where this HOST mounts the share, which is NOT where the workspace container does.
 *
 * Measured 2026-10-17: the same NFS export (`154.201.72.205:/`, dev 0:169) is mounted
 * at `/workspace/kb` on the host and at `/nas/kb` inside the workspace container, and
 * `/nas/kb` does not exist here at all. This suite runs on the host, so it must use the
 * host's path: changing it to the container's makes `mounted()` answer false and the
 * whole file SKIP, which reads as a pass while testing nothing. Asserted below so a
 * future edit toward the container path fails loudly instead of going quiet.
 */
const MOUNT = '/workspace/kb'

/**
 * Per-process suffix for every probe path.
 *
 * The share is a single machine-wide (and in CI, job-wide) resource, so a fixed probe name is
 * shared mutable state: two suites running at once overwrite and delete each other's probe, and
 * the loser sees `linked: []` where it expected its own file. Measured 2026-10-17: the full suite
 * failed 2 of 5 runs while this file alone passed 6 of 6, purely from that collision. The pid keeps
 * each process's probe private, and the interrupted-run cleanup below stays scoped to it.
 */
const PROBE_SUFFIX = String(process.pid)

/** User key the probe uses, named so cleanup cannot collide with a real view. */
const PROBE_USER = 'realmount-probe-' + PROBE_SUFFIX

/** Files the probe creates, so a run interrupted mid-assertion still cleans up. */
const PROBE_FILE = 'realmount-' + PROBE_SUFFIX + '.md'
const PROBE_POINTER = '.realmount-pointer-' + PROBE_SUFFIX

/**
 * Whether the real mount is present AND responsive.
 *
 * Presence is not health. A stale or rejected NFS mount stays in the mount table while every
 * access hangs, so a probe that only stats the directory passes and the tests then time out
 * on their first real operation. Measuring a round trip and requiring it to finish quickly
 * turns "the mount went away" into a skip instead of an intermittent failure.
 */
async function mounted(): Promise<boolean> {
  const probe = (async () => {
    const info = await stat(join(MOUNT, 'actual'))
    // A readdir is a second round trip: one successful stat can be served from cache while
    // the mount is already unusable for the operations these tests perform.
    await readdir(join(MOUNT, 'actual'))
    return info.isDirectory()
  })()
  let timer: NodeJS.Timeout | undefined
  const expiry = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), HEALTH_PROBE_TIMEOUT_MS)
  })
  try {
    return await Promise.race([probe, expiry])
  } catch {
    return false
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * How long the health probe may take before the mount is treated as unavailable.
 *
 * The export is mounted across a WAN, and the first metadata operation after an idle period
 * pays for re-establishing the connection. Measured 2026-10-17 on the healthy mount, six
 * consecutive samples:
 *
 *   stat:    6.77 s, 0.02 s, 0.00 s, 0.00 s, 0.00 s, 0.00 s
 *   readdir: 1.09 s, 0.59 s, 1.51 s, 2.28 s, 5.18 s, 0.31 s
 *
 * A 5 s budget was therefore below the probe's own worst case, and `mounted()` answered false on
 * a mount that was fine: the suite SKIPPED, which reads as a pass while testing nothing. That is
 * the failure this file warns about in the `MOUNT` comment above, arriving through the timeout
 * instead of through the path. The budget now sits above the measured worst case rather than
 * inside it; the tests themselves keep the longer `MOUNT_TIMEOUT_MS` for the same reason.
 */
const HEALTH_PROBE_TIMEOUT_MS = 30_000

const present = await mounted()

/**
 * Generous ceiling for a suite that runs over the network.
 *
 * The export is mounted across a WAN, where a single stat or link costs 0.7-1.9 s against
 * 0.009 s on a local disk (measured 2026-10-16), so the 5 s default is not a statement
 * about correctness here: these tests do dozens of metadata operations and were timing out
 * while passing every assertion. The timeout exists to catch a hung mount, not to score
 * throughput.
 */
const MOUNT_TIMEOUT_MS = 60_000

it('mounts the share at the host path, not the container path', { timeout: MOUNT_TIMEOUT_MS }, async () => {
  // A guard for the comment above. If someone "aligns" this path with the container's,
  // `present` becomes false and the real-NFS coverage disappears without failing.
  //
  // This one ASSERTS rather than skips when the path is absent, which is the whole point:
  // a skip is what the mistake looks like. The cost is that this suite needs the host mount
  // even though the block below tolerates its absence, so the same generous timeout applies
  // here. Two `stat` calls on a WAN mount measured 0.7-1.9 s cold (2026-10-17) and exceeded
  // vitest's 5 s default while the mount was healthy, which failed this guard spuriously.
  await expect(stat(MOUNT)).resolves.toBeDefined()
  await expect(stat(join(MOUNT, 'actual'))).resolves.toBeDefined()
})

describe.skipIf(!present)('over a real NFS mount', () => {
  // Cleanup belongs here rather than at the end of each test body: a run that is killed by
  // the timeout, or that fails an assertion, never reaches its own trailing statements and
  // would leave a probe file and a view directory behind on the shared export. That happened
  // when these tests first timed out.
  afterEach(async () => {
    await rm(join(MOUNT, 'actual', PROBE_FILE), { force: true })
    await rm(join(MOUNT, PROBE_POINTER), { force: true })
    await rm(join(MOUNT, 'views', PROBE_USER), { recursive: true, force: true })
  })

  it('links through the network filesystem and writes nothing when unchanged', { timeout: MOUNT_TIMEOUT_MS }, async () => {
    const options = {
      actualRoot: join(MOUNT, 'actual'),
      viewRoot: join(MOUNT, 'views'),
      userId: PROBE_USER,
    }
    const relPath = PROBE_FILE
    await writeFile(join(options.actualRoot, relPath), '# real\n')

    const first = await syncView(options, [{ relPath }])
    expect(first.linked).toEqual(['global/' + relPath])

    // The design's whole claim: an unchanged answer set costs no filesystem writes.
    const second = await syncView(options, [{ relPath }])
    expect(second.linked).toEqual([])
    expect(second.unchanged).toBeGreaterThan(0)

    // A hardlink shares the inode, which is what makes a revoke a single unlink and a
    // re-grant free. On NFS this only holds within one mount instance.
    // `viewPathFor` names the user's view *directory*, so the file is joined under it.
    const source = await stat(join(options.actualRoot, relPath))
    const linked = await stat(join(viewPathFor(options), 'global', relPath))
    expect(linked.ino).toBe(source.ino)

    const revoked = await syncView(options, [])
    expect(revoked.unlinked).toEqual(['global/' + relPath])
    // The authoritative file must survive the revoke: only the view's name is removed.
    expect((await stat(join(options.actualRoot, relPath))).isFile()).toBe(true)
  })

  it('points the mount point at a view and drops it again', { timeout: MOUNT_TIMEOUT_MS }, async () => {
    const options = {
      actualRoot: join(MOUNT, 'actual'),
      viewRoot: join(MOUNT, 'views'),
      userId: PROBE_USER,
    }
    const pointer = join(MOUNT, PROBE_POINTER)
    await mkdir(join(options.viewRoot, options.userId), { recursive: true })

    await pointMountAtView(options, pointer)
    expect((await stat(pointer)).isDirectory()).toBe(true)

    expect(await dropView(options)).toBe(true)
  })
})
