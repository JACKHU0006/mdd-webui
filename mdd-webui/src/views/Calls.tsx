/**
 * Calls — the browser softphone and the independent cellular path.
 *
 * Four things shape this screen:
 *
 *  1. **The two paths are genuinely independent.** The softphone rides the IMS tunnel through
 *     the engine's Asterisk; a cellular call is placed by the physical modem over the carrier
 *     network and needs no browser registered at all. They are rendered as separate panels
 *     because an operator debugging one must not be misled by the state of the other — the
 *     only shared thing is the call log they both write to.
 *
 *  2. **Connecting is an explicit act.** Registering opens a WSS session to the engine, so it
 *     is a button, not something that happens on page load. That also makes it obvious that a
 *     line which is not connected cannot receive a call.
 *
 *  3. **A call with no microphone still works.** The softphone acquires local media itself and
 *     falls back to a silent track, so a missing or blocked microphone degrades to "they cannot
 *     hear you" instead of a call that dies with no explanation. The warning is stated up front
 *     and again while the call is up.
 *
 *  4. **Audio must be unlocked inside a click.** Remote audio is played through one stable
 *     `<audio>` element that is primed in the Call / Answer handler. Any `await` before that
 *     loses the user gesture and the call goes silent.
 *
 * The softphone instance lives in a ref and the panel is keyed by line id, so switching lines
 * tears the UA down and rebuilds it rather than leaving a registered endpoint behind.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Badge,
  DangerButton,
  Disclosure,
  Empty,
  ErrorNote,
  Field,
  KeyValue,
  SkeletonRows,
  type Tone,
} from '../components/ui'
import { useI18n, type MessageKey } from '../lib/i18n'
import { api } from '../lib/api'
import {
  ApiError,
  type CallRecord,
  type Instance,
  type SoftphoneProvisioning,
  type VoicemailRecord,
} from '../lib/types'
import { useGateway } from '../lib/store'
import {
  Softphone,
  audioInputPresence,
  classifyMicrophone,
  type MicrophoneProblem,
  type SoftphonePayload,
} from '../lib/softphone'
import { elapsedSeconds, formatBytes, formatDuration, formatTimestamp } from '../lib/format'

/** The keypad. DTMF is the only way to answer an IVR, so it is a first-class control. */
const DTMF_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'] as const

/**
 * One message per microphone problem, so "there is no microphone" and "you blocked it" never
 * read the same — they need different actions from the operator.
 */
const MIC_MESSAGE: Record<MicrophoneProblem, MessageKey> = {
  none: 'calls.mic.none',
  blocked: 'calls.mic.blocked',
  busy: 'calls.mic.busy',
  insecure: 'calls.mic.insecure',
  unknown: 'calls.mic.unknown',
}

/** Where the softphone is in its own lifecycle. Distinct from where a *call* is. */
type PhoneStatus = 'idle' | 'connecting' | 'registered' | 'failed'

/** Where a call is. `incoming` is the only state that needs a decision from the operator. */
type SessionState = 'calling' | 'ringing' | 'active' | 'incoming' | null

/** A line whose engine is up can carry a call; anything else cannot, whatever the UI shows. */
function isLineUp(line: Instance | undefined): boolean {
  const state = String(line?.status?.state ?? '').toUpperCase()
  return state !== '' && state !== 'STOPPED' && state !== 'UNKNOWN'
}

/**
 * The modem's raw state, normalised the way the control plane normalises it.
 *
 * The engine reports `dialing`, `ringing-out`, `active`, `terminated`, `ended`, `idle` and
 * `unknown`. Mapping those onto four display states here — instead of listing every raw string
 * in a lookup table — is what stops a new engine state from rendering as a bare token: a table
 * that misses `terminated` shows the operator the word "terminated" in a badge.
 */
type CellularPhase = 'idle' | 'ringing' | 'answered' | 'ended' | 'unknown'

function cellularPhase(raw: string | undefined): CellularPhase {
  const state = String(raw ?? '').toLowerCase()
  if (!state) return 'idle'
  if (state === 'active') return 'answered'
  if (state === 'dialing' || state === 'ringing-out') return 'ringing'
  if (state === 'terminated' || state === 'ended' || state === 'idle') return 'ended'
  return 'unknown'
}

