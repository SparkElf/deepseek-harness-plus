import { describe, expect, it } from 'vitest'
import { nextEnabledOption } from '../src/client/Select.tsx'
import {
  advancedErrors, canTestHost, credentialErrors, fingerprintOf, formatBytes, identityErrors,
  joinedPath, parentPath, pathBreadcrumbs, recentHosts,
} from '../src/client/model.ts'
import type { SshHost } from '../src/types.ts'

function host(patch: Partial<SshHost> = {}): SshHost {
  return {
    id: 'h1', name: 'db', description: '', tags: [], clusterId: null, environment: 'development',
    hostname: '10.0.0.5', port: 22, username: 'root', authKind: 'password', credentialId: null,
    credentialConfigured: false, jumpHostId: null, knownHostFingerprint: null, keepAliveSeconds: 30,
    defaultDirectory: '', ...patch,
  }
}

describe('SSH Manager select navigation', () => {
  const options = [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Bravo', disabled: true },
    { value: 'c', label: 'Charlie' },
  ]

  it('wraps and skips disabled options in both directions', () => {
    expect(nextEnabledOption(options, 0, 1)).toBe(2)
    expect(nextEnabledOption(options, 2, 1)).toBe(0)
    expect(nextEnabledOption(options, 0, -1)).toBe(2)
  })

  it('returns no active option when every option is disabled', () => {
    expect(nextEnabledOption([{ value: 'a', label: 'Alpha', disabled: true }], 0, 1)).toBe(-1)
  })
})

describe('SSH Manager SFTP view model', () => {
  it('builds navigable absolute and relative breadcrumbs', () => {
    expect(pathBreadcrumbs('/var/log')).toEqual([
      { label: 'Root', path: '/' },
      { label: 'var', path: '/var' },
      { label: 'log', path: '/var/log' },
    ])
    expect(pathBreadcrumbs('projects/app/')).toEqual([
      { label: 'Home', path: '.' },
      { label: 'projects', path: 'projects' },
      { label: 'app', path: 'projects/app' },
    ])
  })

  it('keeps path traversal and file joining stable at roots', () => {
    expect(parentPath('/var/log')).toBe('/var')
    expect(parentPath('/var')).toBe('/')
    expect(parentPath('projects')).toBe('.')
    expect(joinedPath('/', 'readme.md')).toBe('/readme.md')
    expect(joinedPath('.', 'readme.md')).toBe('readme.md')
  })

  it('formats file sizes across table units', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB')
  })
})


describe('SSH Manager connection wizard validation', () => {
  it('requires name, host, port, and user on the identity step', () => {
    expect(identityErrors(host({ name: ' ', hostname: '', port: 0, username: '' }))).toEqual({ name: true, hostname: true, port: true, username: true })
    expect(identityErrors(host())).toEqual({})
    expect(identityErrors(host({ port: 65536 })).port).toBe(true)
    expect(canTestHost(host())).toBe(true)
    expect(canTestHost(host({ hostname: '' }))).toBe(false)
  })

  it('lets an existing credential stand in for an empty secret field', () => {
    expect(credentialErrors(host(), {}, false)).toEqual({ credential: true })
    expect(credentialErrors(host(), { password: 'secret' }, false)).toEqual({})
    expect(credentialErrors(host(), {}, true)).toEqual({})
    expect(credentialErrors(host({ authKind: 'private-key' }), { privateKey: '  ' }, false)).toEqual({ credential: true })
    expect(credentialErrors(host({ authKind: 'private-key' }), { privateKey: '-----BEGIN' }, false)).toEqual({})
    expect(credentialErrors(host({ authKind: 'agent' }), {}, false)).toEqual({})
  })

  it('rejects a jump host that is missing or the host itself', () => {
    expect(advancedErrors(host({ jumpHostId: 'h1' }), [host()])).toEqual({ jumpHost: true })
    expect(advancedErrors(host({ jumpHostId: 'missing' }), [host()])).toEqual({ jumpHost: true })
    expect(advancedErrors(host({ jumpHostId: 'h2' }), [host(), host({ id: 'h2' })])).toEqual({})
    expect(advancedErrors(host({ jumpHostId: null }), [host()])).toEqual({})
  })

  it('trims a stored fingerprint for display', () => {
    expect(fingerprintOf(host({ knownHostFingerprint: '  SHA256:abc  ' }))).toBe('SHA256:abc')
    expect(fingerprintOf(host({ knownHostFingerprint: null }))).toBe('')
  })
})

describe('SSH Manager recent hosts', () => {
  it('orders by last opened time, skips never-opened hosts, and honours the limit', () => {
    const hosts = [host({ id: 'a', name: 'Alpha' }), host({ id: 'b', name: 'Bravo' }), host({ id: 'c', name: 'Charlie' })]
    const usage = { a: { openedAt: 100 }, b: { openedAt: 300 }, c: { openedAt: 200 } }
    expect(recentHosts(hosts, usage, 2).map(item => item.id)).toEqual(['b', 'c'])
    expect(recentHosts(hosts, {}, 5)).toEqual([])
  })
})
