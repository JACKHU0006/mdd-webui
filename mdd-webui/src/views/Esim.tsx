/**
 * eSIM.
 *
 * Managing an eUICC through lpac, with one constraint driving the whole design: **lpac is
 * single-threaded across every reader**, and a read is *exclusive* — it takes the card away
 * from whatever line is holding it, even one that is currently registered and carrying a
 * call. That makes these three decisions non-negotiable:
 *
 *   1. Entering the page must never touch a card. The first thing loaded is `GET /esim/status`,
 *      which only asks whether lpac exists. The card is read only when the operator clicks
 *      "Read the card", and that button says what it will interrupt.
 *   2. The cached view is preferred when one exists. `GET /esim/chip/cached` returns the last
 *      successful read for the card currently in the reader (matched server-side by ICCID),
 *      so switching a profile does not require stopping a running line just to see the list.
 *      The UI marks a cached read as cached and when it was taken — presenting it as live
 *      would be the lie that makes an operator stop a working line for nothing.
 *   3. Every mutating call passes `reader_index` and, on a dual-SE card, an explicit `se_id`.
 *      Guessing which Secure Element to install onto can write a profile to the wrong one, and
 *      the card will not tell you afterwards.
 *
 * Profile field names are lpac's own camelCase (`profileState`, `profileNickname`,
 * `profileName`) because `lpa.profile_list` forwards the tool's JSON verbatim. Renaming them
 * for tidiness here would mean the view renders `undefined` for every row.
 *
 * Download progress is a background job on the server pushed over the `esim_download`
 * WebSocket event; the HTTP call only acknowledges the claim. The step list below mirrors
 * lpac's pipeline so a failure names the step that failed rather than showing a generic error.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.ts'
import { useI18n } from '../lib/i18n.tsx'
import type { MessageKey } from '../lib/i18n.tsx'
import { EsimInventoryPanel } from './EsimInventory.tsx'
import { useGateway } from '../lib/store.tsx'
import { ApiError } from '../lib/types.ts'
import type {
  EsimCardView,
  EsimNotification,
  EsimProfile,
  EsimSecureElement,
  EsimStatus,
  WsEvent,
} from '../lib/types.ts'
import {
  Badge,
  ConfirmDialog,
  CopyButton,
  Disclosure,
  Empty,
  ErrorNote,
  Field,
  SkeletonRows,
} from '../components/ui.tsx'
import { QrScan } from '../components/QrScan.tsx'
import { sizeKey, sumMeasured, useProfileSizes, type SizeRecord } from '../lib/esimSize.ts'
import { formatAge, formatBytes } from '../lib/format.ts'

/**
 * lpac's download pipeline, in order, with the i18n key for each step.
 *
 * Defining it here (rather than only on the server) is what lets the UI show which step is
 * running and, on failure, which one broke — the single most useful fact when a download
 * dies, because each step fails for a different reason (no network, bad activation code,
 * eUICC refused, profile package invalid).
 */
const DOWNLOAD_STEPS: Array<[step: string, labelKey: MessageKey]> = [
  ['es10a_get_euicc_configured_addresses', 'esim.step.es10a'],
  ['es10b_get_euicc_challenge_and_info', 'esim.step.es10bChallenge'],
  ['es9p_initiate_authentication', 'esim.step.es9pInitiate'],
  ['es10b_authenticate_server', 'esim.step.es10bAuthServer'],
  ['es9p_authenticate_client', 'esim.step.es9pAuthClient'],
  ['es8p_metadata_parse', 'esim.step.metadata'],
  ['es10b_prepare_download', 'esim.step.prepare'],
  ['es9p_get_bound_profile_package', 'esim.step.fetch'],
  ['es10b_load_bound_profile_package', 'esim.step.install'],
]

/**
 * Map an incoming step name onto the pipeline.
 *
 * lpac emits things like `es10b_load_bound_profile_package:result` and, on failure, steps
 * from a cancel path (`cancel_session`). Returning null for those rather than defaulting to
 * the first step is what stops the progress bar from jumping back to step 1 right before the
 * error arrives — which reads as "it restarted" instead of "it failed".
 */
