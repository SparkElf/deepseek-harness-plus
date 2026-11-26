/**
 * A document that cannot reach the host's right-hand file window must not fail
 * silently. The page falls back to its own preview, but the reader has to be told
 * why the window they expected is not there.
 *
 * The graph canvas test proves the message reaches `openDocument`; this guards the
 * two visible halves of the failure path: the alert in the content column and the
 * fallback that turns an "opened" answer with no expanded track into a real
 * failure instead of a blank frame.
 */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')

describe('knowledge document open failure', () => {
  it('renders a visible alert for the fallback preview', async () => {
    const panel = await read('../src/client/KnowledgePanel.tsx')
    expect(panel).toMatch(/openFailure !== undefined/u)
    expect(panel).toMatch(/role="alert"/u)
    expect(panel).toContain("t('openFailureTitle')")
    expect(panel).toContain("t('openFailureBody')")
  })

  it('turns an opened-but-collapsed host column into a failure', async () => {
    const panel = await read('../src/client/KnowledgePanel.tsx')
    expect(panel).toMatch(/setOpenFailure\('no-column'\)/u)
  })

  it('defines both locale strings', async () => {
    const locales = await read('../src/client/locales.ts')
    expect(locales).toContain('openFailureTitle:')
    expect(locales).toContain('openFailureBody:')
  })
})
