import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import type { ReviewApi } from './review-api.ts'
import { OPEN_OBJECT_SCHEMA, renderJson, type Json } from './tool-output.ts'
import { isSuperAdmin, type DataOpsScope } from './tool-scope.ts'
import type { AiManagedTool } from './tools.ts'

/**
 * 超管代维工作区（`admin-workspace-*`）。
 *
 * 只注册给超级管理员（`AI_TOOL_ACCESS` 里都是 `superAdminOnly`），每次调用还会再校验一次
 * scope —— 工具注册只是可见性，真正的闸门在服务端和这里的二次判定。
 *
 * **私钥红线**：`tunnel_open` 拿到的私钥**不返回正文**，而是写进工作区里的 0600 一次性文件，
 * 工具只返回文件路径与 `ssh -i` 命令。私钥因此不会进对话、日志或审计；`revoke` 与到期清理
 * 负责删文件与目录。
 */

/** 工作区根目录（容器内是挂载卷；本机调试可用环境变量覆盖）。 */
const workspaceRoot = (): string => process.env.DATAOPS_WORKSPACE_ROOT?.trim() || '/workspace'

/** 隧道私钥目录：`<workspace>/.dataops/admin-tunnels/<workspaceId>/`。 */
const tunnelDirectory = (workspaceId: string): string =>
  join(workspaceRoot(), '.dataops', 'admin-tunnels', workspaceId)

/** 私钥文件路径。 */
const tunnelKeyPath = (workspaceId: string): string => join(tunnelDirectory(workspaceId), 'id_ed25519')

/** 从 workspace 列表响应里找目标用户的 workspace id。 */
const findWorkspaceId = (body: unknown, userId: string): string | null => {
  const rows = Array.isArray(body)
    ? body
    : typeof body === 'object' && body !== null && Array.isArray((body as { workspaces?: unknown }).workspaces)
      ? (body as { workspaces: unknown[] }).workspaces
      : []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const entry = row as { id?: unknown; userId?: unknown; ownerUserId?: unknown }
    if (entry.userId === userId || entry.ownerUserId === userId) {
      if (typeof entry.id === 'string' && entry.id !== '') return entry.id
    }
  }
  return null
}

/** 统一处理 DataOps 响应：401/403/409 给可读错误，其它非 2xx 带状态码抛出。 */
const call = async (reviewApi: ReviewApi, path: string, init: RequestInit = {}): Promise<unknown> => {
  const result = await reviewApi.request(path, init)
  const detail = (result.body as { error?: unknown; message?: unknown } | null)
  const reason = typeof detail?.error === 'string' ? detail.error : typeof detail?.message === 'string' ? detail.message : ''
  if (result.status === 401) throw new Error('Unauthorized (401): DataOps 会话已过期，请重新登录')
  if (result.status === 403) throw new Error('Forbidden (403): ' + (reason || '只有超级管理员可以代维工作区'))
  if (result.status === 404) throw new Error('Not Found (404): ' + (reason || path + ' 不存在（目标工作区或路由缺失）'))
  if (result.status < 200 || result.status >= 300) {
    throw new Error('DataOps ' + path + ' failed: HTTP ' + result.status.toString() + (reason ? ': ' + reason : ''))
  }
  return result.body
}

/**
 * 构造三个超管代维工具。
 *
 * @param reviewApi - 同源桥（携带工作区 JWT）。
 * @param readScope - 当前 scope 的实时读取器；调用时再判一次超管。
 */
