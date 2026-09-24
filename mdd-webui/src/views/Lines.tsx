/**
 * Lines.
 *
 * A line is one physical SIM and owns one engine container. This screen is the hub between
 * Devices (which device is present) and Calls/Balance (which need a running line), so it has
 * to answer three questions without ambiguity:
 *
 *   1. Is the engine up, and if not, WHY. The control plane classifies every failure into a
 *      `reason_code`, and that classification is the difference between "the card is locked",
 *      "the carrier rejected the attach" and "the tunnel came up and never registered" —
 *      three problems with three different fixes. The raw state alone hides all of that.
 *   2. Which SIM is where. `reader_index` is the index that *physically* holds the card right
 *      now (ICCID-matched against the live monitor), not the stored one, because PC/SC indices
 *      shift when readers are unplugged. The view shows the live value and says nothing about
 *      a stored one it cannot verify.
 *   3. What editing a line costs. `POST /api/instances` re-renders the engine config and
 *      RESTARTS a running container — except when the only change is the display name, which
 *      the engine never reads. The response carries `applied` and the UI reports it, because
 *      "I renamed it and it dropped my call" is exactly the kind of surprise the API's
 *      name-only shortcut was built to prevent.
 *
 * Nothing here is written optimistically. Every mutation re-reads the store, so what the
 * operator sees after a start is the engine's own verdict, not the click.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api.ts'
import { useI18n } from '../lib/i18n.tsx'
import type { MessageKey } from '../lib/i18n.tsx'
import { useGateway } from '../lib/store.tsx'
import { ApiError } from '../lib/types.ts'
import type {
  EngineLogs,
  Instance,
  InstancePatch,
  LineAvailability,
  LineStatus,
} from '../lib/types.ts'
import {
  Badge,
  ConfirmDialog,
  CopyButton,
  Disclosure,
  Empty,
  ErrorNote,
  Field,
  KeyValue,
  SkeletonRows,
  StatusDot,
  Timeline,
} from '../components/ui.tsx'
import type { Tone } from '../components/ui.tsx'
import { formatDuration, groupDigits, toPercent } from '../lib/format.ts'

/** Live status state → tone. Anything unknown is neutral: guessing would be worse than plain. */
function toneForState(state: string | undefined): Tone {
  switch ((state ?? '').toUpperCase()) {
    case 'RUNNING':
    case 'REGISTERED':
      return 'ok'
    case 'STARTING':
    case 'REGISTERING':
    case 'RECOVERING':
      return 'warn'
    case 'FAILED':
    case 'UNRECOVERABLE':
    case 'BLOCKED':
      return 'danger'
    default:
      return 'neutral'
  }
}

function isUp(state: string | undefined): boolean {
  return (state ?? '').toUpperCase() !== 'STOPPED'
}

/**
 * Reason codes the control plane emits. The mapping exists so a failing line says what a
 * person would have to do about it, rather than repeating a machine code back at them.
 */
const REASON_HINT = {
  pin_required: 'line.reason.pinRequired',
  pin_incorrect: 'line.reason.pinIncorrect',
  card_mismatch: 'line.reason.cardMismatch',
  no_card: 'line.reason.noCard',
  attach_rejected: 'line.reason.attachRejected',
  auth_rejected: 'line.reason.authRejected',
  no_exit: 'line.reason.noExit',
  unregistered: 'line.reason.unregistered',
} as const satisfies Record<string, MessageKey>

type ReasonCode = keyof typeof REASON_HINT

function reasonKeyFor(code: string): MessageKey | null {
  return code in REASON_HINT ? REASON_HINT[code as ReasonCode] : null
}

/* ------------------------------------------------------------------ country */

/**
 * The exit country. An empty value is meaningful — it means "follow the SIM's own MCC" —
 * so the field is deliberately not a required select with a placeholder default.
 */