/** True once the modem has nothing more to say about the current call. */
function isSettledPhase(phase: CellularPhase): boolean {
  return phase === 'ended' || phase === 'unknown'
}

function callStatusTone(status: string | undefined): Tone {
  switch (String(status ?? '').toLowerCase()) {
    case 'answered':
    case 'active':
      return 'ok'
    case 'ringing':
    case 'calling':
      return 'warn'
    case 'missed':
    case 'rejected':
    case 'failed':
    case 'busy':
      return 'danger'
    default:
      return 'neutral'
  }
}

/** A call's length: the stored span once finished, the live span while it is still open. */
function callDuration(call: CallRecord, now: number): number | null {
  const start = call.start_ts
  if (!Number.isFinite(start) || start <= 0) return null
  if (Number.isFinite(call.end_ts ?? NaN) && (call.end_ts ?? 0) > 0) {
    return elapsedSeconds(start, call.end_ts)
  }
  return Math.max(0, Math.floor(now / 1000) - start)
}

/* ------------------------------------------------------------------ softphone */

function SoftphonePanel({
  lineId,
  line,
  onChanged,
}: {
  lineId: string
  line: Instance | undefined
  onChanged: () => void
}) {
  const { t } = useI18n()
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const phoneRef = useRef<Softphone | null>(null)
  /**
   * The event handler reads fresh state, but JsSIP holds the callback it was constructed with.
   * Keep the current closure in a ref so the UA never calls a stale one.
   */
  const handlerRef = useRef<(type: string, data?: SoftphonePayload | boolean | string) => void>(() => {})

  const [provisioning, setProvisioning] = useState<SoftphoneProvisioning | null>(null)
  const [provisionError, setProvisionError] = useState<string | null>(null)
  const [status, setStatus] = useState<PhoneStatus>('idle')
  const [failCause, setFailCause] = useState('')
  const [session, setSession] = useState<SessionState>(null)
  const [peer, setPeer] = useState('')
  const [incomingFrom, setIncomingFrom] = useState('')
  const [number, setNumber] = useState('')
  const [muted, setMuted] = useState(false)
  const [mediaProblem, setMediaProblem] = useState<MicrophoneProblem | null>(null)
  const [audioBlocked, setAudioBlocked] = useState(false)
  const [recording, setRecording] = useState(false)
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null)
  const [micPresence, setMicPresence] = useState<string>('unknown')
  const [actionError, setActionError] = useState<string | null>(null)
  const [showKeypad, setShowKeypad] = useState(false)

  // What the browser reports about audio inputs, checked once so the panel can warn before a
  // call rather than after one. Needs no permission, so it is safe to run on mount.
  useEffect(() => {
    void audioInputPresence().then(setMicPresence)
  }, [])

  // Provisioning for this line. Fetched eagerly so the Connect button can be disabled with a
  // reason instead of failing on click.
  useEffect(() => {
    let cancelled = false
    setProvisionError(null)
    setProvisioning(null)
    api.instances
      .softphone(lineId)
      .then((result) => {
        if (!cancelled) setProvisioning(result)
      })
      .catch((failure: unknown) => {
        if (cancelled) return
        setProvisionError(failure instanceof ApiError ? failure.message : String(failure))
      })
    return () => {
      cancelled = true
    }
  }, [lineId])

  /** Tear the UA down. Also called on unmount and whenever the line changes. */
  const teardown = useCallback(() => {
    phoneRef.current?.stop()
    phoneRef.current = null
    setStatus('idle')
    setSession(null)
    setPeer('')
    setIncomingFrom('')
    setMuted(false)
  }, [])

  useEffect(() => teardown, [teardown])

  // Revoke the recording blob URL when it is replaced or the panel goes away.
  useEffect(() => {
    return () => {
      if (recordingUrl) URL.revokeObjectURL(recordingUrl)
    }
  }, [recordingUrl])

  handlerRef.current = (type, data) => {
    const payload = (typeof data === 'object' && data !== null ? data : {}) as SoftphonePayload
    switch (type) {
      case 'ws':
        setStatus((current) => (data === 'connected' ? current : 'idle'))
        break
      case 'registered':
        if (data) {
          setStatus('registered')
          setFailCause('')
        } else {
          setStatus('idle')
        }
        break
      case 'regfail':
        setStatus('failed')
        setFailCause(String(data ?? ''))
        break
      case 'incoming':
        setIncomingFrom(payload.from ?? '')
        setSession('incoming')
        break
      case 'calling':
        setPeer(payload.to ?? '')
        setSession('calling')
        break
      case 'progress':
        setSession((current) => (current === 'active' ? current : 'ringing'))
        break
      case 'active':
        setSession('active')
        break
      case 'ended':
      case 'failed':
        setSession(null)
        setPeer('')
        setIncomingFrom('')
        setMuted(false)
        if (recording) void stopRecording()
        onChanged()
        break
      case 'mediafail':
        setMediaProblem(classifyMicrophone(String(data ?? '')))
        break
      case 'mediafallback':
        setMediaProblem(classifyMicrophone(String(data ?? '')))
        break
      case 'audioblocked':
        setAudioBlocked(true)
        break
      default:
        break
    }
  }

  async function connect() {
    if (!provisioning) return
    setActionError(null)
    setStatus('connecting')
    const phone = new Softphone((type, data) => handlerRef.current(type, data))
    phone.setAudioEl(audioRef.current)
    phoneRef.current = phone
    try {
      // `prov.host` is derived from the request Host header, which is the browser's own host in
      // a same-origin deployment; `location.hostname` covers a proxy that rewrites it.
      phone.start(provisioning, provisioning.host || window.location.hostname)
    } catch (failure) {
      setStatus('failed')
      setFailCause(failure instanceof Error ? failure.message : String(failure))
    }
  }

  async function dial() {
    const target = number.trim()
    if (!target || !phoneRef.current) return
    // Unlock audio synchronously inside the gesture, before any await.
    phoneRef.current.unlockAudio()
    setActionError(null)
    setAudioBlocked(false)
    setMediaProblem(null)
    setPeer(target)
    setSession('calling')
    await phoneRef.current.call(target)
    onChanged()
  }

  function answer() {
    phoneRef.current?.unlockAudio()
    setAudioBlocked(false)
    setMediaProblem(null)
    setSession('active')
    void phoneRef.current?.answer()
  }

  function decline() {
    phoneRef.current?.reject()
    setSession(null)
    setIncomingFrom('')
    onChanged()
  }

  function hangup() {
    phoneRef.current?.hangup()
    setSession(null)
    setPeer('')
    setMuted(false)
    if (recording) void stopRecording()
    onChanged()
  }

  function toggleMute() {
    const next = !muted
    setMuted(next)
    phoneRef.current?.setMuted(next)
  }

  async function startRecording() {
    const ok = await phoneRef.current?.startRecording()
    if (ok) {
      setRecording(true)
      setRecordingUrl(null)
    } else {
      setActionError(t('calls.recordFailed'))
    }
  }

  async function stopRecording() {
    const blob = await phoneRef.current?.stopRecording()
    setRecording(false)
    if (!blob) return
    setRecordingUrl((current) => {
      if (current) URL.revokeObjectURL(current)
      return URL.createObjectURL(blob)
    })
  }

  const enabled = provisioning?.enabled !== false
  const lineUp = isLineUp(line)
  const inCall = session === 'calling' || session === 'ringing' || session === 'active'
  const secure = window.isSecureContext

  return (
    <section className="card">
      {/* One stable element, primed by the first user gesture and reused for every call. */}
      <audio ref={audioRef} autoPlay playsInline style={{ display: 'none' }} />

      <div className="card-head">
        <strong style={{ fontWeight: 500 }}>{t('calls.softphone')}</strong>
        <span className="row" style={{ gap: 'var(--space-2)' }}>
          {status === 'registered' ? <Badge tone="ok">{t('calls.statusRegistered')}</Badge> : null}
          {status === 'connecting' ? <Badge tone="warn">{t('calls.statusConnecting')}</Badge> : null}
          {status === 'idle' ? <Badge tone="neutral">{t('calls.statusIdle')}</Badge> : null}
          {status === 'failed' ? (
            <Badge tone="danger">{t('calls.statusFailed', { cause: failCause || '—' })}</Badge>
          ) : null}
          {phoneRef.current ? (
            <button type="button" className="btn btn-sm" onClick={teardown}>
              {t('calls.disconnect')}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!enabled || status === 'connecting' || !provisioning}
              title={!enabled ? t('calls.softphoneDisabled') : undefined}
              onClick={() => void connect()}
            >
              {t('calls.connect')}
            </button>
          )}
        </span>
      </div>

      <div className="card-body stack" style={{ gap: 'var(--space-3)' }}>
        {!enabled ? <div className="note note-warn">{t('calls.softphoneDisabled')}</div> : null}
        {provisionError ? <ErrorNote>{provisionError}</ErrorNote> : null}
        {actionError ? <ErrorNote>{actionError}</ErrorNote> : null}
        {!secure ? <div className="note note-warn">{t('calls.insecure')}</div> : null}
        {micPresence === 'none' ? (
          <div className="note note-warn">{t('calls.micNone')}</div>
        ) : null}
        {mediaProblem ? (
          <div className="note note-warn">{t(MIC_MESSAGE[mediaProblem])}</div>
        ) : null}
        {audioBlocked ? <div className="note note-warn">{t('calls.audioBlocked')}</div> : null}
        {/*
          About the line, not the endpoint: a stopped line cannot carry a call on either path, so
          this is shown even when the softphone endpoint is also disabled. Both facts are true
          and they call for different actions.
        */}
        {!lineUp ? <div className="note note-warn">{t('calls.lineDown')}</div> : null}

        {/* ---- an incoming call needs a decision, so it gets its own block ---- */}
        {session === 'incoming' ? (
          <div className="note note-warn stack" style={{ gap: 'var(--space-3)' }}>
            <strong>{t('calls.incomingFrom', { from: incomingFrom || '—' })}</strong>
            <div className="row" style={{ gap: 'var(--space-2)' }}>
              <button type="button" className="btn btn-sm btn-primary" onClick={answer}>
                {t('calls.answer')}
              </button>
              <button type="button" className="btn btn-sm" onClick={decline}>
                {t('calls.decline')}
              </button>
            </div>
          </div>
        ) : null}

        {/* ---- dial + in-call controls ---- */}
        <div className="row wrap" style={{ gap: 'var(--space-2)', alignItems: 'flex-end' }}>
          <Field label={t('calls.number')} hint={t('calls.numberHint')}>
            <input
              className="input mono"
              value={number}
              placeholder="#225#"
              disabled={inCall}
              onChange={(event) => setNumber(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void dial()
              }}
            />
          </Field>
          {inCall || session === 'incoming' ? (
            <button type="button" className="btn btn-sm" onClick={hangup}>
              {t('calls.hangup')}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={status !== 'registered' || !number.trim()}
              onClick={() => void dial()}
            >
              {t('calls.dial')}
            </button>
          )}
        </div>

        {session ? (
          <div className="row wrap" style={{ gap: 'var(--space-3)', alignItems: 'center' }}>
            <Badge tone={session === 'active' ? 'ok' : 'warn'}>
              {session === 'calling'
                ? t('calls.calling', { to: peer })
                : session === 'ringing'
                  ? t('calls.ringing')
                  : session === 'active'
                    ? t('calls.active')
                    : t('calls.incomingFrom', { from: incomingFrom })}
            </Badge>
            {session === 'active' ? (
              <>
                <button type="button" className="btn btn-sm" onClick={toggleMute}>
                  {muted ? t('calls.unmute') : t('calls.mute')}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setShowKeypad((current) => !current)}
                >
                  {t('calls.dtmf')}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void (recording ? stopRecording() : startRecording())}
                >
                  {recording ? t('calls.recording') : t('calls.record')}
                </button>
              </>
            ) : null}
          </div>
        ) : null}

        {showKeypad && session === 'active' ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, minmax(56px, 72px))',
              gap: 'var(--space-2)',
            }}
          >
            {DTMF_KEYS.map((tone) => (
              <button
                key={tone}
                type="button"
                className="btn btn-sm mono"
                onClick={() => phoneRef.current?.sendDTMF(tone)}
              >
                {tone}
              </button>
            ))}
          </div>
        ) : null}

        {recordingUrl ? (
          <div className="row wrap" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
            <span className="small">{t('calls.recordingReady')}</span>
            <a className="btn btn-sm" href={recordingUrl} download="call-recording.webm">
              {t('calls.downloadRecording')}
            </a>
          </div>
        ) : null}

        <span className="xs faint">{t('calls.softphoneDependency')}</span>
        {provisioning ? (
          <Disclosure summary={t('calls.endpoint')}>
            <div className="row wrap" style={{ gap: 'var(--space-4)' }}>
              <KeyValue label="SIP" mono>
                {provisioning.username}@{provisioning.realm || provisioning.host}
              </KeyValue>
              <KeyValue label="WSS" mono>
                {provisioning.ws_path
                  ? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}${provisioning.ws_path}`
                  : `wss://${provisioning.host || window.location.hostname}:${provisioning.ws_port}/ws`}
              </KeyValue>
            </div>
            {/* v1.14.1 起信令走控制面的同源 relay，页面用什么 origin 就复用什么证书；
                只有旧后端才是「引擎自己的端口」，那种情况浏览器必须能直连那个端口。 */}
            <div className="note note-warn">{t('calls.wssHint')}</div>
          </Disclosure>
        ) : null}
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------- cellular */

