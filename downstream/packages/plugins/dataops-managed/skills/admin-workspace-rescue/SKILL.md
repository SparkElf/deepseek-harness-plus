---
name: admin-workspace-rescue
description: 超管代维另一个用户的 DSH 工作区时使用。包含临时 SSH 隧道的开通与撤销、常见故障的定位与修复顺序（workspace 记录、会话迁移、备份恢复）、安全红线与 24 小时到期规则。仅超级管理员可见。
---

# 超管代维工作区（临时 SSH 隧道）

你是以**自己的超管身份**去救另一个用户的工作区，不是拿到对方的凭据。隧道是限时的、可撤销的、全程留痕的；它不改变「这是别人的工作区」这件事。

## 一、什么时候用

- 用户报「工作区起不来 / 一直准备中 / 会话列表空了 / 打不开」而你在门户里看不到根因；
- 需要看容器内的真实文件、进程、日志（`workspace.json`、`sessions/`、`profile`、`web.log`）；
- 需要执行一次修复脚本（修 workspace 记录、迁移会话目录、清 stale lock、备份会话）。

不适用：对方只是不会用（那是产品引导）；需要改对方数据内容（那是业务操作，走正常入口）。

## 二、开通与撤销

两个工具：

- `admin_workspace_tunnel_open(userId)` → 私钥**不返回正文**：工具把它写成工作区内的 0600 一次性文件
  （`/workspace/.dataops/admin-tunnels/<workspaceId>/id_ed25519`，目录 0700），只返回 `keyPath`、
  `sshCommand`、`targetHost`、`port`、`expiresAt`。
- `admin_workspace_tunnel_revoke(userId)` → 立即撤销（删除对应的 `authorized_keys` 标记行并结束转发）。

规则：

1. 开通前先在门户里确认目标工作区 id 和 owner，**不要凭用户名猜 userId**；
2. 私钥只存在于上面那个 0600 文件里（工具不会把正文给你）；不要 `cat` 它、不要贴进聊天、
   不要复制到别处；用完即 `revoke`，`revoke` 会同时删掉文件与目录；
3. 隧道默认 **24 小时**到期，服务端每 5 分钟清理过期标记；到期后连接立即失效，**不要依赖自己记时间**；
4. 同一目标不要并行开多条；用完就撤销，撤销后要复验「再连失败」再结束。

## 三、连上之后先做什么

按「只读 → 备份 → 修复 → 复验」的顺序，不要一上来就改：

1. **只读定位**：
   - `dataops-dsh-service status`（容器内）看服务状态；
   - `tail -n 200 /workspace/.dataops/dsh/logs/web.log` 看启动错误；
   - `ls /workspace/.dataops/dsh/storages/workspace.json`、`ls /workspace/.dataops/dsh/sessions/` 看存储是否还在；
   - `ps aux | grep -E "dsh|sidecar"` 看进程是否卡死。
2. **动手前备份**：任何写操作前，先把要改的文件/目录打成 tar 放到 `/workspace/.dataops/backups/`（带时间戳）；没有备份不做破坏性动作。
3. **修复**：优先用容器里已有的脚本函数，而不是手写 sed：
   - workspace 记录异常（`workspace.json` 指向 `/root`、时间戳缺失、重复键）→ `dataops-dsh-service` 的 `repair_workspace_record()`；
   - stale profile lock → `clear_stale_profile_lock()`；
   - 会话目录迁移 → 按 `persisted_sessions.cwd` 只改 cwd 前缀，目录键跟着 workspace 键走。
4. **复验**：`dataops-dsh-service status` 回到 `running/ready`，让用户在门户里打开一次会话，确认能进、历史在。

## 四、安全红线（违反即事故）

- **不导出、不读取、不复制用户的 JWT / cookie / 凭据**；
- **不删除用户数据**：`sessions/`、`workspace.json`、附件目录只做备份与修复，不做 `rm -rf`；确需删除先问用户；
- **不代替用户发言**、不往用户的会话里写内容；
- **不在容器里安装新东西、不改镜像**；只做修复动作；
- 操作范围仅限**这一次故障**；与故障无关的文件一律不动；
- 全程按「一次隧道一次任务」使用，任务结束立即 `revoke`。

## 五、到期与清理

- 到期时间由服务端签发（默认 24h），写在 `authorized_keys` 的注释里（`dataops-admin-tunnel:<actor>:<expiresAt>`）；
- 清理任务每 5 分钟扫一次过期标记，删行并关闭转发；**手动撤销与到期清理效果一致**；
- 如果发现「已过期但还能连」，立刻 `revoke` 并上报——这是安全缺陷，不是正常现象。

## 六、DataOps MCP 未挂载 / 401：internal-token 缺失

会话里看不到 `mcp__dataops__*` 工具，或每次调用都 401——先怀疑内部 token，而不是模型或网络。

**根因**：MCP server 配置在 `/workspace/.dataops/pi/runtimes/<id>/mcp.json`，里面的 token 是占位符
`${DATAOPS_AI_WORKSPACE_INTERNAL_TOKEN}`；真实凭证来自容器内 `/run/dataops-workspace/internal-token`，
由后端工作区生命周期写入（`ensureWorkspacePlatformServices()`，token 由 `buildWorkspaceInternalToken(userId)` 生成）。
容器重建/重启走非标准路径时该文件会缺失，进程 env 里也没有这个变量，MCP server 拿不到 token → 每次 401。

**诊断三步**（只用只读命令）：

1. `docker exec <容器> ls -l /run/dataops-workspace/internal-token`
   —— 文件不存在即命中；存在则看权限和属主是否被改；
2. `docker exec <容器> env | grep DATAOPS_AI_WORKSPACE`
   —— 正常情况下这里应为空（token 走文件，不走 env）；如果有值但 MCP 仍 401，说明 env 与文件不一致；
3. `docker exec <容器> tail -n 50 /workspace/.dataops/dsh/logs/web.log | grep -i "mcp\|401"`
   —— 确认是 MCP 401，而不是模型侧没挂上工具。

**修复**：走工作区生命周期重新注入——让后端重新执行平台服务注入（`ensureWorkspacePlatformServices`）或按标准路径重建容器，
token 由后端重新生成；**注入完成后还要再重启一次 DSH（或重启整个工作区），让 MCP server 带着新 token 重新拉起**——
只注入不重启，进程里仍是旧值，现象不会消失。**不要手工把 token 写进 `mcp.json`，也不要把 token 打印出来或贴给用户**——
手写进去的 token 在下次重建时又会失配，而且等于把凭据落到了用户可读的文件里。

现在重启路径已经内置了注入（`restartWorkspace` → `injectWorkspaceInternalToken`），所以超管直接执行
`admin_workspace_restart(userId)` 一次即可同时完成「重启容器 + 重新注入」；若走了别的手工路径，按上一段补一次重启。

**验证**：
- 新开会话，工具列表里应出现 `mcp__dataops__*`；
- 或用一个需要鉴权的 `/api/ai/...` 调用确认返回 200（不要回显 token 本身）。

## 七、汇报

结束时给用户三句话：**做了什么**（动作与文件）、**结果**（服务状态/会话是否恢复）、**遗留**（还需要用户自己确认什么）。不要贴私钥、不要贴用户的敏感路径内容。