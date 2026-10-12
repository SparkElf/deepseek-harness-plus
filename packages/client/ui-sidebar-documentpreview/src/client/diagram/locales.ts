/** Locale-owned diagram implementation name and status text. */
export const zh = {
  title: '图表',
  loading: '正在解析图表…',
  failed: '无法解析这份图表文件。',
  empty: '这份图表没有可渲染的节点。',
} satisfies Record<string, string>

/** Diagram renderer dictionary keys. */
export type DiagramPreviewKey = keyof typeof zh

/** English dictionary with the same keys as the Chinese dictionary. */
export const en = {
  title: 'Diagram',
  loading: 'Parsing diagram…',
  failed: 'This diagram file could not be parsed.',
  empty: 'This diagram has no renderable nodes.',
} satisfies Record<DiagramPreviewKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Diagram renderer copy. */
    documentDiagram: DiagramPreviewKey
  }
}
