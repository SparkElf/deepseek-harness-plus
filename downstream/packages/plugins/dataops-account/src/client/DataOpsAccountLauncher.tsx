/**
 * The DataOps account launcher.
 *
 * This component shadows the official `settings.launcher` cell, so it also owns
 * the two menu rows that remain meaningful in a DataOps deployment: Settings
 * and Feedback. The official sign-in row is gone by construction — there is no
 * DeepSeek account to sign into, and the portal already authenticated the
 * operator. Settings still opens through the slot's own `openSettings`
 * callback, which is the same action the official launcher invoked.
 *
 * Feedback opens a dialog in this frame. The submit travels over the portal
 * bridge because the iframe holds no DataOps credential; nothing navigates to
 * an external form.
 *
 * @module @sparkelf/dsh-dataops-account/client/DataOpsAccountLauncher
 */

import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import {
  Button, Input, Menu, Modal, Toast,
  IconPaperPlaneOutlineMedium, IconSettingsOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccountKey } from './locales.ts'
import { submitFeedback, type FeedbackCategory } from './feedback.ts'
import { reportAvatarFallback, useIdentity, type DataOpsIdentity } from './identity.ts'
import css from './DataOpsAccountLauncher.module.css'

/** Owner props the settings shell hands every launcher registration. */
export interface SettingsLauncherOwnerProps {
  readonly wide: boolean
  readonly settingsOpen: boolean
  readonly settingsShortcut?: {
    readonly keys: readonly string[]
    readonly aria?: string | undefined
  }
  readonly openSettings: () => void
  readonly openOnboarding: (id: string) => void
}

/** What this plugin injects into its own registration. */
export interface DataOpsAccountInjected {
  readonly t: (key: AccountKey) => string
}

/** DataOps brand blue for the role disc; matches the portal's role badge. */
const ROLE_BADGE_BLUE = '#175cd3'

const CATEGORIES: readonly FeedbackCategory[] = ['feature', 'bug', 'other']
const CATEGORY_KEYS: Record<FeedbackCategory, AccountKey> = {
  feature: 'feedbackCategoryFeature',
  bug: 'feedbackCategoryBug',
  other: 'feedbackCategoryOther',
}
const MAX_CONTENT = 2000
const MAX_CONTACT = 200

/** The disc's letter: the role name's first grapheme, or `D` while waiting. */
const discLetter = (identity: DataOpsIdentity | null): string => identity?.initial ?? 'D'

/** Map a bridge failure onto readable copy; backend messages pass through. */
const failureText = (error: unknown, t: (key: AccountKey) => string): string => {
  const message = error instanceof Error ? error.message : ''
  if (message === 'timeout') return t('feedbackTimeout')
  if (message === 'not-embedded' || message === 'feedback-cancelled') return t('feedbackUnavailable')
  if (message === 'http-429') return t('feedbackRateLimited')
  if (
    message === ''
    || message === 'feedback-failed'
    || message === 'invalid-feedback'
    || message === 'unauthenticated'
    || message === 'duplicate'
    || message.startsWith('http-')
  ) return t('feedbackFailed')
  return message
}

type Props = SettingsLauncherOwnerProps & DataOpsAccountInjected

/**
 * Render the DataOps avatar, nickname, the surviving account actions, and the
 * in-frame feedback dialog.
 * @param props - sidebar geometry, settings actions, and the plugin's copy binder.
 * @returns the launcher button, its menu, and the feedback dialog.
 */
