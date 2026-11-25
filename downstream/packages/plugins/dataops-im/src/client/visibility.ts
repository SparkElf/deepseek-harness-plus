/**
 * 「IM 机器人」设置页是否应该出现在界面里。
 *
 * 判断来自 DataOps 后端的 `GET /api/im/capability`：它用当前账号的权限键回答
 * `{ allowed }`，与读写接口用的是同一个权威来源，不在浏览器里复制角色/权限规则。
 * 注册即门控：普通用户的界面里没有这个 section，而不是先出现再隐藏；即使有人绕过，
 * 代理接口照样返回 403。
 *
 * 旧部署（4e97/6fb4 等）没有这条 backend 路由，代理会返回 `{available:false}`。
 * 这时仍注册入口，但只显示“IM 管理未启用”的说明页，不加载空表也不报错。
 */

import { fetchImCapability, type ImCapability } from './api.ts'

/**
 * 询问 DataOps：当前部署是否提供 IM 管理、当前账号能不能管理。
 *
 * 永不 throw：所有失败都由 {@link fetchImCapability} 折成不可用结果。
 *
 * @returns 能力探测结果。
 */
export async function probeImBotSettings(): Promise<ImCapability> {
  return fetchImCapability()
}

/** 设置入口的三种状态：可用、部署未启用、对当前账号隐藏。 */
export type ImBotSettingsVisibility = 'enabled' | 'unavailable' | 'hidden'

/**
 * 设置入口应该怎么处理。
 *
 * - 部署有接口且当前账号有权限 → `enabled`，注册完整管理页；
 * - 部署没有接口（旧 backend / 404 / 502 / 网络错误）→ `unavailable`，注册一个只显示
 *   “IM 管理未启用”的说明页，让用户知道这是部署差异而不是页面坏了；
 * - 接口存在但当前账号没权限 → `hidden`，不注册入口（普通用户看不到）。
 *
 * @returns 入口状态。
 */
export async function imBotSettingsVisibility(): Promise<ImBotSettingsVisibility> {
  const capability = await probeImBotSettings()
  if (!capability.available) return 'unavailable'
  return capability.allowed ? 'enabled' : 'hidden'
}

/**
 * 当前账号是否应该看到可用的「IM 机器人」设置入口。
 *
 * 部署未启用或没有权限都返回 false；需要区分“未启用”与“隐藏”时用
 * {@link imBotSettingsVisibility}。
 *
 * @returns 可管理时为 true。
 */
export async function canSeeImBotSettings(): Promise<boolean> {
  return (await imBotSettingsVisibility()) === 'enabled'
}