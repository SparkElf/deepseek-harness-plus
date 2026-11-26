import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, StateDot, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import {
  KB_API,
  kbApiPath,
  type DeployHostView,
  type DeployRunView,
  type DeployStepView,
  type GrantView,
  type KnowledgeConfigView,
  type KnowledgeConfigWriteResult,
  type KnowledgeStatusView,
} from '../api.ts'
import { hasDeployTarget } from './deployTarget.ts'
import type { en } from './locales.ts'
import styles from './KnowledgeSettingsSection.module.css'
import { VectorSettingsGroup } from './VectorSettingsGroup.tsx'

/** Values injected by the DSH Settings slot. */
export interface KnowledgeSettingsInjected {
  /** Translate one knowledge-base message key. */
  t: (key: keyof typeof en) => string
}

/** Props accepted by the injected Settings section. */
export type KnowledgeSettingsProps = Partial<InjectFace<KnowledgeSettingsInjected>>

/** Distinguish the states the panel must render differently. */
type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; config: KnowledgeConfigView; status: KnowledgeStatusView; grants: GrantView[] }
  | { kind: 'unavailable' }

/** POST one JSON method and decode the reply. */
async function postJson<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(kbApiPath(method as never), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  const decoded = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(decoded.error ?? `HTTP ${String(response.status)}`)
  return decoded
}

/**
 * The storage settings as the reader is editing them.
 *
 * Strings throughout, including the port, because these are bound to inputs: a number input
 * still yields text, and holding a half-typed port as a number would fight the caret.
 */
interface StorageDraft {
  mode: 'local' | 'remote'
  protocol: 'nfs' | 'sshfs'
  storageRoot: string
  nfsServer: string
  sshHost: string
  sshUser: string
  sshPort: string
  sshRemotePath: string
  sshMountOptions: string
  sshKeyRef: string
}

const EMPTY_DRAFT: StorageDraft = {
  mode: 'local',
  protocol: 'nfs',
  storageRoot: '~/kb',
  nfsServer: '',
  sshHost: '',
  sshUser: '',
  sshPort: '22',
  sshRemotePath: '',
  sshMountOptions: '',
  sshKeyRef: '',
}

/** What a save attempt ended as. */
type SaveState =
  | { kind: 'idle' }
  | { kind: 'saved' }
  | { kind: 'failed'; message: string }

/** Seed the draft from what the deployment reports. */
function draftOf(config: KnowledgeConfigView, status: KnowledgeStatusView): StorageDraft {
  const ssh = config.ssh
  return {
    mode: status.storageMode === 'remote' ? 'remote' : 'local',
    protocol: status.storageProtocol ?? config.storageProtocol ?? 'nfs',
    storageRoot: config.storageRoot ?? '~/kb',
    nfsServer: config.nfsServer ?? '',
    sshHost: ssh?.host ?? '',
    sshUser: ssh?.user ?? '',
    sshPort: String(ssh?.port ?? 22),
    sshRemotePath: ssh?.remotePath ?? '',
    sshMountOptions: ssh?.mountOptions ?? '',
    sshKeyRef: ssh?.keyRef ?? '',
  }
}

/**
 * Render the knowledge-base connection, resolved paths, status, the read-only
 * authorization summary, and the deployment wizard.
 *
 * Authorization itself is deliberately absent: DataOps owns grants, and this
 * panel only reports what the backend says (AGENTS.md "Managed DataOps
 * Authorization" forbids replicating that policy in a plugin).
 *
 * @param props - Settings slot injection values.
 * @returns The localized Settings section, or nothing before injection.
 */
export function KnowledgeSettingsSection(props: KnowledgeSettingsProps) {
  const { t } = props
  if (t === undefined) return null
  return <Loaded t={t} />
}

