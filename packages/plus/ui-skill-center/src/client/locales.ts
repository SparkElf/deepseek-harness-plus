/**
 * Skill center dictionaries. Keys are typed so the panel and the sidebar entry
 * cannot reference a string that does not exist in both languages.
 *
 * @module @sparkelf/dsh-client-ui-skill-center/client/locales
 */

/** Every string this plugin renders. */
export interface SkillCenterLocale {
  'panel': string
  'search.placeholder': string
  'search.noMatches': string
  'action.refresh': string
  'action.create': string
  'action.delete': string
  'action.showDetail': string
  'action.close': string
  'translate.label': string
  'detail.whenToUse': string
  'detail.source': string
  'detail.provider': string
  'detail.path': string
  'detail.content': string
  'action.cancel': string
  'action.confirm': string
  'state.loading': string
  'state.empty': string
  'state.failed': string
  'content.loading': string
  'content.failed': string
  'skill.enabled': string
  'skill.disabled': string
  'skill.modelInvocable': string
  'skill.userInvocable': string
  'skill.linked': string
  'create.title': string
  'create.name': string
  'create.description': string
  'create.whenToUse': string
  'create.content': string
  'create.root': string
  'create.rootUser': string
  'create.rootProject': string
  'delete.confirm': string
  'plaza.statusLocal': string
  'plaza.statusPending': string
  'plaza.statusApproved': string
  'plaza.statusRejected': string
  'plaza.sharedTag': string
  'plaza.share': string
  'plaza.resubmit': string
  'plaza.unshare': string
  'plaza.unavailable': string
  'plaza.failed': string
  'plaza.dialogTitle': string
  'plaza.tags': string
  'plaza.tagsPlaceholder': string
  'plaza.instruction': string
  'plaza.submit': string
  'plaza.unshareConfirm': string
  'plaza.reason': string
  'plaza.contentLoading': string
  'plaza.visibility': string
  'plaza.visibilityGlobal': string
  'plaza.visibilityDepartment': string
  'plaza.visibilityPrivate': string
  'plaza.department': string
  'plaza.scopeForbidden': string
  'plaza.scopeHintAdmin': string
  'plaza.scopeHintUser': string
}

/** Locale keys, for callers that resolve them dynamically. */
export type SkillCenterLocaleKey = keyof SkillCenterLocale

/** Simplified Chinese dictionary. */
export const zh: SkillCenterLocale = {
  'panel': '技能中心',
  'search.placeholder': '搜索技能…',
  'search.noMatches': '无匹配技能',
  'action.refresh': '刷新',
  'action.create': '新建技能',
  'action.delete': '删除',
  'action.showDetail': '详情',
  'action.close': '关闭',
  'translate.label': '中文翻译',
  'detail.whenToUse': '何时使用',
  'detail.source': '来源',
  'detail.provider': '提供方',
  'detail.path': '位置',
  'detail.content': '技能内容',
  'action.cancel': '取消',
  'action.confirm': '确定',
  'state.loading': '正在加载技能…',
  'state.empty': '该分组暂无技能',
  'state.failed': '技能列表加载失败',
  'content.loading': '正在读取技能正文…',
  'content.failed': '技能正文加载失败',
  'skill.enabled': '已启用',
  'skill.disabled': '已停用',
  'skill.modelInvocable': '模型可调用',
  'skill.userInvocable': '用户可调用',
  'skill.linked': '符号链接（不可删除）',
  'create.title': '新建技能',
  'create.name': '名称（小写连字符）',
  'create.description': '描述',
  'create.whenToUse': '何时使用（可选）',
  'create.content': '正文（可选）',
  'create.root': '位置',
  'create.rootUser': '用户级',
  'create.rootProject': '项目级',
  'delete.confirm': '删除后可从 .trash 恢复。确定删除？',
  'plaza.statusLocal': '未共享',
  'plaza.statusPending': '待审核',
  'plaza.statusApproved': '已上架',
  'plaza.statusRejected': '已驳回',
  'plaza.sharedTag': '已共享',
  'plaza.share': '上架',
  'plaza.resubmit': '重新提交',
  'plaza.unshare': '取消共享',
  'plaza.unavailable': '共享服务未就绪，暂时无法上架',
  'plaza.failed': '共享操作失败',
  'plaza.dialogTitle': '上架到技能广场',
  'plaza.tags': '标签',
  'plaza.tagsPlaceholder': '用逗号分隔，例如：数据,SQL',
  'plaza.instruction': '技能内容',
  'plaza.submit': '提交审核',
  'plaza.unshareConfirm': '确定取消共享？',
  'plaza.reason': '审核意见',
  'plaza.contentLoading': '正在读取技能内容…',
  'plaza.visibility': '可见范围',
  'plaza.visibilityGlobal': '全局（所有人可见）',
  'plaza.visibilityDepartment': '部门专属',
  'plaza.visibilityPrivate': '私有（仅自己可见）',
  'plaza.department': '部门',
  'plaza.scopeForbidden': '无权选择该范围，请改用部门专属或私有',
  'plaza.scopeHintAdmin': '超管/管理员可选全局或任意部门',
  'plaza.scopeHintUser': '普通用户/部门管理员只能选本部门或私有',
}

