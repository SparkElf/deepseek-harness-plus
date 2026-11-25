/**
 * The relogin prompt must not navigate the frame's parent.
 *
 * A 401 inside the workspace shows this prompt; its primary action used to assign
 * `window.top.location.href`, which replaced the whole portal view with the portal home while the
 * user was working. These cases pin the replacement: the portal opens in its own tab, and nothing
 * touches the top window.
 *
 * @module tests/relogin-navigation.test
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(import.meta.dirname, '..', 'src', 'client', 'ReloginPrompt.tsx'), 'utf8')

describe('the relogin prompt', () => {
  it('never assigns the top window location', () => {
    // `window.top.location` is the only way this frame can replace the portal page; the component
    // must not contain it at all, in any form.
    expect(source).not.toMatch(/window\.top\s*\.\s*location/)
    expect(source).not.toMatch(/top\.location\s*=/)
  })

  it('opens the portal in its own tab instead', () => {
    expect(source).toMatch(/window\.open\(\s*`\$\{portalOrigin\}\/`/)
  })
})
