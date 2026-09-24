/**
 * Balance & keepalive.
 *
 * Two jobs that share a page because they share a currency: what the line still has, and
 * what it costs to keep it. The screen is built around three facts that the API encodes
 * deliberately and that a naive UI would flatten away:
 *
 *   1. `run` spends real money. A manual run sends a genuinely chargeable SMS to a carrier.
 *      It therefore goes through `ConfirmDialog` with `requireAcknowledge`, and the confirm
 *      body names the recipient and body text so the operator confirms the actual message,
 *      not a generic "are you sure". A checkbox — not just a click — because the action is
 *      irreversible and the sum is small enough to click through carelessly.
 *
 *   2. Balance values are display strings, never numbers. Carriers write "12.40 GBP" and
 *      "250 texts"; parsing them into floats would invent precision and drop the unit. So
 *      they are shown verbatim. The one place a comparison happens is the balance-watch
 *      threshold, and there it is explicitly best-effort: `_parse_money` in the control
 *      plane returns null rather than guess, and the UI says "shown, never judged" so the
 *      distinction is visible rather than implied.
 *
 *   3. A SIM that is not in the gateway cannot be sent anything. `in_gateway` comes from the
 *      control plane and there are always more configured lines than card slots, so the page
 *      disables the run switch for an absent SIM and explains why. Its expiry still matters
 *      though — an unused SIM is exactly the one a carrier reclaims — so the expiry column
 *      keeps working for a line that is out of the box.
 *
 * Everything reads from one request: `GET /api/keepalive/summary` fans out per line on the
 * server. With five lines, doing four round-trips each from the browser would be pure
 * overhead, and it would also make the "days to expiry" arithmetic depend on the browser's
 * clock, so the server sends `now` and every countdown is computed against that.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api.ts'
import { useI18n } from '../lib/i18n.tsx'
import type { MessageKey } from '../lib/i18n.tsx'
import { ApiError } from '../lib/types.ts'
import type {
  Allowance,
  AllowanceQueryRule,
  Keepalive as KeepaliveConfig,
  KeepaliveSummary,
  KeepaliveSummaryRow,
} from '../lib/types.ts'
import {
  Badge,
  ConfirmDialog,
  Disclosure,
  Empty,
  ErrorNote,
  Field,
  KeyValue,
  SkeletonRows,
  StatusDot,
} from '../components/ui.tsx'
import type { Tone } from '../components/ui.tsx'
import { formatAge, formatDuration, toPercent } from '../lib/format.ts'

/** The six editable allowance fields, in the order the control plane stores them. */
const ALLOWANCE_FIELDS = [
  'balance',
  'valid_until',
  'sms_remaining',
  'data_remaining',
  'voice_remaining',
  'activated_at',
] as const

type AllowanceField = (typeof ALLOWANCE_FIELDS)[number]

const ALLOWANCE_LABEL: Record<AllowanceField, MessageKey> = {
  balance: 'keepalive.balance',
  valid_until: 'keepalive.validUntil',
  sms_remaining: 'keepalive.smsLeft',
  data_remaining: 'keepalive.dataLeft',
  voice_remaining: 'keepalive.voiceLeft',
  activated_at: 'keepalive.activatedAt',
}

/** Keepalive run status → tone. `sent_unconfirmed` is warn, not danger: the charge may have landed. */
function toneForRunStatus(status: string | undefined): Tone {
  switch (status) {
    case 'ok':
      return 'ok'
    case 'balance_low':
      return 'warn'
    case 'sent_unconfirmed':
      return 'warn'
    case 'failed':
      return 'danger'
    default:
      return 'neutral'
  }
}

const RUN_STATUS_KEY: Record<string, MessageKey> = {
  ok: 'keepalive.status.ok',
  sent_unconfirmed: 'keepalive.status.sent_unconfirmed',
  failed: 'keepalive.status.failed',
  balance_low: 'keepalive.status.balance_low',
}

/**
 * Line status → tone, matching the Lines view so a colour means the same thing in both.
 * Duplicated deliberately rather than shared: the two views are allowed to diverge on what
 * they consider "good", and a shared helper would quietly couple them.
 */
