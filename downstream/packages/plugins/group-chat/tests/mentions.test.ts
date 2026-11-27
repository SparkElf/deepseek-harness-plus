import { describe, expect, it } from 'vitest'
import { mentionedMemberIds, textOfContent } from '../src/routing.ts'
import type { RoomMember } from '../src/backend.ts'

/**
 * `@显示名` 解析成结构化 mentions。
 *
 * composer 自己的 @ 菜单只列文件和会话，列不了房间成员（那一层是封闭实现，插件加不进
 * 分类）。所以成员用人们本来就会的写法寻址：`@显示名`，由宿主侧解析成房间服务端存储的
 * `mentions`，也就是回复策略实际读的字段。
 */
const member = (userId: string, displayName: string): RoomMember => ({
  userId,
  displayName,
  avatarUrl: null,
  role: 'member',
} as unknown as RoomMember)

const ROSTER: readonly RoomMember[] = [
  member('u-admin', 'DataOps Admin'),
  member('u-operator', 'DataOps Operator'),
]

describe('mentionedMemberIds', () => {
  it('解析出文本里 @ 的成员', () => {
    expect(mentionedMemberIds('@DataOps Admin 请看这个', ROSTER)).toEqual(['u-admin'])
  })

  it('没有 @ 就没有 mentions', () => {
    expect(mentionedMemberIds('普通消息', ROSTER)).toEqual([])
  })

  it('多个成员按出现顺序返回', () => {
    expect(mentionedMemberIds('@DataOps Operator 和 @DataOps Admin', ROSTER))
      .toEqual(['u-operator', 'u-admin'])
  })

  it('同一个成员只出现一次', () => {
    expect(mentionedMemberIds('@DataOps Admin 然后 @DataOps Admin 又说', ROSTER))
      .toEqual(['u-admin'])
  })

  it('名字是另一个名字的前缀时，长的优先，不会认错人', () => {
    // `@张三` 是 `@张三丰` 的前缀。按长名先匹配，否则短名会先吃掉长名的一部分。
    const roster = [member('u-zhang3', '张三'), member('u-zhang3f', '张三丰')]
    expect(mentionedMemberIds('@张三丰 你好', roster)).toEqual(['u-zhang3f'])
  })

  it('匹配不到的 @ 不猜，返回空', () => {
    // 打错字不该召唤错的人。
    expect(mentionedMemberIds('@DataOps Admn 你好', ROSTER)).toEqual([])
  })

  it('空文本与空名单都是空结果', () => {
    expect(mentionedMemberIds('', ROSTER)).toEqual([])
    expect(mentionedMemberIds('@DataOps Admin', [])).toEqual([])
  })

  it('显示名前后空白不影响匹配', () => {
    expect(mentionedMemberIds('@DataOps Admin 看', [member('u1', '  DataOps Admin  ')])).toEqual(['u1'])
  })
})

describe('textOfContent', () => {
  it('拼出文本块，忽略图片块', () => {
    expect(textOfContent([
      { type: 'text', text: '看这张图 ' },
      { type: 'image', attachment: { name: 'a.png' } },
      { type: 'text', text: '@DataOps Admin' },
    ])).toBe('看这张图 @DataOps Admin')
  })

  it('非数组返回空串', () => {
    expect(textOfContent('纯字符串')).toBe('')
    expect(textOfContent(undefined)).toBe('')
  })
})
