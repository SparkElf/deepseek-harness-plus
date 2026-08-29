# Plus Web Playwright系统验收

[English](README.md) | 中文

本runner通过真实Plus Web UI验证npm/profile/apply distribution。它不启动Desktop或tray，不复用production port 3080，不修改显式提供的model seed home，不mock browser requests，也不通过API calls完成business setup或assertions。它structured读取`settings.yaml`，只写入与`DSH_PLUS_TEST_MODEL_LABEL`匹配的provider、model、safe protocol、Responses compatibility及default-model fields；`.credentials.yaml`保持opaque copy。它不打印任一文件，teardown会删除两份isolated seed files。

## 前置条件

standard command先build candidate，使每个local npm tarball都包含published Host与Client artifacts。runner需要`DSH_PLUS_TEST_MODEL_SEED_HOME`、以`DSH_PLUS_TEST_MODEL_LABEL`提供的当前GPT可见名称、`DSH_MINERU_ENDPOINT`、`DSH_DATAOPS_BASE_URL`。

```bash
pnpm run test:plus-web
```

Global setup创建ignored `.cache/plus-web-system` tree，只把当前GPT settings与credentials seed到isolated home，checkout exact official revision `cd5ef8148158c3a752a658978873241fdf8e2bbc`，pack local Plus capability与patch packages，通过`dsh plugin --profile plus add`安装，执行`dsh-plus apply`，build patched official source，通过official browser picker选择isolated Workspace directory，并在`http://127.0.0.1:3081`启动resulting profile。每个browser context通过official process-token root exchange进入，并跟随redirect到clean root；ephemeral token不写入runtime metadata。runtime只拥有自身记录的process group，并在global teardown停止它。isolated home、deployment lock、Web log、traces、screenshots、videos及HTML report保留在该cache中用于diagnosis，并由下一次run替换。

Desktop cases覆盖Responses gateway setting、Subagent settings persistence、streamed Backup failure recovery与restoration、Document parsing与durable Chat/Trajectory cards、DataOps authorization与chart rendering、Better Sidebar、dshmarket及official Turn folding。一个mobile case在390x844 viewport覆盖installed Mobile Bridge/layout path。每个case记录带stack的page errors、console errors、包括CORS failures的failed requests及HTTP failures；test timeout保留trace/video evidence用于stalls。

Agent Teams在该official revision既不是inherited release capability，也不属于tracked accepted composition：其service、tools、Client UI及Web profile packages均是release families排除且shipped profiles默认disabled的private experimental packages。本suite不声明该surface。
