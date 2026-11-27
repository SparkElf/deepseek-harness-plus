/**
 * The 「文档识别」 settings section.
 *
 * Three actions, and they are genuinely different:
 *
 * - **Test connection** probes the address in the field without saving it. It is the only
 *   way to answer "is this address right?" before distributing it to every member.
 * - **Distribute** fills members who hold no address of their own. Nobody's own choice is
 *   touched, so it is the safe default.
 * - **Overwrite** replaces every member's address, including one they typed themselves.
 *
 * Both writes are gated on `canEdit`, which the backend answers from the caller's role.
 * The write routes enforce that independently: hiding a button is not a permission, so a
 * caller who forges the request is refused by the backend rather than by this page.
 *
 * The section deliberately carries no explanatory prose: a settings page states the field
 * and its state, and the reader who needs the story has the skill document. The connection
 * tag inside the field is the whole status surface.
 *
 * @module @sparkelf/dsh-ocr/client/SettingsSection
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, Input, Tag, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import {
  OCR_API,
  ocrApiPath,
  type OcrConfigView,
  type OcrDistributionView,
  type OcrImpactView,
  type OcrProbeCode,
  type OcrProbeView,
} from '../api.ts'
import type { en } from './locales.ts'
import {
  actions,
  actionsBar,
  addressBox,
  count,
  counts,
  countValue,
  detail,
  errorDetail,
  field,
  label,
  panel,
  section,
  tagSlot,
} from './styles.ts'

/** Values the Settings slot injects into this component. */
export interface OcrSettingsInjected {
  /** Translate one section message key. */
  t: (key: keyof typeof en) => string
}

/** Props accepted by the injected Settings section. */
export type OcrSettingsProps = Partial<InjectFace<OcrSettingsInjected>>

/** What the page knows about the shared address. */
type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; config: OcrConfigView }
  | { kind: 'unavailable' }

/** Which action a confirmation is currently collecting approval for. */
type Pending = 'distribute-default' | 'overwrite'

/** The outcome a reader sees after a write. */
type Outcome =
  | { kind: 'idle' }
  | { kind: 'nothing' }
  | { kind: 'counts'; result: OcrDistributionView }
  | { kind: 'failed'; message: string }

/**
 * What the field currently knows about reachability.
 *
 * `url` is the address the verdict belongs to. Keeping it lets an edit reset the tag: a
 * green "connected" that still referred to the previous string would be a lie the moment
 * the reader typed a different host.
 */
type Connection =
  | { kind: 'untested' }
  | { kind: 'testing' }
  | { kind: 'ok'; latencyMs: number; url: string }
  | { kind: 'failed'; code: OcrProbeCode; status?: number; message?: string; url: string }

/**
 * Read one JSON route, refusing a non-2xx answer with the backend's own message.
 *
 * The backend explains a refusal in the reader's language ("分发内容为空", a permission
 * message), and that text is what belongs on the page: a status code alone would send the
 * administrator looking in the wrong place.
 *
 * @param method - one of {@link OCR_API}.
 * @param body - the JSON body for a write, omitted for a read.
 * @returns the decoded reply.
 */
async function request<T>(method: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(ocrApiPath(method as never), {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    cache: 'no-store',
  })
  const decoded = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(decoded.error ?? `HTTP ${String(response.status)}`)
  return decoded
}

/**
 * Whether a candidate is an absolute http(s) address.
 *
 * Mirrors the backend's own normaliser, and is checked before the round trip so the answer
 * lands beside the field that was typed into rather than after a request that was always
 * going to be refused. The path is preserved: a MinerU service may sit behind a prefix.
 *
 * @param value - the address as typed.
 * @returns true when it parses and carries an http(s) scheme.
 */
export function isAbsoluteHttpAddress(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed === '') return false
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return false
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:'
}

/**
 * Render the document-recognition settings section.
 * @param props - the Settings slot injection.
 * @returns the section, or nothing before injection.
 */
export function OcrSettingsSection(props: OcrSettingsProps) {
  const { t } = props
  if (t === undefined) return null
  return <Loaded t={t} />
}