/** English dictionary. */
export const en: SkillCenterLocale = {
  'panel': 'Skill Center',
  'search.placeholder': 'Search skills…',
  'search.noMatches': 'No matching skills',
  'action.refresh': 'Refresh',
  'action.create': 'New skill',
  'action.delete': 'Delete',
  'action.showDetail': 'Details',
  'action.close': 'Close',
  'translate.label': 'Chinese',
  'detail.whenToUse': 'When to use',
  'detail.source': 'Source',
  'detail.provider': 'Provider',
  'detail.path': 'Location',
  'detail.content': 'Skill content',
  'action.cancel': 'Cancel',
  'action.confirm': 'Confirm',
  'state.loading': 'Loading skills…',
  'state.empty': 'No skills in this group',
  'state.failed': 'Could not load the skill list',
  'content.loading': 'Loading the skill content…',
  'content.failed': 'Could not load the skill content',
  'skill.enabled': 'Enabled',
  'skill.disabled': 'Disabled',
  'skill.modelInvocable': 'Model invocable',
  'skill.userInvocable': 'User invocable',
  'skill.linked': 'Symlink (cannot delete)',
  'create.title': 'New skill',
  'create.name': 'Name (lowercase kebab-case)',
  'create.description': 'Description',
  'create.whenToUse': 'When to use (optional)',
  'create.content': 'Body (optional)',
  'create.root': 'Location',
  'create.rootUser': 'User',
  'create.rootProject': 'Project',
  'delete.confirm': 'Deleting moves it into .trash, where it can be restored. Delete?',
  'plaza.statusLocal': 'Local',
  'plaza.statusPending': 'Pending review',
  'plaza.statusApproved': 'Published',
  'plaza.statusRejected': 'Rejected',
  'plaza.sharedTag': 'Shared',
  'plaza.share': 'Publish',
  'plaza.resubmit': 'Resubmit',
  'plaza.unshare': 'Unshare',
  'plaza.unavailable': 'Sharing service is not ready; publishing is disabled',
  'plaza.failed': 'Sharing action failed',
  'plaza.dialogTitle': 'Publish to skill plaza',
  'plaza.tags': 'Tags',
  'plaza.tagsPlaceholder': 'Comma separated, e.g. data, SQL',
  'plaza.instruction': 'Skill content',
  'plaza.submit': 'Submit for review',
  'plaza.unshareConfirm': 'Stop sharing this skill?',
  'plaza.reason': 'Review note',
  'plaza.contentLoading': 'Loading skill content…',
  'plaza.visibility': 'Visibility',
  'plaza.visibilityGlobal': 'Global (everyone)',
  'plaza.visibilityDepartment': 'Department only',
  'plaza.visibilityPrivate': 'Private (only me)',
  'plaza.department': 'Department',
  'plaza.scopeForbidden': 'You cannot use that visibility; pick department or private',
  'plaza.scopeHintAdmin': 'Super admins/admins may publish globally or to any department',
  'plaza.scopeHintUser': 'Users and department admins may publish to their own department or privately',
}
