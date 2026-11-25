/**
 * Leaving a room: the confirmation, and what a refusal looks like.
 *
 * Leaving is the one room action with a visible consequence the operator cannot undo from the
 * sidebar: the room survives, but only under the "left rooms" filter, and rejoining is a
 * separate discovery step. The old menu entry called the store directly, so a single misclick
 * left the room and a failed request said nothing at all.
 *
 * As with the other client tests here, there is no DOM environment, so the interaction is
 * asserted against the source that implements it and the failure mapping is exercised as a
 * value.
 *
 * @module tests/leave.test
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { failureOf } from '../src/client/store.ts'
import { en, zh } from '../src/client/locales.ts'

const SOURCE = readFileSync(new URL('../src/client/SidebarRooms.tsx', import.meta.url), 'utf8')
const CSS = readFileSync(new URL('../src/client/SidebarRooms.module.css', import.meta.url), 'utf8')

describe('退出群聊二次确认', () => {
  it('菜单项不再直接调用 store.leave', () => {
    // 这正是旧实现的缺陷：右键菜单的一项就是不可撤销的动作，点错即退群。
    expect(SOURCE).not.toMatch(/onClick=\{\(\) => void run\(\(\) => store\.leave/u)
    expect(SOURCE).toMatch(/onClick=\{onRequestLeave\}/u)
  })

  it('确认框使用已有的 menuLeaveConfirm 文案', () => {
    // 这个键早已定义却无人使用，说明确认步骤被漏掉了。
    expect(SOURCE).toContain("t('menuLeaveConfirm')")
    for (const locale of [en, zh]) {
      expect(locale.menuLeaveConfirm.trim().length).toBeGreaterThan(0)
    }
  })

  it('确认后才调用 store.leave', () => {
    const leaveFn = SOURCE.slice(SOURCE.indexOf('const leave = async'), SOURCE.indexOf('return (', SOURCE.indexOf('const leave = async')))
    expect(leaveFn).toContain('await store.leave(room.id)')
    // 确认框的「退出」按钮接的就是这个函数，而不是菜单项。
    expect(SOURCE).toMatch(/onConfirm=\{\(\) => void leave\(\)\}/u)
  })

  it('取消不改变任何状态，也不调用 leave', () => {
    // 取消只是关掉确认框并清掉上一次的错误，不写房间数据。
    const cancel = SOURCE.slice(SOURCE.indexOf('const closeLeave'), SOURCE.indexOf('const leave = async'))
    expect(cancel).toContain('setConfirmingLeave(false)')
    expect(cancel).toContain('setLeaveFailure(undefined)')
    expect(cancel).not.toContain('store.leave')
  })

  it('确认框由房间行持有，不会随右键菜单一起卸载', () => {
    // 点「退出群聊」会先关掉右键菜单；如果确认框挂在菜单里，它会跟着菜单一起消失，
    // 失败信息也就没有地方显示。
    const row = SOURCE.slice(SOURCE.indexOf('function RoomRow'), SOURCE.indexOf('function RoomMenu'))
    expect(row).toContain('<LeaveRoomDialog')
    expect(row).toContain('onRequestLeave={() => { setMenuAnchor(null); setConfirmingLeave(true) }}')
  })

  it('取消是初始焦点，破坏性动作不是', () => {
    expect(SOURCE).toMatch(/data-modal-autofocus[\s\S]{0,200}onClick=\{onCancel\}/u)
  })

  it('确认框点名要退出哪个房间', () => {
    // 打开确认框时右键菜单已经关闭，菜单里那一行不在了；只写「退出这个群聊？」会让人猜。
    expect(SOURCE).toContain('{room.name}')
    expect(CSS).toContain('.leaveRoomName')
  })

  it('确认框提供取消与退出两个动作，各自本地化', () => {
    expect(SOURCE).toContain("t('cancel')")
    expect(SOURCE).toContain("t('menuLeave')")
  })
})

describe('退出失败必须可见', () => {
  it('失败时把 failureOf 的映射留在弹窗里', () => {
    expect(SOURCE).toContain('setLeaveFailure(failureOf(cause))')
    expect(SOURCE).toContain('{t(failure)}')
  })

  it('失败不关闭弹窗，因为此时仍然是成员', () => {
    const leaveFn = SOURCE.slice(SOURCE.indexOf('const leave = async'), SOURCE.indexOf('return (', SOURCE.indexOf('const leave = async')))
    // 只有成功路径关闭确认框。
    expect(leaveFn).toMatch(/await store\.leave\(room\.id\)\s*setConfirmingLeave\(false\)/u)
    expect(leaveFn).not.toMatch(/catch[\s\S]{0,200}setConfirmingLeave\(false\)/u)
  })

  it('错误区域对辅助技术即时播报', () => {
    expect(SOURCE).toContain('role="alert"')
  })

  it('错误用错误色，与普通说明区分', () => {
    const rule = CSS.slice(CSS.indexOf('.leaveError'), CSS.indexOf('}', CSS.indexOf('.leaveError')))
    expect(rule).toContain('var(--dsw-alias-state-error-primary')
  })

  it('每一种可区分的失败都有对应文案，不统一说「出错了」', () => {
    expect(failureOf(new Error('credentialMissing'))).toBe('credentialMissing')
    expect(failureOf(new Error('credentialRejected'))).toBe('credentialRejected')
    expect(failureOf(new Error('notConfigured'))).toBe('notConfigured')
    expect(failureOf(new Error('whatever'))).toBe('unreachable')
    for (const key of ['credentialMissing', 'credentialRejected', 'notConfigured', 'unreachable'] as const) {
      expect(en[key].trim().length).toBeGreaterThan(0)
      expect(zh[key].trim().length).toBeGreaterThan(0)
    }
  })

  it('失败后重开确认框时先清掉上一次的错误', () => {
    // 否则一次失败会让之后每次打开确认框都带着旧错误。
    expect(SOURCE).toContain('setLeaveFailure(undefined)')
  })

  it('请求进行中时按钮禁用，不会重复提交', () => {
    expect(SOURCE).toMatch(/busy=\{leaving\}/u)
    expect(SOURCE).toMatch(/disabled=\{busy\}/u)
  })
})