function resolveDownloadStep(step: unknown): string | null {
  const text = String(step ?? '')
  if (!text || text === 'started' || text === 'completed' || text === 'cancelling') return null
  const base = text.split(':')[0]
  return DOWNLOAD_STEPS.some(([key]) => key === text || key === base) ? base : null
}

/** An empty reader and an ordinary USIM fail identically, so the empty state must tell them apart. */
function isNoCardError(message: string): boolean {
  return /SCARD_E_NO_SMARTCARD|SCARD_W_REMOVED_CARD|no smart ?card|card (is )?(absent|removed|not present)|SCardConnect/i.test(
    message,
  )
}

function isNonEuiccError(message: string): boolean {
  return /euicc_init|does not appear to be an eUICC|not an eUICC|ordinary USIM/i.test(message)
}

/** Nickname first, then the carrier's own name — the order a user expects to read. */
function profileLabel(profile: EsimProfile, fallback: string): string {
  const nickname = String(profile.profileNickname ?? '').trim()
  if (nickname) return nickname
  return String(profile.profileName ?? profile.serviceProviderName ?? fallback).trim() || fallback
}

function isProfileEnabled(profile: EsimProfile): boolean {
  return String(profile.profileState ?? '').toLowerCase() === 'enabled'
}

/* ------------------------------------------------------------- download state */

interface DownloadState {
  step: string
  event: string
  done: boolean
  error?: string
  metadata?: Record<string, unknown>
}

