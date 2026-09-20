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
  'search.clear': string
  'search.noMatches': string
  'action.refresh': string
  'action.create': string
  'action.delete': string
  'action.cancel': string
  'action.confirm': string
  'state.loading': string
  'state.empty': string
  'state.failed': string
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
}

/** Locale keys, for callers that resolve them dynamically. */
export type SkillCenterLocaleKey = keyof SkillCenterLocale

/** Simplified Chinese dictionary. */
export const zh: SkillCenterLocale = {
  'panel': '技能中心',
  'search.placeholder': '搜索技能…',
  'search.clear': '清除搜索',
  'search.noMatches': '无匹配技能',
  'action.refresh': '刷新',
  'action.create': '新建技能',
  'action.delete': '删除',
  'action.cancel': '取消',
  'action.confirm': '确定',
  'state.loading': '正在加载技能…',
  'state.empty': '该分组暂无技能',
  'state.failed': '技能列表加载失败',
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
}

/** English dictionary. */
export const en: SkillCenterLocale = {
  'panel': 'Skill Center',
  'search.placeholder': 'Search skills…',
  'search.clear': 'Clear search',
  'search.noMatches': 'No matching skills',
  'action.refresh': 'Refresh',
  'action.create': 'New skill',
  'action.delete': 'Delete',
  'action.cancel': 'Cancel',
  'action.confirm': 'Confirm',
  'state.loading': 'Loading skills…',
  'state.empty': 'No skills in this group',
  'state.failed': 'Could not load the skill list',
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
}
