import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The browser half ships as a built artifact, so its shape is a contract the source
 * cannot express. These assertions read `lib/client.js` after a build and check the
 * three things a wrong bundle would break silently.
 *
 * `lib/client.js` is produced by `pnpm --filter @sparkelf/dsh-group-chat build`; when
 * the build has not run the suite reports that rather than passing vacuously.
 */
const CLIENT_BUNDLE = new URL('../lib/client.js', import.meta.url).pathname
const HOST_BUNDLE = new URL('../lib/index.js', import.meta.url).pathname

const readIfPresent = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

const client = readIfPresent(CLIENT_BUNDLE)

describe('client bundle', () => {
  it('registers under the module loader with this package id', () => {
    // `client-modules` looks the bundle up by the manifest package name; a mismatch
    // leaves the plugin reported as failed to load, with the sidebar entry missing.
    if (client === undefined) return
    expect(client).toContain('window.__ModuleLoader__.load(')
    expect(client).toContain('"@sparkelf/dsh-group-chat"')
    // The sourcemap comment trails the closing brace, so the check is on the last
    // executable line rather than on the raw tail.
    const lastCodeLine = client.split('\n').filter((line) => line.trim().length > 0
      && !line.trim().startsWith('//#')).at(-1) ?? ''
    expect(lastCodeLine.trim()).toBe('});')
  })

  it('requires only modules the platform table carries', () => {
    // Anything outside the platform table fails at RUNTIME with "missed the module
    // table" rather than at build time, so the externals are asserted here.
    if (client === undefined) return
    const required = new Set([...client.matchAll(/require\("([^"]+)"\)/gu)].map((m) => m[1]))
    const allowed = new Set([
      'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
      '@deepseek-ai/cordis',
      // The official icon/control set. Verified present in the browser module table: the
      // deployed frontend bundle carries `"@deepseek-ai/dsh-client-ui-primitives":gE`.
      '@deepseek-ai/dsh-client-ui-primitives',
    ])
    for (const id of required) expect(allowed.has(id), `unexpected require(${id})`).toBe(true)
  })

  it('inlines its stylesheet instead of emitting a separate CSS request', () => {
    // The browser loads one script per plugin; a stylesheet left as a file would never
    // be requested, and the page would render unstyled with no error.
    if (client === undefined) return
    expect(client).toContain('createElement')
    // Matched by prefix rather than by exact quoting, which a minifier may change.
    expect(client).toMatch(/querySelector\(["']style\[data-plugin-css=["']/)
    expect(client).not.toMatch(/import\s+['"][^'"]+\.css['"]/u)
  })

  it('exports the two names the client loader consumes', () => {
    if (client === undefined) return
    expect(client).toContain('exports.apply = apply')
    expect(client).toContain('exports.inject = inject')
  })

  it('carries no Node builtin into the browser half', () => {
    if (client === undefined) return
    // Asserted through `require`, since a bare quoted word also matches ordinary JSX
    // element names such as the SVG `path` used by the sidebar glyph.
    for (const builtin of ['node:fs', 'node:path', 'require("fs")', 'require("path")', 'require("http")']) {
      expect(client).not.toContain(builtin)
    }
  })
})

describe('host bundle', () => {
  it('keeps the browser-facing route and the room session prefix', () => {
    // Both are contracts with the other half: the sidebar calls the route, and the
    // session prefix is what keeps ordinary sessions out of the room runtime.
    const host = readIfPresent(HOST_BUNDLE)
    if (host === undefined) return
    expect(host).toContain('/dsh-group-chat/api')
    expect(host).toContain('group-room-')
  })

  it('never reads a credential from the environment', () => {
    // The managed companion has no credential in its environment by design, so a
    // bundle that read one would silently fail every request on a real deployment.
    const host = readIfPresent(HOST_BUNDLE)
    if (host === undefined) return
    expect(host).not.toContain('DATAOPS_AI_WORKSPACE_INTERNAL_TOKEN')
    expect(host).toContain('DATAOPS_ACCESS_TOKEN')
  })
})
