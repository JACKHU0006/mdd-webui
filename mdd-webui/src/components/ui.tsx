/**
 * Shared presentational pieces.
 *
 * `CapabilityCard` is the one that carries real domain meaning: the gateway exposes three
 * independent booleans per device (cellular data, flight mode, VoWiFi) and the UI must
 * never imply that one caused another. Each card therefore renders its own desired state,
 * its own actual state and its own reason string, and a failure in one leaves the other
 * two untouched.
 */
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../lib/i18n.tsx'
import type { CapabilityActual, CapabilityView, LineSegment, LineSegmentState } from '../lib/types.ts'
import { formatDuration } from '../lib/format.ts'

/* ------------------------------------------------------------------- atoms */

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info'

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}

export function StatusDot({ tone = 'neutral' }: { tone?: Tone }) {
  return <span className={`dot dot-${tone}`} aria-hidden="true" />
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row small muted">
      <span className="spinner" aria-hidden="true" />
      {label}
    </span>
  )
}

/** A copy-to-clipboard button, used for ICCID/IMSI/EID where a mis-read is costly. */
export function CopyButton({ value, label }: { value: string; label?: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)

  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1400)
        })
      }}
    >
      {copied ? t('action.copied') : (label ?? t('action.copy'))}
    </button>
  )
}

/* --------------------------------------------------------------- tone maps */

export function toneForActual(actual: CapabilityActual | undefined): Tone {
  switch (actual) {
    case 'on':
      return 'ok'
    case 'starting':
    case 'stopping':
      return 'warn'
    case 'error':
      return 'danger'
    case 'unsupported':
      return 'neutral'
    default:
      return 'neutral'
  }
}

export function useActualLabel() {
  const { t } = useI18n()
  return (actual: CapabilityActual | undefined): string => {
    switch (actual) {
      case 'on':
        return t('state.on')
      case 'off':
        return t('state.off')
      case 'starting':
        return t('state.starting')
      case 'stopping':
        return t('state.stopping')
      case 'error':
        return t('state.error')
      case 'unsupported':
        return t('state.unsupported')
      default:
        return t('state.unknown')
    }
  }
}

/* --------------------------------------------------------- capability card */

interface CapabilityCardProps {
  title: string
  capability: CapabilityView | undefined
  /** Omits the switch entirely — a reader has no radio, so offering one would lie. */
  readOnly?: boolean
  busy?: boolean
  onToggle?: (next: boolean) => void
}

export function CapabilityCard({
  title,
  capability,
  readOnly = false,
  busy = false,
  onToggle,
}: CapabilityCardProps) {
  const actualLabel = useActualLabel()
  const tone = toneForActual(capability?.actual)
  const desired = capability?.desired ?? false
  const available = capability?.available ?? false
  // A switch that cannot do anything is disabled, but it still shows *why* — the gateway
  // publishes a reason for every unavailable capability and swallowing it makes the UI
  // look broken rather than blocked.
  const disabled = readOnly || !available || busy || !onToggle

  return (
    <div className="card">
      <div className="card-body stack" style={{ gap: 'var(--space-2)' }}>
        <div className="row-between">
          <span className="row" style={{ gap: 'var(--space-2)' }}>
            <StatusDot tone={tone} />
            <strong style={{ fontWeight: 500 }}>{title}</strong>
          </span>
          <Badge tone={tone}>{actualLabel(capability?.actual)}</Badge>
        </div>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={desired}
            disabled={disabled}
            onChange={(event) => onToggle?.(event.target.checked)}
          />
          <span className="small muted">
            {desired ? 'Desired: on' : 'Desired: off'}
            {busy ? ' · working…' : ''}
          </span>
        </label>

        {capability?.reason ? (
          <div className={`xs ${tone === 'danger' ? '' : 'faint'}`} style={{ color: tone === 'danger' ? 'var(--danger)' : undefined }}>
            {capability.reason}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- stat tile */

export function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: Tone
}) {
  return (
    <div className="card">
      <div className="card-body stack" style={{ gap: 2 }}>
        <div className="xs faint">{label}</div>
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          {tone !== 'neutral' ? <StatusDot tone={tone} /> : null}
          <span style={{ fontSize: 'var(--text-xl)', fontWeight: 500 }}>{value}</span>
        </div>
        {hint ? <div className="xs faint">{hint}</div> : null}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- skeletons */

export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="stack" style={{ gap: 'var(--space-2)' }}>
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          style={{
            height: 38,
            borderRadius: 'var(--radius-sm)',
            background: 'var(--surface-3)',
          }}
        />
      ))}
    </div>
  )
}

/* ------------------------------------------------------------ confirmations */

/**
 * A blocking confirmation for actions that are irreversible or cost real money.
 *
 * Deliberately not a `window.confirm`: the caller needs to render a warning the browser's
 * own dialog cannot carry — which SIM, which number, which body — and the mandatory
 * acknowledge step for the keepalive SMS has to be a real control the operator interacts
 * with, not a dialog they dismiss on reflex.
 *
 * `requireAcknowledge` adds that checkbox. It is used where the action charges the user's SIM.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  tone = 'danger',
  busy = false,
  requireAcknowledge = false,
  acknowledgeLabel,
  onConfirm,
  onCancel,
}: {
  title: string
  children: ReactNode
  confirmLabel: string
  tone?: Tone
  busy?: boolean
  requireAcknowledge?: boolean
  acknowledgeLabel?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useI18n()
  const [acknowledged, setAcknowledged] = useState(!requireAcknowledge)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  // Move focus into the dialog so Escape and Tab behave, and so a keyboard user is not
  // left behind on the button that opened it.
  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  const buttonClass = tone === 'danger' ? 'btn btn-danger' : 'btn btn-primary'

  return (
    <div className="overlay" role="presentation" onClick={() => (busy ? undefined : onCancel())}>
      <div
        ref={dialogRef}
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <strong style={{ fontWeight: 500 }}>{title}</strong>
        </div>
        <div className="modal-body stack" style={{ gap: 'var(--space-3)' }}>
          {children}
          {requireAcknowledge ? (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span className="small">{acknowledgeLabel ?? t('common.acknowledge')}</span>
            </label>
          ) : null}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" disabled={busy} onClick={onCancel}>
            {t('action.cancel')}
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={busy || !acknowledged}
            onClick={onConfirm}
          >
            {busy ? `${confirmLabel}…` : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------- form */