/** The section once the locale resolver is available. */
function Loaded({ t }: { t: OcrSettingsInjected['t'] }) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState<Pending | undefined>(undefined)
  const [impact, setImpact] = useState<OcrImpactView | undefined>(undefined)
  const [counting, setCounting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' })
  const [connection, setConnection] = useState<Connection>({ kind: 'untested' })

  const load = useCallback(async () => {
    setState({ kind: 'loading' })
    try {
      const config = await request<OcrConfigView>(OCR_API.config)
      setState({
        kind: 'ready',
        config: {
          mineruUrl: typeof config.mineruUrl === 'string' ? config.mineruUrl : '',
          canEdit: config.canEdit === true,
        },
      })
      setDraft(undefined)
      setOutcome({ kind: 'idle' })
      setConnection({ kind: 'untested' })
    } catch {
      setState({ kind: 'unavailable' })
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const shown = draft ?? (state.kind === 'ready' ? state.config.mineruUrl : '')

  // A verdict belongs to the exact address it was measured on. Editing the field must
  // clear the tag rather than leave a green "connected" pointing at the old string.
  useEffect(() => {
    setConnection(current => (
      current.kind === 'ok' || current.kind === 'failed'
        ? current.url === shown.trim() ? current : { kind: 'untested' }
        : current
    ))
  }, [shown])

  /**
   * Open a confirmation for one action, reading the impact count first.
   *
   * The count is what makes the confirmation honest: an overwrite names how many members
   * already have a value, which is exactly the set it would destroy. A confirmation that
   * could not state a number would be asking for approval of an unknown quantity.
   *
   * @param action - which of the two writes the reader pressed.
   */
  const begin = useCallback(async (action: Pending) => {
    setPending(action)
    setImpact(undefined)
    setCounting(true)
    try {
      setImpact(await request<OcrImpactView>(OCR_API.impact))
    } catch {
      // The write routes read the same population, so a failed count is not a reason to
      // block: the confirmation then states the action without numbers.
      setImpact(undefined)
    } finally {
      setCounting(false)
    }
  }, [])

  /** Run the confirmed action and report its four counts. */
  const confirm = useCallback(async (action: Pending) => {
    if (state.kind !== 'ready') return
    const address = (draft ?? state.config.mineruUrl).trim()
    if (!isAbsoluteHttpAddress(address)) {
      setPending(undefined)
      setOutcome({ kind: 'failed', message: t('badAddress') })
      return
    }
    setBusy(true)
    setPending(undefined)
    try {
      const result = await request<OcrDistributionView>(
        action === 'overwrite' ? OCR_API.overwrite : OCR_API.distributeDefault,
        { mineruUrl: address },
      )
      // Every member already had a value, so `onlyIfEmpty` had nothing to fill. Reporting
      // "0 written" without the reason reads like a failure, so the reason is named.
      const nothingChanged = action === 'distribute-default'
        && result.filled === 0 && result.failed === 0 && result.total > 0
      setOutcome(nothingChanged ? { kind: 'nothing' } : { kind: 'counts', result })
      setState(current => (current.kind === 'ready'
        ? { ...current, config: { ...current.config, mineruUrl: address } }
        : current))
      setDraft(undefined)
    } catch (error) {
      setOutcome({
        kind: 'failed',
        message: t('failure').replace('{reason}', error instanceof Error ? error.message : String(error)),
      })
    } finally {
      setBusy(false)
    }
  }, [draft, state, t])

  /**
   * Probe the address currently in the field.
   *
   * The Host answers this itself (it is the process inside the workspace network) but
   * checks the caller's role with the backend first, so a member who cannot edit cannot
   * turn the relay into a URL fetcher.
   */
  const test = useCallback(async () => {
    const address = shown.trim()
    if (!isAbsoluteHttpAddress(address)) {
      setConnection({ kind: 'failed', code: 'bad-url', url: address })
      return
    }
    setConnection({ kind: 'testing' })
    try {
      const result = await request<OcrProbeView>(OCR_API.testConnection, { mineruUrl: address })
      if (result.ok) {
        setConnection({ kind: 'ok', latencyMs: result.latencyMs, url: result.testedUrl })
        return
      }
      setConnection({
        kind: 'failed',
        code: result.code,
        ...(result.status === undefined ? {} : { status: result.status }),
        ...(result.message === undefined ? {} : { message: result.message }),
        url: result.testedUrl,
      })
    } catch (error) {
      setConnection({
        kind: 'failed',
        code: 'unreachable',
        message: error instanceof Error ? error.message : String(error),
        url: address,
      })
    }
  }, [shown])

  if (state.kind === 'loading') {
    return (
      <section style={section}>
        <p style={detail} role="status">{t('loading')}</p>
      </section>
    )
  }

  if (state.kind === 'unavailable') {
    return (
      <section style={section}>
        <p style={detail} role="alert">{t('unavailable')}</p>
        <p style={detail}>{t('unavailableDetail')}</p>
      </section>
    )
  }

  const { config } = state
  const action = pending ?? 'distribute-default'

  /**
   * The confirmation sentence with its numbers filled in.
   *
   * A failed count leaves `impact` undefined, and the placeholders then read `?` rather than
   * a number this page does not have: inventing one would make the confirmation claim a
   * blast radius it never measured.
   */
  const confirmation = (action === 'overwrite' ? t('confirmOverwrite') : t('confirmDistribute'))
    .replace('{withValue}', impact === undefined ? '?' : String(impact.withValue))
    .replace('{withoutValue}', impact === undefined ? '?' : String(impact.withoutValue))
    .replace('{total}', impact === undefined ? '?' : String(impact.total))

  /** The tag's palette and label for the current connection state. */
  const tag: { tone: 'neutral' | 'warning' | 'success' | 'danger'; label: string } = (() => {
    if (connection.kind === 'testing') return { tone: 'warning', label: t('connectionTesting') }
    if (connection.kind === 'ok') return { tone: 'success', label: t('connectionConnected') }
    if (connection.kind === 'failed') return { tone: 'danger', label: t('connectionFailed') }
    return { tone: 'neutral', label: t('connectionUntested') }
  })()

  /** One line of evidence under the field: latency on success, the reason on failure. */
  const connectionDetail = (() => {
    if (connection.kind === 'ok') return t('connectionLatency').replace('{ms}', String(connection.latencyMs))
    if (connection.kind === 'failed') {
      if (connection.code === 'bad-url') return t('probeBadUrl')
      if (connection.code === 'timeout') return t('probeTimeout')
      if (connection.code === 'http-error') {
        return t('probeHttpError').replace('{status}', String(connection.status ?? '?'))
      }
      if (connection.code === 'not-mineru') {
        return t('probeNotMineru').replace('{title}', connection.message ?? '?')
      }
      return t('probeUnreachable').replace('{reason}', connection.message ?? '?')
    }
    return undefined
  })()

  const tagNode = connection.kind === 'failed' && connectionDetail !== undefined
    ? (
      <Tooltip label={connectionDetail} portal side="top" align="end">
        <Tag tone={tag.tone}>{tag.label}</Tag>
      </Tooltip>
    )
    : <Tag tone={tag.tone}>{tag.label}</Tag>

  return (
    <section style={section} aria-label={t('title')}>
      <div style={field}>
        <label htmlFor="ocr-mineru-address" style={label}>{t('addressLabel')}</label>
        <div style={addressBox}>
          <Input
            id="ocr-mineru-address"
            type="url"
            inputMode="url"
            value={shown}
            placeholder={t('addressPlaceholder')}
            disabled={!config.canEdit || busy}
            aria-describedby={connectionDetail === undefined ? undefined : 'ocr-connection-detail'}
            // The tag sits inside the field's right edge; the input's own padding keeps
            // the text from running underneath it. `style` lands on the native input.
            style={{ paddingRight: '104px' }}
            onChange={(event) => { setDraft(event.target.value) }}
          />
          <span style={tagSlot}>{tagNode}</span>
        </div>
        {connectionDetail !== undefined && (
          <p
            id="ocr-connection-detail"
            style={connection.kind === 'failed' ? errorDetail : detail}
            role="status"
          >
            {connectionDetail}
          </p>
        )}
        {!config.canEdit && <p style={detail}>{t('readOnly')}</p>}
      </div>

      <div style={actionsBar}>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || shown.trim() === '' || connection.kind === 'testing'}
          onClick={() => { void test() }}
        >
          {t('testConnection')}
        </Button>
        {config.canEdit && (<>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { void begin('distribute-default') }}>
            {t('distributeDefault')}
          </Button>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => { void begin('overwrite') }}>
            {t('overwrite')}
          </Button>
        </>)}
      </div>

      {pending !== undefined && (
        <div style={panel} role="dialog">
          <p style={detail}>{counting ? t('counting') : confirmation}</p>
          <div style={actions}>
            <Button variant="outline" disabled={busy} onClick={() => { setPending(undefined) }}>
              {t('cancel')}
            </Button>
            <Button variant="primary" disabled={busy || counting} onClick={() => { void confirm(action) }}>
              {busy ? t('saving') : t('confirm')}
            </Button>
          </div>
        </div>
      )}

      {outcome.kind === 'nothing' && <p style={detail} role="status">{t('nothingToDo')}</p>}
      {outcome.kind === 'failed' && <p style={detail} role="alert">{outcome.message}</p>}
      {outcome.kind === 'counts' && (
        <div style={panel} role="status">
          <p style={detail}>{t('resultTitle')}</p>
          <dl style={counts}>
            <div style={count}>
              <dt style={detail}>{t('resultFilled')}</dt>
              <dd style={countValue}>{outcome.result.filled}</dd>
            </div>
            <div style={count}>
              <dt style={detail}>{t('resultSkipped')}</dt>
              <dd style={countValue}>{outcome.result.skipped}</dd>
            </div>
            <div style={count}>
              <dt style={detail}>{t('resultFailed')}</dt>
              <dd style={countValue}>{outcome.result.failed}</dd>
            </div>
            <div style={count}>
              <dt style={detail}>{t('resultTotal')}</dt>
              <dd style={countValue}>{outcome.result.total}</dd>
            </div>
          </dl>
        </div>
      )}
    </section>
  )
}