/**
 * The cellular path.
 *
 * `POST .../cellular-call` can answer `uncertain: true` — the modem accepted the command but the
 * carrier never confirmed. That is reported as unknown rather than as success or failure, and
 * the status poll is what resolves it, which is why the poll keeps running after a dial.
 */
function CellularPanel({ lineId, onChanged }: { lineId: string; onChanged: () => void }) {
  const { t } = useI18n()
  const [number, setNumber] = useState('')
  const [state, setState] = useState('')
  const [record, setRecord] = useState<CallRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [polling, setPolling] = useState(false)

  const refreshStatus = useCallback(async () => {
    try {
      const result = await api.instances.calls.cellularStatus(lineId)
      setState(String(result.status ?? ''))
      if (result.record) setRecord(result.record)
      if (result.error) setError(result.error)
      return String(result.status ?? '')
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : String(failure))
      return ''
    }
  }, [lineId])

  // Poll while a call is believed to be up. The control plane reconciles the log row on each
  // status read, so this is also what moves the record from "ringing" to its final state.
  useEffect(() => {
    if (!polling) return
    const timer = window.setInterval(() => {
      void refreshStatus().then((next) => {
        if (isSettledPhase(cellularPhase(next))) {
          setPolling(false)
          onChanged()
        }
      })
    }, 3000)
    return () => window.clearInterval(timer)
  }, [polling, refreshStatus, onChanged])

  async function dial() {
    const target = number.trim()
    if (!target) return
    setBusy(true)
    setError(null)
    try {
      const result = await api.instances.calls.cellularDial(lineId, target)
      if (result.error) setError(result.error)
      if (result.record) setRecord(result.record)
      // Optimistic, and deliberately in the ENGINE's vocabulary (`dialing`, not `ringing`):
      // `cellularPhase` is the single place that maps modem words onto display states, so
      // feeding it a display word here would fall through to "unknown".
      setState(result.uncertain ? 'unknown' : 'dialing')
      setPolling(true)
      onChanged()
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  async function hangup() {
    setBusy(true)
    try {
      const result = await api.instances.calls.cellularHangup(lineId)
      if (result.record) setRecord(result.record)
      setState('ended')
      setPolling(false)
      onChanged()
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const phase = cellularPhase(state)
  const PHASE_LABEL: Record<CellularPhase, MessageKey> = {
    idle: 'calls.cellIdle',
    ringing: 'calls.cellRinging',
    answered: 'calls.cellAnswered',
    ended: 'calls.cellEnded',
    unknown: 'calls.cellUnknown',
  }
  const PHASE_TONE: Record<CellularPhase, Tone> = {
    idle: 'neutral',
    ringing: 'warn',
    answered: 'ok',
    ended: 'neutral',
    unknown: 'warn',
  }

  return (
    <section className="card">
      <div className="card-head">
        <strong style={{ fontWeight: 500 }}>{t('calls.cellular')}</strong>
        <span className="row" style={{ gap: 'var(--space-2)' }}>
          <Badge tone={PHASE_TONE[phase]}>{t(PHASE_LABEL[phase])}</Badge>
          <button type="button" className="btn btn-sm" onClick={() => void refreshStatus()}>
            {t('action.refresh')}
          </button>
        </span>
      </div>
      <div className="card-body stack" style={{ gap: 'var(--space-3)' }}>
        <span className="xs faint">{t('calls.cellularHint')}</span>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {phase === 'unknown' ? (
          <div className="note note-warn">{t('calls.cellUnknownHint')}</div>
        ) : null}
        <div className="row wrap" style={{ gap: 'var(--space-2)', alignItems: 'flex-end' }}>
          <Field label={t('calls.number')}>
            <input
              className="input mono"
              value={number}
              placeholder="10086"
              onChange={(event) => setNumber(event.target.value)}
            />
          </Field>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy || !number.trim()}
            onClick={() => void dial()}
          >
            {t('calls.cellularDial')}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy || !polling}
            onClick={() => void hangup()}
          >
            {t('calls.hangup')}
          </button>
        </div>
        {record ? (
          <div className="row wrap" style={{ gap: 'var(--space-4)' }}>
            {/* The modem's own word, verbatim — the badge above is the interpretation. */}
            <KeyValue label={t('calls.cellularStatus')} mono>
              {state || '—'}
            </KeyValue>
            <KeyValue label={t('calls.duration')}>
              {formatDuration(callDuration(record, Date.now()))}
            </KeyValue>
          </div>
        ) : null}
      </div>
    </section>
  )
}

/* -------------------------------------------------------------- call history */

function HistoryCard({
  lineId,
  calls,
  onChanged,
}: {
  lineId: string
  calls: CallRecord[]
  onChanged: () => void
}) {
  const { t } = useI18n()
  const [now, setNow] = useState(() => Date.now())

  // Only the open row shows a live duration, so the clock is cheap.
  const hasOpen = calls.some((call) => !call.end_ts)
  useEffect(() => {
    if (!hasOpen) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [hasOpen])

  async function removeOne(id: number) {
    await api.instances.calls.remove(lineId, { ids: [id] })
    onChanged()
  }

  async function clearAll() {
    await api.instances.calls.remove(lineId, { all: true })
    onChanged()
  }

  return (
    <section className="card">
      <div className="card-head">
        <strong style={{ fontWeight: 500 }}>{t('calls.history')}</strong>
        {calls.length > 0 ? (
          <DangerButton
            label={t('calls.clearHistory')}
            confirmLabel={t('common.confirmRemove')}
            onConfirm={() => void clearAll()}
          />
        ) : null}
      </div>
      <div className="card-body">
        {calls.length === 0 ? (
          <Empty>{t('calls.noHistory')}</Empty>
        ) : (
          <div className="stack" style={{ gap: 'var(--space-2)' }}>
            {calls.map((call) => (
              <div
                key={call.id}
                className="row wrap"
                style={{
                  gap: 'var(--space-3)',
                  alignItems: 'center',
                  borderBottom: '1px solid var(--border)',
                  paddingBottom: 'var(--space-2)',
                }}
              >
                <Badge tone={callStatusTone(call.status)}>{call.status || '—'}</Badge>
                <span className="small">
                  {call.direction === 'in' ? t('calls.directionIn') : t('calls.directionOut')}
                </span>
                <span className="mono small">{call.peer || '—'}</span>
                <Badge tone="neutral">
                  {call.transport === 'cellular'
                    ? t('calls.transportCellular')
                    : t('calls.transportVowifi')}
                </Badge>
                <span className="xs faint">{formatTimestamp(call.start_ts)}</span>
                <span className="xs faint">
                  {t('calls.duration')} {formatDuration(callDuration(call, now))}
                </span>
                {call.ussd_text ? (
                  // A service code's reply rides on the call record. The gateway does not parse
                  // it, so it is shown verbatim.
                  <span className="xs" style={{ color: 'var(--text-muted)' }}>
                    {t('calls.ussd')}: <span className="mono">{call.ussd_text}</span>
                  </span>
                ) : null}
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ marginLeft: 'auto' }}
                  onClick={() => void removeOne(call.id)}
                >
                  {t('action.remove')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

/* ----------------------------------------------------------------- voicemail */

function VoicemailCard({
  lineId,
  voicemails,
  onChanged,
}: {
  lineId: string
  voicemails: VoicemailRecord[]
  onChanged: () => void
}) {
  const { t } = useI18n()
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playingId, setPlayingId] = useState<number | null>(null)

  function play(item: VoicemailRecord) {
    const el = audioRef.current
    if (!el) return
    // One element for every recording: switching source while playing is what makes the row
    // highlight and the audio stay in sync.
    el.src = api.instances.voicemails.audioUrl(lineId, item.id)
    el.play().catch(() => {})
    setPlayingId(item.id)
    // Marking it heard is best-effort: a failure must not stop playback.
    if (!item.listened) {
      void api.instances.voicemails.markListened(lineId, item.id).then(onChanged).catch(() => {})
    }
  }

  async function removeOne(id: number) {
    await api.instances.voicemails.remove(lineId, { ids: [id] })
    if (playingId === id) {
      audioRef.current?.pause()
      setPlayingId(null)
    }
    onChanged()
  }

  async function clearAll() {
    await api.instances.voicemails.remove(lineId, { all: true })
    audioRef.current?.pause()
    setPlayingId(null)
    onChanged()
  }

  const unheard = voicemails.filter((item) => !item.listened).length

  return (
    <section className="card">
      <audio ref={audioRef} onEnded={() => setPlayingId(null)} style={{ display: 'none' }} />
      <div className="card-head">
        <strong style={{ fontWeight: 500 }}>{t('calls.voicemail')}</strong>
        <span className="row" style={{ gap: 'var(--space-2)' }}>
          {unheard > 0 ? <Badge tone="warn">{unheard}</Badge> : null}
          {voicemails.length > 0 ? (
            <DangerButton
              label={t('calls.deleteVoicemail')}
              confirmLabel={t('common.confirmRemove')}
              onConfirm={() => void clearAll()}
            />
          ) : null}
        </span>
      </div>
      <div className="card-body stack" style={{ gap: 'var(--space-2)' }}>
        <span className="xs faint">{t('calls.voicemailHint')}</span>
        {voicemails.length === 0 ? (
          <Empty>{t('calls.noVoicemail')}</Empty>
        ) : (
          voicemails.map((item) => (
            <div
              key={item.id}
              className="row wrap"
              style={{ gap: 'var(--space-3)', alignItems: 'center' }}
            >
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => play(item)}
                aria-pressed={playingId === item.id}
              >
                {playingId === item.id ? '❚❚' : '▶'} {t('calls.play')}
              </button>
              <span className="mono small">{item.peer || '—'}</span>
              <span className="xs faint">{formatTimestamp(item.ts)}</span>
              <span className="xs faint">{formatDuration(item.duration_seconds)}</span>
              <span className="xs faint">{formatBytes(item.size_bytes)}</span>
              <Badge tone={item.listened ? 'neutral' : 'warn'}>
                {item.listened ? t('calls.listened') : t('calls.unheard')}
              </Badge>
              <button
                type="button"
                className="btn btn-sm"
                style={{ marginLeft: 'auto' }}
                onClick={() => void removeOne(item.id)}
              >
                {t('action.remove')}
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------- view */

export function Calls() {
  const { t } = useI18n()
  const { instances, loading, error, subscribe } = useGateway()

  const [lineId, setLineId] = useState('')
  const [calls, setCalls] = useState<CallRecord[] | null>(null)
  const [voicemails, setVoicemails] = useState<VoicemailRecord[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Default to the first line once the list arrives, without fighting a deliberate choice.
  useEffect(() => {
    if (!lineId && instances && instances.length > 0) setLineId(instances[0].id)
  }, [instances, lineId])

  const line = useMemo(
    () => instances?.find((item) => item.id === lineId),
    [instances, lineId],
  )

  const reload = useCallback(async () => {
    if (!lineId) return
    try {
      const [callResult, voicemailResult] = await Promise.all([
        api.instances.calls.list(lineId),
        // Voicemail is secondary; a failure there must not blank the call log.
        api.instances.voicemails.list(lineId).catch(() => null),
      ])
      setCalls(callResult.calls)
      if (voicemailResult) setVoicemails(voicemailResult.voicemails)
      setLoadError(null)
    } catch (failure) {
      setLoadError(failure instanceof ApiError ? failure.message : String(failure))
    }
  }, [lineId])

  useEffect(() => {
    setCalls(null)
    setVoicemails(null)
    void reload()
  }, [reload])

  // Both paths write to the same log, and the control plane broadcasts a `call` event for each
  // change — including the deletes. `voicemail` covers playback and deletion from elsewhere.
  useEffect(() => {
    return subscribe((event) => {
      if (event.instance && event.instance !== lineId) return
      if (event.type === 'call' || event.type === 'voicemail') void reload()
    })
  }, [subscribe, lineId, reload])

  if (loading && !instances) return <SkeletonRows rows={4} />

  if (!instances || instances.length === 0) {
    return (
      <div className="card">
        <Empty>{t('calls.noLines')}</Empty>
      </div>
    )
  }

  return (
    <div className="stack" style={{ gap: 'var(--space-4)' }}>
      <div>
        <h1 style={{ marginBottom: 4 }}>{t('calls.title')}</h1>
        <p className="muted small" style={{ margin: 0 }}>
          {t('calls.hint')}
        </p>
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {loadError ? <ErrorNote>{loadError}</ErrorNote> : null}

      <div className="row wrap" style={{ gap: 'var(--space-3)', alignItems: 'center' }}>
        <label className="row small" style={{ gap: 'var(--space-2)' }}>
          <span className="faint">{t('calls.line')}</span>
          <select
            className="select"
            style={{ width: 'auto' }}
            value={lineId}
            onChange={(event) => setLineId(event.target.value)}
          >
            {instances.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name || item.id}
                {item.msisdn ? ` · ${item.msisdn}` : ''}
              </option>
            ))}
          </select>
        </label>
        {line?.status?.state ? (
          <Badge tone={isLineUp(line) ? 'ok' : 'neutral'}>{line.status.state}</Badge>
        ) : null}
        {line?.msisdn ? (
          <span className="xs faint mono">{line.msisdn}</span>
        ) : null}
      </div>

      {/*
        Nothing is mounted until a line is chosen. The default comes from an effect, so on the
        first render `lineId` is still empty — mounting the panels then would fire requests at
        `/api/instances//softphone` and 404 twice before the real id arrived.
        Keyed by line so switching tears the UA down instead of reusing it.
      */}
      {lineId ? (
        <>
          <SoftphonePanel key={`soft-${lineId}`} lineId={lineId} line={line} onChanged={reload} />
          <CellularPanel key={`cell-${lineId}`} lineId={lineId} onChanged={reload} />
        </>
      ) : null}

      {calls === null ? (
        <SkeletonRows rows={3} />
      ) : (
        <HistoryCard lineId={lineId} calls={calls} onChanged={reload} />
      )}

      {voicemails === null ? (
        <SkeletonRows rows={2} />
      ) : (
        <VoicemailCard lineId={lineId} voicemails={voicemails} onChanged={reload} />
      )}
    </div>
  )
}