function CountryField({
  line,
  onSaved,
}: {
  line: Instance
  onSaved: () => Promise<void>
}) {
  const { t } = useI18n()
  const [value, setValue] = useState(line.proxy_country_effective ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    setValue(line.proxy_country_effective ?? '')
  }, [line.proxy_country_effective])

  const save = async (next: string) => {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const result = await api.instances.setCountry(line.id, next.trim().toLowerCase())
      setValue(result.country)
      setNote(t('line.countryEffective', { country: result.effective_country || '—' }))
      await onSaved()
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Field
      label={t('line.country')}
      hint={error ?? note ?? t('line.countryHint')}
      error={error ?? undefined}
    >
      <div className="row" style={{ gap: 'var(--space-2)' }}>
        <input
          className="input"
          style={{ maxWidth: 120 }}
          value={value}
          placeholder={t('line.countryAuto')}
          maxLength={2}
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => {
            if ((line.proxy_country_effective ?? '') !== value.trim().toLowerCase()) {
              void save(value)
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void save(value)
          }}
        />
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy || !value}
          onClick={() => void save('')}
        >
          {t('line.countryAuto')}
        </button>
      </div>
    </Field>
  )
}

/* --------------------------------------------------------------------- logs */

function EngineLogsPanel({ lineId }: { lineId: string }) {
  const { t } = useI18n()
  const [logs, setLogs] = useState<EngineLogs | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stream, setStream] = useState<'engine' | 'charon' | 'diagnostics'>('engine')

  const load = useCallback(async () => {
    try {
      setLogs(await api.instances.logs(lineId, 200))
      setError(null)
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : String(failure))
    }
  }, [lineId])

  useEffect(() => {
    void load()
  }, [load])

  const text = logs ? logs[stream] : ''

  return (
    <Disclosure
      summary={
        <span className="row" style={{ gap: 'var(--space-2)' }}>
          <span>{t('line.logs')}</span>
          {logs ? <Badge tone="neutral">{formatDuration(0).replace('0', '') || 'live'}</Badge> : null}
        </span>
      }
    >
      <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
        {(
          [
            ['engine', t('line.logsEngine')],
            ['charon', t('line.logsCharon')],
            ['diagnostics', t('line.logsDiagnostics')],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className="tab"
            aria-selected={stream === key}
            onClick={() => setStream(key)}
          >
            {label}
          </button>
        ))}
        <span className="grow" />
        <button type="button" className="btn btn-sm" onClick={() => void load()}>
          {t('action.refresh')}
        </button>
      </div>

      <p className="xs faint" style={{ margin: 0 }}>
        {t('line.logsHint')}
      </p>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {text ? (
        <pre className="logview">{text}</pre>
      ) : (
        <div className="empty">{t('common.none')}</div>
      )}
    </Disclosure>
  )
}

/* -------------------------------------------------------------- availability */

function AvailabilityPanel({ lineId }: { lineId: string }) {
  const { t } = useI18n()
  const [data, setData] = useState<LineAvailability | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void api.instances
      .availability(lineId)
      .then((result) => {
        if (!cancelled) setData(result)
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(failure instanceof ApiError ? failure.message : String(failure))
      })
    return () => {
      cancelled = true
    }
  }, [lineId])

  if (error) return <ErrorNote>{error}</ErrorNote>
  if (!data) return <SkeletonRows rows={2} />

  const percent = toPercent(data.summary.uptime_ratio)

  return (
    <div className="stack" style={{ gap: 'var(--space-3)' }}>
      <div className="kv-grid">
        <KeyValue label={t('line.uptime')}>
          {percent === null ? (
            <span className="faint">{t('state.unknown')}</span>
          ) : (
            <span className="row" style={{ gap: 'var(--space-2)' }}>
              <StatusDot tone={percent >= 95 ? 'ok' : percent >= 80 ? 'warn' : 'danger'} />
              {percent}%
            </span>
          )}
        </KeyValue>
        <KeyValue label={t('line.outages')}>{data.summary.outages}</KeyValue>
        <KeyValue label={t('line.longestOutage')}>
          {formatDuration(data.summary.longest_outage_seconds)}
        </KeyValue>
        <KeyValue label={t('line.availability')}>
          {formatDuration(data.span_seconds)}
        </KeyValue>
      </div>

      <Timeline segments={data.segments} start={data.start} end={data.end} />

      <p className="xs faint" style={{ margin: 0 }}>
        {t('line.availabilityHint')}
      </p>
    </div>
  )
}

/* --------------------------------------------------------------- edit dialog */

interface EditState {
  name: string
  imei: string
  apn: string
  idr_mode: string
  cp_mode: string
  smsc: string
  pcscf: string
  user_agent: string
  user_eq_phone: boolean
  rekey_minutes: number
  ike_rekey_minutes: number
  webrtc_enable: boolean
  webrtc_username: string
  webrtc_password: string
  pin: string
}

