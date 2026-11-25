# 接口导入

OpenAPI / Swagger / 接口说明导入接口资源，按现有 `api-connector-authoring` 技能执行；本 reference 只负责在治理技能内路由，不复制其步骤。

要求：

- 先解析接口文档，判断一个 connector 还是多个；
- 资源命名用业务语义，不用 `api_v1`；
- 导入前用 GenUI 预览，用户确认后才导入；
- 字段返回英文缩写时给中文语义名；
- 不在本流程里写指标/血缘。
