---
name: api-connector-authoring
description: 从接口文档（OpenAPI/Swagger/接口说明）创建 API Connector 并导入为接口资源时使用
metadata:
  permissions:
    - data:connector:authoring
---

# API Connector 作者

用户给一份**接口文档**（上传文件或直接粘贴文本），要把它变成 DataOps 里的**接口连接器 + 接口资源**时用本技能。**只有超级管理员能看到这个技能**，因为它一次能创建一批资源。

不适用：只是要调一个接口（用 `dataops-query` 或 `api_prepare_request`）；手工调请求参数。

## 一、先判断文档能不能干活

1. 拿到文档 → 判断格式：OpenAPI 3 / Swagger 2 / 还是「人写的接口说明」。
2. **人写的说明**也要能用：只要每个接口有「方法 + 路径 + 参数 + 返回字段」就能建连接器。
3. 缺关键信息（比如只有接口名没有路径）→ 停下来问用户，**不要猜路径**。

## 二、定粒度（这一步由你判断，但要说明理由）

- 一份文档通常 = **一个 connector**；`connectorKey` 用业务语义命名（如 `toll_operation`），不要用 `api_v1`。
- operation 的取舍：
  - **只导入用户真正要用的那组接口**，不要把文档里 200 个接口全导进来；
  - 同一组增删改查如果用户只要查询，就只导查询；
  - 粒度判断完，在预览里写清「导入了哪 N 个接口、为什么跳过其余」。

## 三、做语义治理（资源命名与目录）

- `displayName` 用业务名（「通行费日报」），不用接口名（`getTollDaily`）。
- 资源目录（catalog）按业务域归类（如「交通运营」「经营分析」），**和现有目录保持一致**，不要新建一个只放一条的目录。
- 字段命名：接口返回的英文缩写字段（`toll_amt`）要在 `responseFields` 里给出中文语义名，便于后续取数。

## 四、写 session.json（唯一需要你手写的文件）

```json
{
  "connectorKey": "toll_operation",
  "displayName": "通行运营接口",
  "sourceSystem": "toll-operation",
  "sourceDept": "交通运营部",
  "accessLevel": "PROTECTED",
  "tags": ["api", "toll"],
  "auth": { "mode": "bearer" },
  "connection": {
    "code": "toll_operation_conn",
    "name": "通行运营连接",
    "baseUrl": "https://example.internal/api",
    "config": { "authMode": "bearer" },
    "secretConfig": { "token": "" },
    "enabled": true,
    "allowedHostPatterns": ["example.internal"]
  },
  "operations": [
    {
      "operationKey": "toll_daily",
      "summary": "通行费日报",
      "method": "GET",
      "pathTemplate": "/toll/daily",
      "parameters": [{ "name": "date", "in": "query", "required": true, "type": "string" }],
      "requestBodyFields": [],
      "resultPath": "data.items",
      "responseFields": [{ "name": "tollAmt", "type": "number" }]
    }
  ]
}
```

**认证**：`auth.mode` 取 `bearer` / `apiKey` / `basic` / `none`；真实密钥**不要写进 session.json**（`secretConfig` 留空），导入后由管理员在凭据页填写。

## 五、用表格 + 文字汇报预览（必须）

导入前必须给用户一份**可读的预览**，包含：

- 连接器名、业务域、目录、可见范围；
- 要导入的 operation 清单（方法 + 路径 + 中文名）；
- 认证方式，以及「密钥需要你稍后在凭据页填」；
- 被跳过的接口及原因；
- 一句话风险提示：**导入会创建资源并对授权范围内的人可见**。

用表格 + 文字汇报预览，不要生成按钮/表单；确认靠用户回一句话。

## 六、等用户确认

- **必须由用户用自然语言明确确认**（「确认」「可以导入」「就这样」）才能继续；
- 用户改需求 → 回到第二节重新定粒度，并**重新出预览**；
- **不允许**跳过预览直接导入，也不允许把「我觉得可以」当成确认。

## 七、生成包并导入

确认后按顺序执行：

```bash
# 1) 写 session.json 到工作区目录
# 2) 生成预览产物（会校验 schema）
python3 /root/projects/dataops/python/api_connector_materializer.py preview --session <dir>

# 3) 打成可导入的包
python3 /root/projects/dataops/python/api_connector_materializer.py package --session <dir> --output <dir>/connector.zip

# 4) 导入（需要 data:connector:manage 权限的 token）
curl -sS -X POST "$DATAOPS_API_BASE/api/resources/connectors/import-package" \
  -H "authorization: Bearer $DATAOPS_ACCESS_TOKEN" \
  -F "file=@<dir>/connector.zip"
```

- 导入返回 `connectorKey` 与资源数后，用表格 + 文字汇报**结果**（连接器、资源数、需要补密钥的提示），不要生成按钮/表单；
- 失败时把**后端原始错误**给用户（常见：`session.json 与 preview.manifest.json 的 connectorKey 不一致`、`preview.resources.json 至少需要包含 1 条资源`），不要自己改写错误信息。

## 八、禁止

- 不猜接口路径、不猜返回字段；
- 不在 session.json 里写真实密钥；
- 不跳过预览、不跳过用户确认；
- 不把整份文档的所有接口一次性导入；
- 不新建重复目录（先看现有目录）。