function Loaded({ t }: { t: KnowledgeSettingsInjected['t'] }) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  // 知识库自己的偏好（当前只有 MinerU 地址与 review 开关）与部署配置是两条读路径：
  // 前者是每个 caller 的 view 目录里的文件，后者是部署级配置。分开加载，互不阻塞。
  /**
   * MinerU settings: the stored address, the address this deployment derives when
   * none is stored, and whether the caller may write either.
   *
   * `stored === ''` is what "derive it" looks like, so the derived address is a
   * separate field rather than a client-side guess: it is computed by the Host from
   * the live config and sent back with the settings.
   */
  const [mineru, setMineru] = useState<
    {
      stored: string
      derived: string
      canEdit: boolean
      source?: 'own' | 'shared' | 'derived'
      invalidFallback?: boolean
    } | undefined
  >(undefined)
  const [mineruDraft, setMineruDraft] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  // What the reader is editing, seeded from the server and saved by an explicit action.
  // Deliberately NOT applied on change: the deployment's storage shape is decided when the
  // workspace container is created, so a radio button that silently rewrote it would be
  // claiming an effect it cannot have. The reader edits, presses save, and is told what the
  // save means for the running deployment.
  const [draft, setDraft] = useState<StorageDraft>(EMPTY_DRAFT)
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' })
  /**
   * The stored review flag, held for the merged write.
   *
   * `settings.set` replaces one record that also carries the review switch, and that
   * switch belongs to another page. Sending the stored value keeps this page's save
   * from silently flipping a setting it does not show.
   */
  const reviewRequiredRef = useRef(false)

  const load = useCallback(async () => {
    setState({ kind: 'loading' })
    try {
      const config = await postJson<KnowledgeConfigView>(KB_API.config)
      const status = await postJson<KnowledgeStatusView>(KB_API.status)
      const grantsReply = await postJson<{ grants: GrantView[] }>(KB_API.grants)
      setState({ kind: 'ready', config, status, grants: grantsReply.grants })
      // 设置读取失败不能拖垮整个分节：地址是附加配置，读不到就按"未配置"显示，
      // 用户可以照样改存储模式与部署。
      try {
        const reply = await postJson<{
          settings?: { mineruBaseUrl?: string }
          canEdit?: boolean
          // The address in effect, resolved by the Host when nothing is stored. Absent
          // when the deployment has neither a shared address nor a usable port, in which
          // case there is nothing to show and the field stays empty.
          mineruUrl?: string
          // Where `mineruUrl` came from. `shared` means the 「文档识别」 plugin's
          // administrator set it for the whole deployment; `derived` means this deployment
          // computed it from its own port. The caption differs, because a reader must not
          // mistake a shared value for one they own.
          mineruSource?: 'own' | 'shared' | 'derived'
          // The stored value was refused as invalid, so what the field shows is a
          // fallback. Reported separately from `mineruUrl` because the address itself
          // cannot say where it came from.
          mineruInvalid?: boolean
        }>(KB_API.settingsGet)
        setMineru({
          stored: typeof reply.settings?.mineruBaseUrl === 'string' ? reply.settings.mineruBaseUrl : '',
          derived: typeof reply.mineruUrl === 'string' ? reply.mineruUrl : '',
          canEdit: reply.canEdit === true,
          source: reply.mineruSource,
          invalidFallback: reply.mineruInvalid === true,
        })
        reviewRequiredRef.current = (reply.settings as { reviewRequired?: boolean } | undefined)?.reviewRequired === true
        setMineruDraft(undefined)
      } catch {
        setMineru({ stored: '', derived: '', canEdit: false })
      }
      setDraft(draftOf(config, status))
      setSaveState({ kind: 'idle' })
    } catch {
      setState({ kind: 'unavailable' })
    }
  }, [])

  useEffect(() => { void load() }, [load])

  /**
   * Persist everything this section edits, in one action.
   *
   * One button rather than one per group: the two groups are two halves of the same
   * settings record and the reader edits them as one page, so two buttons made every
   * visit a question of which one to press. Both writes are the same click.
   *
   * The two writes are issued together but reported apart, because they can fail
   * apart: `config.set` writes the deployment's storage shape and `settings.set` writes
   * the caller's MinerU address, and a partial failure has to name which half landed.
   *
   * A port that is not a number is refused before the round trip: the server would
   * reject it anyway, and the answer belongs beside the field that was typed in.
   */
  const save = useCallback(async () => {
    setBusy(true); setSaveState({ kind: 'idle' })
    const port = Number(draft.sshPort)
    if (draft.protocol === 'sshfs' && (!Number.isInteger(port) || port <= 0 || port > 65_535)) {
      setSaveState({ kind: 'failed', message: t('saveBadPort') })
      setBusy(false)
      return
    }

    // Only an edited field is written. Untouched, the input shows the derived address,
    // and sending that back would freeze today's derivation into an explicit setting --
    // so a deployment that only follows its configured port would acquire a stored
    // address the moment someone pressed save for an unrelated reason.
    const mineruChanged = mineruDraft !== undefined && mineru !== undefined && mineruDraft !== mineru.stored

    let storageFailure: string | undefined
    try {
      await postJson<KnowledgeConfigWriteResult>(KB_API.configSet, {
        storageMode: draft.mode,
        storageProtocol: draft.protocol,
        storageRoot: draft.storageRoot,
        nfsServer: draft.nfsServer,
        sshHost: draft.sshHost,
        sshUser: draft.sshUser,
        sshPort: draft.protocol === 'sshfs' ? port : 22,
        sshRemotePath: draft.sshRemotePath,
        sshMountOptions: draft.sshMountOptions,
        sshKeyRef: draft.sshKeyRef,
      })
    } catch (error) {
      storageFailure = error instanceof Error ? error.message : String(error)
    }

    let settingsFailure: string | undefined
    if (mineruChanged) {
      try {
        const reply = await postJson<{
          settings?: { mineruBaseUrl?: string }
          mineruUrl?: string
        }>(KB_API.settingsSet, {
          // The review switch lives in this record but belongs to another page; sent as
          // the value already stored so this write cannot change it.
          reviewRequired: reviewRequiredRef.current,
          mineruBaseUrl: mineruDraft,
        })
        const stored = typeof reply.settings?.mineruBaseUrl === 'string' ? reply.settings.mineruBaseUrl : ''
        setMineru(current => (current === undefined ? current : {
          ...current,
          stored,
          derived: typeof reply.mineruUrl === 'string' ? reply.mineruUrl : current.derived,
        }))
        setMineruDraft(undefined)
      } catch (error) {
        settingsFailure = error instanceof Error ? error.message : String(error)
      }
    }

    // Re-read both sources: the Host normalises what it stores, and the restart flag
    // below is about the deployment, not about what this page asked for.
    try {
      const status = await postJson<KnowledgeStatusView>(KB_API.status)
      setState(current => (current.kind === 'ready' ? { ...current, status } : current))
    } catch {
      // A status read is only used for the restart hint; a failure here must not report
      // a save that succeeded as broken.
    }

    if (storageFailure !== undefined || settingsFailure !== undefined) {
      setSaveState({ kind: 'failed', message: (storageFailure ?? settingsFailure) as string })
    } else {
      setSaveState({ kind: 'saved' })
    }
    setBusy(false)
  }, [draft, mineru, mineruDraft, t])

  if (state.kind === 'loading') {
    return (
      <section className={styles.section}>
        <h2 className={styles.title}>{t('title')}</h2>
        <p className={styles.detail}>{t('loading')}</p>
      </section>
    )
  }

  if (state.kind === 'unavailable') {
    return (
      <section className={styles.section}>
        <h2 className={styles.title}>{t('title')}</h2>
        <div className={styles.statusRow}>
          <StateDot state="error" />
          <span className={styles.statusLabel} role="alert">{t('unavailable')}</span>
        </div>
        <p className={styles.detail}>{t('unavailableDetail')}</p>
      </section>
    )
  }

  const { config, status } = state

  /**
   * Whether the save changed the shape the running deployment was started with.
   *
   * The mount is a bind decided at container create, so a stored change to it cannot
   * take effect until the workspace container is recreated. Comparing the draft with
   * what `status` reports is the only honest way to know: the write succeeded either
   * way, and saying nothing would leave the reader waiting for an effect that is not
   * coming.
   */
  const restartNeeded = draft.mode !== (status.storageMode === 'remote' ? 'remote' : 'local')
    || draft.protocol !== (status.storageProtocol ?? config.storageProtocol ?? 'nfs')

  return (
    <section className={styles.section}>
      <h2 className={styles.title}>{t('title')}</h2>

      <div className={styles.body}>
          {/* Storage: what decides the rest of this section. The reader edits and presses
              save; nothing here is applied on change, because the shape is fixed when the
              workspace container is created. */}
          <h3 className={styles.groupTitle}>{t('storageMode')}</h3>
          <div className={styles.modeRow} role="radiogroup" aria-label={t('storageMode')}>
            <label className={styles.modeOption}>
              <input
                type="radio"
                name="kb-storage-mode"
                value="local"
                checked={draft.mode === 'local'}
                onChange={() => { setDraft(d => ({ ...d, mode: 'local' })); setSaveState({ kind: 'idle' }) }}
              />
              <span>{t('storageModeLocal')}</span>
            </label>
            <label className={styles.modeOption}>
              <input
                type="radio"
                name="kb-storage-mode"
                value="remote"
                checked={draft.mode === 'remote'}
                onChange={() => { setDraft(d => ({ ...d, mode: 'remote' })); setSaveState({ kind: 'idle' }) }}
              />
              <span>{t('storageModeRemote')}</span>
            </label>
          </div>

          {draft.mode === 'local' && (
            <>
              <h3 className={styles.groupTitle}>{t('storageRoot')}</h3>
              <div className={styles.field}>
                <input
                  className={styles.input}
                  type="text"
                  value={draft.storageRoot}
                  placeholder="~/kb"
                  aria-label={t('storageRoot')}
                  onChange={event => { setDraft(d => ({ ...d, storageRoot: event.target.value })); setSaveState({ kind: 'idle' }) }}
                />
              </div>
              <p className={styles.detail}>{t('storageRootHint')}</p>
            </>
          )}

          {draft.mode === 'remote' && (<>
            {/* The transport decides which fields matter, so it is asked for before them. */}
            <h3 className={styles.groupTitle}>{t('storageProtocol')}</h3>
            <div className={styles.modeRow} role="radiogroup" aria-label={t('storageProtocol')}>
              <label className={styles.modeOption}>
                <input
                  type="radio"
                  name="kb-storage-protocol"
                  value="nfs"
                  checked={draft.protocol === 'nfs'}
                  onChange={() => { setDraft(d => ({ ...d, protocol: 'nfs' })); setSaveState({ kind: 'idle' }) }}
                />
                <span>{t('protocolNfs')}</span>
              </label>
              <label className={styles.modeOption}>
                <input
                  type="radio"
                  name="kb-storage-protocol"
                  value="sshfs"
                  checked={draft.protocol === 'sshfs'}
                  onChange={() => { setDraft(d => ({ ...d, protocol: 'sshfs' })); setSaveState({ kind: 'idle' }) }}
                />
                <span>{t('protocolSshfs')}</span>
              </label>
            </div>
            <p className={styles.detail}>
              {draft.protocol === 'nfs' ? t('protocolNfsHint') : t('protocolSshfsHint')}
            </p>

            {draft.protocol === 'nfs' ? (
              <dl className={styles.pairs}>
                <div className={styles.pair}>
                  <dt>{t('nfsServer')}</dt>
                  <dd>
                    <input
                      className={styles.input}
                      type="text"
                      value={draft.nfsServer}
                      placeholder={t('nfsServerPlaceholder')}
                      onChange={event => { setDraft(d => ({ ...d, nfsServer: event.target.value })); setSaveState({ kind: 'idle' }) }}
                    />
                  </dd>
                </div>
              </dl>
            ) : (
              <dl className={styles.pairs}>
                <div className={styles.pair}>
                  <dt>{t('sshHost')}</dt>
                  <dd>
                    <input
                      className={styles.input}
                      type="text"
                      value={draft.sshHost}
                      placeholder={t('sshHostPlaceholder')}
                      onChange={event => { setDraft(d => ({ ...d, sshHost: event.target.value })); setSaveState({ kind: 'idle' }) }}
                    />
                  </dd>
                </div>
                <div className={styles.pair}>
                  <dt>{t('sshUser')}</dt>
                  <dd>
                    <input
                      className={styles.input}
                      type="text"
                      value={draft.sshUser}
                      placeholder={t('sshUserPlaceholder')}
                      onChange={event => { setDraft(d => ({ ...d, sshUser: event.target.value })); setSaveState({ kind: 'idle' }) }}
                    />
                  </dd>
                </div>
                <div className={styles.pair}>
                  <dt>{t('sshPort')}</dt>
                  <dd>
                    <input
                      className={styles.input}
                      type="number"
                      min={1}
                      max={65535}
                      value={draft.sshPort}
                      onChange={event => { setDraft(d => ({ ...d, sshPort: event.target.value })); setSaveState({ kind: 'idle' }) }}
                    />
                  </dd>
                </div>
                <div className={styles.pair}>
                  <dt>{t('sshRemotePath')}</dt>
                  <dd>
                    <input
                      className={styles.input}
                      type="text"
                      value={draft.sshRemotePath}
                      placeholder={t('sshRemotePathPlaceholder')}
                      onChange={event => { setDraft(d => ({ ...d, sshRemotePath: event.target.value })); setSaveState({ kind: 'idle' }) }}
                    />
                  </dd>
                </div>
                <div className={styles.pair}>
                  <dt>{t('sshMountOptions')}</dt>
                  <dd>
                    <input
                      className={styles.input}
                      type="text"
                      value={draft.sshMountOptions}
                      placeholder={t('sshMountOptionsPlaceholder')}
                      onChange={event => { setDraft(d => ({ ...d, sshMountOptions: event.target.value })); setSaveState({ kind: 'idle' }) }}
                    />
                  </dd>
                </div>
                <div className={styles.pair}>
                  <dt>{t('sshKey')}</dt>
                  <dd>
                    {/* The key itself never reaches this page: the panel shows the
                        credential's name and whether it resolves. */}
                    <code>{draft.sshKeyRef === '' ? t('sshKeyUnset') : draft.sshKeyRef}</code>
                    {' '}
                    <span className={config.ssh?.keyConfigured === true ? styles.badgeOk : styles.badgeWarn}>
                      {config.ssh?.keyConfigured === true ? t('sshKeyConfigured') : t('sshKeyMissing')}
                    </span>
                  </dd>
                </div>
              </dl>
            )}

          </>)}

          {/* Where the tree is mounted, and the resolved paths it points at: facts about
              the running deployment rather than settings, so they read as values. */}
          <h3 className={styles.groupTitle}>{t('connection')}</h3>

        <dl className={styles.pairs}>
          <div className={styles.pair}>
            <dt>{t('host')}</dt>
            <dd>{config.host === '' ? t('backendUnset') : config.host}</dd>
          </div>
          <div className={styles.pair}>
            <dt>{t('actualRoot')}</dt>
            <dd><code>{config.actualRoot}</code></dd>
          </div>
          <div className={styles.pair}>
            <dt>{t('viewRoot')}</dt>
            <dd><code>{config.viewRoot}</code></dd>
          </div>
          <div className={styles.pair}>
            <dt>{t('mountPoint')}</dt>
            <dd><code>{config.mountPoint}</code></dd>
          </div>
        </dl>
        {config.backendError !== undefined && (
          <p className={styles.detail} role="status">
            {t('backendError')} {config.backendError.message}
          </p>
        )}

        <DeploymentWizard t={t} storageMode={status.storageMode} />

          {/* MinerU's address. A port can only ever mean this machine, so a service
              behind a tunnel, a gateway or another host has nowhere to be named; this
              field is that override, and the stored value is empty when it is unused.

              The field shows the address IN EFFECT, not the stored one. When nothing is
              stored the deployment derives the address from its configured port -- a
              working configuration -- and showing that as a blank box claimed there was
              nothing to see. The caption underneath says which of the two it is, so the
              reader is never left thinking a derived value was saved. */}
          <h3 className={styles.groupTitle}>{t('settingsMineruHeading')}</h3>
          {mineru === undefined
            ? <p className={styles.detail}>{t('settingsLoading')}</p>
            : (
              <>
                <div className={styles.field}>
                  {/* One visible heading is enough: the field's accessible name is the
                      same text, but the duplicated caption label is gone. */}
                  <input
                    id="kb-mineru-base-url"
                    className={styles.input}
                    type="url"
                    inputMode="url"
                    aria-label={t('settingsMineruHeading')}
                    // Untouched, this is the effective address: the stored one when there
                    // is one, otherwise what the deployment derives.
                    value={mineruDraft ?? (mineru.stored !== '' ? mineru.stored : mineru.derived)}
                    // An empty box would fall back to this, which says where the value
                    // comes from rather than promising a blank state that cannot happen.
                    placeholder={mineru.derived !== '' ? mineru.derived : t('settingsMineruPlaceholder')}
                    // 没有授权的人看到的是已配置值，但改不了：这是部署级行为，不是
                    // 个人偏好，所以按 canEdit 禁用而不是隐藏。
                    disabled={!mineru.canEdit || busy}
                    onChange={(event) => { setMineruDraft(event.target.value) }}
                  />
                </div>
                {mineru.invalidFallback === true && (
                  <p className={styles.detail}>{t('settingsMineruSharedInvalid')}</p>
                )}
                {!mineru.canEdit && <p className={styles.detail}>{t('settingsReadOnly')}</p>}
              </>
            )}

          <VectorSettingsGroup t={t} />

          {/* One save for the whole section, last: both groups are one settings record
              edited on one page, and two buttons made every visit a question of which to
              press. Storage is written by `config.set` and the address by `settings.set`;
              the button submits whichever of them the reader actually changed. */}
          <div className={styles.saveRow}>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => { void save() }}
            >
              {busy ? t('saving') : t('save')}
            </Button>
            {saveState.kind === 'saved' && (
              <p className={styles.notice} role="status">
                {t('savedOk')}
                {restartNeeded ? ' ' + t('savedRestart') : ''}
              </p>
            )}
            {saveState.kind === 'failed' && (
              <p className={styles.error} role="alert">{saveState.message}</p>
            )}
          </div>

          {/* Runtime state (idle/indexing, visible count, last sync, the read-only grant
              list) deliberately stays off this page: a settings surface answers "what can
              I change", while those answer "what is happening right now". They live on the
              Home and Permissions pages, which is where a reader goes to look at them. */}

      </div>
    </section>
  )
}

