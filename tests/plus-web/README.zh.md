# Plus Web Playwright系统验收

[English](README.md) | 中文

本runner通过真实Plus Web UI验证npm/profile/apply distribution。它不启动Desktop或tray，不复用production port 3080，不修改显式提供的model seed home，不mock browser requests，也不通过API calls完成business setup或assertions。它structured读取`settings.yaml`，只写入与`DSH_PLUS_TEST_MODEL_LABEL`匹配的provider、model、safe protocol、Responses compatibility及default-model fields；`.credentials.yaml`保持opaque copy。它不打印任一文件，teardown会删除两份isolated seed files。

## 前置条件

standard command先build candidate，使每个local npm tarball都包含published Host与Client artifacts。runner需要`DSH_PLUS_TEST_MODEL_SEED_HOME`、以`DSH_PLUS_TEST_MODEL_LABEL`提供的当前GPT可见名称、`DSH_MINERU_ENDPOINT`及`DSH_DATAOPS_BASE_URL`。当real DataOps Web要求account login时，`DSH_PLUS_TEST_DATAOPS_USERNAME`与`DSH_PLUS_TEST_DATAOPS_PASSWORD`只由visible browser form消费；其值不写入runtime metadata或repository files。提供password variable时会禁用Playwright tracing，因为action trace会保留form-fill arguments；page、console及network diagnostics仍保持强制。

```bash
pnpm run test:plus-web
```

Global setup先通过publication使用的同一canonical release-pack边界pack local Plus capability与patch packages。单槽且有界的`.cache/plus-web-build-cache`以这些exact tarball bytes、official revision `0a53fb55bea101816fa226bb964ae2bed71c343b`、platform、architecture、Node及pnpm为key。miss会替换旧槽，checkout并build patched official source，再记录不含credentials的profile template；hit直接复用该immutable source，并以hardlink物化全新profile tree，不重复build或复制package bytes。Settings、credentials、plugin-market runtime state、Workspace files、fixtures、logs、reports及runtime process从不进入cache：每轮都在`.cache/plus-web-system`重新创建，在`http://127.0.0.1:3081`启动resulting profile，并由teardown删除两份seeded secret files。

每个browser context通过无process token或browser cookie的clean root URL进入，因此每条UI workflow都会经过Plus-selected disabled policy及保留的Host/Origin trust fence。runtime只拥有自身记录的process group，并在global teardown停止它。isolated home、deployment lock、Web log、traces、screenshots、videos及HTML report保留在per-run tree中用于diagnosis，并由下一次run替换。

DataOps case保留current visible GPT model，并通过browser为bounded SQL/dsh-genui-chart workflow选择provider公布的**Low** reasoning effort。它证明bundled `genui` skill出现在slash catalog中，并通过compact line-chart contract渲染真实查询结果。Univer Office case使用其bundled skills与tools创建、核验并合入真实Sheet，再要求可见的已合入审阅卡片。Desktop cases还覆盖Trajectory toolbar Session export、Responses gateway setting、三个独立Backup scope及其visible restore isolation、Document parsing、durable Chat/Trajectory cards及其Session-authorized Better Sidebar preview、DataOps authorization与expired-grant recovery、Better Sidebar、dshmarket及official Turn folding。Mobile cases在390x844 viewport覆盖installed Mobile Bridge/layout path及保留的Session Header导出操作。每个case记录带stack的page errors、console errors、包括CORS failures的failed requests及HTTP failures；failure保留screenshot/video evidence；未提供form password时还保留trace evidence用于stalls。

Agent Teams在该official revision既不是inherited release capability，也不属于tracked accepted composition：其service、tools、Client UI及Web profile packages均是release families排除且shipped profiles默认disabled的private experimental packages。本suite不声明该surface。
