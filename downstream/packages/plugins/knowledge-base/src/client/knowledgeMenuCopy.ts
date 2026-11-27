/**
 * Copy for the Share dialog.
 *
 * The context menu's own labels are NOT here: they are `action*` keys in the shared
 * namespace (`locales.ts`), because they are the same sentences the rest of the knowledge
 * surface uses for the same verbs, and two copies of one sentence drift. What stays local
 * is the dialog's copy, which is longer, dialog-specific, and not addressable from the
 * settings namespace -- putting it in `locales.ts` would also mean touching a file several
 * other changes are editing at once.
 *
 * `SHARE_ZH` is typed as the English record, so a key added to one and forgotten in the
 * other fails to compile rather than rendering an English sentence inside a Chinese
 * dialog.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import type { ShareDialogCopy } from './KnowledgeShareDialog.tsx'

/** The share dialog's English copy. */
const SHARE_EN: ShareDialogCopy = {
  title: 'Share',
  intro: 'Choose who may open this. The permission is recorded by DataOps, so it applies in the workspace tree too.',
  subjectType: 'Share with',
  search: 'Find',
  searchPlaceholder: 'Type a name or department',
  noMatch: 'Nothing matches that search.',
  loading: 'Loading\u2026',
  empty: 'Nothing to choose from here.',
  cancel: 'Cancel',
  confirm: 'Share',
  working: 'Sharing\u2026',
  permission: 'Permission',
  actionRead: 'Read',
  actionWrite: 'Write',
  actionManage: 'Manage',
  chosen: 'Selected',
  failed: 'Could not share:',
  directoryFailed: 'Could not load the list:',
  kind_user: 'People',
  kind_role: 'Roles',
  kind_department: 'Departments',
  kind_group: 'Groups',
}

/** The share dialog's Chinese copy. */
const SHARE_ZH: ShareDialogCopy = {
  title: '分享',
  intro: '选择可以打开它的人。权限由 DataOps 记录，因此在工作区文件树里同样生效。',
  subjectType: '分享给',
  search: '查找',
  searchPlaceholder: '输入姓名或部门',
  noMatch: '没有匹配的对象。',
  loading: '加载中\u2026',
  empty: '这里没有可选的对象。',
  cancel: '取消',
  confirm: '分享',
  working: '分享中\u2026',
  permission: '权限',
  actionRead: '只读',
  actionWrite: '可写',
  actionManage: '可管理',
  chosen: '已选择',
  failed: '分享失败：',
  directoryFailed: '无法加载列表：',
  kind_user: '用户',
  kind_role: '角色',
  kind_department: '部门',
  kind_group: '用户组',
}

/**
 * Resolve the share-dialog copy for one locale tag.
 * @param locale - the reader's locale tag, as the page received it.
 * @returns The English or Chinese record.
 */
export function shareCopyFor(locale: string | undefined): ShareDialogCopy {
  return locale !== undefined && locale.toLowerCase().startsWith('zh') ? SHARE_ZH : SHARE_EN
}
