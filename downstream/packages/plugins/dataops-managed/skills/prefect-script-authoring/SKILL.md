---
name: prefect-script-authoring
description: 用纯 Prefect Python（@flow/@task）编写 DataOps 工作流定义、发布部署并运行；通过 workflow_query / workflow_definition / workflow_deployment / workflow_run_control 四个超管工具操作时使用
metadata:
  permissions:
    - automation:workflow:create
---

# Prefect 脚本作者

用户要「写一个每天跑的 Prefect 工作流」「把这段 Python 变成平台工作流」「部署并跑一次」时用本技能。
工作流定义的事实源是**一段纯 Prefect Python 脚本**；平台会解析出图（只读投影），执行时跑脚本本身。

只有超级管理员能看到这四个工具（`workflow_query` / `workflow_definition` / `workflow_deployment` /
`workflow_run_control`）。不要试图绕过它们直接调 Prefect API。

## 一、写脚本的硬约束

1. **一个 `@flow` 入口**，其余业务步骤用 `@task` 拆分；入口名会被解析成 `flowName`。
2. 只 import 可用的库：`prefect`、`pandas/polars`、`requests/httpx`、`sqlalchemy`、`pymysql`、
   `psycopg`、`sqlglot`、`pyarrow` 等镜像内已装依赖；不要 pip install。
3. 数据连接从环境变量或平台凭据读取，**不要把密码/Token 写进源码**。
4. 有副作用的写操作要幂等（按主键 upsert / 先删后插限定分区）。
5. 不要写 `while True`、无限重试或长时间 sleep；单次运行应可结束。
6. `if __name__ == "__main__"` 可以留，但平台执行时不会触发（wrapper 以非 `__main__` 命名空间执行）。

最小示例：

```python
from prefect import flow, task

@task(retries=2, retry_delay_seconds=30)
def extract() -> list[dict]:
    """从源表抽取当日订单。"""
    ...

@task
def load(rows: list[dict]) -> int:
    """写入汇总表，返回写入行数。"""
    ...

@flow(name="order_daily")
def pipeline() -> int:
    rows = extract()
    return load(rows)
```

## 二、提交定义

1. 先把脚本写成工作区文件（如 `/workspace/flows/order_daily.py`）。
2. 调 `workflow_definition`：
   - `create`：`code`、`englishName`、`chineseName`、`description`、`tags`、`source`（或先上传文件用 `sourceFileId`）；
   - 后端会解析成图并返回 `diagnostics`；`severity=error` 时保存被拒绝，按提示改脚本。
3. 图只是投影：`approximate=true` 表示有动态控制流（if/for 里的 task），**不影响执行**，
   但要在回复里说明「图是近似结构」。

## 三、配置部署

`workflow_deployment` 的 `create`：

| 字段 | 说明 |
|---|---|
| `workflowId` | 上一步返回的定义 id |
| `name` | 部署名（同一工作流可多个运行时配置） |
| `workPoolName` | 默认 `local-pool`，除非用户指定 |
| `schedule` | cron 数组，如 `[{ "cron": "0 2 * * *", "timezone": "Asia/Shanghai" }]`；手动触发传 `[]` |
| `parameters` | 脚本入口参数（dict） |
| `concurrencyLimit` | 可选并发上限 |
| `lineageStrategy` | SCRIPT 定义固定 `OFF`（服务端会强制），不要传 STATIC/RUNTIME |

发布成功后返回 `deploymentId` 与 `bundleSha256`；**不要**把 bundle 路径或 sha 当入参再次提交。

## 四、运行与排障

- 立即跑一次：`workflow_deployment` 的 `run_now`（必须显式传 action），等待到终态；
- 看结果：`workflow_query` 的 `list_runs` / `get_run_logs`；
- 取消/重试：`workflow_run_control`（`cancel` / `retry`）；
- 常见错误：
  - `400 field=source` + diagnostics：脚本语法/缺 `@flow`/多 `@flow` 且无法判定入口；
  - `节点缺少脚本快照`：说明走了 GRAPH 路径（定义 origin 不是 SCRIPT），检查创建参数；
  - `WORKFLOW_SCRIPT` 不被接受：worker 镜像太旧，需要重建 worker 镜像；
  - `BPMN_SERVICE_UNAVAILABLE`：与工作流无关，是审批服务不可用。

## 五、何时必须先问用户

- 要写生产表、删除数据、改调度时间；
- 要用 `lineageStrategy=STATIC/RUNTIME`（当前 SCRIPT 不支持，需改走图定义）；
- 脚本需要镜像里没有的依赖；
- 用户没说清数据源、目标表或调度时区。

## 六、回复模板

> 已创建工作流「订单日报」（脚本定义，解析出 3 个节点，图有 1 处近似）。
> 部署 `order_daily/每日2点` 已发布，bundle `abc123…`，下次运行 2026-11-10 02:00（Asia/Shanghai）。
> 已手动跑一次：flow run `...` 成功，2 个 task 完成，写入 128,450 行。

**不要**在回复里贴完整脚本或凭据；给定义 id、部署 id、运行 id 和结果摘要即可。