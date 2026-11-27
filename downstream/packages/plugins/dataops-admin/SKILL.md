---
name: dataops-admin
description: "管理万相数据中台的账号与权限：创建账号、调整角色、重置密码、查询用户与角色。需要超级管理员账号凭据。"
---

# 万相数据AI中台管理

管理万相数据中台的**账号与权限**：创建账号、调整角色、重置密码、查询用户与角色。这不是浏览门户，而是直接调管理接口——**每一步都会真实改变系统状态**。

## 一、什么时候用

**只有**用户明确要求下列事情时才用：

- 「帮我创建一个账号」
- 「把这个用户的角色改成 XXX」
- 「看一下有哪些用户 / 有哪些角色」
- 「重置某个用户的密码」

**不要**在这些情况下用：

- 用户只是在问中台怎么用、菜单在哪、某个功能怎么点 → 直接回答，别调脚本；
- 用户想查询数据、看报表、跑流程 → 那是别的能力；
- 用户没有提供**超级管理员**账号凭据 → 先问他，别猜。

## 二、凭据怎么给（重要）

脚本从**环境变量**读凭据：

```bash
DATAOPS_ADMIN_USER='admin' \
DATAOPS_ADMIN_PASSWORD="$DATAOPS_ADMIN_PASSWORD" \
  node scripts/dataops-admin.mjs list-users
```

**规则：**

1. **密码只从用户消息里拿，用完即弃**——不要写进任何文件、不要 `echo`、不要放进会话总结。
2. **绝对不要把密码打印出来**，也不要在回复里复述。用户给你密码后，回复里只用 `***`。
3. **优先环境变量，不要用 `--password`**：命令行参数会出现在 `ps` 的进程列表里，同机其他人能看到。脚本本身不提供 `--password`，就是为了逼出这个习惯。
4. 脚本**不保存**任何凭据：登录拿到 token 后只在内存里用到进程结束。

## 三、动作清单（只有这 5 个）

| 动作 | 类型 | 作用 |
| --- | --- | --- |
| `list-users` | 只读 | 列出用户，可按 `--search` / `--role` / `--department` 过滤 |
| `list-roles` | 只读 | 列出角色，用来查 `roleCodes` 的真实取值 |
| `create-user` | **写入** | 创建一个账号 |
| `set-roles` | **写入** | **替换**某用户的角色集合（不是追加） |
| `reset-password` | **写入** | 重置某用户的密码 |

**没有删除用户的能力**，也没有「自定义请求」入口——这是有意为之，不是遗漏。用户要是要求删除账号，告诉他本技能不支持。

## 四、先看再做（推荐流程）

任何写操作之前，**先跑一次 `--dry-run` 给用户看**：

```bash
node scripts/dataops-admin.mjs create-user \
  --username ops_test --display-name '运营测试' --email ops@example.invalid \
  --department data-platform --roles 管理员 \
  --new-password "$NEW_USER_PASSWORD" --dry-run
```

`--dry-run` **不登录、不发送**，只打印将要发出的请求（密码显示为 `***`）。用户点头后去掉 `--dry-run`、加 `--yes` 再跑。

**写操作缺少 `--yes` 时脚本只打印计划并退出**，不会执行——这是防止误触发的最后一道闸。

## 五、权限边界（必须如实告知用户）

**只有「超级管理员」能执行。** 登录后脚本会检查角色：

- 是 `超级管理员` → 继续；
- 是别的角色（例如 `管理员`）→ **直接拒绝**，并说明是哪个角色：

```
✗ 拒绝执行：当前账号角色为「管理员」，该角色在后端也有管理权限，但本脚本只允许「超级管理员」
```

**被拒绝时不要重试、不要换账号、不要绕过。** 把原话转告用户即可。

> ⚠️ **如实说明**：这是**本脚本自身的策略**，**不是安全边界**。DataOps 后端的权限清单实际上把 `system:user:*`、`system:role:*` 同时授予了「超级管理员」和「管理员」，所以直接用「管理员」令牌调 API 仍然能成功。本脚本按用户的要求收紧到只允许超级管理员；要真正在系统层面收紧，需要改后端的权限清单，不在这里做。

## 六、输出格式

**成功**（带结构化的后端返回，已删敏感字段）：

```
✓ 已登录：admin（令牌 abcdefgh… (912 chars)）
✓ 权限检查通过：超级管理员
→ list-users
✓ 完成（HTTP 200）
{ ... }
```

**失败**（带 HTTP 状态码与后端原文，最多 200 字）：

```
✗ 权限不足：该账号无管理权限。
  后端返回：当前账号缺少所需权限
  该操作需要超级管理员账号。
```

**把失败原话转述给用户**，不要自己编一个更"友好"的理由——后端的话才是事实。

## 七、特殊失败（照原话转述）

| 情况 | 脚本输出 | 你要做什么 |
| --- | --- | --- |
| 账号启用了 MFA | `✗ 该账号启用了多因素认证（MFA），本脚本无法完成登录` | 告诉用户换一个未启用 MFA 的超管账号，或先在门户里关闭 MFA |
| 登录态失效（401） | `✗ 登录态失效（HTTP 401），请重新运行并提供凭据。不会自动重试。` | 重新向用户要凭据。**不要**自动重跑——重复登录会触发后端限流，可能锁号 |
| 无管理权限（403） | `✗ 权限不足：该账号无管理权限。` | 转告用户需要超管账号 |
| 连接失败 | `✗ 无法连接后端 <url>` | 检查后端地址（默认 `http://127.0.0.1:3101`，用 `--base-url` 覆盖） |

## 八、`reset-password` 需要 `--updated-at`

后端用乐观锁防丢更新，重置密码必须带上**你读到的那个用户的 `updatedAt`**：

```bash
# 1) 先读到 updatedAt
node scripts/dataops-admin.mjs list-users --search 张三
# 2) 用它重置
node scripts/dataops-admin.mjs reset-password \
  --user-id <上一步的 id> --updated-at '<上一步的 updatedAt>' \
  --new-password "$NEW_PASSWORD" --yes
```

`updatedAt` 过期就重新读一次，**不要猜**。

## 九、安装与部署

本技能随包以 tarball 形式进入 profile，和 `@sparkelf/dsh-knowledge-base` 走同一条路：

```bash
# 1) 打包（在仓库根）
cd packages/dataops-admin && npm pack --pack-destination /tmp/plugins

# 2) 装进 profile（容器内）
install-local-plugins.sh /workspace/.dataops/dsh/profiles/dataops-web \
  /tmp/plugins/sparkelf-dsh-dataops-admin-0.1.0.tgz

# 3) 重启
dataops-dsh-service stop; sleep 3; dataops-dsh-service start
```

**注意**：`prepare_profile()` 在镜像模板的 `version+digest` 变化时会**删掉整个 profile 重建**，只保留 `cordis.patch.yml`。所以这个包必须同时进入 **`/opt/dataops-dsh-profile-template`**（或 `--build-context extra-plugins` 的构建上下文），否则重建镜像后技能会消失。这一点和 knowledge-base 完全一样。

## 十、安全红线（给自己看的）

1. 密码**不进**文件、日志、会话记录、错误信息；
2. 任何输出都过 `redact()` / `scrub()`；
3. `--dry-run` 是默认动作，写操作必须显式 `--yes`；
4. 白名单之外没有入口，不做「自定义请求」；
5. 401 不自动重登，403 不重试；
6. 不在回复里复述密码或令牌——只说「已用你提供的凭据」。
