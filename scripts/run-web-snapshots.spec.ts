import { describe, expect, it } from 'vitest'
import { parseWebSnapshotSelection, partitionWebSnapshotFiles } from './run-web-snapshots.ts'

describe('Web snapshot impact selection', () => {
  it('keeps the complete suite marker and both serial owners', () => {
    expect(parseWebSnapshotSelection(undefined)).toBeUndefined()
    expect(partitionWebSnapshotFiles(undefined)).toEqual({
      serial: [
        'apps/web/tests/hmr-live.e2e.ts',
        'apps/web/tests/cordis-tool-round.e2e.ts',
      ],
      parallel: undefined,
    })
  })

  it('separates an affected serial owner from the bounded parallel files', () => {
    const selected = [
      'apps/web/tests/goal-bar.e2e.ts',
      'apps/web/tests/hmr-live.e2e.ts',
    ]

    expect(partitionWebSnapshotFiles(parseWebSnapshotSelection(JSON.stringify(selected)))).toEqual({
      serial: ['apps/web/tests/hmr-live.e2e.ts'],
      parallel: ['apps/web/tests/goal-bar.e2e.ts'],
    })
  })

  it.each([
    '',
    '[]',
    JSON.stringify(['apps/web/tests/support.ts']),
    JSON.stringify(['apps/web/tests/goal-bar.e2e.ts', 'apps/web/tests/goal-bar.e2e.ts']),
  ])('rejects an invalid affected selection %s', (selection) => {
    expect(() => parseWebSnapshotSelection(selection)).toThrow()
  })
})
