# Plus Web Playwright系统验收

[English](README.md) | 中文

本runner通过真实Plus Web UI验证npm/profile/apply distribution。它不启动Desktop或tray，不复用production port 3080，不修改显式提供的model seed home，不mock browser requests，也不通过API calls完成business setup或assertions。它structured读取`settings.yaml`，只写入与`DSH_PLUS_TEST_MODEL_LABEL`匹配的provider、model、safe protocol、Responses compatibility及default-model fields；`.credentials.yaml`保持opaque copy。它不打印任一文件，teardown会删除两份isolated seed files。

## 前置条件

standard command先build candidate，使每个local npm tarball都包含published Host与Client artifacts。runner需要`DSH_PLUS_TEST_MODEL_SEED_HOME`、以`DSH_PLUS_TEST_MODEL_LABEL`提供的当前GPT可见名称、`DSH_MINERU_ENDPOINT`及`DSH_DATAOPS_BASE_URL`。当real DataOps Web要求account login时，`DSH_PLUS_TEST_DATAOPS_USERNAME`与`DSH_PLUS_TEST_DATAOPS_PASSWORD`只由visible browser form消费；其值不写入runtime metadata或repository files。提供password variable时会禁用Playwright tracing，因为action trace会保留form-fill arguments；page、console及network diagnostics仍保持强制。

```bash
pnpm run test:plus-web
```

Global setup创建ignored `.cache/plus-web-system` tree，只把当前GPT settings与credentials seed到isolated home，checkout exact official revision `0a53fb55bea101816fa226bb964ae2bed71c343b`，pack local Plus capability与patch packages，通过`dsh plugin --profile plus add`安装，执行`dsh-plus apply`，build patched official source，通过official browser picker选择isolated Workspace directory，并在`http://127.0.0.1:3081`启动resulting profile。每个browser context通过无process token或browser cookie的clean root URL进入，因此每条UI workflow都会经过Plus-selected disabled policy及保留的Host/Origin trust fence。runtime只拥有自身记录的process group，并在global teardown停止它。isolated home、deployment lock、Web log、traces、screenshots、videos及HTML report保留在该cache中用于diagnosis，并由下一次run替换。

DataOps case保留current visible GPT model，并通过browser为bounded SQL/dsh-genui-chart workflow选择provider公布的**Low** reasoning effort。它证明bundled `genui` skill出现在slash catalog中，并通过compact line-chart contract渲染真实查询结果。Desktop cases还覆盖Trajectory toolbar Session export、Responses gateway setting、三个独立Backup scope及其visible restore isolation、Document parsing与durable Chat/Trajectory cards、DataOps authorization与expired-grant recovery、Better Sidebar、dshmarket及official Turn folding。Mobile cases在390x844 viewport覆盖installed Mobile Bridge/layout path及保留的Session Header导出操作。每个case记录带stack的page errors、console errors、包括CORS failures的failed requests及HTTP failures；failure保留screenshot/video evidence；未提供form password时还保留trace evidence用于stalls。

Agent Teams在该official revision既不是inherited release capability，也不属于tracked accepted composition：其service、tools、Client UI及Web profile packages均是release families排除且shipped profiles默认disabled的private experimental packages。本suite不声明该surface。
