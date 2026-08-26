// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { PendingSteeringBubble } from '../src/client/chat/MessageItem.tsx'

afterEach(() => {
  cleanup()
})

type PendingProps = Parameters<typeof PendingSteeringBubble>[0]

const t = ((key: string): string => {
  if (key === 'document.label') return '文档'
  if (key === 'message.extraBlock') return '附加内容块'
  if (key === 'json.truncated') return '已截断'
  return key
}) as PendingProps['t']

describe('message document cards', () => {
  it('renders durable document metadata as a compact card instead of unknown JSON', () => {
    const view = render(<PendingSteeringBubble
      content={[{
        type: 'document',
        attachment: {
          attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
          mediaType: 'application/pdf',
          bytes: 2048,
          name: 'report.pdf',
        },
        parsed: {
          parser: 'mineru',
          markdown: { attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`), mediaType: 'text/markdown', bytes: 4 },
          contentList: { attachmentId: AttachmentId(`sha256:${'c'.repeat(64)}`), mediaType: 'application/json', bytes: 2 },
          images: [],
        },
      }]}
      renderMessageImages={() => null}
      t={t}
    />)

    expect(view.getByRole('group', { name: '文档' })).toBeTruthy()
    expect(view.getByText('PDF')).toBeTruthy()
    expect(view.getByText('report.pdf')).toBeTruthy()
    expect(view.getByText('2.0 KB')).toBeTruthy()
    expect(view.queryByText('附加内容块')).toBeNull()
    expect(view.container.querySelector('[data-message-document]')).toBeTruthy()
  })
})
