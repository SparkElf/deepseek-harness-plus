import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { ImBotsSection } from './ImBotsSection.tsx'
import { imBotSettingsVisibility } from './visibility.ts'

/** 客户端只用到 slots：设置页是纯 slot 贡献，没有会话/工具依赖。 */
export const inject = ['slots']

/**
 * 注册「IM 机器人」设置页。
 *
 * 先问 DataOps 当前部署/账号有没有 IM 管理能力。旧 backend 没有 capability 路由、
 * 或代理返回 502 时，探测结果是 `available:false`：仍然注册 section，但只显示
 * “IM 管理未启用”的说明，不加载空表也不报错。接口存在而账号无权限时才不注册——普通用户
 * 的设置列表里不会出现这个 section，而不是有而藏起来。
 *
 * 会话结束时由 `ctx.effect` 的清理函数注销；身份切换（门户换账号）会重新加载工作台页面，
 * 因而重新走一次本流程，不需要在页面内轮询权限。
 *
 * @param ctx - DSH 客户端上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    let dispose: (() => void) | undefined
    let cancelled = false
    void imBotSettingsVisibility().then((visibility) => {
      if (cancelled || visibility === 'hidden' || dispose !== undefined) return
      dispose = ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'im-bots',
        order: 26,
        label: () => 'IM 机器人',
      }, ImBotsSection))
    }).catch(() => {
      // 探针本身不可用时宁可不注册入口，也不要把异常抛到客户端运行时。
    })
    return () => {
      cancelled = true
      dispose?.()
      dispose = undefined
    }
  }, 'dataops-im: IM bot settings section')
}