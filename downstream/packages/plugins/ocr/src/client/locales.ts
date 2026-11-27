/**
 * Settings copy for the document-recognition section.
 *
 * One English object is the key set and each other locale is a complete record over it,
 * so a missing translation fails to compile rather than falling back at runtime. That is
 * the shape every locale-backed DSH client plugin uses.
 *
 * The reader-facing name is 「文档识别」, matching the skill's own display name in
 * `i18n/zh.json`. Both say what the feature is for rather than naming the backend: MinerU
 * is the implementation, and a reader who has never heard of it still has to find this page.
 *
 * @module @sparkelf/dsh-ocr/client/locales
 */

/** English copy for the document-recognition settings section. */
export const en = {
  /** Settings navigation entry. */
  nav: 'Document recognition',
  /** Accessible name of the section; the page itself shows no second heading. */
  title: 'Document text recognition',

  /** Address field label; the only visible label in the section. */
  addressLabel: 'MinerU service address',
  /** Placeholder for the address field. */
  addressPlaceholder: 'http://172.17.0.1:8000',

  /** Shown while the stored value is being read. */
  loading: 'Loading…',
  /** Shown when the Host route cannot answer at all. */
  unavailable: 'The document-recognition settings are unavailable.',
  /** Explains {@link unavailable}. */
  unavailableDetail:
    'The plugin could not reach its own settings route. Reload the page; if this persists, the plugin is not mounted on this deployment.',

  /** Whether the current caller may change the value. */
  readOnly: 'Only a super administrator can change this.',

  /** Button that probes the address without saving it. */
  testConnection: 'Test connection',

  /** Connection tag: nothing has been probed in this page yet. */
  connectionUntested: 'Untested',
  /** Connection tag: the probe is in flight. */
  connectionTesting: 'Testing…',
  /** Connection tag: the address answered as MinerU. */
  connectionConnected: 'Connected',
  /** Connection tag: the probe failed. */
  connectionFailed: 'Connection failed',

  /** Latency under the field after a successful probe. */
  connectionLatency: '{ms} ms',
  /** Probe detail: not an absolute http(s) address. */
  probeBadUrl: 'Enter an absolute http or https address',
  /** Probe detail: no answer inside the probe window. */
  probeTimeout: 'The address did not answer in time',
  /** Probe detail: refused, unknown host, or unreachable. */
  probeUnreachable: 'Could not connect: {reason}',
  /** Probe detail: an HTTP server answered, but it is not MinerU. */
  probeNotMineru: 'The address answers, but it is not a MinerU service ({title})',
  /** Probe detail: a non-2xx status. */
  probeHttpError: 'The service answered HTTP {status}',
  /** Probe detail: the Host could not check the caller's role first. */
  probeUnavailable: 'The connection test is unavailable right now',

  /** Label of the button that fills empty members only. */
  distributeDefault: 'Distribute to members without a value',
  /** Label of the button that replaces every member's value. */
  overwrite: 'Save and overwrite every member',

  /** Shown while a write is in flight. */
  saving: 'Saving…',
  /** Shown while the impact count is being read. */
  counting: 'Counting members…',

  /**
   * The overwrite confirmation.
   *
   * Both numbers are load-bearing: `{withValue}` is what the action destroys and
   * `{total}` is the size of the population, so the reader can see the blast radius
   * instead of being asked a bare "are you sure?".
   */
  confirmOverwrite:
    'This replaces the address {withValue} of {total} members already set. This cannot be undone. Continue?',
  /** The distribute confirmation. */
  confirmDistribute: 'Fill the address for {withoutValue} of {total} members that have none. Continue?',
  /** Confirm button. */
  confirm: 'Continue',
  /** Cancel button. */
  cancel: 'Cancel',

  /** Result headline after a write, before the four counts. */
  resultTitle: 'Distribution finished',
  /** One count in the result row. */
  resultFilled: 'Written',
  /** One count in the result row. */
  resultSkipped: 'Skipped',
  /** One count in the result row. */
  resultFailed: 'Failed',
  /** One count in the result row. */
  resultTotal: 'Considered',

  /** A write that failed as a whole, before any per-member counting. */
  failure: 'The change did not go through: {reason}',
  /** The address typed in is not an absolute http(s) address. */
  badAddress: 'Enter an absolute http or https address, for example http://172.17.0.1:8000',

  /** Status line for a distribution that wrote nothing because everyone had a value. */
  nothingToDo: 'Nothing to change: every member already has an address.',
} as const

/** The key set this namespace's dictionaries must cover. */
export type SettingsOcrKey = keyof typeof en

/** Chinese copy; a complete record over {@link en}, so a missing key fails to compile. */
export const zh: Record<keyof typeof en, string> = {
  nav: '文档识别',
  title: '文档文字识别',

  addressLabel: 'MinerU 服务地址',
  addressPlaceholder: 'http://172.17.0.1:8000',

  loading: '加载中…',
  unavailable: '文档识别设置不可用。',
  unavailableDetail:
    '插件访问不到自己的设置路由。请刷新页面；若一直如此，说明该部署没有挂载这个插件。',

  readOnly: '仅超级管理员可修改。',

  testConnection: '测试连接',

  connectionUntested: '未测试',
  connectionTesting: '测试中…',
  connectionConnected: '已连接',
  connectionFailed: '连接失败',

  connectionLatency: '{ms} ms',
  probeBadUrl: '请填写完整的 http 或 https 地址',
  probeTimeout: '地址在超时时间内没有响应',
  probeUnreachable: '无法连接：{reason}',
  probeNotMineru: '地址可访问，但不是 MinerU 服务（{title}）',
  probeHttpError: '服务返回 HTTP {status}',
  probeUnavailable: '当前无法测试连接',

  distributeDefault: '分发给未填写地址的成员',
  overwrite: '保存并覆盖全部成员',

  saving: '保存中…',
  counting: '正在统计成员…',

  confirmOverwrite: '这会把 {withValue} 位已填写地址的成员一并覆盖，共涉及 {total} 位成员，且无法撤销。继续？',
  confirmDistribute: '将为 {total} 位成员中缺地址的 {withoutValue} 位填写该地址。继续？',
  confirm: '继续',
  cancel: '取消',

  resultTitle: '分发完成',
  resultFilled: '已填写',
  resultSkipped: '已跳过',
  resultFailed: '失败',
  resultTotal: '共处理',

  failure: '本次修改未生效：{reason}',
  badAddress: '请填写完整的 http 或 https 地址，例如 http://172.17.0.1:8000',

  nothingToDo: '无需改动：所有成员都已填写地址。',
}