/**
 * A labelled form control with its hint/error slot.
 *
 * `inline` puts the label beside the control, which is what a dense settings grid wants;
 * the default stacks them.
 */
export function Field({
  label,
  hint,
  error,
  inline = false,
  children,
}: {
  label: string
  hint?: ReactNode
  error?: string
  inline?: boolean
  children: ReactNode
}) {
  return (
    <div className="field" style={inline ? { marginBottom: 0 } : undefined}>
      <label>{label}</label>
      <div className={inline ? 'stack' : undefined}>{children}</div>
      {error ? (
        <span className="xs" style={{ color: 'var(--danger)' }}>
          {error}
        </span>
      ) : hint ? (
        <span className="xs faint" style={{ display: 'block' }}>
          {hint}
        </span>
      ) : null}
    </div>
  )
}

/** A read-only label/value pair, used throughout the diagnostic panels. */
export function KeyValue({
  label,
  children,
  mono = false,
}: {
  label: string
  children: ReactNode
  mono?: boolean
}) {
  return (
    <div className="stack" style={{ gap: 2, minWidth: 0 }}>
      <div className="xs faint">{label}</div>
      <div className={`small truncate${mono ? ' mono' : ''}`}>{children}</div>
    </div>
  )
}

/* ---------------------------------------------------------------- timeline */

const SEGMENT_TONE: Record<LineSegmentState, Tone> = {
  up: 'ok',
  down: 'danger',
  off: 'neutral',
  unknown: 'warn',
}

/**
 * Availability as a proportional bar.
 *
 * A segment's width is its real duration, not an equal slice: an outage that lasted four
 * hours has to look four times as bad as one that lasted an hour, or the chart lies. Gaps
 * in the record are drawn as `unknown` in a distinct tone rather than being interpolated —
 * the control plane was not watching, so the UI cannot claim either way.
 */
export function Timeline({
  segments,
  start,
  end,
}: {
  segments: LineSegment[]
  start: number
  end: number
}) {
  const { t } = useI18n()
  const span = Math.max(1, end - start)

  const label: Record<LineSegmentState, string> = {
    up: t('line.legendUp'),
    down: t('line.legendDown'),
    off: t('line.legendOff'),
    unknown: t('line.legendUnknown'),
  }

  if (segments.length === 0) {
    return <div className="empty">{t('line.noHistory')}</div>
  }

  return (
    <div className="stack" style={{ gap: 'var(--space-2)' }}>
      <div className="timeline" role="img" aria-label={t('line.availability')}>
        {segments.map((segment, index) => {
          const width = Math.max(0.35, ((segment.end - segment.start) / span) * 100)
          return (
            <span
              key={`${segment.start}-${index}`}
              className={`timeline-seg tone-${SEGMENT_TONE[segment.state]}`}
              style={{ width: `${width}%` }}
              title={`${label[segment.state]} · ${formatDuration(segment.end - segment.start)}${
                segment.reason ? ` · ${segment.reason}` : ''
              }`}
            />
          )
        })}
      </div>
      <div className="row wrap" style={{ gap: 'var(--space-3)' }}>
        {(['up', 'down', 'off', 'unknown'] as LineSegmentState[]).map((state) => (
          <span key={state} className="row xs faint" style={{ gap: 5 }}>
            <span className={`dot dot-${SEGMENT_TONE[state]}`} aria-hidden="true" />
            {label[state]}
          </span>
        ))}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------- misc */

/**
 * A destructive action behind a two-step click.
 *
 * The second click must land within a few seconds; otherwise the button reverts. This is
 * for actions that are annoying rather than dangerous (clearing a log, deleting a finished
 * call record) — anything that destroys a SIM line or costs money goes through
 * `ConfirmDialog` instead.
 */
export function DangerButton({
  label,
  confirmLabel,
  busy = false,
  onConfirm,
}: {
  label: string
  confirmLabel: string
  busy?: boolean
  onConfirm: () => void
}) {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), 4000)
    return () => window.clearTimeout(timer)
  }, [armed])

  return (
    <button
      type="button"
      className="btn btn-sm"
      disabled={busy}
      style={armed ? { color: 'var(--danger)', borderColor: 'var(--danger)' } : undefined}
      onClick={() => {
        if (armed) {
          setArmed(false)
          onConfirm()
        } else {
          setArmed(true)
        }
      }}
    >
      {busy ? `${label}…` : armed ? confirmLabel : label}
    </button>
  )
}

/** An inline error banner that a view can drop anywhere. */
export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null
  return <div className="alert alert-danger small">{children}</div>
}

/** A collapsed `<details>` block for secondary material (logs, raw payloads). */
export function Disclosure({
  summary,
  children,
  open = false,
}: {
  summary: ReactNode
  children: ReactNode
  open?: boolean
}) {
  return (
    <details className="disclosure" open={open}>
      <summary>{summary}</summary>
      <div className="stack" style={{ gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
        {children}
      </div>
    </details>
  )
}
