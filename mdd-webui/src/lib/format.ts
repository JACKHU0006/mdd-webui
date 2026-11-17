/**
 * Formatting helpers shared by the console views.
 *
 * Two rules run through all of this:
 *
 *  - A missing value is rendered as an explicit placeholder, never as `0` or `NaN`. "0 bytes"
 *    and "no reading yet" mean different things and the UI must not conflate them.
 *  - Timestamps are epoch seconds on the wire (the control plane stores them that way) and are
 *    converted exactly once, here. A view that does its own `new Date(x * 1000)` will get it
 *    wrong somewhere; a view that calls `formatTimestamp` will not.
 */

/** Longest duration the console will ever render, in seconds (100 days). */
const DURATION_CLAMP = 100 * 86400

/** Human-readable byte count. Returns '—' for a value the server never reported. */
export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (value <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${(value / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

/**
 * A duration as a compact two-unit string: `3d 4h`, `2h 15m`, `48s`.
 *
 * Deliberately not localised: these are diagnostics numbers an operator compares across
 * lines, and "3d 4h" reads the same in every console the gateway ships.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '—'
  }
  const total = Math.floor(seconds)
  if (total < 60) return `${total}s`
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return `${minutes}m`
}

/** True when a timestamp is a usable Unix second count, not 0/NaN/undefined. */
export function isTimestamp(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** Absolute local date and time. `—` when the server has no reading. */
export function formatTimestamp(value: number | null | undefined): string {
  if (!isTimestamp(value)) return '—'
  return new Date(value * 1000).toLocaleString()
}

/** Date only, in the browser's zone. */
export function formatDate(value: number | null | undefined): string {
  if (!isTimestamp(value)) return '—'
  return new Date(value * 1000).toLocaleDateString()
}

/**
 * A carrier identity as one line of text.
 *
 * The engine may answer `operator` either as a bare name or as an identity object (name +
 * home network + PLMN). A JSX child must be text, so both shapes are flattened here rather
 * than at each call site — passing the object through is what blanked the devices page.
 */
export function formatOperator(
  value: string | { name?: string; home_network?: string; plmn?: string } | null | undefined,
): string {
  if (typeof value === 'string') return value.trim() || '—'
  if (!value || typeof value !== 'object') return '—'
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  if (name) return name
  const home = typeof value.home_network === 'string' ? value.home_network.trim() : ''
  if (home) return home
  const plmn = typeof value.plmn === 'string' ? value.plmn.trim() : ''
  return plmn || '—'
}

/**
 * A coarse "time ago". Used for freshness indicators where the exact second is noise.
 * Rounds down on purpose: "2 minutes ago" must not be shown for something 90 seconds old
 * if the point is that it might be stale.
 */
export function formatAge(value: number | null | undefined, now = Date.now()): string {
  if (!isTimestamp(value)) return '—'
  const seconds = Math.max(0, Math.floor(now / 1000) - value)
  if (seconds < 45) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`
  return `${Math.floor(seconds / 86400)} d ago`
}

/** Seconds between two epoch readings, clamped so a clock jump cannot print a silly number. */
export function elapsedSeconds(from: number | null | undefined, to: number | null | undefined): number | null {
  if (!isTimestamp(from) || !isTimestamp(to)) return null
  return Math.min(DURATION_CLAMP, Math.max(0, to - from))
}

/**
 * Percent from a 0..1 ratio, for progress and uptime readouts. `null` stays `null` so the
 * caller can render "no data" rather than "0%".
 */
export function toPercent(ratio: number | null | undefined): number | null {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return null
  return Math.round(Math.min(1, Math.max(0, ratio)) * 100)
}

/** `12345678` → `12 345 678`; makes long ICCIDs and IMEIs readable without changing them. */
export function groupDigits(value: string, size = 4): string {
  const text = String(value ?? '')
  if (!text) return ''
  const out: string[] = []
  for (let index = 0; index < text.length; index += size) {
    out.push(text.slice(index, index + size))
  }
  return out.join(' ')
}

/** A port list as the gateway stores it: either a number or `start-end`. */
export function formatPorts(value: unknown): string {
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const start = record.rtp_start
    const end = record.rtp_end
    if (typeof start === 'number' && typeof end === 'number') return `RTP ${start}-${end}`
  }
  return '—'
}
