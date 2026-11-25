import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { clampSidebarHeight, readPreferences, writePreferences, SIDEBAR_HEIGHT_MIN, SIDEBAR_HEIGHT_MAX } from '../src/index.ts'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 群聊区域的高度可以拖动调节，并且存进用户自己的工作区卷。
 *
 * 存文件而不是数据库：工作区卷本来就是按用户隔离的，重新登录、换浏览器都还在；
 * 为一个面板的高度加一张表、一套模型和一次迁移不划算。
 */
describe('高度边界', () => {
  it('低于下限被抬到下限', () => {
    expect(clampSidebarHeight(10)).toBe(SIDEBAR_HEIGHT_MIN)
  })

  it('高于上限被压到上限', () => {
    expect(clampSidebarHeight(99999)).toBe(SIDEBAR_HEIGHT_MAX)
  })

  it('范围内的值取整保留', () => {
    expect(clampSidebarHeight(320.6)).toBe(321)
  })
})

describe('偏好文件读写', () => {
  const envFor = (home: string): Record<string, string> => ({ DATAOPS_DSH_HOME: home })

  it('没有文件时读成空偏好', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gc-prefs-'))
    try {
      expect(await readPreferences(envFor(dir))).toEqual({})
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('写入后能读回来', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gc-prefs-'))
    try {
      await writePreferences({ sidebarHeightPx: 360 }, envFor(dir))
      expect(await readPreferences(envFor(dir))).toEqual({ sidebarHeightPx: 360 })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('写入时把越界值夹到范围内', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gc-prefs-'))
    try {
      await writePreferences({ sidebarHeightPx: 5 }, envFor(dir))
      expect(await readPreferences(envFor(dir))).toEqual({ sidebarHeightPx: SIDEBAR_HEIGHT_MIN })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('损坏的文件读成空偏好而不是抛错', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gc-prefs-'))
    try {
      const path = join(dir, 'group-chat', 'preferences.json')
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(dir, 'group-chat'), { recursive: true })
      await (await import('node:fs/promises')).writeFile(path, '{ not json', 'utf8')
      expect(await readPreferences(envFor(dir))).toEqual({})
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('写出的文件是带缩进的 JSON，便于人读', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gc-prefs-'))
    try {
      await writePreferences({ sidebarHeightPx: 300 }, envFor(dir))
      const raw = await readFile(join(dir, 'group-chat', 'preferences.json'), 'utf8')
      expect(raw).toContain('\n')
      expect(JSON.parse(raw)).toEqual({ sidebarHeightPx: 300 })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

describe('拖动交互', () => {
  it('抓手只在悬停或聚焦时显示，默认隐藏', () => {
    const css = readFileSync(new URL('../src/client/SidebarRooms.module.css', import.meta.url), 'utf8')
    // `opacity: 0` 是默认，悬停/聚焦才置 1：常驻的抓手会白占一行列表高度。
    expect(css).toMatch(/\.resizer::after[\s\S]{0,200}opacity:\s*0/)
    expect(css).toContain('.root:hover .resizer::after')
    expect(css).toContain('.resizer:focus-visible::after')
  })

  it('拖动手柄在上边缘，光标为 row-resize', () => {
    const css = readFileSync(new URL('../src/client/SidebarRooms.module.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.resizer\s*\{[\s\S]{0,300}cursor:\s*row-resize/)
  })

  it('向上拖动使区域变高', () => {
    const src = readFileSync(new URL('../src/client/SidebarRooms.tsx', import.meta.url), 'utf8')
    // 抓手在区域上方，所以 delta 取反：向上（y 变小）变高，和右侧边栏拖左变宽同向。
    expect(src).toContain('start.height + (start.y - move.clientY)')
  })
})

/**
 * 默认就是最小高度。
 *
 * 早先没拖过时按内容自适应到 `46vh`，1080p 下约 437px：群聊区域看起来像主区域，
 * 把工作区列表挤到侧栏上半截。默认应当只是「能看到几个房间」的高度。
 */
describe('默认高度', () => {
  it('没保存过高度时用最小值，而不是内容自适应', () => {
    const src = readFileSync(new URL('../src/client/SidebarRooms.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/draggingPx \?\? heightPx \?\? HEIGHT_MIN/)
  })

  it('高度总是显式设置（不再回落到样式表的 46vh）', () => {
    const src = readFileSync(new URL('../src/client/SidebarRooms.tsx', import.meta.url), 'utf8')
    // 旧写法是「undefined 时不给 style」，正是它让区域按内容撑到 46vh。
    expect(src).not.toContain('? undefined\n        : { height:')
    expect(src).toContain('maxHeight: \'none\'')
  })
})
