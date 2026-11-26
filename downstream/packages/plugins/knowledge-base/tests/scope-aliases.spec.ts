import { describe, expect, it } from 'vitest'
import { localizedScopeForPath, resolveScopeAlias, scopeAliasFor, scopeFromAlias } from '../src/scopeAliases.ts'
import { assertToolPath } from '../src/knowledgeTools.ts'
import { readKnowledgeFile } from '../src/index.ts'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('scope aliases', () => {
  it('accepts Chinese and English virtual bucket names while canonicalizing', () => {
    expect(resolveScopeAlias('全局/制度.md')).toBe('global/制度.md')
    expect(resolveScopeAlias('部门/OPS/a.md')).toBe('department/OPS/a.md')
    expect(resolveScopeAlias('个人/u1/a.md')).toBe('personal/u1/a.md')
    expect(resolveScopeAlias('Global/a.md')).toBe('global/a.md')
    expect(resolveScopeAlias('Department/OPS/a.md')).toBe('department/OPS/a.md')
    expect(resolveScopeAlias('Personal/u1/a.md')).toBe('personal/u1/a.md')
    expect(resolveScopeAlias('custom/a.md')).toBe('custom/a.md')
  })

  it('localizes canonical paths for zh/en display', () => {
    expect(localizedScopeForPath('global/a.md', 'zh')).toBe('全局/a.md')
    expect(localizedScopeForPath('department/OPS/a.md', 'zh')).toBe('部门/OPS/a.md')
    expect(localizedScopeForPath('personal/u1/a.md', 'en')).toBe('Personal/u1/a.md')
    expect(scopeAliasFor('global', 'en')).toBe('Global')
    expect(scopeFromAlias('部门')).toBe('department')
  })

  it('canonicalizes model tool paths before checks', () => {
    expect(assertToolPath('全局/a.md')).toBe('global/a.md')
    expect(assertToolPath('部门/OPS/a.md')).toBe('department/OPS/a.md')
    expect(() => assertToolPath('../全局/a.md')).toThrow()
  })
})


describe('scope aliases at the read boundary', () => {
  it('reads a localized bucket path through the canonical mount', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-alias-'))
    try {
      await mkdir(join(root, 'global'), { recursive: true })
      await writeFile(join(root, 'global/a.md'), 'aliased content')
      const config = { baseUrl: '', credentialRef: '', timeoutMs: 1000, mountPoint: root, storageMode: 'local', actualRoot: root, viewRoot: root } as never
      await expect(readKnowledgeFile({} as never, config, '全局/a.md'))
        .resolves.toMatchObject({ kind: 'text', content: 'aliased content' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
