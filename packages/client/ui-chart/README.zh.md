# @deepseek-ai/dsh-client-ui-chart

[English](README.md) | 中文

仅浏览器使用的`render_chart`结果展示插件。Host工具位于[`@deepseek-ai/dsh-tool-chart`](../../chart/tool-chart/README.md)；本包只负责Web keyed tool view与ECharts生命周期，与browser boot plane保持一致。

## API 与扩展点

`./client`入口在现有keyed `tool.call.toolview` slot下以`render_chart`作为key注册本地化组件。它从direct `tool/result.meta`或nested `dsh/chart`结果content验证version-one chart数据，并从保存的JSON option初始化ECharts。

renderer监听容器尺寸，在初始化ECharts时跟随Harness亮色或暗色外观，并在组件卸载时释放chart instance。完成后的图表数据完全来自durable direct metadata或nested result content，因此历史回放不要求原DataOps resultRef仍然存活。

包仍然导出 no-op Host entry 与 `./invariant`，因为 browser-only package 也参与普通 Loader／package ownership 检查。

## Model Experience

### Interactive chart presentation

#### What the model sees

本包通过`@deepseek-ai/dsh-tool-chart`间接生效；这个browser-only package不增加model-visible文本或数据。它把成功的direct和nested `render_chart`结果显示成交互式图表，而不是generic raw tool JSON。

#### Token effect

没有直接token影响。browser renderer不改变model request或tool result。

#### KV Cache effect

本包不改变model-request prefix，也不追加model context，因此不会使原本可复用的provider cache prefix失效。

## Known Limitations and Deferred Work

- 首版渲染可 JSON 序列化的 ECharts option；function-valued formatter 与事件回调无法持久回放。
- 无效 ECharts option 在渲染时失败，UI 提供简洁失败状态与普通 tool inspection；不增加推测性的 option repair pipeline。
- 极大的 option 可能在持久化和渲染上变贵。prepared-chart handle 或独立 artifact store 等真实测量证明需要时再引入。
- 本包不查询 DataOps、不读取 resultRef、不执行 SQL，也不拥有图表数据获取。
