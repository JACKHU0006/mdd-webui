/**
 * AT / USSD terminal.
 *
 * A terminal is a loaded gun, so most of the design here is about making the dangerous parts
 * legible rather than hiding them:
 *
 *  1. **The server decides, the UI explains.** The command policy lives in the control plane
 *     (`at_terminal.py`) and is enforced there. This page does not try to duplicate the rules —
 *     it renders the server's verdict. A client that bypassed this page still cannot run a
 *     blocked command, which is the only arrangement where the safety is real.
 *
 *  2. **Three outcomes, three appearances.** Allowed → the response is shown. `needs_confirm` →
 *     a confirmation naming the specific consequence, because "are you sure?" without a reason
 *     trains people to click through. `blocked` (a 403) → shown as a refusal, visually distinct
 *     from a command that ran and failed, since the module never saw it.
 *
 *  3. **The module's own words are shown verbatim.** `ERROR` and `+CME ERROR: 10` are the
 *     module talking, not a transport problem, and they are the whole reason to have a
 *     terminal. They are never reworded.
 *
 *  4. **History is local.** Kept in `localStorage` per line, so it survives a reload without
 *     the gateway having to store what operators typed.
 *
 * Commands go through ModemManager, which shares the modem, so this is safe to use **while a
 * line is running** — which is precisely when it is needed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Badge,
  ConfirmDialog,
  Disclosure,
  Empty,
  ErrorNote,
  Field,
  KeyValue,
  SkeletonRows,
  type Tone,
} from '../components/ui'
import { useI18n } from '../lib/i18n'
import { api } from '../lib/api'
import { ApiError, type AtCommandResult } from '../lib/types'
import { useGateway } from '../lib/store'

/** How many entries the history keeps. Deep enough to be useful, shallow enough to scan. */
const HISTORY_LIMIT = 100

/** The commands worth a button: the ones reached for constantly while diagnosing. */
const QUICK_COMMANDS = [
  { command: 'ATI', labelKey: 'term.quick.model' },
  { command: 'AT+CGSN', labelKey: 'term.quick.imei' },
  { command: 'AT+CSQ', labelKey: 'term.quick.signal' },
  { command: 'AT+CREG?', labelKey: 'term.quick.registration' },
  { command: 'AT+COPS?', labelKey: 'term.quick.operator' },
  { command: 'AT+CGPADDR', labelKey: 'term.quick.address' },
  { command: 'AT+CGDCONT?', labelKey: 'term.quick.pdp' },
  { command: 'AT+CFUN?', labelKey: 'term.quick.radio' },
] as const

/** USSD codes worth a button. These are the reason the terminal exists. */
const USSD_COMMANDS = [
  { command: 'AT+CUSD=1,"#225#",15', labelKey: 'term.ussd.balance' },
  { command: 'AT+CUSD=1,"*100#",15', labelKey: 'term.ussd.balanceAlt' },
  { command: 'AT+CUSD=1,"#100#",15', labelKey: 'term.ussd.credit' },
] as const

interface HistoryEntry {
  command: string
  response: string
  ok: boolean
  /** Set when the module answered with its own error rather than a transport failure. */
  moduleError: boolean
  at: number
}

function historyKey(lineId: string): string {
  return `mdd.at.history.${lineId}`
}

function loadHistory(lineId: string): HistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(historyKey(lineId))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.slice(0, HISTORY_LIMIT) as HistoryEntry[]
  } catch {
    // A corrupt or unavailable store must not break the page — the terminal still works.
    return []
  }
}

function saveHistory(lineId: string, entries: HistoryEntry[]): void {
  try {
    window.localStorage.setItem(historyKey(lineId), JSON.stringify(entries.slice(0, HISTORY_LIMIT)))
  } catch {
    // Private browsing, or a full quota. Losing history is acceptable; failing is not.
  }
}

function outcomeTone(entry: HistoryEntry): Tone {
  if (!entry.ok) return 'danger'
  if (entry.moduleError) return 'warn'
  return 'ok'
}

function isModuleError(response: string): boolean {
  return /(^|\r\n)\s*(ERROR|\+CM[SE] ERROR)/i.test(response)
}

