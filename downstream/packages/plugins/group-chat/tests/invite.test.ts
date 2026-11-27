/**
 * The invite dialog: who is selected, and the surfaces that show it.
 *
 * Two kinds of assertion live here. The selection rules are imported from `rows.ts` and
 * exercised as values, because they are the part that goes wrong silently — a narrowed
 * search must not drop people already picked, and a second press must deselect rather than
 * duplicate. The rest is a contract on the dialog's source and stylesheet: there is no DOM
 * environment in this repository, so the properties that make the dialog usable — a bounded
 * scrolling list, whole rows, a visible selection mark, a count on the submit button, and a
 * statement for each of loading / empty / error — are asserted where they are written.
 *
 * @module tests/invite.test
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { filterCandidates, isChosen, toggleChosen } from '../src/client/rows.ts'
import type { InviteCandidate } from '../src/client/api.ts'

const person = (userId: string, displayName = userId): InviteCandidate => ({
  userId,
  displayName,
  username: userId,
})

const DIALOG = readFileSync(new URL('../src/client/RoomDialogs.tsx', import.meta.url), 'utf8')
const CSS = readFileSync(new URL('../src/client/InviteDialog.module.css', import.meta.url), 'utf8')

/** Read every declaration block one selector owns, joined. */
const ruleOf = (selector: string): string => {
  const pattern = new RegExp(`\\.${selector}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, 'gu')
  const blocks = [...CSS.matchAll(pattern)].map((match) => match[1])
  if (blocks.length === 0) throw new Error(`no rule for .${selector}`)
  return blocks.join(' ').replace(/\s+/gu, ' ')
}

describe('邀请多选', () => {
  it('点击候选加入选中集合', () => {
    expect(toggleChosen([], person('a')).map((member) => member.userId)).toEqual(['a'])
  })

  it('可以连续选多个人，并保持选择顺序', () => {
    // Order is the operator's own: the chips read back in the order they were picked.
    const chosen = toggleChosen(toggleChosen([], person('a')), person('b'))
    expect(chosen.map((member) => member.userId)).toEqual(['a', 'b'])
  })

  it('再点一次同一个人就取消，而不是重复加入', () => {
    const once = toggleChosen([], person('a'))
    expect(toggleChosen(once, person('a'))).toEqual([])
  })

  it('取消中间一个不影响其他人', () => {
    const chosen = [person('a'), person('b'), person('c')]
    expect(toggleChosen(chosen, person('b')).map((member) => member.userId)).toEqual(['a', 'c'])
  })

  it('重复加入同一个人不会产生两行', () => {
    // 选中态按 userId 判定，所以同一个账号即使在两批搜索结果里都出现，也只有一个 chip。
    const chosen = [person('a')]
    expect(toggleChosen(chosen, { ...person('a'), displayName: '另一个名字' })).toEqual([])
  })

  it('选中判定只认 userId，不认显示名', () => {
    expect(isChosen([person('a')], 'a')).toBe(true)
    expect(isChosen([person('a')], 'b')).toBe(false)
    expect(isChosen([], 'a')).toBe(false)
  })

  it('选中集合独立于搜索结果，查询变化不会丢失已选的人', () => {
    // 这是本次改版的核心风险：服务端搜索只返回匹配项，把选中态挂在结果行上会让
    // 「先选张三、再搜李四」把张三悄悄丢掉。选中行整条存起来，就与结果列表无关。
    const chosen = toggleChosen([], person('zhang', '张三'))
    const narrowed = [person('li', '李四')]
    expect(narrowed.some((row) => isChosen(chosen, row.userId))).toBe(false)
    expect(isChosen(chosen, 'zhang')).toBe(true)
  })
})

describe('候选列表本地即时收窄', () => {
  const rows = [
    person('u1', 'DataOps Admin'),
    { userId: 'u2', displayName: '张三', username: 'zhangsan' },
    person('u3', 'Font Check'),
  ]

  it('按姓名过滤，忽略大小写', () => {
    expect(filterCandidates(rows, 'admin').map((row) => row.userId)).toEqual(['u1'])
    expect(filterCandidates(rows, 'ADMIN').map((row) => row.userId)).toEqual(['u1'])
  })

  it('也按账号过滤，因为同事常被记住的是账号名', () => {
    expect(filterCandidates(rows, 'zhangsan').map((row) => row.userId)).toEqual(['u2'])
  })

  it('空查询返回全部，这是对话框刚打开时列表有内容的依据', () => {
    expect(filterCandidates(rows, '')).toHaveLength(3)
    expect(filterCandidates(rows, '   ')).toHaveLength(3)
  })

  it('没有匹配时返回空数组，而不是回退成全部', () => {
    // 回退成全部会让一次拼错看起来像搜索成功。
    expect(filterCandidates(rows, 'zzz')).toEqual([])
  })

  it('保持服务端返回的顺序', () => {
    const ordered = [person('c', 'Charlie'), person('a', 'Alice'), person('b', 'Bob')]
    expect(filterCandidates(ordered, '').map((row) => row.userId)).toEqual(['c', 'a', 'b'])
  })
})

describe('邀请弹窗尺寸与滚动', () => {
  it('比共享弹窗更宽，但窄窗口下仍让位', () => {
    // 共享 Modal 固定 width: min(380px, 100%)；候选人一行要放头像、姓名、账号和对勾。
    // 重复类名是为了在同等特异性下压过官方的 .dialog（MessageSide.module.css 同一手法）。
    expect(DIALOG).toContain('className={invite.dialog}')
    expect(ruleOf('dialog')).toContain('width: min(760px, 100%)')
  })

  it('弹窗高度不超过遮罩的可用区域', () => {
    expect(ruleOf('dialog')).toContain('max-height: 100%')
  })

  it('候选列表有优雅的最大高度并在内部滚动', () => {
    // 列表自己滚动而不是把行挤扁：出现滚动条时行仍然是完整的。
    const list = ruleOf('list')
    expect(list).toMatch(/max-height: min\(46vh, 420px\)/u)
    expect(list).toContain('overflow-y: auto')
    expect(list).toContain('scrollbar-gutter: stable')
  })

  it('候选行按内容撑高，不写死高度', () => {
    // 写死 height 正是「有一行只露出一半」的来源；min-height 让行至少可点，内容多则变高。
    for (const selector of ['row', 'rowSelected']) {
      expect(ruleOf(selector)).toContain('min-height: 38px')
      expect(ruleOf(selector)).not.toMatch(/(?:^|[; ])height:/u)
    }
  })

  it('窄窗口或矮窗口时整个对话框可滚动，页脚不会跑到屏幕外', () => {
    expect(ruleOf('content')).toContain('overflow-y: auto')
    expect(ruleOf('content')).toContain('min-height: 0')
  })
})

describe('邀请弹窗的无障碍与状态', () => {
  it('候选项是可访问的按钮，并用 aria-pressed 表达选中态', () => {
    // 原生 button 自带 Tab 可达、Enter/Space 触发；aria-pressed 让读屏器读出选中与否。
    expect(DIALOG).toMatch(/data-candidate[\s\S]{0,220}aria-pressed=\{selected\}/u)
    expect(DIALOG).toContain('<button')
  })

  it('选中态有对勾，不只靠颜色', () => {
    expect(DIALOG).toContain('IconCheckOutlineRegular')
    expect(DIALOG).toMatch(/selected \? invite\.check : invite\.checkHidden/u)
    // 对勾占位保留，选中时行内元素不位移。
    expect(ruleOf('checkHidden')).toContain('visibility: hidden')
  })

  it('选中时有可见的选中样式', () => {
    const selected = ruleOf('rowSelected')
    expect(selected).toContain('border-color: var(--dsw-alias-state-business-primary)')
    expect(selected).toContain('background: var(--dsw-alias-interactive-bg-active)')
  })

  it('键盘可用箭头逐个走候选行', () => {
    expect(DIALOG).toContain("event.key !== 'ArrowDown' && event.key !== 'ArrowUp'")
    expect(DIALOG).toContain("listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-candidate]')")
    expect(DIALOG).toContain('rows[next]?.focus()')
  })

  it('搜索框有本地化标签，并作为初始焦点', () => {
    expect(DIALOG).toContain("aria-label={t('inviteSearchLabel')}")
    expect(DIALOG).toContain('data-modal-autofocus')
    // 官方 Modal 建议用 data-modal-autofocus 而不是 autoFocus，否则打开弹窗时会丢返回焦点。
    expect(DIALOG).not.toContain('autoFocus')
  })

  it('底部按钮显示已选数量', () => {
    expect(DIALOG).toContain("t('inviteSubmitCount').replace('{count}', String(chosen.length))")
    expect(DIALOG).toMatch(/disabled=\{busy \|\| chosen\.length === 0\}/u)
  })

  it('已选数量对读屏器可感知', () => {
    expect(DIALOG).toContain('role="status"')
    expect(DIALOG).toContain("t('inviteSelectedCount').replace('{count}', String(chosen.length))")
  })
})

describe('邀请弹窗的加载、空结果与错误状态', () => {
  it('加载中有提示和旋转指示', () => {
    expect(DIALOG).toContain("t('inviteSearching')")
    // 加载态以本地收窄后的行数为准：查询变化后旧结果还在，但列表已经先按新词收窄了。
    expect(DIALOG).toMatch(/searching && visible\.length === 0/u)
    expect(DIALOG).toContain('IconLoadingOutlineRegular')
    expect(ruleOf('spinner')).toContain('animation: inviteSpin')
  })

  it('搜索无结果时说明原因，而不是留空白面板', () => {
    expect(DIALOG).toContain("t('inviteEmpty')")
  })

  it('搜索失败时显示原因并提供重试', () => {
    expect(DIALOG).toContain("t('retry')")
    expect(DIALOG).toContain('setAttempt((current) => current + 1)')
    // 重试要真的重新发一次请求：query 可能没变，所以 attempt 是 effect 的依赖。
    expect(DIALOG).toMatch(/\}, \[roomId, query, attempt\]\)/u)
  })

  it('邀请失败时错误留在弹窗里，不静默关闭', () => {
    expect(DIALOG).toContain("t(submitError)")
    expect(DIALOG).toContain('setSubmitError(failureOf(cause))')
    // 失败不能把已选的人清掉，否则重试时得重新选一遍。
    expect(DIALOG).toMatch(/catch \(cause\) \{\s*setSubmitError/u)
  })

  it('搜索结果只在请求仍有效时落地', () => {
    // 快速输入会产生多个请求，过期响应不能覆盖新结果。
    expect(DIALOG).toContain('let cancelled = false')
    expect(DIALOG).toContain('if (!cancelled)')
  })
})

describe('邀请弹窗保留搜索行为', () => {
  it('按姓名或账号由服务端搜索，并做防抖', () => {
    expect(DIALOG).toContain('searchInviteCandidates(roomId, query)')
    expect(DIALOG).toMatch(/setTimeout\([\s\S]{0,1200}220/u)
  })

  it('本地先收窄一次，服务端答案到达前列表就有反应', () => {
    // 服务端搜索有一个防抖的时间差；只等它会让输入看起来没反应。
    expect(DIALOG).toContain('filterCandidates(candidates, query)')
    expect(DIALOG).toContain('{visible.map((candidate) => {')
  })

  it('空查询也发起请求，列表在输入前就有内容', () => {
    expect(DIALOG).toContain("if (query.length === 0) setAttempt((current) => current + 1)")
    expect(DIALOG).toContain("else setQuery('')")
  })

  it('邀请成功后重新读候选，已加入的人从列表消失', () => {
    expect(DIALOG).toContain('await store.refresh()')
    expect(DIALOG).toContain('setChosen([])')
    expect(DIALOG).toContain("t('saved')")
  })
})
