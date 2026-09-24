/**
 * eUICC inventory panel — every card the gateway knows about, on one screen.
 *
 * The eSIM page below this panel works on one card at a time (that is what `/api/esim/chip`
 * does). This answers a different question: *what eUICCs do I have, and which line is on
 * which?* It exists because with a soldered eUICC plus a removable one plus a dual-SE card
 * there was no single place to see the whole picture.
 *
 * Three things the rendering has to get right:
 *
 *  1. **`present` is three-valued.** `true` = a reader reported it just now. `null` = known
 *     only from the cache. The cache is keyed by EID and nothing removes an entry when a card
 *     is taken out, so a cached card must read as "not verified", never as "here" or "gone".
 *
 *  2. **Reading is disruptive, so it is a button, not a page load.** lpac is single-threaded
 *     and a read takes the reader from any running engine. The default view is the cache.
 *
 *  3. **A stale reading is shown, and labelled.** Hiding it would leave the operator with less
 *     information than before; showing it unlabelled would be a lie.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Badge,
  ConfirmDialog,
  Disclosure,
  Empty,
  ErrorNote,
  KeyValue,
  SkeletonRows,
  type Tone,
} from '../components/ui'
import { useI18n, type MessageKey } from '../lib/i18n'
import { api } from '../lib/api'
import { ApiError, type EsimInventory } from '../lib/types'
import { formatDuration, formatTimestamp } from '../lib/format'

function presenceTone(entry: EsimInventory['euiccs'][number]): Tone {
  if (entry.present === true) return entry.stale ? 'warn' : 'ok'
  // Only known from the cache: neither present nor absent is claimed.
  return 'neutral'
}

function presenceKey(entry: EsimInventory['euiccs'][number]): MessageKey {
  if (entry.present === true) return entry.stale ? 'esimInv.inReaderStale' : 'esimInv.inReader'
  return 'esimInv.fromCache'
}

export function EsimInventoryPanel() {
  const { t } = useI18n()
  const [inventory, setInventory] = useState<EsimInventory | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [confirmRefresh, setConfirmRefresh] = useState(false)

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true)
    setError(null)
    try {
      setInventory(await api.esim.inventory(refresh))
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : String(failure))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(false)
  }, [load])

  const euiccs = inventory?.euiccs ?? []

  return (
    <section className="card">
      <div className="card-head">
        <strong style={{ fontWeight: 500 }}>{t('esimInv.title')}</strong>
        <span className="row" style={{ gap: 'var(--space-2)' }}>
          {inventory ? (
            <Badge tone={inventory.refreshed ? 'ok' : 'neutral'}>
              {inventory.refreshed ? t('esimInv.justRead') : t('esimInv.fromCacheBadge')}
            </Badge>
          ) : null}
          <button
            type="button"
            className="btn btn-sm"
            disabled={loading}
            onClick={() => void load(false)}
          >
            {t('action.refresh')}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={loading}
            onClick={() => setConfirmRefresh(true)}
          >
            {t('esimInv.readCards')}
          </button>
        </span>
      </div>

      <div className="card-body stack" style={{ gap: 'var(--space-3)' }}>
        <span className="xs faint">{t('esimInv.hint')}</span>
        {error ? <ErrorNote>{error}</ErrorNote> : null}

        {inventory && inventory.errors.length > 0 ? (
          <div className="note note-warn stack" style={{ gap: 4 }}>
            <span className="small">{t('esimInv.readerErrors')}</span>
            {inventory.errors.map((text) => (
              <span key={text} className="xs mono">
                {text}
              </span>
            ))}
          </div>
        ) : null}

        {inventory && inventory.unseen > 0 ? (
          <div className="note note-warn">
            {t('esimInv.unseen', { count: inventory.unseen })}
          </div>
        ) : null}

        {loading && !inventory ? (
          <SkeletonRows rows={3} />
        ) : euiccs.length === 0 ? (
          <Empty>{t('esimInv.none')}</Empty>
        ) : (
          <div className="stack" style={{ gap: 'var(--space-2)' }}>
            {euiccs.map((entry) => (
              <div
                key={entry.eid}
                className="stack"
                style={{
                  gap: 4,
                  borderBottom: '1px solid var(--border)',
                  paddingBottom: 'var(--space-2)',
                }}
              >
                <div className="row wrap" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
                  <Badge tone={presenceTone(entry)}>{t(presenceKey(entry))}</Badge>
                  <span className="mono small">{entry.eid}</span>
                  {entry.line ? <Badge tone="info">{entry.line}</Badge> : null}
                  {entry.ses > 1 ? (
                    <Badge tone="neutral">{t('esimInv.dualSe', { count: entry.ses })}</Badge>
                  ) : null}
                </div>
                <div className="row wrap" style={{ gap: 'var(--space-4)' }}>
                  {entry.reader ? (
                    <KeyValue label={t('esimInv.reader')} mono>
                      {entry.reader}
                    </KeyValue>
                  ) : null}
                  {entry.imei ? (
                    <KeyValue label="IMEI" mono>
                      {entry.imei}
                    </KeyValue>
                  ) : null}
                  <KeyValue label={t('esimInv.profiles')}>
                    {entry.enabled} / {entry.profiles}
                  </KeyValue>
                  <KeyValue label={t('esimInv.readAt')}>
                    {entry.read_at ? formatTimestamp(entry.read_at) : '—'}
                    {entry.age_seconds != null ? ` · ${formatDuration(entry.age_seconds)}` : ''}
                  </KeyValue>
                </div>
                {entry.errors.length > 0 ? (
                  <span className="xs" style={{ color: 'var(--warning)' }}>
                    {entry.errors.join('；')}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        )}

        <Disclosure summary={t('esimInv.about')}>
          <span className="small">{t('esimInv.aboutBody')}</span>
          {inventory ? (
            <KeyValue label={t('esimInv.readers')} mono>
              {inventory.readers.length ? inventory.readers.join(' · ') : t('esimInv.noReaders')}
            </KeyValue>
          ) : null}
        </Disclosure>
      </div>

      {confirmRefresh ? (
        <ConfirmDialog
          title={t('esimInv.readCards')}
          confirmLabel={t('esimInv.readCards')}
          tone="danger"
          busy={loading}
          onCancel={() => setConfirmRefresh(false)}
          onConfirm={() => {
            setConfirmRefresh(false)
            void load(true)
          }}
        >
          <p className="small" style={{ margin: 0 }}>
            {t('esimInv.readCardsConfirm')}
          </p>
        </ConfirmDialog>
      ) : null}
    </section>
  )
}