function toEditState(line: Instance): EditState {
  const sip = (line.sip ?? {}) as Record<string, unknown>
  const webrtc = (sip.webrtc ?? {}) as Record<string, unknown>
  const asText = (value: unknown, fallback = '') =>
    typeof value === 'string' ? value : fallback
  const asNum = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return {
    name: asText(line.name),
    imei: asText(line.imei),
    apn: asText(line.apn),
    idr_mode: asText(line.idr_mode),
    cp_mode: asText(line.cp_mode),
    smsc: asText(line.smsc),
    pcscf: asText(line.pcscf),
    user_agent: asText(sip.user_agent),
    user_eq_phone: sip.user_eq_phone === true,
    rekey_minutes: asNum(line.rekey_minutes, 0),
    ike_rekey_minutes: asNum(line.ike_rekey_minutes, 0),
    webrtc_enable: webrtc.enable !== false,
    webrtc_username: asText(webrtc.username, 'webrtc'),
    webrtc_password: '',
    pin: '',
  }
}

/**
 * The line editor.
 *
 * A nested object is replaced wholesale by `POST /api/instances` (the whole `sip` block goes
 * as one document), so a field this form does not show would be silently destroyed by saving
 * it. Every nested object is therefore rebuilt from the *stored* line rather than from
 * scratch, and a blank softphone password is omitted so the stored credential survives —
 * exactly the rule `config.upsert_instance` applies server-side.
 */
