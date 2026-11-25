import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'

describe('Workbench Cordis overlays', () => {
  for (const name of ['ssh-manager', 'api-client']) it('parses ' + name, async () => {
    const value = YAML.parse(await readFile(join(process.cwd(), '..', name, 'cordis.patch.yml'), 'utf8')) as Array<{ insert: Array<{ id: string; name: string }> }>
    expect(value[0]?.insert[0]).toEqual({ id: name, name: '@sparkelf/dsh-' + name })
  })
})
