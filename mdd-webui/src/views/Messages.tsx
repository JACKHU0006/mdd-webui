/**
 * Messages.
 *
 * Two sources of truth meet here and must not be confused:
 *  - `GET /api/instances/{iid}/messages/{peer}` is the persisted history for one line.
 *  - `sms` events on the socket are pushed in real time and may arrive for a line the user
 *    is not currently looking at.
 *
 * The view therefore keeps the fetched thread as the base and merges any pushed message
 * that belongs to the selected line and peer. It does not treat the socket buffer as the
 * history — that buffer is bounded and would silently truncate a long conversation.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api.ts'
import { useI18n } from '../lib/i18n.tsx'
import { useGateway } from '../lib/store.tsx'
import { ApiError } from '../lib/types.ts'
import type { Instance, MessageThread, SmsMessage } from '../lib/types.ts'
import { Badge, Empty, Spinner } from '../components/ui.tsx'

export function Messages({ initialLineId }: { initialLineId?: string }) {
  const { t } = useI18n()
  const { instances, liveMessages, refresh } = useGateway()

  const [lineId, setLineId] = useState<string>(initialLineId ?? '')
  const [peer, setPeer] = useState<string | null>(null)
  const [threads, setThreads] = useState<MessageThread[] | null>(null)
  const [history, setHistory] = useState<SmsMessage[] | null>(null)
  const [loadingThread, setLoadingThread] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [composeTo, setComposeTo] = useState('')
  const [composeBody, setComposeBody] = useState('')
  const [sending, setSending] = useState(false)

  const bottomRef = useRef<HTMLDivElement | null>(null)

  // Default to the first line once the list arrives.
  useEffect(() => {
    if (!lineId && instances && instances.length > 0) setLineId(instances[0].id)
  }, [instances, lineId])

  const line: Instance | undefined = useMemo(
    () => instances?.find((item) => item.id === lineId),
    [instances, lineId],
  )

  /**
   * The conversation list is server state, not socket state.
   *
   * Deriving it from `liveMessages` alone looks right in a demo and is wrong in practice:
   * the socket buffer only holds what arrived since the tab opened, so a reload shows an
   * empty inbox even though the line has history. `threads` is the durable list; pushed
   * messages are merged on top so a brand-new peer appears without a refetch.
   */
  const loadThreads = useCallback(async () => {
    if (!lineId) return
    try {
      const result = await api.instances.messages.threads(lineId)
      setThreads(result.threads)
    } catch (failure) {
      if (failure instanceof ApiError && failure.isUnauthorized) {
        setError(t('common.sessionExpired'))
        return
      }
      setThreads([])
    }
  }, [lineId, t])

  useEffect(() => {
    setThreads(null)
    void loadThreads()
  }, [loadThreads])

  const peers = useMemo(() => {
    const merged = new Map<string, MessageThread>()
    for (const thread of threads ?? []) merged.set(thread.peer, thread)
    for (const message of liveMessages) {
      const existing = merged.get(message.peer)
      if (!existing || message.timestamp >= existing.last.timestamp) {
        merged.set(message.peer, {
          peer: message.peer,
          last: message,
          count: (existing?.count ?? 0) + (existing ? 0 : 1),
          unread: existing?.unread ?? (message.inbound && message.unread ? 1 : 0),
        })
      }
    }
    return [...merged.values()].sort((a, b) => b.last.timestamp - a.last.timestamp)
  }, [threads, liveMessages])

  const loadThread = useCallback(
    async (targetPeer: string) => {
      if (!lineId) return
      setLoadingThread(true)
      setError(null)
      try {
        const result = await api.instances.messages.withPeer(lineId, targetPeer)
        setHistory(result.messages)
      } catch (failure) {
        if (failure instanceof ApiError && failure.isUnauthorized) {
          setError(t('common.sessionExpired'))
          return
        }
        setError(failure instanceof ApiError ? failure.message : String(failure))
      } finally {
        setLoadingThread(false)
      }
    },
    [lineId, t],
  )

  useEffect(() => {
    if (peer) void loadThread(peer)
  }, [peer, loadThread])

  // Merge pushed messages for the open conversation.
  const conversation = useMemo(() => {
    const base = history ?? []
    if (!peer) return base
    const known = new Set(base.map((message) => message.id))
    const pushed = liveMessages.filter((message) => message.peer === peer && !known.has(message.id))
    return [...base, ...pushed].sort((a, b) => a.timestamp - b.timestamp)
  }, [history, liveMessages, peer])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [conversation.length])

  const send = async () => {
    if (!lineId) {
      setError(t('msg.selectLine'))
      return
    }
    const to = composeTo.trim() || peer || ''
    if (!to || !composeBody.trim()) return
    setSending(true)
    setError(null)
    try {
      await api.instances.messages.sendSms(lineId, to, composeBody)
      setComposeBody('')
      // The outbound message comes back as an `sms` event, but the history endpoint is the
      // durable copy — refetch so a dropped frame cannot hide what was actually sent.
      setPeer(to)
      await Promise.all([loadThread(to), loadThreads(), refresh()])
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : String(failure))
    } finally {
      setSending(false)
    }
  }

  if (!instances || instances.length === 0) {
    return (
      <div className="card">
        <Empty>No provisioned lines. Insert a readable SIM and let automatic setup finish.</Empty>
      </div>
    )
  }

  return (
    <div className="stack">
      {error ? <div className="alert alert-danger">{error}</div> : null}

      <div className="row wrap" style={{ gap: 'var(--space-3)' }}>
        <label className="row small" style={{ gap: 'var(--space-2)' }}>
          <span className="faint">Line</span>
          <select
            className="select"
            style={{ width: 'auto' }}
            value={lineId}
            onChange={(event) => {
              setLineId(event.target.value)
              setPeer(null)
              setHistory(null)
            }}
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
          <Badge tone={line.status.state === 'STOPPED' ? 'neutral' : 'ok'}>
            {line.status.state}
          </Badge>
        ) : null}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(200px, 260px) 1fr',
          gap: 'var(--space-4)',
          alignItems: 'start',
        }}
      >
        <section className="card">
          <div className="card-head">
            <strong style={{ fontWeight: 500 }}>{t('msg.threads')}</strong>
          </div>
          {peers.length === 0 ? (
            <Empty>{t('msg.noThreads')}</Empty>
          ) : (
            <div>
              {peers.map((thread) => (
                <button
                  key={thread.peer}
                  type="button"
                  onClick={() => setPeer(thread.peer)}
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: 'var(--space-2) var(--space-3)',
                    border: 'none',
                    borderBottom: '1px solid var(--border)',
                    background: peer === thread.peer ? 'var(--accent-soft)' : 'transparent',
                    font: 'inherit',
                    fontSize: 'var(--text-sm)',
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  <div className="row-between">
                    <span className="mono xs truncate">{thread.peer}</span>
                    <span className="row" style={{ gap: 5 }}>
                      {thread.unread > 0 ? <Badge tone="info">{thread.unread}</Badge> : null}
                      <span className="xs faint">
                        {new Date(thread.last.timestamp * 1000).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </span>
                  </div>
                  <div className="xs muted truncate">{thread.last.body}</div>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <strong style={{ fontWeight: 500 }}>
              {peer ? <span className="mono">{peer}</span> : t('msg.empty')}
            </strong>
            {loadingThread ? <Spinner /> : null}
          </div>

          <div
            className="card-body"
            style={{ maxHeight: 420, overflowY: 'auto', background: 'var(--surface-2)' }}
          >
            {!peer ? (
              <Empty>{t('msg.empty')}</Empty>
            ) : conversation.length === 0 && !loadingThread ? (
              <Empty>No messages with this peer yet.</Empty>
            ) : (
              <div className="stack" style={{ gap: 'var(--space-2)' }}>
                {conversation.map((message) => (
                  <div
                    key={message.id}
                    style={{
                      alignSelf: message.inbound ? 'flex-start' : 'flex-end',
                      maxWidth: '78%',
                      padding: '6px 10px',
                      borderRadius: 'var(--radius-sm)',
                      background: message.inbound ? 'var(--surface)' : 'var(--accent-soft)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    <div className="small" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {message.body}
                    </div>
                    <div className="xs faint" style={{ marginTop: 2 }}>
                      {new Date(message.timestamp * 1000).toLocaleString()}
                      {message.delivery ? ` · ${message.delivery}` : ''}
                    </div>
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>
            )}
          </div>

          <div className="card-body" style={{ borderTop: '1px solid var(--border)' }}>
            <div className="stack" style={{ gap: 'var(--space-2)' }}>
              <input
                className="input"
                placeholder={t('msg.to')}
                value={composeTo || peer || ''}
                onChange={(event) => setComposeTo(event.target.value)}
              />
              <textarea
                className="textarea"
                style={{ minHeight: 64, fontFamily: 'var(--font-sans)' }}
                placeholder={t('msg.body')}
                value={composeBody}
                onChange={(event) => setComposeBody(event.target.value)}
              />
              <div className="row-between">
                <span className="xs faint">
                  Sending from {line?.name || line?.id} · each message is billable
                </span>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={sending || !composeBody.trim()}
                  onClick={() => void send()}
                >
                  {sending ? t('msg.sending') : t('msg.send')}
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
