# @sparkelf/dsh-patch-web-base-path

[English](README.md) | 中文

该data-only package为exact official DSH source base增加完整reverse-proxy mount-prefix support。一个`--base-path /prefix`或`DSH_WEB_BASE_PATH=/prefix`值由WebServer normalize，在HTTP与upgrade route dispatch前strip，作为document `<base>`注入，并传到startup/browser URLs，由Connection RPC与Session export消费。Vite assets、parser preloads、PWA metadata、Backup与DataOps browser requests都在同一document base下解析。

payload有意跨越WebServer、frontend static owner、Web app startup/shell、Connection browser transport、Session export与Web source assets。拆分这些files会允许partial mounted deployments，因此它们共享一个patch lifecycle。empty-prefix default behavior从用户视角保持root-relative不变。

target是official source base `b2e3b2a0125854567a4a5fcba75782e42fe84901`；package没有JavaScript entry、lifecycle script、compatibility fallback或credential data。official DSH发布等价end-to-end base-path behavior后retire。
