/** Typed dictionaries owned by the Subagent settings capability. */

export type SubagentSettingsLocaleKey =
  | 'nav' | 'reset' | 'readOnly' | 'save' | 'saving' | 'discard' | 'unsaved' | 'saveFailed'
  | 'subagentTitle' | 'subagentIntro' | 'subagentModes'
  | 'subagentContinuous' | 'subagentOneShot'
  | 'subagentContinuousDescription' | 'subagentOneShotDescription'
  | 'subagentEnableContinuous' | 'subagentEnableOneShot'
  | 'subagentModel' | 'subagentFollowParent' | 'subagentFixedModel' | 'subagentProvider' | 'subagentModelId' | 'subagentMaxTokens'
  | 'subagentPersona' | 'subagentInheritPersona' | 'subagentOverridePersona' | 'subagentPersonaPlaceholder'
  | 'subagentTools' | 'subagentAllTools' | 'subagentAllowTools' | 'subagentDenyTools' | 'subagentToolNamesPlaceholder'
  | 'subagentDepth' | 'subagentProviderManaged'

/** English product copy. */
export const en: Record<SubagentSettingsLocaleKey, string> = {
  nav: 'Subagents', reset: 'Reset to default', readOnly: 'This deployment stores settings read-only.',
  save: 'Save', saving: 'Saving...', discard: 'Discard', unsaved: 'Unsaved',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  subagentTitle: 'Subagents',
  subagentIntro: 'Choose which delegation modes agents may use and configure each mode\'s child defaults.',
  subagentModes: 'Subagent modes', subagentContinuous: 'Continuous subagent', subagentOneShot: 'One-shot subagent',
  subagentContinuousDescription: 'Starts a fresh child conversation that can receive follow-up messages.',
  subagentOneShotDescription: 'Forks completed context for one task and returns its result.',
  subagentEnableContinuous: 'Enable continuous mode', subagentEnableOneShot: 'Enable one-shot mode',
  subagentModel: 'Model', subagentFollowParent: 'Follow the current agent', subagentFixedModel: 'Use a fixed model',
  subagentProvider: 'Provider', subagentModelId: 'Model ID', subagentMaxTokens: 'Maximum output tokens',
  subagentPersona: 'Role prompt', subagentInheritPersona: 'Use the parent role',
  subagentOverridePersona: 'Override the role for every child',
  subagentPersonaPlaceholder: 'Describe the child agent\'s role and output requirements.',
  subagentTools: 'Tool visibility', subagentAllTools: 'Use the parent tool set',
  subagentAllowTools: 'Allow only these tools', subagentDenyTools: 'Hide these tools',
  subagentToolNamesPlaceholder: 'Tool names separated by commas', subagentDepth: 'Maximum child depth',
  subagentProviderManaged: 'Provider managed',
}

/** Simplified Chinese product copy. */
export const zh: Record<SubagentSettingsLocaleKey, string> = {
  nav: '子代理', reset: '恢复默认', readOnly: '本部署的设置为只读。', save: '保存', saving: '保存中...',
  discard: '放弃修改', unsaved: '未保存', saveFailed: '本部署没有接受这些值，已保留供你修改。',
  subagentTitle: '子代理', subagentIntro: '选择智能体可使用的委派方式，并分别配置子代理默认值。',
  subagentModes: '子代理模式', subagentContinuous: '连续子代理', subagentOneShot: '一次性子代理',
  subagentContinuousDescription: '创建全新子会话，之后可以继续发送消息。',
  subagentOneShotDescription: '继承已完成的对话内容，执行一次任务后返回结果。',
  subagentEnableContinuous: '启用连续模式', subagentEnableOneShot: '启用一次性模式',
  subagentModel: '模型', subagentFollowParent: '跟随当前智能体', subagentFixedModel: '固定模型',
  subagentProvider: '提供方', subagentModelId: '模型 ID', subagentMaxTokens: '最大输出 token',
  subagentPersona: '角色提示词', subagentInheritPersona: '沿用父智能体角色',
  subagentOverridePersona: '为每个子代理覆盖角色', subagentPersonaPlaceholder: '描述子代理的角色和输出要求。',
  subagentTools: '工具可见范围', subagentAllTools: '沿用父智能体工具集',
  subagentAllowTools: '仅允许这些工具', subagentDenyTools: '隐藏这些工具',
  subagentToolNamesPlaceholder: '用逗号分隔工具名称', subagentDepth: '最大子代理嵌套层数',
  subagentProviderManaged: '由提供方管理',
}