function EditDialog({
  line,
  onClose,
  onSaved,
}: {
  line: Instance
  onClose: () => void
  onSaved: (message: string) => Promise<void>
}) {
  const { t } = useI18n()
  const [draft, setDraft] = useState<EditState>(() => toEditState(line))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const set = <K extends keyof EditState>(key: K, value: EditState[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))

  const save = async () => {
    if (!draft.name.trim()) {
      setError(t('line.nameRequired'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const storedSip = (line.sip ?? {}) as Record<string, unknown>
      const storedWebrtc = (storedSip.webrtc ?? {}) as Record<string, unknown>

      const patch: InstancePatch = {
        id: line.id,
        name: draft.name.trim(),
        imei: draft.imei.trim(),
        apn: draft.apn.trim(),
        smsc: draft.smsc.trim(),
        pcscf: draft.pcscf.trim(),
        idr_mode: draft.idr_mode as InstancePatch['idr_mode'],
        cp_mode: draft.cp_mode as InstancePatch['cp_mode'],
        // Rebuilt from the stored block: keys this form does not render must survive the save.
        sip: {
          ...storedSip,
          user_agent: draft.user_agent.trim(),
          user_eq_phone: draft.user_eq_phone,
          webrtc: {
            ...storedWebrtc,
            enable: draft.webrtc_enable,
            username: draft.webrtc_username.trim() || 'webrtc',
            // Omitted entirely when blank: an empty string would be treated as "no change"
            // anyway, but sending it makes the intent explicit and keeps the payload honest.
            ...(draft.webrtc_password ? { password: draft.webrtc_password } : {}),
          },
        },
      }
      // 0 is a real value (= proactive rekey disabled), so it is sent; a blank PIN is not.
      if (draft.rekey_minutes >= 0) patch.rekey_minutes = draft.rekey_minutes
      if (draft.ike_rekey_minutes >= 0) patch.ike_rekey_minutes = draft.ike_rekey_minutes
      if (draft.pin.trim()) patch.pin = draft.pin.trim()

      const result = await api.instances.upsert(patch)
      await onSaved(
        result.applied ? t('line.applied') : t('line.savedNoRestart'),
      )
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        setError(t('line.nameTaken'))
      } else {
        setError(failure instanceof ApiError ? failure.message : String(failure))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" role="presentation" onClick={() => (busy ? undefined : onClose())}>
      <div
        className="modal"
        style={{ maxWidth: 560 }}
        role="dialog"
        aria-modal="true"
        aria-label={t('line.edit')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <strong style={{ fontWeight: 500 }}>
            {t('line.edit')} · {line.name || line.id}
          </strong>
        </div>
        <div className="modal-body stack" style={{ gap: 'var(--space-4)' }}>
          {error ? <ErrorNote>{error}</ErrorNote> : null}

          <div className="field-row">
            <Field label={t('line.title')}>
              <input
                className="input"
                value={draft.name}
                onChange={(event) => set('name', event.target.value)}
              />
            </Field>
            <Field label={t('line.imei')} hint={t('line.imeiHint')}>
              <input
                className="input mono"
                value={draft.imei}
                onChange={(event) => set('imei', event.target.value)}
              />
            </Field>
          </div>

          <div className="field-row">
            <Field label={t('line.apn')} hint={t('line.apnHint')}>
              <input
                className="input mono"
                value={draft.apn}
                placeholder="ims"
                onChange={(event) => set('apn', event.target.value)}
              />
            </Field>
            <Field label={t('line.smsc')}>
              <input
                className="input mono"
                value={draft.smsc}
                onChange={(event) => set('smsc', event.target.value)}
              />
            </Field>
          </div>

          <div className="field-row">
            <Field label={t('line.pcscf')}>
              <input
                className="input mono"
                value={draft.pcscf}
                onChange={(event) => set('pcscf', event.target.value)}
              />
            </Field>
            <Field label={t('line.pinLabel')} hint={t('line.pinPrompt')}>
              <input
                className="input mono"
                type="password"
                autoComplete="off"
                value={draft.pin}
                placeholder={line.has_pin ? '••••' : ''}
                onChange={(event) => set('pin', event.target.value)}
              />
            </Field>
          </div>

          <Disclosure summary={t('line.advanced')}>
            <div className="field-row">
              <Field label={t('line.idrMode')}>
                <select
                  className="select"
                  value={draft.idr_mode}
                  onChange={(event) => set('idr_mode', event.target.value)}
                >
                  <option value="">{t('line.idrApn')}</option>
                  <option value="apn">{t('line.idrApn')}</option>
                  <option value="fqdn">{t('line.idrFqdn')}</option>
                </select>
              </Field>
              <Field label={t('line.cpMode')}>
                <select
                  className="select"
                  value={draft.cp_mode}
                  onChange={(event) => set('cp_mode', event.target.value)}
                >
                  <option value="">{t('line.cpAuto')}</option>
                  <option value="auto">{t('line.cpAuto')}</option>
                  <option value="v4">{t('line.cpV4')}</option>
                  <option value="v6">{t('line.cpV6')}</option>
                  <option value="dual">{t('line.cpDual')}</option>
                </select>
              </Field>
            </div>

            <div className="field-row">
              <Field label={t('line.userAgent')} hint={t('line.userAgentHint')}>
                <input
                  className="input mono"
                  value={draft.user_agent}
                  onChange={(event) => set('user_agent', event.target.value)}
                />
              </Field>
              <Field label={t('line.rekey')} hint={t('line.rekeyHint')}>
                <input
                  className="input"
                  type="number"
                  min={0}
                  value={String(draft.rekey_minutes)}
                  onChange={(event) => set('rekey_minutes', Number(event.target.value))}
                />
              </Field>
            </div>

            <div className="field-row">
              <Field label={t('line.ikeRekey')} hint={t('line.rekeyHint')}>
                <input
                  className="input"
                  type="number"
                  min={0}
                  value={String(draft.ike_rekey_minutes)}
                  onChange={(event) => set('ike_rekey_minutes', Number(event.target.value))}
                />
              </Field>
              <div />
            </div>

            <label className="checkbox">
              <input
                type="checkbox"
                checked={draft.user_eq_phone}
                onChange={(event) => set('user_eq_phone', event.target.checked)}
              />
              <span className="small">{t('line.userEqPhone')}</span>
            </label>
            <p className="xs faint" style={{ margin: 0 }}>
              {t('line.userEqPhoneHint')}
            </p>

            <div className="field-row">
              <Field label={t('line.webrtcUser')}>
                <input
                  className="input mono"
                  value={draft.webrtc_username}
                  onChange={(event) => set('webrtc_username', event.target.value)}
                />
              </Field>
              <Field label={t('line.webrtcPassword')} hint={t('line.webrtcPasswordHint')}>
                <input
                  className="input mono"
                  type="password"
                  autoComplete="new-password"
                  value={draft.webrtc_password}
                  onChange={(event) => set('webrtc_password', event.target.value)}
                />
              </Field>
            </div>

            <label className="checkbox">
              <input
                type="checkbox"
                checked={draft.webrtc_enable}
                onChange={(event) => set('webrtc_enable', event.target.checked)}
              />
              <span className="small">{t('line.webrtcEnable')}</span>
            </label>
          </Disclosure>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            {t('action.cancel')}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? t('settings.saving') : t('action.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------- card */

type PendingAction =
  | { kind: 'delete' }
  | { kind: 'clearPin' }
  | { kind: 'startWithPin' }

function LineCard({
  line,
  onChanged,
}: {
  line: Instance
  onChanged: () => Promise<void>
}) {
  const { t } = useI18n()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [pin, setPin] = useState('')
  const [editing, setEditing] = useState(false)

  const status: LineStatus = line.status ?? { state: 'STOPPED' }
  const state = status.state
  const running = isUp(state)
  const reasonKey = reasonKeyFor(String(status.reason_code ?? ''))
  const draft = line.provisioning_state === 'draft'

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key)
    setError(null)
    setNote(null)
    try {
      await action()
      await onChanged()
    } catch (failure) {
      // A PIN-blocked start answers 409 with a structured body rather than a string, which is
      // what lets the view offer the PIN prompt instead of printing a machine code.
      const detail = failure instanceof ApiError ? failure.body : null
      const code =
        detail && typeof detail === 'object' && 'detail' in detail
          ? (detail as { detail: unknown }).detail
          : null
      if (
        failure instanceof ApiError &&
        failure.status === 409 &&
        code &&
        typeof code === 'object' &&
        'code' in (code as Record<string, unknown>) &&
        ['pin_required', 'pin_incorrect'].includes(
          String((code as Record<string, unknown>).code),
        )
      ) {
        setPending({ kind: 'startWithPin' })
        setError(failure.message)
      } else {
        setError(failure instanceof ApiError ? failure.message : String(failure))
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <div className="row wrap" style={{ gap: 'var(--space-2)', minWidth: 0 }}>
          <StatusDot tone={toneForState(state)} />
          <strong className="truncate" style={{ fontWeight: 500 }}>
            {line.name || line.id}
          </strong>
          {draft ? <Badge tone="warn">{t('line.draft')}</Badge> : null}
          <Badge tone={line.has_pin ? 'neutral' : 'warn'}>
            {line.has_pin ? t('line.pinSaved') : t('line.pinMissing')}
          </Badge>
          <Badge tone={toneForState(state)}>{status.label || state}</Badge>
        </div>
        <div className="row xs faint" style={{ gap: 'var(--space-3)' }}>
          <span className="mono">{line.id}</span>
        </div>
      </div>

      <div className="card-body stack">
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {note ? <div className="alert alert-ok small">{note}</div> : null}

        {draft ? (
          <div className="alert alert-warn small">
            {t('line.draftHint')}
          </div>
        ) : null}

        {reasonKey ? (
          <div className="alert alert-danger small">{t(reasonKey)}</div>
        ) : status.reason ? (
          <div className="alert alert-danger small">{String(status.reason)}</div>
        ) : null}

        <div className="kv-grid">
          <KeyValue label={t('line.iccid')} mono>
            {line.iccid ? (
              <span className="row" style={{ gap: 'var(--space-2)' }}>
                <span className="truncate">{groupDigits(line.iccid, 4)}</span>
                <CopyButton value={line.iccid} />
              </span>
            ) : (
              <span className="faint">{t('common.none')}</span>
            )}
          </KeyValue>
          <KeyValue label={t('line.imsi')} mono>
            {line.imsi ? groupDigits(line.imsi, 5) : <span className="faint">{t('common.none')}</span>}
          </KeyValue>
          <KeyValue label={t('line.msisdn')} mono>
            {line.msisdn ? (
              <span className="row" style={{ gap: 'var(--space-2)' }}>
                {line.msisdn}
                <CopyButton value={line.msisdn} />
              </span>
            ) : (
              <span className="faint">{t('state.unknown')}</span>
            )}
          </KeyValue>
          <KeyValue label={t('line.reader')}>
            {line.reader_index !== undefined ? (
              <span className="mono">#{line.reader_index}</span>
            ) : (
              <span className="faint">—</span>
            )}
            {line.reader_port ? (
              <span className="xs faint mono"> · {line.reader_port}</span>
            ) : null}
          </KeyValue>
          <KeyValue label={t('line.engine')}>
            <span className="mono truncate">{line.id}</span>
          </KeyValue>
          <KeyValue label={t('line.country')}>
            {line.proxy_country_effective ? (
              <span className="mono">{line.proxy_country_effective.toUpperCase()}</span>
            ) : (
              <span className="faint">{t('line.countryAuto')}</span>
            )}
          </KeyValue>
        </div>

        <CountryField line={line} onSaved={onChanged} />

        <AvailabilityPanel lineId={line.id} />

        <EngineLogsPanel lineId={line.id} />

        <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
          {running ? (
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() => void run('stop', () => api.instances.stop(line.id))}
            >
              {busy === 'stop' ? t('line.stopping') : t('action.stop')}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy !== null}
              onClick={() => {
                if (line.has_pin) setPending({ kind: 'startWithPin' })
                else void run('start', () => api.instances.start(line.id))
              }}
            >
              {busy === 'start' ? t('line.starting') : t('action.start')}
            </button>
          )}

          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => void run('reprovision', () => api.instances.reprovision(line.id))}
          >
            {t('line.reprovision')}
          </button>

          <button
            type="button"
            className="btn"
            disabled={busy !== null || !running}
            onClick={() => void run('register', () => api.instances.register(line.id))}
          >
            {t('line.register')}
          </button>

          <button type="button" className="btn" disabled={busy !== null} onClick={() => setEditing(true)}>
            {t('action.edit')}
          </button>

          <span className="grow" />

          <button
            type="button"
            className="btn btn-sm"
            disabled={busy !== null || !line.has_pin}
            onClick={() => setPending({ kind: 'clearPin' })}
          >
            {t('line.clearPin')}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            style={{ color: 'var(--danger)' }}
            disabled={busy !== null}
            onClick={() => setPending({ kind: 'delete' })}
          >
            {t('line.delete')}
          </button>
        </div>
      </div>

      {editing ? (
        <EditDialog
          line={line}
          onClose={() => setEditing(false)}
          onSaved={async (message) => {
            setEditing(false)
            setNote(message)
            await onChanged()
          }}
        />
      ) : null}

      {pending?.kind === 'delete' ? (
        <ConfirmDialog
          title={t('line.delete')}
          confirmLabel={t('action.delete')}
          busy={busy === 'delete'}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            void run('delete', async () => {
              await api.instances.remove(line.id)
              setPending(null)
            })
          }}
        >
          <p className="small" style={{ margin: 0 }}>
            {t('line.deleteConfirm', { name: line.name || line.id })}
          </p>
          <p className="xs faint" style={{ margin: 0 }}>
            {t('line.deleteHint')}
          </p>
        </ConfirmDialog>
      ) : null}

      {pending?.kind === 'clearPin' ? (
        <ConfirmDialog
          title={t('line.clearPin')}
          confirmLabel={t('action.confirm')}
          busy={busy === 'clear-pin'}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            void run('clear-pin', async () => {
              await api.instances.clearPin(line.id)
              setPending(null)
            })
          }}
        >
          <p className="small" style={{ margin: 0 }}>
            {t('line.clearPinHint')}
          </p>
        </ConfirmDialog>
      ) : null}

      {pending?.kind === 'startWithPin' ? (
        <ConfirmDialog
          title={t('line.pinPrompt')}
          confirmLabel={t('action.start')}
          busy={busy === 'start'}
          onCancel={() => {
            setPending(null)
            setPin('')
          }}
          onConfirm={() => {
            if (!pin.trim()) return
            void run('start', async () => {
              await api.instances.start(line.id, pin.trim())
              setPending(null)
              setPin('')
            })
          }}
        >
          <Field label={t('line.pinLabel')}>
            <input
              className="input mono"
              type="password"
              autoComplete="off"
              autoFocus
              value={pin}
              onChange={(event) => setPin(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && pin.trim()) {
                  void run('start', async () => {
                    await api.instances.start(line.id, pin.trim())
                    setPending(null)
                    setPin('')
                  })
                }
              }}
            />
          </Field>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
        </ConfirmDialog>
      ) : null}
    </section>
  )
}

