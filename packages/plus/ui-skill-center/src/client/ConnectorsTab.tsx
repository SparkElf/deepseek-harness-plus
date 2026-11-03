/**
 * The skill center's connector tab: one card per connector, its enable switch,
 * and — while enabled — the capability rows this account may use.
 *
 * @module @sparkelf/dsh-client-ui-skill-center/client/ConnectorsTab
 */
import type { ReactNode } from 'react'
import {
  Button,
  Switch,
  Tag,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './SkillCenterPage.module.css'
import { ConnectorGlyph } from './glyphs.tsx'
import {
  connectorState,
  visibleCapabilities,
  type Connector,
  type ConnectorCapability,
  type ConnectorCatalogue,
} from './connectors.ts'
import type { SkillCenterLocaleKey } from './locales.ts'

/** What the tab currently knows about the catalogue. */
export type ConnectorLoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; catalogue: ConnectorCatalogue }
  | { kind: 'failed'; message: string }

/** The tab's render inputs. */
export interface ConnectorsTabProps {
  state: ConnectorLoadState
  query: string
  /** `connectorId` or `connectorId:capabilityId` while a write is in flight. */
  busyId: string | null
  t(key: SkillCenterLocaleKey): string
  onRetry(): void
  onToggleConnector(connector: Connector, enabled: boolean): void
  onToggleCapability(connector: Connector, capability: ConnectorCapability, enabled: boolean): void
}

/** Status label and tone for one connector. */
function statusOf(connector: Connector, t: ConnectorsTabProps['t']): { label: string; tone: TagTone } {
  const state = connectorState(connector)
  if (state === 'error') return { label: t('connector.error'), tone: 'danger' }
  if (state === 'connected') return { label: t('connector.connected'), tone: 'success' }
  return { label: t('connector.disabled'), tone: 'neutral' }
}

/** Whether the query matches a connector or one of its visible capabilities. */
function matchesQuery(connector: Connector, needle: string): boolean {
  if (needle === '') return true
  const values = [
    connector.name,
    connector.vendor ?? '',
    connector.description ?? '',
    ...visibleCapabilities(connector).flatMap(capability => [capability.name, capability.description ?? '']),
  ]
  return values.some(value => value.toLowerCase().includes(needle))
}

/**
 * Render one connector card.
 * @param props.connector - the catalogue row.
 * @param props.busy - whether a write for this connector is in flight.
 * @param props.t - dictionary resolver.
 * @param props.onToggleConnector - enable/disable request.
 * @param props.onToggleCapability - capability toggle request.
 * @returns the card.
 */
function ConnectorCard({ connector, busy, t, onToggleConnector, onToggleCapability }: {
  connector: Connector
  busy: boolean
  t: ConnectorsTabProps['t']
  onToggleConnector: ConnectorsTabProps['onToggleConnector']
  onToggleCapability: ConnectorsTabProps['onToggleCapability']
}): ReactNode {
  const status = statusOf(connector, t)
  const capabilities = visibleCapabilities(connector)
  return (
    <article
      className={css.connectorCard}
      data-connector-id={connector.id}
      data-connector-enabled={connector.enabled}
    >
      <div className={css.connectorHead}>
        <span className={css.connectorIcon}><ConnectorGlyph /></span>
        <div className={css.connectorIdentity}>
          <div className={css.connectorName}>{connector.name}</div>
          {connector.vendor === undefined ? null : <div className={css.connectorVendor}>{connector.vendor}</div>}
        </div>
        <Tag tone={status.tone}>{status.label}</Tag>
      </div>
      {connector.description === undefined ? null : (
        <p className={css.connectorDescription}>{connector.description}</p>
      )}
      {connector.enabled && connector.error !== undefined ? (
        <p className={css.connectorError} role="status">{connector.error}</p>
      ) : null}
      <div className={css.connectorToggleRow}>
        <span className={css.connectorToggleLabel}>
          {connector.enabled ? t('connector.enabled') : t('connector.disabled')}
        </span>
        <Switch
          checked={connector.enabled}
          disabled={busy}
          label={(connector.enabled ? t('connector.disable') : t('connector.enable')) + ' ' + connector.name}
          onChange={(next) => { onToggleConnector(connector, next) }}
        />
      </div>
      {connector.enabled && capabilities.length > 0 ? (
        <div className={css.capabilityList} data-connector-capabilities>
          <div className={css.capabilityTitle}>{t('connector.capabilities')}</div>
          {capabilities.map((capability) => {
            const unavailable = capability.unavailableReason !== undefined
            return (
              <div
                className={css.capabilityRow}
                key={capability.id}
                data-capability-id={capability.id}
                data-capability-enabled={capability.enabled}
              >
                <div className={css.capabilityCopy}>
                  <div className={css.capabilityName}>{capability.name}</div>
                  {capability.description === undefined ? null : (
                    <div className={css.capabilityDescription}>{capability.description}</div>
                  )}
                  {capability.unavailableReason === undefined ? null : (
                    <div className={css.capabilityReason}>{t('connector.unavailable')} · {capability.unavailableReason}</div>
                  )}
                </div>
                <Switch
                  checked={capability.enabled}
                  disabled={busy || unavailable}
                  label={(capability.enabled ? t('connector.disable') : t('connector.enable')) + ' ' + capability.name}
                  onChange={(next) => { onToggleCapability(connector, capability, next) }}
                />
              </div>
            )
          })}
        </div>
      ) : null}
    </article>
  )
}

/**
 * Render the connector tab body.
 * @param props - catalogue state, search text, and the two write handlers.
 * @returns the connector cards, or the loading/failure/empty status.
 */
export function ConnectorsTab(props: ConnectorsTabProps): ReactNode {
  const { state, query, busyId, t, onRetry, onToggleConnector, onToggleCapability } = props
  if (state.kind === 'loading') return <div className={css.status}>{t('connector.loading')}</div>
  if (state.kind === 'failed') {
    return (
      <div className={css.connectorFailed} role="alert" data-connector-failed>
        <span>{t('connector.failed')}：{state.message}</span>
        <Button variant="outline" size="sm" onClick={onRetry}>{t('connector.retry')}</Button>
      </div>
    )
  }
  const needle = query.trim().toLowerCase()
  const connectors = state.catalogue.connectors.filter(connector => matchesQuery(connector, needle))
  return (
    <div className={css.connectorTab} data-connector-catalogue data-demo={state.catalogue.demo}>
      {state.catalogue.demo ? (
        <div className={css.connectorDemoNote} role="status">
          <span className={css.connectorDemoTag}>{t('connector.demoTag')}</span>
          {t('connector.demo')}
        </div>
      ) : null}
      {connectors.length === 0 ? (
        <div className={css.status}>
          {state.catalogue.connectors.length === 0 ? t('connector.empty') : t('connector.noMatches')}
        </div>
      ) : (
        <div className={css.connectorGrid}>
          {connectors.map((connector) => {
            const busy = busyId === connector.id || busyId?.startsWith(connector.id + ':') === true
            return (
              <ConnectorCard
                key={connector.id}
                connector={connector}
                busy={busy}
                t={t}
                onToggleConnector={onToggleConnector}
                onToggleCapability={onToggleCapability}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
