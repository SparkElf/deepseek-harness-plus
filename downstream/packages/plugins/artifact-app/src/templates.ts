/**
 * Cockpit HTML contract, validation and runtime injection.
 *
 * The HTML is untrusted content rendered in an opaque-origin iframe. The plugin
 * never "sanitizes" it; instead it refuses files that cannot be rendered safely
 * (missing SDK markers or external resources) and injects the SDK, ECharts and a
 * small theme reset before the bytes leave the host.
 *
 * @module templates
 */

/** One failed contract check. */
export class TemplateContractError extends Error {
  readonly code = 'TEMPLATE_CONTRACT_MISSING'
  constructor(readonly missing: string[]) {
    super('模板合同不满足：' + missing.join('；'))
    this.name = 'TemplateContractError'
  }
}

/** External-resource patterns the sandbox cannot load. */
const EXTERNAL_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: '外链 script', pattern: /<script[^>]+src\s*=\s*["']\s*(?:https?:)?\/\//iu },
  { label: '外链样式', pattern: /<link[^>]+href\s*=\s*["']\s*(?:https?:)?\/\//iu },
  { label: '外链图片', pattern: /<img[^>]+src\s*=\s*["']\s*(?:https?:)?\/\//iu },
  { label: '外链字体', pattern: /@import\s+url\(\s*["']?\s*(?:https?:)?\/\//iu },
]

/**
 * Validate one cockpit HTML document against the template contract.
 * @param html - document bytes as text.
 * @param maxBytes - configured size ceiling.
 * @throws TemplateContractError when a required marker is missing or an external resource is present.
 * @throws Error when the document is too large.
 */
export function assertCockpitHtml(html: string, maxBytes: number): void {
  const bytes = Buffer.byteLength(html, 'utf8')
  if (bytes > maxBytes) {
    throw new Error('HTML 超过 ' + String(maxBytes) + ' 字节上限（当前 ' + String(bytes) + ' 字节）')
  }
  const missing: string[] = []
  if (!/window\.artifactApp/u.test(html) && !/\bartifactApp\s*\./u.test(html)) missing.push('缺少 window.artifactApp')
  if (!/artifactApp\.ready\s*\(/u.test(html)) missing.push('缺少 artifactApp.ready()')
  if (!/data-slot\s*=\s*["']charts["']/iu.test(html)) missing.push('缺少 data-slot="charts"')
  for (const rule of EXTERNAL_PATTERNS) {
    if (rule.pattern.test(html)) missing.push('禁止' + rule.label)
  }
  if (missing.length > 0) throw new TemplateContractError(missing)
}

/** Keep an inline script from closing its own tag. */
const inlineScript = (source: string): string => source.replace(/<\/script/giu, '<\\/script').replace(/<!--/gu, '<\\!--')

/** Theme reset prepended to every rendered document. */
const THEME_RESET = `<style id="dsh-artifact-app-theme">
:root{color-scheme:dark}
html,body{margin:0;width:100%;height:100%;background:#060a14;color:#e6edf7;font-family:Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif}
body{overflow:auto}
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-thumb{background:rgba(120,150,200,.35);border-radius:4px}
</style>`

/**
 * Inject the theme reset, ECharts and the artifact runtime into a cockpit document.
 * @param html - validated document.
 * @param options - runtime sources; `echartsJs` is omitted when ECharts injection is off.
 * @returns the document the render route serves.
 */
export function injectCockpitRuntime(html: string, options: { runtimeJs: string; echartsJs?: string }): string {
  const head = THEME_RESET
    + (options.echartsJs === undefined ? '' : '<script>' + inlineScript(options.echartsJs) + '</script>')
    + '<script>' + inlineScript(options.runtimeJs) + '</script>'
  if (/<\/head\s*>/iu.test(html)) return html.replace(/<\/head\s*>/iu, (match) => head + '\n' + match)
  if (/<html[^>]*>/iu.test(html)) return html.replace(/<html[^>]*>/iu, (match) => match + '\n<head>' + head + '</head>')
  return head + html
}

/**
 * Build the CSP header for a rendered cockpit.
 * @param origin - the DSH origin the sandboxed page may call for gateway traffic.
 * @returns the header value.
 */
export function cockpitCsp(origin: string): string {
  void origin // 保留参数以维持调用方签名；'self' 已覆盖代理场景。
  return [
    // 允许同源：驾驶舱要带会话 Cookie 调宿主的网关（/dsh-artifact-app/gateway/…）。
    // 只给 allow-scripts 会让文档变成不透明源——contentDocument 读不到、Cookie 不发，
    // 表现就是「HTML 明明 200 了，iframe 里一片空白」。
    'sandbox allow-scripts allow-same-origin',
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline' 'unsafe-eval'",
    // 素材托管后图片来自门户 origin（绝对 URL），只允许 data:/blob: 会把它们全拦掉。
    "img-src 'self' data: blob: http: https:",
    'font-src data:',
    // 'self' 而不是拼出来的绝对 origin：部署在反向代理后面时，服务端拼的是内部地址
    // （如 http://127.0.0.1:3080），浏览器那侧根本不在这个源上，请求会被 CSP 拦掉。
    "connect-src 'self'",
    "form-action 'none'",
    "base-uri 'none'",
    // 不写 frame-ancestors：驾驶舱在门户里是**三层嵌套**（门户 → DSH → 驾驶舱），
    // 而 frame-ancestors 校验的是整条祖先链；写 'self' 会把最外层门户算成非法祖先，
    // 浏览器直接 ERR_BLOCKED_BY_RESPONSE。嵌入范围由 sandbox 指令约束即可。
  ].join('; ')
}