/* ------------------------------------------------------------------- view */

export function Lines() {
  const { t } = useI18n()
  const { instances, loading, error, refresh } = useGateway()
  const [creating, setCreating] = useState(false)

  // Keep the newest known line list for the "lines up" counter without re-deriving on every
  // member change — the counter is cosmetic and must never gate the cards.
  const upCount = useMemo(
    () => (instances ?? []).filter((line) => isUp(line.status?.state)).length,
    [instances],
  )

  if (loading && !instances) return <SkeletonRows rows={4} />

  return (
    <div className="stack">
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <div className="row-between">
        <p className="small muted" style={{ margin: 0 }}>
          {t('line.hint')}
        </p>
        <span className="row xs faint" style={{ gap: 'var(--space-2)' }}>
          <StatusDot tone={upCount > 0 ? 'ok' : 'neutral'} />
          {upCount} / {instances?.length ?? 0}
        </span>
      </div>

      <div className="row" style={{ gap: 'var(--space-2)' }}>
        <button
          type="button"
          className="btn btn-sm"
          disabled={creating}
          onClick={() => setCreating(true)}
        >
          {t('line.create')}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => void refresh()}>
          {t('action.refresh')}
        </button>
      </div>

      {creating ? (
        <NewLineCard
          onClose={() => setCreating(false)}
          onSaved={async () => {
            setCreating(false)
            await refresh()
          }}
        />
      ) : null}

      {!instances || instances.length === 0 ? (
        <div className="card">
          <Empty>{t('line.none')}</Empty>
        </div>
      ) : (
        instances.map((line) => <LineCard key={line.id} line={line} onChanged={refresh} />)
      )}
    </div>
  )
}

