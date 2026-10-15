# Agent Note: 插件解析不到的平台模块名会让整个面板变空白

Status: implemented

[English](2026-10-16-unresolvable-platform-module-name-blanks-a-panel.md) | 中文

# 插件解析不到的平台模块名会让整个面板变空白

## Problem

宿主应用把 `@deepseek-ai/dsh-client-ui-primitives` 作为平台模块静态打进包
（`packages/client/web/src/platform.ts`），因此插件里的
`require('@deepseek-ai/dsh-client-ui-primitives')` 解析到的是宿主那份，而不是插件自己树里的那份。
两份对同一批图标用了不同的命名：本仓源码按画出来的尺寸命名（`IconSearchOutline16`），
已发布线按字重命名（`IconSearchOutlineRegular`）。

于是按本仓源码构建的插件，可能编译期有这个名字、而服务端宿主那份并不导出它。该导入求值为
`undefined`，React 抛 error #130（element type is invalid），slot entry 卸载，面板渲染成一片空白。
2026-10-16 实测：技能中心一个引用 `IconSearchOutline16` 的构建通过了 `tsc`、`tsdown` 与
`verify-client-ui-i18n`，部署后面板整块空白。部署的宿主 bundle 导出的是
`IconSearchOutlineRegular`，没有 `16` 那个拼写。

任何类型检查都看不见这件事。编译期的模块经 tsconfig paths 解析到本仓 `src`，那里名字存在；
只有真正服务的那个 bundle 才决定运行期是否存在。本仓已经为四个名字带了桥接别名
（`packages/client/ui-primitives/src/icons/index.tsx`），所以失效形态是别名漏了一个，而不是机制缺失。

## Decision

`scripts/check-browser-platform-module-exports.mjs` 从将要服务某个插件的宿主 bundle 里读出平台模块的
导出表，并报告插件已构建的 `lib/client.js` 引用、而该 bundle 不导出的每一个名字。它通过
`$DSH_HOME/profiles/<profile>` 走进对应 release 来定位被服务的 bundle（`--served`），
因为多个 release 并列且文件名相同，只有被链接的那个在服务。

没有指明平面时，该检查拒绝给出通过结论。本仓自建的 `apps/web/dist` 同时导出两套拼写，
拿它跑无论插件引用什么都成功；来自那个平面的结论反映不出这个检查要抓的不匹配。

它的默认语料是本 fork 发布、按 `@sparkelf` 作用域选出的家族。家族之外的包由发行版自己的线构建与
交付，所以本仓这里的 `lib/` 与部署所服务的那份是不同产物，拿它去对部署 bundle 判，
报出的是两次构建之间的差异，而不是本仓的缺陷。

`scripts/check-skill-center-panel.mjs` 在真实浏览器里打开面板，断言真正要紧的结果：卡片渲染出来、
console 里没有 React #130 或 slot entry crashed、搜索框能收窄并恢复列表、没有翻译批次停在半途。
批次完成后面板会按设计隐藏该进度条，所以检查断言的是「不存在未完成的计数」，而不是「进度条存在」。

两者分别暴露为 `pnpm run verify:platform-module-exports` 与 `pnpm run verify:skill-center-panel`。
它们都不注册进 `scripts/run-gates.ts`：导出检查读的是部署的 profile 链接，CI runner 没有部署，
注册进去只会得到一个跑不起来的门禁而不是一条发现。它们是部署期检查。

## Consequences

漏掉的别名现在会在部署前被抓住，而不是靠一片空白的面板暴露；同一个检查还抓到了这一类的第二处：
`packages/plus/subagent-settings` 引用了 `IconChevronDownOutline14`，而服务的 bundle 导出的是
`IconChevronDownOutlineRegular`。该包当时尚未安装，所以还没炸。

检查报的是名字不匹配，不是渲染缺陷：插件可以通过它而在别处接错线。浏览器检查覆盖那一面，
而它需要一套运行中的部署，所以两者都不能替代真的去看一眼面板。

从压缩后的 bundle 里读导出表是结构性的做法，若打包器将来以别的方式产出该平台模块，需要重新审视。
读不到导出表时检查会抛错而不是通过，因此这种变化会以「读不出来」暴露，而不是静默通过。

## Alternatives considered

**为运行期 JavaScript 检查加声明文件。** 本仓没有把任何 `.mjs` 脚本与 `.d.mts` 配对，
而 scripts 的 spec 导入运行期 JavaScript 的既有做法是写明理由的 `@ts-expect-error`
（`scripts/python-snapshot-workflow-order.spec.ts`）。为满足一个导入而引入仓库第一对声明文件，
等于为同一个问题立第二套约定。

**直接在仓库自建的产物上断言。** 那是最省事、也恰恰是最不可能因为这个检查存在的理由而失败的平面：
它就是按插件编译所依据的源码构建出来的。

**把这两个检查注册进门禁。** CI 没有部署，导出检查会因为找不到 profile 链接而失败，
而不是因为插件缺陷；一个跑不起来的门禁比一步写明的手工操作更糟。