function toneForLineState(state: string | undefined): Tone {
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

function blankAllowance(instance: string): Allowance {
  const blank: Allowance = {
    instance,
    balance: '',
    valid_until: '',
    sms_remaining: '',
    data_remaining: '',
    voice_remaining: '',
    activated_at: '',
  }
  return blank
}

/* ------------------------------------------------------------ expiry display */

/**
 * "Days to expiry" with the sign handled explicitly.
 *
 * The server computes the day count against the gateway's own timezone, because "does this
 * expire before the next billing date" is a calendar question and the browser may be in a
 * different zone. A null day count means the carrier's date could not be parsed — that is
 * shown as unknown, never as a number invented from a partial match.
 */
function ExpiryNote({
  days,
  validUntil,
}: {
  days: number | null
  validUntil: string
}) {
  const { t } = useI18n()
  if (!validUntil) return <span className="xs faint">{t('keepalive.expiryUnknown')}</span>
  if (days === null) return <span className="xs faint">{t('keepalive.expiryUnknown')}</span>
  const tone: Tone = days < 0 ? 'danger' : days <= 14 ? 'warn' : 'ok'
  const text =
    days < 0
      ? t('keepalive.expired', { days: Math.abs(days) })
      : t('keepalive.expiresIn', { days })
  return (
    <Badge tone={tone}>
      {text}
    </Badge>
  )
}

/* ------------------------------------------------------------- allowance edit */

function AllowanceEditor({
  row,
  onClose,
  onSaved,
}: {
  row: KeepaliveSummaryRow
  onClose: () => void
  onSaved: (next: Allowance) => void
}) {
  const { t } = useI18n()
  const [draft, setDraft] = useState<Record<AllowanceField, string>>(() => {
    const initial = {} as Record<AllowanceField, string>
    for (const key of ALLOWANCE_FIELDS) initial[key] = String(row.allowance[key] ?? '')
    return initial
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      // Unchanged fields are sent as-is rather than omitted: this endpoint replaces the
      // whole snapshot, so a partial body would blank the fields it left out.
      const payload: Allowance = { ...blankAllowance(row.instance), ...draft }
      const result = await api.instances.allowance.save(row.instance, payload)
      onSaved(result.allowance)
      onClose()
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" role="presentation" onClick={() => (busy ? undefined : onClose())}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('keepalive.editAllowance')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <strong style={{ fontWeight: 500 }}>{t('keepalive.editAllowance')}</strong>
        </div>
        <div className="modal-body stack" style={{ gap: 'var(--space-3)' }}>
          <p className="small muted" style={{ margin: 0 }}>
            {t('keepalive.allowanceHint')}
          </p>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {ALLOWANCE_FIELDS.map((key) => (
            <Field key={key} label={t(ALLOWANCE_LABEL[key])}>
              <input
                className="input"
                value={draft[key]}
                placeholder={key === 'activated_at' || key === 'valid_until' ? 'YYYY-MM-DD' : ''}
                onChange={(event) =>
                  setDraft((previous) => ({ ...previous, [key]: event.target.value }))
                }
              />
            </Field>
          ))}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            {t('action.cancel')}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>
            {busy ? `${t('action.save')}…` : t('action.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- query rule edit */

function QueryRulePanel({
  iid,
  rule,
  onChanged,
}: {
  iid: string
  rule: AllowanceQueryRule | null
  onChanged: (next: AllowanceQueryRule) => void
}) {
  const { t } = useI18n()
  const [recipient, setRecipient] = useState(rule?.effective?.recipient ?? '')
  const [body, setBody] = useState(rule?.effective?.body ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The effective rule can change underneath this panel (a carrier is re-detected, or another
  // tab resets it), so the inputs re-seed whenever the resolved rule identity changes.
  useEffect(() => {
    setRecipient(rule?.effective?.recipient ?? '')
    setBody(rule?.effective?.body ?? '')
  }, [rule?.effective?.recipient, rule?.effective?.body])

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.instances.allowance.saveQueryRule(iid, recipient, body)
      onChanged(result.rule)
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const reset = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.instances.allowance.removeQueryRule(iid)
      onChanged(result.rule)
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack" style={{ gap: 'var(--space-3)' }}>
      <p className="xs faint" style={{ margin: 0 }}>
        {t('keepalive.queryRuleHint')}
      </p>

      {rule?.known ? (
        <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
          <Badge tone="ok">{t('keepalive.ruleKnown', { carrier: rule.carrier_label })}</Badge>
          {rule.custom ? <Badge tone="warn">{t('keepalive.ruleCustom')}</Badge> : null}
        </div>
      ) : (
        <div className="alert alert-info small">{t('keepalive.ruleNone')}</div>
      )}

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <div className="field-row">
        <Field label={t('keepalive.recipient')}>
          <input
            className="input"
            value={recipient}
            onChange={(event) => setRecipient(event.target.value)}
            placeholder="6700"
          />
        </Field>
        <Field label={t('keepalive.body')}>
          <input
            className="input"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="BAL"
          />
        </Field>
      </div>

      <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={busy || !recipient.trim() || !body.trim()}
          onClick={save}
        >
          {busy ? `${t('action.save')}…` : t('action.save')}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy || !rule?.custom}
          onClick={reset}
        >
          {t('keepalive.resetRule')}
        </button>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- config form */

function KeepaliveForm({
  iid,
  initial,
  onSaved,
}: {
  iid: string
  initial: KeepaliveConfig
  onSaved: (next: KeepaliveConfig) => void
}) {
  const { t } = useI18n()
  const [enabled, setEnabled] = useState(initial.enabled)
  const [action, setAction] = useState(initial.action)
  const [smsTo, setSmsTo] = useState(initial.sms_to)
  const [smsBody, setSmsBody] = useState(initial.sms_body)
  const [verifyCharge, setVerifyCharge] = useState(initial.verify_charge)
  const [threshold, setThreshold] = useState(initial.threshold)
  const [interval, setInterval] = useState(String(initial.interval_days || 30))
  const [firstRun, setFirstRun] = useState(initial.next_run_date)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Client-side mirror of `_clean_keepalive`. Every one of these rules also exists on the
  // server; they are repeated here so the operator is told before a round-trip, not after.
  const intervalNumber = Number(interval)
  const intervalBad =
    interval.trim() === '' ||
    !Number.isInteger(intervalNumber) ||
    intervalNumber < 1 ||
    intervalNumber > 365
  const needsRecipient = enabled && action === 'sms'
  const recipientBad =
    needsRecipient && !/^\+?[0-9 ()-]{3,32}$/.test(smsTo.trim())
  const bodyMissing = needsRecipient && !smsBody.trim()
  const bodyTooLong = smsBody.length > 160
  const blocked = intervalBad || recipientBad || bodyMissing || bodyTooLong

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.instances.keepalive.save(iid, {
        enabled,
        action,
        sms_to: smsTo.trim(),
        sms_body: smsBody.trim(),
        verify_charge: verifyCharge,
        threshold: threshold.trim(),
        interval_days: intervalNumber,
        // Omitted when blank so the server keeps the existing schedule instead of clearing it.
        next_run_date: firstRun.trim() || undefined,
      })
      onSaved(result.keepalive)
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack" style={{ gap: 'var(--space-3)' }}>
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <label className="checkbox">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        <span className="small">{t('keepalive.keepaliveConfig')}</span>
      </label>

      <Field label={t('keepalive.action')}>
        <select
          className="input"
          value={action}
          onChange={(event) => setAction(event.target.value as KeepaliveConfig['action'])}
        >
          <option value="sms">{t('keepalive.actionSms')}</option>
          <option value="balance_watch">{t('keepalive.actionBalance')}</option>
        </select>
        <span className="xs faint" style={{ display: 'block' }}>
          {action === 'sms' ? t('keepalive.actionSmsHint') : t('keepalive.actionBalanceHint')}
        </span>
      </Field>

      {action === 'sms' ? (
        <>
          <div className="field-row">
            <Field
              label={t('keepalive.to')}
              error={recipientBad ? t('keepalive.needRecipient') : undefined}
            >
              <input
                className="input"
                value={smsTo}
                onChange={(event) => setSmsTo(event.target.value)}
                placeholder="+447700900123"
              />
            </Field>
            <Field
              label={t('keepalive.message')}
              hint={`${smsBody.length}/160`}
              error={
                bodyMissing
                  ? t('keepalive.needBody')
                  : bodyTooLong
                    ? t('keepalive.bodyTooLong')
                    : undefined
              }
            >
              <input
                className="input"
                value={smsBody}
                maxLength={200}
                onChange={(event) => setSmsBody(event.target.value)}
                placeholder="Keepalive"
              />
            </Field>
          </div>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={verifyCharge}
              onChange={(event) => setVerifyCharge(event.target.checked)}
            />
            <span className="small">{t('keepalive.verifyCharge')}</span>
          </label>
          <span className="xs faint" style={{ marginTop: -8 }}>
            {t('keepalive.verifyChargeHint')}
          </span>
        </>
      ) : (
        <Field label={t('keepalive.threshold')} hint={t('keepalive.thresholdHint')}>
          <input
            className="input"
            value={threshold}
            onChange={(event) => setThreshold(event.target.value)}
            placeholder="5.00"
          />
        </Field>
      )}

      <div className="field-row">
        <Field
          label={t('keepalive.interval')}
          error={intervalBad ? t('keepalive.interval') : undefined}
        >
          <input
            className="input"
            type="number"
            min={1}
            max={365}
            value={interval}
            onChange={(event) => setInterval(event.target.value)}
          />
        </Field>
        <Field label={t('keepalive.firstRun')} hint={t('keepalive.window')}>
          <input
            className="input"
            type="date"
            value={firstRun}
            onChange={(event) => setFirstRun(event.target.value)}
          />
        </Field>
      </div>

      <div className="row">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={busy || blocked}
          onClick={save}
        >
          {busy ? `${t('action.save')}…` : t('action.save')}
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ run confirm */

/**
 * The manual-run confirmation.
 *
 * The body reproduces the exact recipient and message text that will be sent, so the
 * acknowledgment is about a specific charge rather than a generic one. A `balance_watch`
 * run sends a query rather than a charge, and says so — conflating the two would either
 * overstate the cost or, worse, train the operator to click through the warning.
 */
function RunConfirmDialog({
  row,
  rule,
  busy,
  onConfirm,
  onCancel,
}: {
  row: KeepaliveSummaryRow
  rule: AllowanceQueryRule | null
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useI18n()
  const config = row.keepalive
  const isSms = config.action === 'sms'
  return (
    <ConfirmDialog
      title={isSms ? t('keepalive.runConfirmTitle') : t('keepalive.queryNow')}
      confirmLabel={t('keepalive.runNow')}
      tone="danger"
      busy={busy}
      requireAcknowledge
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <p className="small" style={{ margin: 0 }}>
        {isSms
          ? t('keepalive.runConfirmBody', {
              body: config.sms_body || '—',
              to: config.sms_to || '—',
            })
          : t('keepalive.runConfirmBalance', {
              recipient: rule?.effective?.recipient ?? '—',
            })}
      </p>
      <div className="kv-grid">
        <KeyValue label={t('keepalive.to')} mono>
          {config.sms_to || '—'}
        </KeyValue>
        <KeyValue label={t('keepalive.message')} mono>
          {isSms ? config.sms_body || '—' : `${config.threshold || '—'}`}
        </KeyValue>
      </div>
    </ConfirmDialog>
  )
}

/* ------------------------------------------------------------------- line card */

function LineBalanceCard({
  row,
  rule,
  onRuleChanged,
  onRowChanged,
}: {
  row: KeepaliveSummaryRow
  rule: AllowanceQueryRule | null
  onRuleChanged: (next: AllowanceQueryRule) => void
  onRowChanged: (next: Partial<KeepaliveSummaryRow>) => void
}) {
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)
  const [confirmingRun, setConfirmingRun] = useState(false)
  const [running, setRunning] = useState(false)
  const [querying, setQuerying] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const config = row.keepalive

  const runNow = async () => {
    setRunning(true)
    setError(null)
    setNotice(null)
    try {
      const result = await api.instances.keepalive.run(row.instance)
      onRowChanged({ keepalive: result.keepalive })
      setNotice(result.keepalive.last_detail || t('keepalive.runResult'))
      setConfirmingRun(false)
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : String(failure))
      setConfirmingRun(false)
    } finally {
      setRunning(false)
    }
  }

  const queryNow = async () => {
    setQuerying(true)
    setError(null)
    setNotice(null)
    try {
      await api.instances.allowance.query(row.instance, 'auto')
      setNotice(t('keepalive.querySent'))
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : String(failure))
    } finally {
      setQuerying(false)
    }
  }

  const allowanceHasData = ALLOWANCE_FIELDS.some((key) => String(row.allowance[key] ?? '').trim())

  return (
    <div className="card">
      <div className="card-head">
        <div className="stack" style={{ gap: 4, minWidth: 0 }}>
          <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
            <strong style={{ fontWeight: 500 }}>{row.name}</strong>
            <span className="row xs faint" style={{ gap: 5 }}>
              <StatusDot tone={toneForLineState(row.state)} />
              {row.label || row.state}
            </span>
            {row.in_gateway ? (
              <Badge tone="ok">{t('keepalive.inGateway')}</Badge>
            ) : (
              <Badge tone="neutral">{t('keepalive.notInGateway')}</Badge>
            )}
          </div>
          <div className="xs faint mono">{row.msisdn || row.instance}</div>
        </div>
        <div className="stack" style={{ gap: 4, alignItems: 'flex-end' }}>
          <ExpiryNote days={row.days_to_expiry} validUntil={row.allowance.valid_until} />
          {row.allowance.updated_ts ? (
            <span className="xs faint">
              {t('keepalive.updatedAt')} · {formatAge(row.allowance.updated_ts)}
              {' · '}
              {row.allowance.source === 'sms'
                ? t('keepalive.sourceSms')
                : t('keepalive.sourceManual')}
            </span>
          ) : null}
        </div>
      </div>

      <div className="card-body stack" style={{ gap: 'var(--space-4)' }}>
        {!row.in_gateway ? (
          <div className="alert alert-warn small">{t('keepalive.notInGatewayHint')}</div>
        ) : null}

        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {notice ? <div className="alert alert-info small">{notice}</div> : null}

        {/* Balance snapshot — display strings, shown exactly as the carrier wrote them. */}
        <div className="kv-grid">
          <KeyValue label={t('keepalive.balance')}>{row.allowance.balance || '—'}</KeyValue>
          <KeyValue label={t('keepalive.smsLeft')}>{row.allowance.sms_remaining || '—'}</KeyValue>
          <KeyValue label={t('keepalive.dataLeft')}>
            {row.allowance.data_remaining || '—'}
          </KeyValue>
          <KeyValue label={t('keepalive.voiceLeft')}>
            {row.allowance.voice_remaining || '—'}
          </KeyValue>
          <KeyValue label={t('keepalive.activatedAt')}>
            {row.allowance.activated_at || '—'}
          </KeyValue>
          <KeyValue label={t('line.availability')}>
            {toPercent(row.uptime_ratio) === null
              ? t('state.unknown')
              : `${toPercent(row.uptime_ratio)}%`}
          </KeyValue>
        </div>

        <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
          <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
            {t('keepalive.editAllowance')}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={querying || !rule?.effective || !row.in_gateway}
            onClick={queryNow}
          >
            {querying ? t('keepalive.querySending') : t('keepalive.queryNow')}
          </button>
        </div>

        <Disclosure summary={t('keepalive.queryRule')} open={!allowanceHasData}>
          <QueryRulePanel iid={row.instance} rule={rule} onChanged={onRuleChanged} />
        </Disclosure>

        <Disclosure summary={t('keepalive.keepaliveConfig')} open={config.enabled}>
          {config.last_status ? (
            <div className="row wrap small" style={{ gap: 'var(--space-2)' }}>
              <Badge tone={toneForRunStatus(config.last_status)}>
                {RUN_STATUS_KEY[config.last_status]
                  ? t(RUN_STATUS_KEY[config.last_status])
                  : config.last_status}
              </Badge>
              {config.last_run_ts ? (
                <span className="faint">
                  {t('keepalive.lastRun')} · {formatAge(config.last_run_ts)}
                </span>
              ) : null}
            </div>
          ) : (
            <span className="xs faint">{t('keepalive.status.never')}</span>
          )}

          {config.enabled && config.next_due_ts ? (
            <div className="kv-grid">
              <KeyValue label={t('keepalive.nextRun')}>
                {config.next_run_date || '—'}
              </KeyValue>
              <KeyValue label={t('keepalive.window')}>
                {formatDuration(Math.max(0, config.next_due_ts - Date.now() / 1000))}
              </KeyValue>
            </div>
          ) : null}

          <KeepaliveForm
            iid={row.instance}
            initial={config}
            onSaved={(next) => onRowChanged({ keepalive: next })}
          />

          <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!row.in_gateway || running}
              onClick={() => setConfirmingRun(true)}
            >
              {running ? t('keepalive.running') : t('keepalive.runNow')}
            </button>
            <span className="xs faint">{t('keepalive.window')}</span>
          </div>
        </Disclosure>
      </div>

      {editing ? (
        <AllowanceEditor
          row={row}
          onClose={() => setEditing(false)}
          onSaved={(next) => onRowChanged({ allowance: next })}
        />
      ) : null}

      {confirmingRun ? (
        <RunConfirmDialog
          row={row}
          rule={rule}
          busy={running}
          onConfirm={runNow}
          onCancel={() => setConfirmingRun(false)}
        />
      ) : null}
    </div>
  )
}

/* ----------------------------------------------------------------------- view */

export function Keepalive() {
  const { t } = useI18n()
  const [summary, setSummary] = useState<KeepaliveSummary | null>(null)
  const [rules, setRules] = useState<Record<string, AllowanceQueryRule | null>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const result = await api.instances.keepalive.summary()
      setSummary(result)
      setError(null)
      // The summary answers "is there a rule" but not what it IS, so the editable rule is
      // fetched per line. Only for lines that report one — a line with no rule would just
      // return null and there is nothing to show.
      const withRules = result.lines.filter((line) => line.has_query_rule)
      const fetched = await Promise.all(
        withRules.map(async (line) => {
          try {
            const response = await api.instances.allowance.getQueryRule(line.instance)
            return [line.instance, response.rule] as const
          } catch {
            return [line.instance, null] as const
          }
        }),
      )
      setRules(Object.fromEntries(fetched))
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : String(failure))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const rows = useMemo(() => summary?.lines ?? [], [summary])

  const patchRow = useCallback((instance: string, patch: Partial<KeepaliveSummaryRow>) => {
    setSummary((previous) =>
      previous
        ? {
            ...previous,
            lines: previous.lines.map((line) =>
              line.instance === instance ? { ...line, ...patch } : line,
            ),
          }
        : previous,
    )
  }, [])

  return (
    <div className="stack" style={{ gap: 'var(--space-4)' }}>
      <header className="row wrap" style={{ gap: 'var(--space-3)', alignItems: 'flex-start' }}>
        <div className="stack" style={{ gap: 4, flex: 1, minWidth: 200 }}>
          <h1 className="h1">{t('keepalive.title')}</h1>
          <p className="small muted" style={{ margin: 0 }}>
            {t('keepalive.hint')}
          </p>
        </div>
        <button type="button" className="btn btn-sm" disabled={loading} onClick={() => void load()}>
          {loading ? `${t('action.refresh')}…` : t('action.refresh')}
        </button>
      </header>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {loading && !summary ? (
        <SkeletonRows rows={3} />
      ) : rows.length === 0 ? (
        <Empty>{t('keepalive.none')}</Empty>
      ) : (
        <div className="stack" style={{ gap: 'var(--space-4)' }}>
          {rows.map((row) => (
            <LineBalanceCard
              key={row.instance}
              row={row}
              rule={rules[row.instance] ?? null}
              onRuleChanged={(next) =>
                setRules((previous) => ({ ...previous, [row.instance]: next }))
              }
              onRowChanged={(patch) => patchRow(row.instance, patch)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
