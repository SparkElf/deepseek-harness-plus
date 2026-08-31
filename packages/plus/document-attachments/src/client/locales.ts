import type {} from '@deepseek-ai/dsh-client-ui-slots'

export const en = {
  'intake.count': 'Attach up to {count} documents per message.',
  'intake.type': 'Choose a PDF, DOCX, PPTX, or XLSX file whose extension matches its type.',
  'intake.fileSize': 'Each document must be {size} or smaller.',
  'intake.totalSize': 'Documents in one message must total {size} or less.',
  'submit.failed': 'Unable to submit the document prompt.',
  'command.unsupported': 'Slash commands do not accept document attachments.',
  'drop.title': 'Drop images or documents here',
  'drop.desc': 'PDF, DOCX, PPTX, or XLSX; up to {count} documents, {size} each.',
  'draft.group': 'Draft documents',
  'draft.remove': 'Remove {name}',
  'history.group': 'Attached documents',
  'preview.title': 'Document preview',
  'preview.open': 'Preview {name} in sidebar',
  'preview.loading': 'Loading document preview...',
  'preview.empty': 'No text was extracted from this document.',
  'preview.failed': 'Unable to load this document preview.',
  'preview.copyCode': 'Copy code',
  'preview.copiedCode': 'Copied',
  'preview.footnotes': 'Footnotes',
  'format.pdf': 'PDF',
  'format.docx': 'DOCX',
  'format.pptx': 'PPTX',
  'format.xlsx': 'XLSX',
  'format.mib': '{value} MiB',
  'format.kib': '{value} KiB',
} as const

export const zh = {
  'intake.count': '每条消息最多可附加 {count} 个文档。',
  'intake.type': '请选择扩展名与类型一致的 PDF、DOCX、PPTX 或 XLSX 文件。',
  'intake.fileSize': '每个文档不得超过 {size}。',
  'intake.totalSize': '单条消息中的文档总大小不得超过 {size}。',
  'submit.failed': '无法提交文档消息。',
  'command.unsupported': '斜杠命令不接受文档附件。',
  'drop.title': '将图片或文档拖放到此处',
  'drop.desc': '支持 PDF、DOCX、PPTX 或 XLSX；最多 {count} 个文档，每个不超过 {size}。',
  'draft.group': '待发送文档',
  'draft.remove': '移除 {name}',
  'history.group': '已附加文档',
  'preview.title': '文档预览',
  'preview.open': '在侧边栏预览{name}',
  'preview.loading': '正在加载文档预览…',
  'preview.empty': '此文档未提取到文本内容。',
  'preview.failed': '无法加载此文档预览。',
  'preview.copyCode': '复制代码',
  'preview.copiedCode': '已复制',
  'preview.footnotes': '脚注',
  'format.pdf': 'PDF',
  'format.docx': 'DOCX',
  'format.pptx': 'PPTX',
  'format.xlsx': 'XLSX',
  'format.mib': '{value} MiB',
  'format.kib': '{value} KiB',
} as const

type DocumentLocaleKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Product copy for document intake and durable document cards. */
    documentAttachments: DocumentLocaleKey
  }
}
