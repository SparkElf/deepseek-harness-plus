# 候选镜像运行时验收（B-09a，2026-11-26）

## 结论

**条件通过（pass-with-pre-existing-caveat）**。候选 `dataops-ai-workspace-candidate:local` 在与生产相同路径（entrypoint + CMD 覆盖为 `sleep infinity` + `dataops-dsh-service`）下可启动到 DSH `ready=true`，版本、插件、gateway 进程、RSS、writable layer 均达标，镜像体积与 writable layer 明显低于生产基线。

发现一个**非候选引入**的镜像默认 CMD 缺陷：`/opt/dataops-runtime/src/daemon.mjs` 在镜像中不存在，默认 CMD 启动 1.1 秒后以 `MODULE_NOT_FOUND` 退出。生产镜像 `final-20261125-sdkfix` 以及 11-23/11-24 的旧镜像同样缺该文件；运行中的 `dataops-ai-admin` 用 `sleep infinity` 覆盖了 CMD，因此当前部署不受影响，但镜像不能仅靠默认 CMD 启动。

## 关键指标

| 指标 | 生产基线 | 候选 | 变化 |
| --- | ---: | ---: | ---: |
| `docker images` 体积 | 13.2GB | **11.9GB** | -1.3GB（-9.8%） |
| 压缩体积（inspect `.Size`） | 3,160,902,480 B | **2,909,582,424 B** | -251,320,056 B（-7.95%） |
| 层合计（history） | 10,068,270,890 B | **8,965,493,990 B** | -1,102,776,900 B（-10.95%） |
| writable layer | 2.2GB | **733kB** | -2.2GB（-99.97%） |
| DSH RSS | 358,392 KB | **334,548 KB** | -23,844 KB（-6.65%） |
| gateway RSS | 44,900 KB | 69,804 KB | +24,904 KB（+55.5%） |
| DSH+gateway RSS | 403,292 KB | 404,352 KB | +1,060 KB（+0.26%） |
| profile bundles | 26 | **26** | 一致 |
| 冷启动 ready | 目标 30–60s | **43.6s** | 区间内 |
| 热重启 ready | 目标 10–15s | **4.3s** | 优于目标 |

RSS 取 `ps -eo rss`；`docker stats` 的 961.6MiB 含 page cache，不作为进程 RSS 对比口径。

## 检查明细

- **DSH 版本**：`/opt/dsh-home/profiles/dataops-web/node_modules/.bin/dsh --version` → `0.2.3-alpha.2`；运行容器内同一路径结果一致。`@sparkelf/dsh-plus` 为 `0.2.9-alpha.106`。
- **插件**：profile 26 个 bundle；`@sparkelf` 28 个目录、`@deepseek-ai` 422 个目录；`compatibility.json` 141 字节（豁免 `dsh-web-search-exa@0.2.2-rc.1`、`anysearch-dsh@0.1.8`）；`web.log` 中 `skipping profile bundle` 为 0。
- **gateway**：镜像内 `/opt/dataops-runtime/src/` 有 `workspace-gateway.mjs`、`workspace-web-gateway-agent.mjs`、`workspace-sdk-gateway.mjs`、`workspace-platform-sidecars.mjs`、`dataops-dsh-embedded.patch.yml`；运行时 `node /opt/dataops-runtime/src/workspace-gateway.mjs`（PID 18），日志 `running: web, sdk`，SDK 监听容器内 `0.0.0.0:43118`（未发布到宿主机）。
- **就绪**：新卷冷启动 `dataops-dsh-service start` 43,607ms 返回 `state=running, ready=true`；同一卷 `stop` 1,008ms、再 `start` 4,299ms。启动返回后瞬间有一次 `status` 显示 `starting`，5–10 秒内稳定 `running`，属启动窗口。
- **路由**：容器内 `/`、`/integrations/dataops/model-sync`、`/integrations/dataops/skill-plaza`、`/integrations/dataops/workspace-limits` 均为 **401**（已注册且需要浏览器认证），无 404/5xx。
- **默认 CMD 缺陷**：`docker run --rm ... dataops-ai-workspace-candidate:local` 退出码 1，错误为 `Error: Cannot find module '/opt/dataops-runtime/src/daemon.mjs'`（`MODULE_NOT_FOUND`）。生产镜像用同一命令同样退出 1；生产容器实际 Cmd 为 `... exec sleep infinity`，DSH 由 `dataops-dsh-service` 拉起（生产 PID 199883）。

## 隔离与清理

- 临时容器 `b09a-candidate-runtime-20261126`，临时卷 `b09a-candidate-workspace-20261126`；无 `-p`，`PortBindings={}`、`NetworkSettings.Ports={}`，DSH 仅监听容器内 `127.0.0.1:13080`。
- 为不触碰生产 profile，使用**全新命名卷**而非生产卷 `dataops-ai-admin-dsh-run`；挂载目标仍为 `/workspace`，环境变量取自 `dataops-ai-admin`（去掉 profile ref / port 覆盖）。
- 因镜像默认 helper/daemon 路径缺失，测试容器内手动写入 64 字符 owner token 到 `/run/dataops-workspace/internal-token`（`nobody:nogroup`，0640）以解除 sidecar 等待；生产容器内该文件为 64 字节。gateway 的后端握手未用合成 token 做端到端断言。
- 结束后 `dataops-dsh-service stop` → `docker stop` → `docker rm -f` → `docker volume rm`；含密 env 文件已删除。生产 `dataops-ai-admin` 仍在运行且 `StartedAt` 未变，宿主 `3000`/`3080` 监听未变。

## 复现命令

```bash
# 1) 只读检查版本
docker run --rm --entrypoint sh dataops-ai-workspace-candidate:local \
  -c '/opt/dsh-home/profiles/dataops-web/node_modules/.bin/dsh --version'

# 2) 生产同构启动（无端口发布，临时卷）
docker run -d --name b09a-candidate-runtime-20261126 \
  --env-file /tmp/b09a-env -e DATAOPS_DSH_PORT=13080 \
  -v b09a-candidate-workspace-20261126:/workspace \
  dataops-ai-workspace-candidate:local /bin/sh -lc 'exec sleep infinity'

# 3) DSH 到 ready
docker exec b09a-candidate-runtime-20261126 dataops-dsh-service start
docker exec b09a-candidate-runtime-20261126 dataops-dsh-service status

# 4) 指标
docker ps -s --filter name=b09a-candidate-runtime-20261126
docker exec b09a-candidate-runtime-20261126 ps -eo pid,ppid,rss,args
```

完整机器可读证据见 [candidate-runtime-20261126.json](</root/projects/deepseek-harness-plus/images/workspace/acceptance/candidate-runtime-20261126.json>)。