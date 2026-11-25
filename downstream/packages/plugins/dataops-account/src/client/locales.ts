/**
 * Copy for the account launcher and its feedback dialog.
 *
 * One English object is the key set; the Chinese record is complete over it so a
 * missing translation fails to compile. Registered under this plugin's own
 * namespace, which no official package owns.
 *
 * @module @sparkelf/dsh-dataops-account/client/locales
 */

export const en = {
  menu: 'DataOps account menu',
  more: 'DataOps',
  settings: 'Settings',
  contactUs: 'Feedback',
  identityPending: 'DataOps',

  feedbackTitle: 'Send feedback',
  feedbackDescription: 'Tell us what works and what does not. Your feedback is stored in DataOps.',
  feedbackCategory: 'Type',
  feedbackCategoryFeature: 'Feature request',
  feedbackCategoryBug: 'Problem report',
  feedbackCategoryOther: 'Other',
  feedbackContent: 'Details',
  feedbackContentPlaceholder: 'Describe what happened, what you expected, or what you need.',
  feedbackContact: 'Contact (optional)',
  feedbackContactPlaceholder: 'Email, phone, or anything we can reply to',
  feedbackContext: 'Submitted from',
  feedbackCancel: 'Cancel',
  feedbackSubmit: 'Submit',
  feedbackSubmitting: 'Submitting…',
  feedbackClose: 'Close',
  feedbackRequired: 'Please describe your feedback.',
  feedbackTooLong: 'Keep the details within 2000 characters.',
  feedbackContactTooLong: 'Keep the contact within 200 characters.',
  feedbackTimeout: 'The feedback service did not answer in time. Try again.',
  feedbackUnavailable: 'Feedback is unavailable outside the DataOps workbench.',
  feedbackFailed: 'Could not submit feedback. Try again.',
  feedbackRateLimited: 'Too many submissions. Wait a moment and try again.',
  feedbackSuccess: 'Feedback submitted. Thank you.',
} as const

export const zh: Record<keyof typeof en, string> = {
  menu: 'DataOps 账号菜单',
  more: 'DataOps',
  settings: '设置',
  contactUs: '意见反馈',
  identityPending: 'DataOps',

  feedbackTitle: '意见反馈',
  feedbackDescription: '告诉我们哪里好用、哪里需要改进。反馈会保存到 DataOps。',
  feedbackCategory: '反馈类型',
  feedbackCategoryFeature: '功能建议',
  feedbackCategoryBug: '问题反馈',
  feedbackCategoryOther: '其他',
  feedbackContent: '反馈内容',
  feedbackContentPlaceholder: '请描述发生了什么、你期望的结果，或你需要的功能。',
  feedbackContact: '联系方式（可选）',
  feedbackContactPlaceholder: '邮箱、电话，或其他可以联系你的方式',
  feedbackContext: '提交页面',
  feedbackCancel: '取消',
  feedbackSubmit: '提交',
  feedbackSubmitting: '提交中…',
  feedbackClose: '关闭',
  feedbackRequired: '请填写反馈内容。',
  feedbackTooLong: '反馈内容不能超过 2000 个字符。',
  feedbackContactTooLong: '联系方式不能超过 200 个字符。',
  feedbackTimeout: '反馈服务响应超时，请重试。',
  feedbackUnavailable: '当前不在 DataOps 工作台内，无法提交反馈。',
  feedbackFailed: '反馈提交失败，请重试。',
  feedbackRateLimited: '提交过于频繁，请稍后再试。',
  feedbackSuccess: '反馈已提交，谢谢。',
}

export type AccountKey = keyof typeof en