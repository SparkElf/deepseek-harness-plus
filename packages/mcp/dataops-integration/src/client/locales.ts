/** English DataOps Settings copy. */
export const en = {
  nav: 'DataOps',
  title: 'DataOps',
  connected: 'Connected',
  notConnected: 'Not connected',
  connectionFailed: 'Connection failed',
  managedByAdministrator: 'Managed by administrator',
  connect: 'Connect DataOps',
  reauthorize: 'Authorize again',
  disconnect: 'Disconnect',
  confirmDisconnect: 'Disconnect this DataOps account?',
  confirmDisconnectDetail: 'You’ll need to connect DataOps again before using this account.',
  keepConnected: 'Keep connected',
  confirm: 'Disconnect',
  retry: 'Retry',
  loading: 'Checking connection…',
  popupBlocked: 'The authorization window could not be opened. Allow pop-ups for this page and try again.',
  connectFailed: 'DataOps connection failed. Try again.',
  disconnectFailed: 'Unable to disconnect DataOps. Try again.',
} as const

/** Stable key set shared by every DataOps Settings locale. */
export type DataOpsKey = keyof typeof en

/** Chinese DataOps Settings copy. */
export const zh: Record<DataOpsKey, string> = {
  nav: 'DataOps',
  title: 'DataOps',
  connected: '已连接',
  notConnected: '未连接',
  connectionFailed: '连接失败',
  managedByAdministrator: '由管理员管理',
  connect: '连接 DataOps',
  reauthorize: '重新授权',
  disconnect: '断开连接',
  confirmDisconnect: '要断开这个 DataOps 账号吗？',
  confirmDisconnectDetail: '断开后，需要重新连接 DataOps 才能继续使用此账号。',
  keepConnected: '保持连接',
  confirm: '确认断开',
  retry: '重试',
  loading: '正在检查连接…',
  popupBlocked: '无法打开授权窗口。请允许当前页面打开弹窗后重试。',
  connectFailed: 'DataOps 连接失败，请重试。',
  disconnectFailed: '无法断开 DataOps，请重试。',
}