/* ------------------------------------------------------------- new line form */

/**
 * Manual line creation.
 *
 * The control plane normally creates a line the moment a card is inserted, so this form
 * exists for the case it does not: a draft that never materialised, or a card the operator
 * wants to describe by hand. `id` is required and is what every other endpoint keys on, so
 * it is validated to the same shape the settings API accepts for profile ids.
 */
function NewLineCard({
  onClose,
  onSaved,
}: {
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const { t } = useI18n()
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [imsi, setImsi] = useState('')
  const [iccid, setIccid] = useState('')
  const [mcc, setMcc] = useState('')
  const [mnc, setMnc] = useState('')
  const [msisdn, setMsisdn] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const idRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    idRef.current?.focus()
  }, [])

  const valid = /^[A-Za-z0-9_.-]{1,80}$/.test(id.trim())

  const create = async () => {
    if (!valid) return
    setBusy(true)
    setError(null)
    try {
      await api.instances.upsert({
        id: id.trim(),
        name: name.trim() || id.trim(),
        imsi: imsi.trim(),
        iccid: iccid.trim(),
        mcc: mcc.trim(),
        mnc: mnc.trim(),
        msisdn: msisdn.trim(),
      })
      await onSaved()
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <strong style={{ fontWeight: 500 }}>{t('line.create')}</strong>
      </div>
      <div className="card-body stack">
        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <div className="field-row">
          <Field
            label={t('line.id')}
            hint={t('line.idHint')}
            error={id.trim() && !valid ? t('line.idInvalid') : undefined}
          >
            <input
              ref={idRef}
              className="input mono"
              value={id}
              placeholder="line-3"
              onChange={(event) => setId(event.target.value)}
            />
          </Field>
          <Field label={t('line.title')}>
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
        </div>

        <div className="field-row">
          <Field label={t('line.iccid')}>
            <input
              className="input mono"
              value={iccid}
              onChange={(event) => setIccid(event.target.value)}
            />
          </Field>
          <Field label={t('line.imsi')}>
            <input
              className="input mono"
              value={imsi}
              onChange={(event) => setImsi(event.target.value)}
            />
          </Field>
        </div>

        <div className="field-row">
          <Field label="MCC">
            <input
              className="input mono"
              maxLength={3}
              value={mcc}
              onChange={(event) => setMcc(event.target.value)}
            />
          </Field>
          <Field label="MNC">
            <input
              className="input mono"
              maxLength={3}
              value={mnc}
              onChange={(event) => setMnc(event.target.value)}
            />
          </Field>
        </div>

        <div className="field-row">
          <Field label={t('line.msisdn')}>
            <input
              className="input mono"
              value={msisdn}
              onChange={(event) => setMsisdn(event.target.value)}
            />
          </Field>
          <div />
        </div>

        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !valid}
            onClick={() => void create()}
          >
            {busy ? t('settings.saving') : t('action.save')}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            {t('action.cancel')}
          </button>
        </div>
      </div>
    </section>
  )
}