export function Terminal() {
  const { t } = useI18n()
  const { instances, loading, error } = useGateway()

  const [lineId, setLineId] = useState('')
  const [command, setCommand] = useState('')
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingConfirm, setPendingConfirm] = useState<{ command: string; reason: string } | null>(
    null,
  )
  /** Index into the *typed* history while walking it with the arrow keys; -1 = not walking. */
  const [walkIndex, setWalkIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!lineId && instances && instances.length > 0) setLineId(instances[0].id)
  }, [instances, lineId])

  useEffect(() => {
    if (lineId) setEntries(loadHistory(lineId))
  }, [lineId])

  const line = useMemo(() => instances?.find((item) => item.id === lineId), [instances, lineId])

  /** Distinct commands, newest first — what the up-arrow walks. */
  const typed = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const entry of entries) {
      if (seen.has(entry.command)) continue
      seen.add(entry.command)
      out.push(entry.command)
    }
    return out
  }, [entries])

  // Keep the newest entry in view. A terminal that does not follow its own output is unusable.
  useEffect(() => {
    const node = logRef.current
    if (node) node.scrollTop = 0
  }, [entries])

  const record = useCallback(
    (result: AtCommandResult) => {
      setEntries((current) => {
        const next: HistoryEntry[] = [
          {
            command: result.command,
            response: result.response,
            ok: result.ok,
            moduleError: isModuleError(result.response),
            at: Math.floor(Date.now() / 1000),
          },
          ...current,
        ].slice(0, HISTORY_LIMIT)
        saveHistory(lineId, next)
        return next
      })
    },
    [lineId],
  )

  const run = useCallback(
    async (raw: string, confirm = false) => {
      const text = raw.trim()
      if (!text || !lineId) return
      setBusy(true)
      setActionError(null)
      try {
        const result = await api.instances.at(lineId, text, confirm)
        if (result.needs_confirm) {
          setPendingConfirm({ command: result.command, reason: result.reason })
          return
        }
        record(result)
        setCommand('')
        setWalkIndex(-1)
      } catch (failure) {
        if (failure instanceof ApiError) {
          // A 403 is the server refusing, not a failed command. It is shown as a refusal so it
          // is never confused with "the module said no".
          setActionError(
            failure.status === 403
              ? t('term.refused', { reason: failure.message })
              : failure.message,
          )
        } else {
          setActionError(String(failure))
        }
      } finally {
        setBusy(false)
      }
    },
    [lineId, record, t],
  )

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      void run(command)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      const next = Math.min(walkIndex + 1, typed.length - 1)
      if (next >= 0 && typed[next]) {
        setWalkIndex(next)
        setCommand(typed[next])
      }
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      const next = walkIndex - 1
      if (next < 0) {
        setWalkIndex(-1)
        setCommand('')
      } else {
        setWalkIndex(next)
        setCommand(typed[next] ?? '')
      }
      return
    }
    if (event.key === 'l' && event.ctrlKey) {
      event.preventDefault()
      clearLog()
    }
  }

  function clearLog() {
    setEntries([])
    saveHistory(lineId, [])
  }

  if (loading && !instances) return <SkeletonRows rows={4} />

  if (!instances || instances.length === 0) {
    return (
      <div className="card">
        <Empty>{t('term.noLines')}</Empty>
      </div>
    )
  }

  return (
    <div className="stack" style={{ gap: 'var(--space-4)' }}>
      <div>
        <h1 style={{ marginBottom: 4 }}>{t('term.title')}</h1>
        <p className="muted small" style={{ margin: 0 }}>
          {t('term.hint')}
        </p>
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {actionError ? <ErrorNote>{actionError}</ErrorNote> : null}

      <div className="row wrap" style={{ gap: 'var(--space-3)', alignItems: 'center' }}>
        <label className="row small" style={{ gap: 'var(--space-2)' }}>
          <span className="faint">{t('term.line')}</span>
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
          <Badge tone={String(line.status.state).toUpperCase() === 'STOPPED' ? 'neutral' : 'ok'}>
            {line.status.state}
          </Badge>
        ) : null}
      </div>

      {/* ---- input ---- */}
      <div className="card">
        <div className="card-body stack" style={{ gap: 'var(--space-3)' }}>
          <div className="row wrap" style={{ gap: 'var(--space-2)', alignItems: 'flex-end' }}>
            <Field label={t('term.command')} hint={t('term.commandHint')}>
              <input
                ref={inputRef}
                className="input mono"
                value={command}
                placeholder="AT+CSQ"
                disabled={busy}
                onChange={(event) => setCommand(event.target.value)}
                onKeyDown={onKeyDown}
              />
            </Field>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy || !command.trim()}
              onClick={() => void run(command)}
            >
              {busy ? t('term.running') : t('term.run')}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={entries.length === 0}
              onClick={clearLog}
            >
              {t('term.clear')}
            </button>
          </div>

          <div className="stack" style={{ gap: 'var(--space-2)' }}>
            <strong className="small">{t('term.quick')}</strong>
            <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
              {QUICK_COMMANDS.map((item) => (
                <button
                  key={item.command}
                  type="button"
                  className="btn btn-sm mono"
                  disabled={busy}
                  title={item.command}
                  onClick={() => void run(item.command)}
                >
                  {t(item.labelKey)}
                </button>
              ))}
            </div>
          </div>

          <div className="stack" style={{ gap: 'var(--space-2)' }}>
            <strong className="small">{t('term.ussd')}</strong>
            <span className="xs faint">{t('term.ussdHint')}</span>
            <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
              {USSD_COMMANDS.map((item) => (
                <button
                  key={item.command}
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  title={item.command}
                  onClick={() => void run(item.command)}
                >
                  {t(item.labelKey)}
                </button>
              ))}
            </div>
          </div>

          <span className="xs faint">{t('term.viaModemManager')}</span>
        </div>
      </div>

      {/* ---- output ---- */}
      <div className="card">
        <div className="card-head">
          <strong style={{ fontWeight: 500 }}>{t('term.output')}</strong>
          <span className="xs faint">
            {entries.length > 0 ? t('term.count', { count: entries.length }) : ''}
          </span>
        </div>
        <div
          ref={logRef}
          className="card-body"
          style={{ maxHeight: 420, overflowY: 'auto' }}
        >
          {entries.length === 0 ? (
            <Empty>{t('term.noOutput')}</Empty>
          ) : (
            <div className="stack" style={{ gap: 'var(--space-3)' }}>
              {entries.map((entry, index) => (
                <div key={`${entry.at}-${index}`} className="stack" style={{ gap: 4 }}>
                  <div className="row wrap" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
                    <Badge tone={outcomeTone(entry)}>
                      {!entry.ok
                        ? t('term.failed')
                        : entry.moduleError
                          ? t('term.moduleError')
                          : t('term.ok')}
                    </Badge>
                    <span className="mono small">{entry.command}</span>
                  </div>
                  {entry.response ? (
                    <pre
                      className="mono xs"
                      style={{
                        margin: 0,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        padding: 'var(--space-2)',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-sm, 6px)',
                      }}
                    >
                      {entry.response}
                    </pre>
                  ) : (
                    <span className="xs faint">{t('term.emptyResponse')}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ---- what this cannot do ---- */}
      <Disclosure summary={t('term.about')}>
        <span className="small">{t('term.aboutBody')}</span>
        <div className="row wrap" style={{ gap: 'var(--space-4)' }}>
          <KeyValue label={t('term.transport')} mono>
            ModemManager · Modem.Command
          </KeyValue>
          <KeyValue label={t('term.readOnlyFlag')} mono>
            MDD_AT_TERMINAL_ACTIONS
          </KeyValue>
        </div>
      </Disclosure>

      {pendingConfirm ? (
        <ConfirmDialog
          title={t('term.confirmTitle')}
          confirmLabel={t('term.confirmRun')}
          onCancel={() => setPendingConfirm(null)}
          onConfirm={() => {
            const pending = pendingConfirm
            setPendingConfirm(null)
            void run(pending.command, true)
          }}
        >
          <div className="stack" style={{ gap: 'var(--space-2)' }}>
            <span className="mono">{pendingConfirm.command}</span>
            {/* The reason comes from the server, so the dialog cannot drift from the rule. */}
            <span>{pendingConfirm.reason}</span>
          </div>
        </ConfirmDialog>
      ) : null}
    </div>
  )
}
