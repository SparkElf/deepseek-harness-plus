/**
 * The Home surface's "New" chooser.
 *
 * A new document is not a file-manager operation here: it starts a conversation
 * that writes the document. The dialog therefore asks what kind of artefact the
 * reader wants and hands the prompt to the conversation surface, instead of
 * asking for a file name and a directory the reader has not opened yet.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import type { ReactNode } from 'react'
import { Button, FileTypeIcon, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './KnowledgeNewDocumentDialog.module.css'

/** The document kinds the conversation can create. */
export type NewDocumentKind = 'document' | 'spreadsheet' | 'presentation'

/** One choice in the dialog. */
interface Choice {
  readonly kind: NewDocumentKind
  readonly title: string
  readonly fileIcon: 'word' | 'excel' | 'ppt'
  readonly prompt: string
}

const CHOICES: readonly Choice[] = [
  {
    kind: 'document',
    title: '文档',
    fileIcon: 'word',
    prompt: '帮我创建一份文档',
  },
  {
    kind: 'spreadsheet',
    title: '表格',
    fileIcon: 'excel',
    prompt: '帮我创建一份表格',
  },
  {
    kind: 'presentation',
    title: 'PPT',
    fileIcon: 'ppt',
    prompt: '帮我创建一份PPT',
  },
]

/** Props for the chooser. */
export interface KnowledgeNewDocumentDialogProps {
  /** Whether the dialog is showing. */
  open: boolean
  /** Close without choosing a type. */
  onClose: () => void
  /** Start a conversation with the chosen prompt, caret after "一份". */
  onCreate: (prompt: string, caretOffset: number) => void
  /** Open the conventional folder form instead. */
  onNewFolder: () => void
  /** Locale-bound copy resolver. */
  t: (key: string) => string
}

/**
 * Render the type chooser.
 * @param props - open state and the two actions.
 * @returns The dialog.
 */
export function KnowledgeNewDocumentDialog(props: KnowledgeNewDocumentDialogProps): ReactNode {
  const { open, onClose, onCreate, onNewFolder, t } = props
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('homeNewTitle')}
      closeLabel={t('cancel')}
      className={styles.modal}
      footer={(
        <div className={styles.footer}>
          <Button variant="ghost" onClick={onNewFolder}>{t('cardItemNewFolder')}</Button>
          <Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>
        </div>
      )}
    >
      <div className={styles.dialog}>
        <div className={styles.cards}>
          {CHOICES.map(choice => (
            <button
              key={choice.kind}
              type="button"
              className={styles.card}
              onClick={() => { onCreate(choice.prompt, 6) }}
            >
              <span className={styles.iconPlate} data-kind={choice.kind} aria-hidden="true">
                <FileTypeIcon kind={choice.fileIcon} size={30} />
              </span>
              <span className={styles.cardText}>
                <span className={styles.cardTitle}>{choice.title}</span>
                </span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}
