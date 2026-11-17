/**
 * System maintenance.
 *
 * Two things the control plane has always been able to do but the UI never exposed:
 *
 * 1. `GET /api/diagnostics/support-bundle` — a redacted zip (IMSI/ICCID/EID/number/tokens and
 *    message bodies stripped) covering devices, egress, readers and per-line diagnostics.
 *    It is a plain authenticated GET, so a normal link is enough; no CSRF token needed.
 * 2. `GET /api/system/update/check` — the same release lookup the product polls every six
 *    hours. The click passes `force=1` so it bypasses the in-process cache instead of
 *    burning GitHub's rate limit on every page load.
 *
 * Updating is deliberately *not* wired to the button. `POST /api/system/update/apply`
 * only asks the orchestrator to start a detached update (and a container stack update
 * pulls images and restarts all three containers), so a click here would kill the very
 * page the user is looking at, and it is still gated by `update-policy.json`. The card
 * reports the version and the exact command to run on the host instead.
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api.ts'
import { useI18n } from '../lib/i18n.tsx'
import type { UpdateCheck, UpdateRelease } from '../lib/types.ts'
import { Badge } from './ui.tsx'

export function Maintenance() {
  const { t } = useI18n()
  const [version, setVersion] = useState('')
  const [check, setCheck] = useState<UpdateCheck | null>(null)
  const [release, setRelease] = useState<UpdateRelease | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api.system
      .status()
      .then((status) => {
        if (alive) setVersion(status.version ?? '')
      })
      .catch(() => {
        /* The version tile is cosmetic; a failure here must not break the page. */
      })
    return () => {
      alive = false
    }
  }, [])

  const runCheck = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.system.updateCheck(true)
      setCheck(result)
      if (result.available) {
        const list = await api.system.releases().catch(() => null)
        setRelease(
          (list?.releases ?? []).find((item) => item.version === result.latest) ?? null,
        )
      } else {
        setRelease(null)
      }
    } catch (message) {
      setError((message as Error).message || t('maint.error'))
    } finally {
      setBusy(false)
    }
  }, [t])

  const shownVersion = check?.current || version

  return (
    <section className="card">
      <div className="card-head" style={{ flexWrap: 'wrap', rowGap: 'var(--space-2)' }}>
        <strong style={{ fontWeight: 500 }}>{t('maint.title')}</strong>
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={runCheck}>
            {busy ? t('maint.checking') : t('maint.check')}
          </button>
          <a
            className="btn btn-sm"
            href={api.system.supportBundleUrl()}
            target="_blank"
            rel="noreferrer"
          >
            {t('maint.bundle')}
          </a>
        </div>
      </div>

      <div className="card-body stack">
        {error ? <div className="alert alert-danger">{error}</div> : null}

        <div className="row" style={{ gap: 'var(--space-4)', flexWrap: 'wrap' }}>
          <span className="muted">
            {t('maint.version')}:{' '}
            <span className="mono">{shownVersion || '—'}</span>
          </span>
          {check ? (
            <>
              <span className="muted">
                {t('maint.channel')}:{' '}
                <span className="mono">{check.channel || '—'}</span>
              </span>
              <Badge tone={check.available ? 'warn' : 'ok'}>
                {check.available
                  ? `${t('maint.available')} ${check.latest ?? ''}`.trim()
                  : t('maint.upToDate')}
              </Badge>
            </>
          ) : null}
        </div>

        {release ? (
          <div className="stack" style={{ gap: 'var(--space-1)' }}>
            <span className="muted xs">
              {t('maint.notes')} · {release.version}
              {release.published_at
                ? ` · ${new Date(release.published_at).toLocaleDateString()}`
                : ''}
            </span>
            {release.notes ? (
              <pre
                className="mono xs muted"
                style={{
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  maxHeight: 220,
                  overflow: 'auto',
                  padding: 'var(--space-2)',
                  background: 'var(--surface-2, rgba(127,127,127,.08))',
                  borderRadius: 'var(--radius-1, 6px)',
                }}
              >
                {release.notes}
              </pre>
            ) : null}
          </div>
        ) : null}

        <span className="muted xs">{t('maint.bundleHint')}</span>
        <span className="muted xs">{t('maint.applyHint')}</span>
      </div>
    </section>
  )
}
