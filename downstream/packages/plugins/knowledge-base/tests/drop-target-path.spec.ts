/**
 * 上传目标目录的解析。
 *
 * 这条守护的是一类"看得见但找不到"的缺陷：视图把 `personal/<owner>/<file>` 里的
 * owner 段藏起来（`views.ts` 的注释写明 owner is a user id and is not shown），所以树上
 * 「个人」这一行携带的路径只有 `personal`。把这个路径原样交给写入方，文件就落到
 * `personal/` 根下、与各 owner 目录并列 —— 而视图只挂 `personal/<uid>/`，于是用户
 * 看到进度条说「已完成」，文件夹里却是空的。
 *
 * 用例直接钉住「最终路径必须含 callerId」，以及"没有 callerId 时不得落到 personal 根"。
 */
import { describe, expect, it } from 'vitest'
import { resolveUploadDir } from '../src/client/dropTargetPath.ts'

/** A caller id shaped like the ones DataOps reports. */
const ME = '260afb31-f8d9-44ba-b161-2a9bfe283a79'

describe('a drop on the personal folder lands in the caller\'s own subtree', () => {
  it('adds the caller id to the bucket row itself', () => {
    // 「个人」这一行携带的就是 'personal'；不补 owner 就会写到 personal 根。
    expect(resolveUploadDir('personal', ME)).toBe('personal/' + ME)
  })

  it('adds the caller id to a folder inside it', () => {
    // 展开后在 personal 下看到的子目录，视图里写 `personal/specs`，实际必须是
    // `personal/<uid>/specs`。
    expect(resolveUploadDir('personal/specs', ME)).toBe('personal/' + ME + '/specs')
  })

  it('adds the caller id at any depth', () => {
    expect(resolveUploadDir('personal/specs/2026/q1', ME)).toBe('personal/' + ME + '/specs/2026/q1')
  })

  it('always produces a path that contains the caller id', () => {
    // 这条是 Lead 要求钉住的那句断言，用属性式的写法而不是再抄一遍期望值。
    for (const target of ['personal', 'personal/a', 'personal/a/b/c']) {
      const resolved = resolveUploadDir(target, ME)
      expect(resolved, target + ' 没有解析出 caller 段').toBeDefined()
      expect(resolved).toContain(ME)
      expect(resolved).toMatch(new RegExp('^personal/' + ME + '(/|$)', 'u'))
    }
  })
})

describe('a drop outside the personal bucket is left alone', () => {
  it('does not touch the global bucket', () => {
    // 误加 caller 段会把公共文档写进个人目录，那是另一个方向的破坏。
    expect(resolveUploadDir('global', ME)).toBe('global')
    expect(resolveUploadDir('global/specs', ME)).toBe('global/specs')
  })

  it('does not touch the department bucket', () => {
    expect(resolveUploadDir('department/OPS', ME)).toBe('department/OPS')
    expect(resolveUploadDir('department/OPS/q1', ME)).toBe('department/OPS/q1')
  })

  it('does not touch the mount root', () => {
    // 根目录没有 owner 段可补，空串原样返回。
    expect(resolveUploadDir('', ME)).toBe('')
    expect(resolveUploadDir('   ', ME)).toBe('')
  })
})

describe('a personal target with no caller id is refused, never written bare', () => {
  it('refuses the bucket row', () => {
    // 宁可拒绝也不再写 personal 根：那是"上传成功但用户看不到"的根因，
    // 悄悄放行等于把这个缺陷留回去。
    expect(resolveUploadDir('personal', undefined)).toBeUndefined()
    expect(resolveUploadDir('personal', '')).toBeUndefined()
  })

  it('refuses a folder inside it', () => {
    expect(resolveUploadDir('personal/specs', undefined)).toBeUndefined()
    expect(resolveUploadDir('personal/specs', '')).toBeUndefined()
  })

  it('still resolves the buckets that need no owner', () => {
    // 没有 caller id 不该让整个上传功能失效：其它桶与根照常。
    expect(resolveUploadDir('global/specs', undefined)).toBe('global/specs')
    expect(resolveUploadDir('department/OPS', undefined)).toBe('department/OPS')
    expect(resolveUploadDir('', undefined)).toBe('')
  })
})

describe('separator handling does not change the destination', () => {
  it('normalises backslashes and padding', () => {
    expect(resolveUploadDir('personal\\specs', ME)).toBe('personal/' + ME + '/specs')
    expect(resolveUploadDir('/personal/specs/', ME)).toBe('personal/' + ME + '/specs')
    expect(resolveUploadDir('personal/specs/', ME)).toBe('personal/' + ME + '/specs')
  })

  it('does not mistake a lookalike bucket for the personal one', () => {
    // `personally` 不是 personal 桶；按前缀匹配会把它误改。
    expect(resolveUploadDir('personally', ME)).toBe('personally')
    expect(resolveUploadDir('personally/x', ME)).toBe('personally/x')
  })
})