function DownloadProgress({
  state,
  onCancel,
  onDismiss,
}: {
  state: DownloadState
  onCancel: () => void
  onDismiss: () => void
}) {
  const { t } = useI18n()
  const resolved = resolveDownloadStep(state.step)
  const index = resolved ? DOWNLOAD_STEPS.findIndex(([key]) => key === resolved) : -1
  // `started` is genuinely index 0; an unknown step is -1 (no highlight at all) rather than 0.
  const current = state.done
    ? DOWNLOAD_STEPS.length
    : index >= 0
      ? index
      : state.step === 'started'
        ? 0
        : -1

  const preview = state.metadata
    ? String(state.metadata.profileName ?? state.metadata.serviceProviderName ?? '').trim()
    : ''

  return (
    <div className="stack" style={{ gap: 'var(--space-3)' }}>
      <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
        <strong style={{ fontWeight: 500 }}>{t('esim.downloadProgress')}</strong>
        {state.error ? (
          <Badge tone="danger">{t('esim.downloadFailed')}</Badge>
        ) : state.done ? (
          <Badge tone="ok">{t('esim.downloadDone')}</Badge>
        ) : (
          <Badge tone="warn">{t('esim.downloading')}</Badge>
        )}
      </div>

      <div className="stack" style={{ gap: 4 }}>
        {DOWNLOAD_STEPS.map(([key, labelKey], position) => {
          const done = state.done || (current >= 0 && position < current)
          const active = !state.done && current === position
          const failed = Boolean(state.error) && current === position
          return (
            <div
              key={key}
              className="row small"
              style={{
                gap: 'var(--space-2)',
                opacity: done || active || failed ? 1 : 0.45,
              }}
            >
              <span
                className={`dot dot-${failed ? 'danger' : done ? 'ok' : active ? 'warn' : 'neutral'}`}
                aria-hidden="true"
              />
              <span style={{ color: active ? 'var(--text)' : undefined }}>{t(labelKey)}</span>
            </div>
          )
        })}
      </div>

      {preview || state.metadata?.iccid ? (
        <div className="small muted">
          {t('esim.downloadPreview')}: {preview || t('esim.profileFallback')}
          {state.metadata?.iccid ? ` · ${String(state.metadata.iccid)}` : ''}
        </div>
      ) : null}

      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}

      <div className="row" style={{ gap: 'var(--space-2)' }}>
        {!state.done && !state.error ? (
          <button type="button" className="btn btn-sm" onClick={onCancel}>
            {t('esim.cancelDownload')}
          </button>
        ) : (
          <button type="button" className="btn btn-sm" onClick={onDismiss}>
            {t('esim.dismiss')}
          </button>
        )}
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- download form */

function DownloadDialog({
  readerIndex,
  ses,
  imeiDefault,
  onClose,
  onStarted,
}: {
  readerIndex: number
  ses: EsimSecureElement[]
  imeiDefault: string
  onClose: () => void
  onStarted: () => void
}) {
  const { t } = useI18n()
  const dual = ses.length > 1
  const [mode, setMode] = useState<'code' | 'manual'>('code')
  const [activation, setActivation] = useState('')
  const [smdp, setSmdp] = useState('')
  const [matchingId, setMatchingId] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [imei, setImei] = useState(imeiDefault || '')
  // A dual-SE card starts with nothing selected on purpose: defaulting to the first element
  // is how a profile lands on the wrong one.
  const [seId, setSeId] = useState(dual ? '' : (ses[0]?.id ?? 'default'))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [discovered, setDiscovered] = useState<string[]>([])

  /** `LPA:1$smdp.example.com$MATCHING-ID` → the two fields, so pasting one code is enough. */
  useEffect(() => {
    const parts = activation.trim().split('$')
    if (parts[0]?.toUpperCase() === 'LPA:1' && parts[1]) {
      setSmdp(parts[1])
      if (parts[2] !== undefined) setMatchingId(parts[2])
    }
  }, [activation])

  const target = () => ({
    reader_index: readerIndex,
    se_id: seId || ses[0]?.id || 'default',
    imei: imei.trim() || undefined,
    confirmation_code: confirmation.trim() || undefined,
  })

  const runDiscovery = async () => {
    setDiscovering(true)
    setError(null)
    try {
      const result = await api.esim.discovery(target())
      const addresses = (result.entries ?? [])
        .map((entry) => String(entry.smdp ?? '').trim())
        .filter(Boolean)
      setDiscovered(addresses)
      if (addresses[0] && !smdp.trim()) setSmdp(addresses[0])
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : String(failure))
    } finally {
      setDiscovering(false)
    }
  }

  const submit = async () => {
    setError(null)
    if (dual && !seId) {
      setError(t('esim.selectSe'))
      return
    }
    const body: Record<string, unknown> = { ...target() }
    if (mode === 'code') {
      if (!activation.trim()) {
        setError(t('esim.activationCode'))
        return
      }
      body.activation_code = activation.trim()
    } else {
      if (!smdp.trim()) {
        setError(t('esim.smdp'))
        return
      }
      body.smdp = smdp.trim()
      body.matching_id = matchingId.trim() || undefined
    }
    setBusy(true)
    try {
      await api.esim.download(body)
      onStarted()
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
        aria-label={t('esim.download')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <strong style={{ fontWeight: 500 }}>{t('esim.download')}</strong>
        </div>
        <div className="modal-body stack" style={{ gap: 'var(--space-3)' }}>
          <p className="small muted" style={{ margin: 0 }}>
            {t('esim.downloadHint')}
          </p>
          {error ? <ErrorNote>{error}</ErrorNote> : null}

          {/* 扫码只是把二维码里的那串文本取出来填进下面的字段，不改变下载流程本身。 */}
          <Field label={t('esim.scanLabel')}>
            <QrScan
              onDetect={(text) => {
                const clean = text.trim()
                setError(null)
                if (/^LPA:\d+\$/i.test(clean)) {
                  setMode('code')
                  setActivation(clean)
                } else if (!clean.includes('$') && clean.includes('.')) {
                  // 只有地址没有激活码：当成 SM-DP+ 填，Matching ID 让操作员自己补。
                  setMode('manual')
                  setSmdp(clean)
                } else {
                  setMode('code')
                  setActivation(clean)
                }
              }}
            />
          </Field>

          {dual ? (
            <Field label={t('esim.selectSe')} hint={t('esim.selectSeHint')}>
              <select className="input" value={seId} onChange={(event) => setSeId(event.target.value)}>
                <option value="">—</option>
                {ses.map((se, index) => (
                  <option key={se.id} value={se.id}>
                    {t('esim.slot', { index: index + 1 })} · {se.eid || se.id}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}

          <Field label={t('esim.downloadMode')}>
            <div className="tabs" role="tablist">
              <button
                type="button"
                role="tab"
                className={`tab${mode === 'code' ? ' active' : ''}`}
                aria-selected={mode === 'code'}
                onClick={() => setMode('code')}
              >
                {t('esim.modeCode')}
              </button>
              <button
                type="button"
                role="tab"
                className={`tab${mode === 'manual' ? ' active' : ''}`}
                aria-selected={mode === 'manual'}
                onClick={() => setMode('manual')}
              >
                {t('esim.modeManual')}
              </button>
            </div>
          </Field>

          {mode === 'code' ? (
            <Field label={t('esim.activationCode')}>
              <input
                className="input mono"
                value={activation}
                onChange={(event) => setActivation(event.target.value)}
                placeholder={t('esim.activationCodePlaceholder')}
              />
            </Field>
          ) : (
            <>
              <Field label={t('esim.smdp')} hint={t('esim.discoveryHint')}>
                <div className="row" style={{ gap: 'var(--space-2)' }}>
                  <input
                    className="input mono"
                    value={smdp}
                    onChange={(event) => setSmdp(event.target.value)}
                    placeholder="smdp.example.com"
                  />
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={discovering}
                    onClick={runDiscovery}
                  >
                    {discovering ? `${t('esim.discovery')}…` : t('esim.discovery')}
                  </button>
                </div>
              </Field>
              {discovered.length === 0 ? null : (
                <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
                  {discovered.map((address) => (
                    <button
                      key={address}
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setSmdp(address)}
                    >
                      {address}
                    </button>
                  ))}
                </div>
              )}
              <Field label={t('esim.matchingId')}>
                <input
                  className="input mono"
                  value={matchingId}
                  onChange={(event) => setMatchingId(event.target.value)}
                />
              </Field>
            </>
          )}

          <Field label={t('esim.confirmationCode')}>
            <input
              className="input"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </Field>

          <Field label={t('esim.imeiOverride')}>
            <input
              className="input mono"
              value={imei}
              onChange={(event) => setImei(event.target.value)}
            />
          </Field>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            {t('action.cancel')}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>
            {busy ? `${t('esim.downloadStart')}…` : t('esim.downloadStart')}
          </button>
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- rename dialog */

function RenameDialog({
  profile,
  readerIndex,
  seId,
  onClose,
  onSaved,
}: {
  profile: EsimProfile
  readerIndex: number
  seId: string
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useI18n()
  const [nickname, setNickname] = useState(() => profileLabel(profile, ''))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.esim.nickname(profile.iccid, nickname.trim(), {
        reader_index: readerIndex,
        se_id: seId,
      })
      onSaved()
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
        aria-label={t('esim.renameTitle')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <strong style={{ fontWeight: 500 }}>{t('esim.renameTitle')}</strong>
        </div>
        <div className="modal-body stack" style={{ gap: 'var(--space-3)' }}>
          <p className="small muted" style={{ margin: 0 }}>
            {t('esim.renameBody')}
          </p>
          <div className="small mono faint">{profile.iccid}</div>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <Field label={t('esim.nickname')}>
            <input
              className="input"
              autoFocus
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit()
              }}
            />
          </Field>
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

/* ------------------------------------------------------------------ se section */

function SecureElementPanel({
  se,
  index,
  dual,
  busy,
  sizes,
  onReload,
  onEnable,
  onDisable,
  onDelete,
  onRename,
}: {
  se: EsimSecureElement
  index: number
  dual: boolean
  busy: boolean
  sizes: Record<string, SizeRecord>
  onReload: () => void
  onEnable: (profile: EsimProfile) => void
  onDisable: (profile: EsimProfile) => void
  onDelete: (profile: EsimProfile) => void
  onRename: (profile: EsimProfile) => void
}) {
  const { t } = useI18n()
  const profiles = se.profiles ?? []
  const notifications = se.notifications ?? []
  const measured = sumMeasured(
    se.eid,
    profiles.map((profile) => String(profile.iccid ?? '')),
    sizes,
  )

  return (
    <div className="stack" style={{ gap: 'var(--space-3)' }}>
      <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
        {dual ? <Badge tone="neutral">{t('esim.slot', { index: index + 1 })}</Badge> : null}
        {se.eid ? (
          <>
            <span className="xs faint">{t('esim.eid')}</span>
            <span className="small mono truncate">{se.eid}</span>
            <CopyButton value={se.eid} />
          </>
        ) : null}
        {se.freeSpace !== null && se.freeSpace !== undefined ? (
          <span className="xs faint">
            {t('esim.storageFree')} · {formatBytes(se.freeSpace)}
          </span>
        ) : null}
        {measured.count > 0 ? (
          <span className="xs faint">
            {t('esim.sizeMeasured', {
              measured: String(measured.count),
              total: String(profiles.length),
              size: formatBytes(measured.total),
            })}
          </span>
        ) : null}
      </div>

      {se.freeSpace !== null && se.freeSpace !== undefined && measured.count < profiles.length ? (
        <p className="xs faint" style={{ margin: 0 }}>
          {t('esim.sizeHint')}
        </p>
      ) : null}

      {se.error ? <ErrorNote>{se.error}</ErrorNote> : null}

      {profiles.length === 0 ? (
        <div className="empty">{t('esim.noProfiles')}</div>
      ) : (
        <div className="stack" style={{ gap: 'var(--space-2)' }}>
          {profiles.map((profile) => {
            const enabled = isProfileEnabled(profile)
            return (
              <div
                key={`${se.id}:${profile.iccid}`}
                className="pickrow row wrap"
                style={{ gap: 'var(--space-2)' }}
              >
                <div className="stack" style={{ gap: 2, flex: 1, minWidth: 180 }}>
                  <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
                    <Badge tone={enabled ? 'ok' : 'neutral'}>
                      {enabled ? t('esim.profileEnabled') : t('esim.profileDisabled')}
                    </Badge>
                    <strong style={{ fontWeight: 500 }}>
                      {profileLabel(profile, t('esim.profileFallback'))}
                    </strong>
                    {profile.profileClass ? (
                      <span className="xs faint">
                        {t('esim.profileClass')} · {profile.profileClass}
                      </span>
                    ) : null}
                  </div>
                  <div className="row" style={{ gap: 'var(--space-2)' }}>
                    <span className="xs faint mono truncate">{profile.iccid}</span>
                    <CopyButton value={profile.iccid} />
                    {sizes[sizeKey(se.eid, String(profile.iccid ?? ''))] ? (
                      <span className="xs faint">
                        {t('esim.profileSize', {
                          size: formatBytes(sizes[sizeKey(se.eid, String(profile.iccid ?? ''))].bytes),
                        })}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy || enabled}
                    onClick={() => onEnable(profile)}
                  >
                    {t('esim.enable')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy || !enabled}
                    onClick={() => onDisable(profile)}
                  >
                    {t('esim.disable')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => onRename(profile)}
                  >
                    {t('esim.nickname')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => onDelete(profile)}
                  >
                    {t('esim.deleteProfile')}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="row wrap small" style={{ gap: 'var(--space-2)' }}>
        <span className="faint">{t('esim.notifications')}</span>
        {notifications.length === 0 ? (
          <span className="faint">{t('esim.noNotifications')}</span>
        ) : (
          <span>
            {notifications.map((notification: EsimNotification) => (
              <span key={notification.seq} className="badge" style={{ marginRight: 4 }}>
                #{notification.seq} · {notification.event || '—'}
              </span>
            ))}
          </span>
        )}
        <button type="button" className="btn btn-sm" disabled={busy} onClick={onReload}>
          {t('action.refresh')}
        </button>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------------- view */

export function Esim() {
  const { t } = useI18n()
  const { subscribe } = useGateway()

  const [status, setStatus] = useState<EsimStatus | null>(null)
  const [readerIndex, setReaderIndex] = useState(0)
  const [card, setCard] = useState<EsimCardView | null>(null)
  const [cachedAt, setCachedAt] = useState(0)
  const [loading, setLoading] = useState(false)
  const [statusLoading, setStatusLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [emptyReason, setEmptyReason] = useState<'no-card' | 'not-euicc' | null>(null)
  const [busyOp, setBusyOp] = useState<string | null>(null)
  const [download, setDownload] = useState<DownloadState | null>(null)
  const [showDownload, setShowDownload] = useState(false)
  const [renameTarget, setRenameTarget] = useState<{ profile: EsimProfile; seId: string } | null>(
    null,
  )
  const [deleteTarget, setDeleteTarget] = useState<{ profile: EsimProfile; seId: string } | null>(
    null,
  )
  // Enabling a profile silently disables the one that was active — and that profile is very
  // likely the one carrying a running line. The page says so in the header, so the action has
  // to stop and ask rather than let the operator discover it from a dropped connection.
  const [enableTarget, setEnableTarget] = useState<{ profile: EsimProfile; seId: string } | null>(
    null,
  )

  // Reader names come from `/api/readers`; the index is the array position, which is exactly
  // what every eSIM endpoint takes as `reader_index`. This is deliberately fetched rather than
  // derived from the device list: a card reader with no modem attached still has to appear.
  const [readers, setReaders] = useState<string[]>([])
  const [readersStale, setReadersStale] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.hardware
      .readers()
      .then((result) => {
        if (cancelled) return
        setReaders(result.readers ?? [])
        setReadersStale(Boolean(result.stale))
      })
      .catch(() => {
        if (!cancelled) setReaders([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const readerName = readers[readerIndex] ?? ''

  const ses = card?.ses ?? []
  const hasEuicc = ses.some((se) => se.eid || se.chip || (se.profiles ?? []).length > 0)
  // SGP.22 不给每个配置的大小，只能靠"下载前后空闲空间差值"来测；这里读的是本地记录。
  const sizes = useProfileSizes(card)

  /** Load only the lpac status — never the card. Safe to run on mount and on reader change. */
  useEffect(() => {
    let cancelled = false
    setStatusLoading(true)
    api.esim
      .status()
      .then((value) => {
        if (!cancelled) setStatus(value)
      })
      .catch((failure: unknown) => {
        if (!cancelled) {
          setError(failure instanceof ApiError ? failure.message : String(failure))
        }
      })
      .finally(() => {
        if (!cancelled) setStatusLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Reset everything when the reader changes, then look for a cached read to show instead of
  // forcing an exclusive one.
  useEffect(() => {
    setCard(null)
    setCachedAt(0)
    setError(null)
    setEmptyReason(null)
    setDownload(null)
  }, [readerIndex])

  useEffect(() => {
    if (card || loading || !readerName || ses.length) return
    let cancelled = false
    api.esim
      .cachedChip(readerIndex)
      .then((result) => {
        if (cancelled || !result.cached) return
        setCard({
          ok: true,
          reader: result.reader,
          reader_index: result.reader_index,
          dual: (result.ses ?? []).length > 1,
          ses: result.ses ?? [],
          imei: result.imei ?? '',
          line_running: false,
        })
        setCachedAt((result.ts ?? 0) * 1000)
      })
      .catch(() => {
        // A missing cache is the normal case, not an error worth showing.
      })
    return () => {
      cancelled = true
    }
  }, [card, loading, readerName, readerIndex, ses.length])

  /** The exclusive read. This is the only action that touches the card, and it says so. */
  const loadCard = useCallback(async () => {
    if (!readerName) return
    setLoading(true)
    setError(null)
    setCard(null)
    setCachedAt(0)
    try {
      const result = await api.esim.chip(readerIndex)
      const list = result.ses ?? []
      setCard(result)
      const seErrors = list.map((se) => se.error).filter(Boolean) as string[]
      if (list.length === 0) {
        setEmptyReason('no-card')
      } else if (seErrors.some(isNoCardError)) {
        setEmptyReason('no-card')
      } else if (list.every((se) => se.error) && seErrors.every(isNonEuiccError)) {
        setEmptyReason('not-euicc')
      } else if (list.every((se) => se.error)) {
        setError(seErrors[0] ?? null)
      }
    } catch (failure) {
      const message = failure instanceof ApiError ? failure.message : String(failure)
      // An ordinary USIM and an empty reader both fail `euicc_init`; showing a red banner for
      // either would accuse a perfectly good card of being broken.
      if (isNoCardError(message)) {
        setEmptyReason('no-card')
      } else if (isNonEuiccError(message)) {
        setEmptyReason('not-euicc')
      } else {
        setError(message)
      }
    } finally {
      setLoading(false)
    }
  }, [readerIndex, readerName])

  // Download progress arrives on the shared socket; the store forwards every event to
  // subscribers so this view does not need a second connection.
  const loadCardRef = useRef(loadCard)
  loadCardRef.current = loadCard
  useEffect(() => {
    return subscribe((event: WsEvent) => {
      if (event.type !== 'esim_download') return
      if (readerName && event.reader && event.reader !== readerName) return
      const kind = String(event.event ?? '')
      if (kind === 'started') {
        setDownload({ step: 'started', event: 'started', done: false })
      } else if (kind === 'progress' || kind === 'preview') {
        setDownload((current) => ({
          step: resolveDownloadStep(event.step) ?? current?.step ?? 'started',
          event: kind,
          done: false,
          metadata:
            (event.metadata as Record<string, unknown> | undefined) ??
            (event.data as Record<string, unknown> | undefined) ??
            current?.metadata,
        }))
      } else if (kind === 'completed') {
        setDownload({ step: 'completed', event: 'completed', done: true })
        void loadCardRef.current()
      } else if (kind === 'error') {
        setDownload((current) => ({
          step: resolveDownloadStep(event.step) ?? current?.step ?? 'started',
          event: 'error',
          done: false,
          error: String(event.error ?? t('esim.downloadFailed')),
        }))
      }
    })
  }, [subscribe, readerName, t])

  const profileOp = useCallback(
    async (label: string, action: () => Promise<unknown>) => {
      setBusyOp(label)
      setError(null)
      try {
        await action()
        await loadCardRef.current()
      } catch (failure) {
        setError(failure instanceof ApiError ? failure.message : String(failure))
      } finally {
        setBusyOp(null)
      }
    },
    [],
  )

  const switchSeId = (se: EsimSecureElement | undefined) =>
    se?.id ?? ses[0]?.id ?? 'default'

  if (statusLoading) {
    return (
      <div className="stack" style={{ gap: 'var(--space-4)' }}>
        <h1 className="h1">{t('esim.title')}</h1>
        <SkeletonRows rows={2} />
      </div>
    )
  }

  return (
    <div className="stack" style={{ gap: 'var(--space-4)' }}>
      <header className="row wrap" style={{ gap: 'var(--space-3)', alignItems: 'flex-start' }}>
        <div className="stack" style={{ gap: 4, flex: 1, minWidth: 200 }}>
          <h1 className="h1">{t('esim.title')}</h1>
          <p className="small muted" style={{ margin: 0 }}>
            {t('esim.hint')}
          </p>
        </div>
      </header>

      {status && !status.available ? (
        <div className="alert alert-warn">{t('esim.unavailable')}</div>
      ) : null}

      {/* PC/SC enumeration failed and the control plane served its last-known list. Saying so
          matters: a reader that vanished from the list is usually a transient failure, not an
          unplugged device, and the operator should retry rather than re-seat hardware. */}
      {readersStale ? <div className="alert alert-warn small">{t('esim.readersStale')}</div> : null}

      <div className="card">
        <div className="card-body stack" style={{ gap: 'var(--space-3)' }}>
          <div className="field-row">
            <Field label={t('esim.readerLabel')}>
              <select
                className="input"
                value={readerIndex}
                onChange={(event) => setReaderIndex(Number(event.target.value))}
              >
                {readers.map((name, index) => (
                  <option key={name} value={index}>
                    {t('esim.readerOption', { index, name })}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('esim.binary')}>
              <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
                <span className="small mono truncate">{status?.lpac_bin || '—'}</span>
                {status && status.busy_readers.length > 0 ? (
                  <Badge tone="warn">{t('esim.readerBusy')}</Badge>
                ) : null}
              </div>
            </Field>
          </div>

          <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={loading || !readerName || !status?.available}
              onClick={() => void loadCard()}
            >
              {loading ? t('esim.loading') : t('esim.loadCard')}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!hasEuicc}
              onClick={() => setShowDownload(true)}
            >
              {t('esim.download')}
            </button>
            {cachedAt > 0 ? (
              <span className="xs faint">{t('esim.cached', { when: formatAge(cachedAt) })}</span>
            ) : null}
          </div>

          <span className="xs faint">{t('esim.loadHint')}</span>

          {card?.line_running ? (
            <div className="alert alert-warn small">
              {t('esim.switchRunning')}
              {card.matched_instance ? ` · ${card.matched_instance}` : ''}
            </div>
          ) : null}

          {error ? <ErrorNote>{error}</ErrorNote> : null}
        </div>
      </div>

      {download ? (
        <div className="card">
          <div className="card-body">
            <DownloadProgress
              state={download}
              onCancel={() =>
                void api.esim
                  .cancelDownload({ reader_index: readerIndex })
                  .catch((failure: unknown) =>
                    setError(failure instanceof ApiError ? failure.message : String(failure)),
                  )
              }
              onDismiss={() => setDownload(null)}
            />
          </div>
        </div>
      ) : null}

      {!hasEuicc ? (
        <Empty>
          {loading
            ? t('esim.loading')
            : emptyReason === 'no-card'
              ? t('esim.noReaderCard')
              : emptyReason === 'not-euicc'
                ? t('esim.notEuicc')
                : t('esim.notLoaded')}
        </Empty>
      ) : (
        ses.map((se, index) => (
          <div className="card" key={se.id}>
            <div className="card-body">
              <SecureElementPanel
                se={se}
                index={index}
                dual={ses.length > 1}
                busy={busyOp !== null}
                onReload={() => void loadCard()}
                onEnable={(profile) => setEnableTarget({ profile, seId: switchSeId(se) })}
                sizes={sizes}
                onDisable={(profile) =>
                  void profileOp('disable', () =>
                    api.esim.disable(profile.iccid, {
                      reader_index: readerIndex,
                      se_id: switchSeId(se),
                    }),
                  )
                }
                onRename={(profile) => setRenameTarget({ profile, seId: switchSeId(se) })}
                onDelete={(profile) => setDeleteTarget({ profile, seId: switchSeId(se) })}
              />
            </div>
          </div>
        ))
      )}

      <Disclosure summary={t('esim.notifications')}>
        <p className="xs faint" style={{ margin: 0 }}>
          {t('esim.notificationsHint')}
        </p>
        <p className="xs faint" style={{ margin: 0 }}>
          {t('esim.processAllHint')}
        </p>
        {ses.map((se) => (
          <div className="row wrap" key={se.id} style={{ gap: 'var(--space-2)' }}>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busyOp !== null || !(se.notifications ?? []).length}
              onClick={() =>
                void profileOp('process', () =>
                  api.esim.processNotifications({
                    reader_index: readerIndex,
                    se_id: switchSeId(se),
                  }),
                )
              }
            >
              {t('esim.processAll')}
            </button>
            <span className="xs faint">
              {(se.notifications ?? []).length === 0
                ? t('esim.noNotifications')
                : `${(se.notifications ?? []).length}`}
            </span>
          </div>
        ))}
      </Disclosure>

      {showDownload ? (
        <DownloadDialog
          readerIndex={readerIndex}
          ses={ses}
          imeiDefault={card?.imei ?? ''}
          onClose={() => setShowDownload(false)}
          onStarted={() => setDownload({ step: 'started', event: 'started', done: false })}
        />
      ) : null}

      {renameTarget ? (
        <RenameDialog
          profile={renameTarget.profile}
          readerIndex={readerIndex}
          seId={renameTarget.seId}
          onClose={() => setRenameTarget(null)}
          onSaved={() => void loadCard()}
        />
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          title={t('esim.deleteProfileTitle')}
          confirmLabel={t('action.delete')}
          tone="danger"
          busy={busyOp !== null}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            const target = deleteTarget
            setDeleteTarget(null)
            void profileOp('delete', () =>
              api.esim.remove(target.profile.iccid, {
                reader_index: readerIndex,
                se_id: target.seId,
              }),
            )
          }}
        >
          <p className="small" style={{ margin: 0 }}>
            {t('esim.deleteProfileBody', { iccid: deleteTarget.profile.iccid })}
          </p>
        </ConfirmDialog>
      ) : null}

      {enableTarget ? (
        <ConfirmDialog
          title={t('esim.switchConfirmTitle')}
          confirmLabel={t('esim.enable')}
          tone="danger"
          busy={busyOp !== null}
          onCancel={() => setEnableTarget(null)}
          onConfirm={() => {
            const target = enableTarget
            setEnableTarget(null)
            void profileOp('enable', () =>
              api.esim.enable(target.profile.iccid, {
                reader_index: readerIndex,
                se_id: target.seId,
              }),
            )
          }}
        >
          <p className="small" style={{ margin: 0 }}>
            {t('esim.switchConfirmBody', { iccid: enableTarget.profile.iccid })}
          </p>
        </ConfirmDialog>
      ) : null}

      {/* Every card, not just the selected one. Self-contained so this page stays readable. */}
      <EsimInventoryPanel />
    </div>
  )
}