export function buildAdminWorkspaceTools(
  reviewApi: ReviewApi,
  readScope: () => DataOpsScope | undefined,
): AiManagedTool[] {
  const assertSuperAdmin = (tool: string): void => {
    const scope = readScope()
    if (scope === undefined || !isSuperAdmin(scope)) {
      throw new Error('Forbidden (403): ' + tool + ' 仅超级管理员可用')
    }
  }

  /** 解析目标用户的 workspace id：优先新列表接口，退回旧的 userId 重启接口。 */
  const resolveWorkspaceId = async (userId: string): Promise<string | null> => {
    try {
      const body = await call(reviewApi, '/api/ai/workspaces')
      return findWorkspaceId(body, userId)
    } catch (error) {
      if (error instanceof Error && /\(404\)/.test(error.message)) return null
      throw error
    }
  }

  const restart: AiManagedTool = {
    name: 'admin_workspace_restart',
    definition: defineTool({
      name: 'admin_workspace_restart',
      description: 'Restart one managed DSH workspace by owner userId. Super administrators only; audited by DataOps. Use after the tunnel-based repair, or when the user reports the workspace is stuck.',
      parameters: {
        user_id: { type: 'string', required: true, description: 'Owner userId of the target workspace (never guess it from a display name).' },
      },
      output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
      execute: async (args: { user_id: string }) => {
        assertSuperAdmin('admin_workspace_restart')
        const userId = String(args.user_id)
        const workspaceId = await resolveWorkspaceId(userId)
        const body = workspaceId === null
          // 旧接口：按 userId 重启（当前线上后端就有）。
          ? await call(reviewApi, '/api/ai/workspace/restart?userId=' + encodeURIComponent(userId), { method: 'POST' })
          : await call(reviewApi, '/api/ai/workspaces/' + encodeURIComponent(workspaceId) + '/restart', { method: 'POST' })
        return { userId, workspaceId, result: (body ?? {}) as Json }
      },
    }),
  }

  const open: AiManagedTool = {
    name: 'admin_workspace_tunnel_open',
    definition: defineTool({
      name: 'admin_workspace_tunnel_open',
      description: 'Open a temporary SSH tunnel into one user\'s workspace (24h, server-side expiry). Super administrators only; audited. The private key is NOT returned in the conversation: it is written once to a 0600 file under .dataops/admin-tunnels/<workspaceId>/, and this tool returns that path plus the ssh -i command. Revoke when done.',
      parameters: {
        user_id: { type: 'string', required: true, description: 'Owner userId of the target workspace.' },
      },
      output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
      execute: async (args: { user_id: string }) => {
        assertSuperAdmin('admin_workspace_tunnel_open')
        const userId = String(args.user_id)
        const workspaceId = await resolveWorkspaceId(userId)
        if (workspaceId === null) throw new Error('目标用户没有可代维的工作区（workspaces 列表里找不到 userId=' + userId + '）')
        const body = await call(reviewApi, '/api/ai/workspaces/' + encodeURIComponent(workspaceId) + '/tunnel', { method: 'POST' })
        const tunnel = (body ?? {}) as { privateKey?: unknown; targetHost?: unknown; port?: unknown; expiresAt?: unknown }
        const privateKey = typeof tunnel.privateKey === 'string' ? tunnel.privateKey : ''
        if (privateKey === '') throw new Error('开通隧道的响应里没有 privateKey，无法建立一次性凭据')
        const directory = tunnelDirectory(workspaceId)
        await mkdir(directory, { recursive: true, mode: 0o700 })
        await chmod(directory, 0o700)
        const keyPath = tunnelKeyPath(workspaceId)
        await writeFile(keyPath, privateKey, { mode: 0o600 })
        await chmod(keyPath, 0o600)
        const host = typeof tunnel.targetHost === 'string' ? tunnel.targetHost : '127.0.0.1'
        const port = typeof tunnel.port === 'number' ? tunnel.port : 22
        return {
          userId,
          workspaceId,
          keyPath,
          sshCommand: 'ssh -i ' + keyPath + ' -p ' + String(port) + ' root@' + host,
          targetHost: host,
          port,
          expiresAt: typeof tunnel.expiresAt === 'string' ? tunnel.expiresAt : null,
          note: '私钥只写在上面这个 0600 文件里，不要把它贴进对话；用完调用 admin_workspace_tunnel_revoke 删除。',
        }
      },
    }),
  }

  const revoke: AiManagedTool = {
    name: 'admin_workspace_tunnel_revoke',
    definition: defineTool({
      name: 'admin_workspace_tunnel_revoke',
      description: 'Revoke the temporary SSH tunnel of one user\'s workspace and delete the local one-time key file. Super administrators only; audited.',
      parameters: {
        user_id: { type: 'string', required: true, description: 'Owner userId of the target workspace.' },
      },
      output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
      execute: async (args: { user_id: string }) => {
        assertSuperAdmin('admin_workspace_tunnel_revoke')
        const userId = String(args.user_id)
        const workspaceId = await resolveWorkspaceId(userId)
        if (workspaceId === null) throw new Error('目标用户没有可代维的工作区（workspaces 列表里找不到 userId=' + userId + '）')
        const body = await call(reviewApi, '/api/ai/workspaces/' + encodeURIComponent(workspaceId) + '/tunnel', { method: 'DELETE' })
        // 无论服务端是否幂等，本地一次性私钥都必须删掉。
        await rm(tunnelKeyPath(workspaceId), { force: true })
        await rm(tunnelDirectory(workspaceId), { recursive: true, force: true })
        return { userId, workspaceId, revoked: true, result: (body ?? {}) as Json }
      },
    }),
  }

  return [restart, open, revoke]
}