export function DataOpsAccountLauncher({
  wide, settingsOpen, settingsShortcut, openSettings, t,
}: Props): ReactNode {
  const identity = useIdentity()
  const [open, setOpen] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)

  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [category, setCategory] = useState<FeedbackCategory>('feature')
  const [content, setContent] = useState('')
  const [contact, setContact] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [feedbackError, setFeedbackError] = useState('')
  const [toast, setToast] = useState(0)

  useEffect(() => {
    setImageFailed(false)
  }, [identity?.avatarUrl])

  // A keyboard shortcut can open Settings while this menu is up; leaving the
  // list floating over the modal would strand it there.
  useEffect(() => {
    if (settingsOpen) setOpen(false)
  }, [settingsOpen])

  const showImage = identity !== null && identity.avatarUrl !== '' && !imageFailed
  const label = identity?.name ?? t('identityPending')

  const shortcut = settingsShortcut?.aria ?? settingsShortcut?.keys.join('+')
  const settingsLabel: ReactNode = shortcut === undefined
    ? t('settings')
    : (
        <span className={css.itemLabel}>
          <span>{t('settings')}</span>
          <kbd className={css.shortcut}>{shortcut}</kbd>
        </span>
      )

  const items: readonly MenuEntry[] = [
    {
      id: 'settings',
      label: settingsLabel,
      icon: <IconSettingsOutlineMedium size={16} />,
    },
    {
      id: 'contact',
      label: t('contactUs'),
      icon: <IconPaperPlaneOutlineMedium size={16} />,
    },
  ]

  const openFeedback = (): void => {
    setOpen(false)
    setCategory('feature')
    setContent('')
    setContact('')
    setFeedbackError('')
    setSubmitting(false)
    setFeedbackOpen(true)
  }

  const closeFeedback = (): void => {
    if (submitting) return
    setFeedbackOpen(false)
    setFeedbackError('')
  }

  const submit = async (): Promise<void> => {
    const trimmed = content.trim()
    if (trimmed === '') {
      setFeedbackError(t('feedbackRequired'))
      return
    }
    if (content.length > MAX_CONTENT) {
      setFeedbackError(t('feedbackTooLong'))
      return
    }
    if (contact.trim().length > MAX_CONTACT) {
      setFeedbackError(t('feedbackContactTooLong'))
      return
    }
    setSubmitting(true)
    setFeedbackError('')
    try {
      await submitFeedback({
        category,
        content: trimmed,
        contact: contact.trim(),
        pageUrl: window.location.href,
      })
      setFeedbackOpen(false)
      setContent('')
      setContact('')
      setToast(value => value + 1)
    } catch (error) {
      setFeedbackError(failureText(error, t))
    } finally {
      setSubmitting(false)
    }
  }

  const contentOverLimit = content.length > MAX_CONTENT

  return (
    <>
      <Menu
        open={open}
        side="top"
        align="start"
        portal
        autoFocus
        className={css.menu}
        anchor={(
          <button
            type="button"
            className={wide ? css.trigger : `${css.trigger} ${css.triggerCollapsed}`}
            data-dataops-account="launcher"
            data-dataops-identity={identity === null ? 'pending' : 'ready'}
            aria-label={t('menu')}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => { setOpen(value => !value) }}
          >
            <span
              className={css.avatar}
              data-dataops-avatar={showImage ? 'image' : 'initial'}
              style={{ background: ROLE_BADGE_BLUE }}
            >
              {showImage ? (
                <img
                  className={css.avatarImage}
                  src={identity.avatarUrl}
                  alt=""
                  onError={() => {
                    setImageFailed(true)
                    reportAvatarFallback()
                  }}
                />
              ) : (
                <span className={css.initial} aria-hidden="true">{discLetter(identity)}</span>
              )}
            </span>
            {wide && <span className={css.label} data-dataops-account-name>{label}</span>}
          </button>
        )}
        items={items}
        onClose={() => { setOpen(false) }}
        onSelect={(id) => {
          setOpen(false)
          if (id === 'settings') openSettings()
          else if (id === 'contact') openFeedback()
        }}
      />

      <Modal
        open={feedbackOpen}
        onClose={closeFeedback}
        title={t('feedbackTitle')}
        description={t('feedbackDescription')}
        closeLabel={t('feedbackClose')}
        footer={(
          <>
            <Button variant="outline" onClick={closeFeedback} disabled={submitting}>
              {t('feedbackCancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => { void submit() }}
              disabled={submitting || content.trim() === ''}
              data-dataops-feedback-submit
            >
              {submitting ? t('feedbackSubmitting') : t('feedbackSubmit')}
            </Button>
          </>
        )}
      >
        <div className={css.form}>
          <fieldset className={css.fieldset}>
            <legend className={css.fieldLabel}>{t('feedbackCategory')}</legend>
            <div className={css.radioRow}>
              {CATEGORIES.map(value => (
                <label key={value} className={css.radioLabel}>
                  <input
                    type="radio"
                    name="dataops-feedback-category"
                    value={value}
                    checked={category === value}
                    disabled={submitting}
                    onChange={() => { setCategory(value) }}
                  />
                  <span>{t(CATEGORY_KEYS[value])}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <label className={css.field}>
            <span className={css.fieldLabel}>{t('feedbackContent')}</span>
            <textarea
              className={contentOverLimit ? `${css.textarea} ${css.textareaOver}` : css.textarea}
              rows={6}
              value={content}
              autoFocus
              disabled={submitting}
              placeholder={t('feedbackContentPlaceholder')}
              aria-invalid={feedbackError !== '' || contentOverLimit}
              onChange={(event) => { setContent(event.target.value) }}
            />
            <span className={contentOverLimit ? `${css.counter} ${css.counterOver}` : css.counter}>
              {content.length}/{MAX_CONTENT}
            </span>
          </label>

          <label className={css.field}>
            <span className={css.fieldLabel}>{t('feedbackContact')}</span>
            <Input
              className={css.inputFull}
              value={contact}
              disabled={submitting}
              placeholder={t('feedbackContactPlaceholder')}
              onChange={(event) => { setContact(event.target.value) }}
            />
          </label>

          <p className={css.context}>
            <span>{t('feedbackContext')}: </span>
            <span className={css.contextValue} title={window.location.href}>{window.location.href}</span>
          </p>

          {feedbackError !== '' && (
            <p className={css.error} role="alert" data-dataops-feedback-error>{feedbackError}</p>
          )}
        </div>
      </Modal>

      {toast > 0 && (
        <Toast
          key={toast}
          text={t('feedbackSuccess')}
          onDone={() => { setToast(0) }}
        />
      )}
    </>
  )
}