/**
 * The deployment wizard.
 *
 * Every step is idempotent on the Host side, so a button is safe to press
 * repeatedly; the panel only mirrors what the Host reports and never assembles
 * shell commands itself. The Host resolves a step's commands from its own
 * configuration, so the browser cannot choose what runs.
 */
function DeploymentWizard({ t, storageMode }: { t: KnowledgeSettingsInjected['t']; storageMode?: 'local' | 'remote' }) {
  const [hosts, setHosts] = useState<DeployHostView[]>([])
  const [hostId, setHostId] = useState('')
  const [steps, setSteps] = useState<DeployStepView[]>([])
  const [run, setRun] = useState<DeployRunView | undefined>(undefined)
  const [running, setRunning] = useState(false)
  const [hostsError, setHostsError] = useState<string | undefined>(undefined)
  /**
   * Whether the host list has been read yet.
   *
   * The two shapes below render differently, and guessing before the answer arrives
   * would flash the seven-step wizard at a local reader and then replace it -- a
   * layout jump in a settings panel reads as a bug. Until the read settles the
   * section renders nothing, which is the same thing it renders for the reader who
   * has no remote host at all.
   */
  const [hostsLoaded, setHostsLoaded] = useState(false)

  const loadHosts = useCallback(async () => {
    try {
      const reply = await postJson<{ hosts: DeployHostView[]; error?: { message: string } }>(KB_API.deployHosts)
      setHosts(reply.hosts)
      setHostsError(reply.error?.message)
      setHostId(current => (current !== '' ? current : (reply.hosts[0]?.id ?? '')))
    } catch (error) {
      setHostsError(error instanceof Error ? error.message : String(error))
    } finally {
      setHostsLoaded(true)
    }
  }, [])

  const loadSteps = useCallback(async () => {
    const reply = await postJson<{ steps: DeployStepView[] }>(KB_API.deploySteps)
    setSteps(reply.steps)
  }, [])

  useEffect(() => { void loadHosts() }, [loadHosts])

  /**
   * Read the plan only once the block is actually going to draw it.
   *
   * The host list decides whether the wizard has a remote target; a local deployment
   * renders one sentence instead of the steps, so fetching them there is a request
   * whose answer is never shown. Gated on `hostsLoaded` so the decision is made after
   * the answer arrives, not on a guess.
   */
  useEffect(() => {
    if (!hostsLoaded) return
    if (hosts.length === 0 && storageMode !== 'remote') return
    void loadSteps()
  }, [hostsLoaded, hosts.length, storageMode, loadSteps])

  const runStep = useCallback(async (stepId: string) => {
    if (hostId === '') return
    setRunning(true)
    setRun(undefined)
    try {
      // The Host runs every command of the step before replying, so the reply
      // is already the finished record; no polling is needed.
      setRun(await postJson<DeployRunView>(KB_API.deployRun, { stepId, hostId }))
    } catch (error) {
      const now = new Date().toISOString()
      setRun({
        stepId,
        hostId,
        state: 'failed',
        startedAt: now,
        finishedAt: now,
        log: [error instanceof Error ? error.message : String(error)],
      })
    } finally {
      setRunning(false)
    }
  }, [hostId])

  const selectedHost = hosts.find(host => host.id === hostId)

  /**
   * Whether this deployment can run any of the steps at all.
   *
   * Every step in the plan executes ON A REMOTE HOST: the Host's `deploy.run` route
   * refuses a request without a `hostId` ("Steps mutate a remote host"), and the
   * MinerU steps are shell run there too -- they read the remote `/etc/os-release`,
   * remote `uv`, remote `docker`. So the wizard is not an NFS-only block that a local
   * deployment skips in part; with no SSH host configured it has nothing that can
   * run, and seven disabled buttons are seven dead controls.
   *
   * A configured host is what makes the block meaningful, so that is the test. The
   * deployment's own declared mode is the fallback: a `remote` deployment is one that
   * intends to sync, so it keeps the wizard even before a host row exists (the host
   * list may be empty for reasons the reader can fix, and hiding the wizard would
   * remove the only place that says so).
   *
   * Both inputs are real state: `hosts` is the `deploy.hosts` reply, `storageMode` is
   * the `status` reply. Anything missing counts as local -- the conservative
   * direction, because the local shape is the one where the buttons would be a lie.
   */
  const hasRemoteTarget = hasDeployTarget(hosts, storageMode)

  // The host list has not come back yet: hold the section rather than guess at its
  // shape (see `hostsLoaded`).
  if (!hostsLoaded) return null

  // No remote target: nothing here can act, and the explanation that used to fill
  // this branch is gone (the reader struck it out), which would leave the heading
  // `Deployment` standing over emptiness. A lone heading is a promise of controls
  // that are not there, so the whole block disappears instead. `hasRemoteTarget`
  // still gates the wizard: with a host or a remote mode the steps below render as
  // before.
  if (!hasRemoteTarget) return null

  return (
    <div className={styles.wizard}>
      <h3 className={styles.groupTitle}>{t('deploy')}</h3>
      <p className={styles.detail}>{t('deployIntro')}</p>

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="kb-deploy-host">{t('deployHost')}</label>
        {/* A native select, because the primitive library exports no Select at all
            (checked `ui-primitives/src/index.ts`: no Select, Dropdown or Combobox).
            What it does export -- SegmentedControl, SegmentedTabs -- renders every
            option side by side, which suits three fixed tabs and not a list of
            hosts that grows with the deployment. The label is bound by `htmlFor`,
            so the keyboard and screen-reader behaviour is the platform's own. */}
        <select
          id="kb-deploy-host"
          className={styles.select}
          value={hostId}
          onChange={event => { setHostId(event.target.value) }}
        >
          {hosts.length === 0 && <option value="">{t('deployNoHosts')}</option>}
          {hosts.map(host => (
            <option key={host.id} value={host.id}>
              {host.name} ({host.username}@{host.hostname}:{String(host.port)})
            </option>
          ))}
        </select>
      </div>

      {hostsError !== undefined && (
        <p className={styles.detail} role="status">{t('deployHostsError')} {hostsError}</p>
      )}
      {selectedHost !== undefined && !selectedHost.credentialConfigured && (
        <p className={styles.detail} role="status">{t('deployNoCredential')}</p>
      )}

      <ul className={styles.steps}>
        {steps.map(step => (
          <li key={step.id} className={styles.step}>
            <span className={styles.stepLabel}>{t(`step.${step.id}` as keyof typeof en)}</span>
            <Button
              variant="outline"
              disabled={running || hostId === ''}
              onClick={() => { void runStep(step.id) }}
            >
              {running ? t('deployRunning') : t('deployRun')}
            </Button>
          </li>
        ))}
      </ul>

      {run !== undefined && (
        <div className={styles.logBox}>
          <div className={styles.statusRow}>
            <StateDot state={run.state === 'succeeded' ? 'done' : run.state === 'failed' ? 'error' : 'ongoing'} />
            <span className={styles.statusLabel}>
              {run.state === 'succeeded'
                ? t('deploySucceeded')
                : run.state === 'failed' ? t('deployFailed') : t('deployRunning')}
            </span>
          </div>
          <pre className={styles.log}>{run.log.join('\n')}</pre>
        </div>
      )}
    </div>
  )
}
