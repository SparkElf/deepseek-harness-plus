/**
 * The create-room dialog.
 *
 * Three fields are required because each one decides something the room cannot change
 * later — the name, the working directory, and the agent preset. `cwd` is the real
 * security boundary: every member of the room can ask the agent to modify anything under
 * it, so the field carries a visible warning rather than a hint.
 *
 * The three policy switches are the room's settings, offered at creation so a room is not
 * born with defaults the creator would have chosen differently. The notice at the foot is
 * required wording: these settings control where a room appears, not who may reach it.
 *
 * @module @sparkelf/dsh-group-chat/client/CreateRoomDialog
 */

import { useEffect, useState, type ReactNode } from 'react'
import { Button, Input, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { createRoom, listDirectories, readOptions, type PresetOption } from './api.ts'
import { Picker } from './Picker.tsx'
import { PresetSelect } from './PresetSelect.tsx'
import { type PickerOption } from './rows.ts'
import { failureOf, type RoomStore } from './store.ts'
import type { GroupChatKey } from './locales.ts'
import styles from './CreateRoomDialog.module.css'

/** Props the page half passes. */
export interface CreateRoomDialogProps {
  readonly t: (key: GroupChatKey) => string
  /**
   * Lookup for the platform's own preset copy.
   *
   * Separate from `t` because it is a different namespace: `t` resolves this plugin's keys,
   * while this one resolves `settings.agentPreset`, which the platform registers. Keeping them
   * apart is what lets a shipped preset show the platform's wording without this plugin
   * reprinting it.
   */
  readonly tPreset: (key: string) => string
  readonly store: RoomStore
}

/** Invite policy values the backend accepts. */
type InvitePolicy = 'anyone' | 'admin'
/** Discoverability values the backend accepts. */
type Discoverability = 'discoverable' | 'invite_only'
/** Agent trigger values the backend accepts. */
type AgentTrigger = 'mention' | 'always' | 'never'

/**
 * Render the create-room dialog.
 * @param props - the copy resolver and shared store whose `pendingCreate` opens this.
 * @returns the dialog, or null while closed.
 */
export function CreateRoomDialog(props: CreateRoomDialogProps) {
  const { t, tPreset, store } = props
  const open = store.getState().pendingCreate

  const [name, setName] = useState('')
  const [cwd, setCwd] = useState('')
  // `standard` is the only preset every deployment ships. An empty value used to be sent as
  // "no preset", which the host resolved to its own `default` and answered with
  // 503 Unknown agent preset; naming the shipped preset explicitly keeps room creation working.
  const [preset, setPreset] = useState('standard')
  const [invitePolicy, setInvitePolicy] = useState<InvitePolicy>('anyone')
  const [discoverability, setDiscoverability] = useState<Discoverability>('discoverable')
  const [agentTrigger, setAgentTrigger] = useState<AgentTrigger>('mention')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<GroupChatKey | undefined>(undefined)
  // Preset names the deployment offers. Empty means the picker could not be filled, and the
  // field then falls back to typing — the dialog must not become unusable because a listing
  // failed.
  const [presets, setPresets] = useState<readonly PresetOption[]>([])
  const [directories, setDirectories] = useState<readonly PickerOption[]>([])
  const [dirPath, setDirPath] = useState('')

  // Read once when the dialog opens rather than at module load: the deployment's presets and
  // its directories can both change while the page is up, and a failed read must be retried
  // by reopening instead of being cached for the life of the page.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      try {
        const options = await readOptions()
        if (!cancelled) setPresets(options.presets)
      } catch {
        if (!cancelled) setPresets([])
      }
    })()
    return () => { cancelled = true }
  }, [open])

  // The directory list follows `cwd` only after a pick. Re-listing on every keystroke would
  // fight the operator: a half-typed path is usually an invalid one, and the list would flip
  // to empty between characters.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      try {
        const listing = await listDirectories(dirPath.length === 0 ? undefined : dirPath)
        if (cancelled) return
        const entries = listing.entries.map((entry) => ({
          id: entry.path,
          label: entry.name,
          secondary: entry.path,
        }))
        // The current directory is offered as the first row: the common case is accepting the
        // root, and without it the list can only ever move deeper.
        setDirectories([
          { id: listing.path, label: listing.path, secondary: t('pickThisDirectory') },
          ...(listing.parent === null
            ? []
            : [{ id: listing.parent, label: '..', secondary: listing.parent }]),
          ...entries,
        ])
      } catch {
        if (!cancelled) setDirectories([])
      }
    })()
    return () => { cancelled = true }
  }, [open, dirPath, t])

  // A reopened dialog starts clean, so a cancelled attempt leaves nothing behind.
  useEffect(() => {
    if (!open) {
      setName(''); setBusy(false); setError(undefined)
    }
  }, [open])

  const close = (): void => store.closeCreate()

  const submit = async (): Promise<void> => {
    if (name.trim().length === 0 || busy) return
    setBusy(true)
    try {
      const room = await createRoom(name.trim(), {
        // Empty means "use the server's default", so it is omitted rather than sent blank.
        ...cwd.trim().length === 0 ? {} : { cwd: cwd.trim() },
        ...preset.trim().length === 0 ? {} : { agentPreset: preset.trim() },
      })
      // The policies travel as a follow-up update rather than create-time fields, so a
      // failure to apply them still leaves a usable room instead of none.
      await Promise.all([
        invitePolicy === 'anyone' ? Promise.resolve() : store.setPolicy(room.id, { invitePolicy }),
        discoverability === 'discoverable' ? Promise.resolve() : store.setPolicy(room.id, { discoverability }),
        agentTrigger === 'mention' ? Promise.resolve() : store.setPolicy(room.id, { agentTrigger }),
      ])
      await store.refresh()
      store.open(room.id)
      close()
    } catch (cause) {
      setError(failureOf(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={t('createTitle')}
      closeLabel={t('cancel')}
      footer={(
        <div className={styles.footer}>
          <Button variant="ghost" size="md" onClick={close}>{t('cancel')}</Button>
          <Button
            variant="primary"
            size="md"
            disabled={busy || name.trim().length === 0}
            onClick={() => void submit()}
          >
            {t('createSubmit')}
          </Button>
        </div>
      )}
    >
      <div className={styles.body}>
        <label className={styles.field}>
          <span className={styles.label}>{t('createName')}</span>
          <Input
            value={name}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void submit() }}
          />
        </label>

        {/* Required and security-relevant: this field decides what the agent can touch on
            behalf of everyone in the room, so it is shown with its consequence. */}
        <div className={styles.field}>
          <span className={styles.label}>{t('createCwd')}</span>
          <Picker
            value={cwd}
            options={directories}
            placeholder="/workspace"
            emptyHint={t('optionEmpty')}
            onQueryChange={(next) => { setCwd(next) }}
            onTypedCommit={(text) => { setCwd(text); setDirPath(text) }}
            typedCommitLabel={(text) => text}
            onPick={(option) => {
              // Browsing and choosing are the same gesture here: taking a directory both sets
              // the value and moves the list into it, so the field never shows a path whose
              // contents the operator cannot see.
              setCwd(option.id)
              setDirPath(option.id)
            }}
          />
          <span className={styles.warn}>{t('createCwdHint')}</span>
        </div>

        <div className={styles.field}>
          <span className={styles.label}>{t('createPreset')}</span>
          {presets.length === 0
            // The roster could not be read. Falling back to a text box would accept any string,
            // and a preset the registry does not hold fails only after the room is submitted —
            // so the field states the one thing it can promise instead: the deployment default.
            ? <span className={styles.hint}>{t('createPresetUnavailable')}</span>
            : (
              <PresetSelect
                presets={presets}
                value={preset}
                t={tPreset}
                defaultLabel={t('createPresetDefault')}
                onChange={setPreset}
              />
            )}
          <span className={styles.hint}>{t('createPresetHint')}</span>
        </div>

        <div className={styles.switches}>
          <Switch
            checked={invitePolicy === 'anyone'}
            onChange={(next) => setInvitePolicy(next ? 'anyone' : 'admin')}
            label={t('createPolicy')}
          />
          <Switch
            checked={discoverability === 'discoverable'}
            onChange={(next) => setDiscoverability(next ? 'discoverable' : 'invite_only')}
            label={t('createVisibility')}
          />
          <Switch
            checked={agentTrigger === 'mention'}
            onChange={(next) => setAgentTrigger(next ? 'mention' : 'always')}
            label={t('createTrigger')}
          />
          <div className={styles.triggerExtra}>
            {(['mention', 'always', 'never'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={agentTrigger === mode ? styles.pillActive : styles.pill}
                onClick={() => setAgentTrigger(mode)}
              >
                {mode === 'mention' ? t('triggerMention')
                  : mode === 'always' ? t('triggerAlways') : t('triggerNever')}
              </button>
            ))}
          </div>
        </div>

        {/* Required wording: these settings are about appearance, not authorization. */}
        <p className={styles.notice}>{t('createNotice')}</p>
        {error !== undefined && <p className={styles.error}>{t(error)}</p>}
      </div>
    </Modal>
  )
}
