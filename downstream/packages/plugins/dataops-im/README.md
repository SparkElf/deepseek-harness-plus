# `@sparkelf/dsh-dataops-im`

DataOps IM 机器人的 DSH 集成。一个包、两种 mode，按文件拆开写：

| mode | 作用 | 文件 |
|---|---|---|
| `admin` | 只注册 DSH 设置页「IM 机器人」与同源代理；不加载 IM 通道、不注册工具/技能/context | `src/admin/**`、`src/client/**` |
| `connector` | 加载 `@xmanrui/dsh-im`，对其工具与 `/api/dsh-im/*` 管理路由做门控 | `src/auth.ts`、`src/gating.ts`、`src/connector/**` |

入口 `src/index.ts` 由 connector 侧维护：所有 mode 先 `await registerAdminProxy(ctx, { baseUrl })`，
`mode === 'connector'` 再装配通道与门控。

## 数据与授权

- 设置页的数据来自 DataOps `GET/POST/PATCH/DELETE /api/im/bots`、`POST /api/im/bots/:id/test`；
- 宿主代理把网关附带的 `Authorization: Bearer <jwt>` 原样转给 DataOps，插件**不判断权限**；
- 可见性由 `GET /api/im/capability` 的 `{allowed}` 决定：非管理员不注册 section；
- 写接口需要 `system:im:manage`；Secret 只存 DataOps 秘密库（`im-bot/<uuid>`），响应只回
  `secretConfigured`，Bot ID 一律脱敏。

## 构建

```bash
pnpm --filter @sparkelf/dsh-dataops-im build   # tsc 声明 + tsdown 双产物（lib/index.js、lib/client.js）
```

只改客户端时可 `./node_modules/.bin/tsdown`（跳过 dts），`lib/client.js` 即 DSH 模块加载器读取的产物。

## 安装（工作区热补丁）

包必须同时出现在三棵树里，缺一处会在容器重建/换机后失效：

```text
/opt/dsh-plus/node_modules/@sparkelf/dsh-dataops-im
/opt/dataops-dsh-profile-template/node_modules/@sparkelf/dsh-dataops-im
/workspace/.dataops/dsh/profiles/<profile>/node_modules/@sparkelf/dsh-dataops-im
```

并同步 profile/template 的 `package.json`（依赖行 + `dsh.profile.bundles` 行）与
`cordis.patch.yml`（`dataops-im` 配置块），最后 `dataops-dsh-service stop/start`。
## connector：企微 sender 身份映射

`mode=connector` 额外加载 `src/connector/identity.ts`：

- 订阅 dsh-im 的 `dsh-im/session-pre-bind`，按 `botId + senderId` 调 DataOps
  `POST /api/im/identity/resolve`；
- 事件到达时先给 Session 放一个不含 scope 字段的占位 actor，解析成功后再写
  `DATAOPS_ACCESS_TOKEN_S_<SID>` 并替换真实 actor；解析失败保留占位 actor，MCP 凭据解析
  找不到槽会报错，**不会**回退工作区服务账号 token；
- `dsh-im/session-unbind` 删除该会话的 scoped 槽；`session/created` 对重启后已存在的会话用
  `dshIm.describeConversation(sessionId)` 补一次身份；
- 管理员可通过 `GET /api/dsh-dataops-im/identity/status?sessionId=` 查看解析状态（不返回 token）。

依赖：`@sparkelf/dsh-plugin-mcp-credentials >= 0.2.9-alpha.91`（支持 `_S_` 会话槽），
profile 必须移除独立的 `@xmanrui/dsh-im` bundle，避免同一通道被挂两次。

## connector：企微群历史同步

`src/connector/history-sync.ts` 每 5 分钟通过 `@wecom/cli@1.3.4` 的
`chat groups list` / `chat messages list` 拉最近 7 天群消息，归一化后用
`POST /api/ai/chat/external/ingest` 写 room（`agentTrigger=never`、`authorKind=external`），
@ 时把最近 N 条群历史拼进 prompt。无 `msgid`，去重键：

```text
sha256(chatId \0 send_time \0 userid \0 msg_type \0 text_hash \0 same_second_ordinal)
```

环境变量：`WECOM_HISTORY_SYNC`（默认开）、`WECOM_HISTORY_SYNC_INTERVAL_MS`（默认 300000）、
`WECOM_HISTORY_CONTEXT_LIMIT`（默认 50）、`WECOM_HISTORY_FIRST_RUN_ROOM_LIMIT`（默认 50）、
`WECOM_HISTORY_OVERLAP_MINUTES`（默认 10）、`WECOM_HISTORY_CLI_PATH`、
`WECOM_HISTORY_CLI_HOME`、`WECOM_HISTORY_STATE_DIR`、`WECOM_HISTORY_BRIDGE_URL`
（默认 `http://127.0.0.1:3199`；DSH 无 capabilities，必须由 `scripts/wecom-history-bridge.mjs`
以 `nobody` 运行 CLI）。文件/图片/语音/视频 v1 只计数，TODO 走 `message files get` → KB。
