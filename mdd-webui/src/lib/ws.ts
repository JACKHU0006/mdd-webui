/**
 * WebSocket client for the control plane event hub.
 *
 * Server behaviour this client has to cooperate with (`control/app/main.py:ws_endpoint`):
 *
 *  - The socket authenticates from the `mdd_session` cookie, so it must be opened
 *    same-origin or the handshake arrives unauthenticated.
 *  - The server always `accept()`s before it validates. That is deliberate: it lets an
 *    unauthenticated client receive close code 4401 instead of an opaque HTTP 403 that
 *    browsers retry forever. We therefore append `auth_close=1`, which is the flag that
 *    tells the server to actually close with 4401 rather than hold the socket open.
 *  - 4401 means "your session is gone" — reconnect would just spin, so we surface it as an
 *    auth failure and let the app return to the login screen.
 *  - The server reads (and ignores) inbound text purely to detect liveness, so we send a
 *    small keepalive on an interval.
 */
import type { WsEvent } from './types.ts'

const RAW_WS_BASE = (import.meta.env.VITE_WS_BASE ?? '').trim()

/** Close code the control plane uses for an unauthenticated socket. */
export const WS_UNAUTHORIZED = 4401

export type WsStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'unauthorized'

export interface WsClientOptions {
  onEvent: (event: WsEvent) => void
  onStatus?: (status: WsStatus) => void
  /** Backoff ceiling in ms. */
  maxBackoff?: number
  keepaliveMs?: number
}

function resolveWsUrl(): string {
  if (RAW_WS_BASE) return `${RAW_WS_BASE.replace(/\/+$/, '')}/ws`
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${window.location.host}/ws`
}

export class WsClient {
  private socket: WebSocket | null = null
  private reconnectTimer: number | null = null
  private keepaliveTimer: number | null = null
  private attempts = 0
  private stopped = true
  private status: WsStatus = 'idle'

  constructor(private readonly options: WsClientOptions) {}

  get currentStatus(): WsStatus {
    return this.status
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.attempts = 0
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    if (this.socket) {
      // Detach handlers first so the close does not schedule a reconnect.
      this.socket.onopen = null
      this.socket.onmessage = null
      this.socket.onclose = null
      this.socket.onerror = null
      try {
        this.socket.close(1000, 'client stop')
      } catch {
        /* already closing */
      }
      this.socket = null
    }
    this.setStatus('idle')
  }

  private setStatus(status: WsStatus): void {
    if (this.status === status) return
    this.status = status
    this.options.onStatus?.(status)
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.keepaliveTimer !== null) {
      window.clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = null
    }
  }

  private connect(): void {
    if (this.stopped) return
    this.setStatus('connecting')

    const url = `${resolveWsUrl()}?auth_close=1`
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.socket = socket

    socket.onopen = () => {
      this.attempts = 0
      this.setStatus('open')
      this.keepaliveTimer = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          try {
            socket.send('ping')
          } catch {
            /* the close handler will deal with it */
          }
        }
      }, this.options.keepaliveMs ?? 25_000)
    }

    socket.onmessage = (message) => {
      if (typeof message.data !== 'string') return
      // Keepalive echoes and any non-JSON frame are not events.
      if (!message.data.startsWith('{')) return
      try {
        this.options.onEvent(JSON.parse(message.data) as WsEvent)
      } catch {
        /* a malformed frame must not tear the socket down */
      }
    }

    socket.onerror = () => {
      /* onclose always follows; handle it in one place */
    }

    socket.onclose = (event) => {
      this.clearTimers()
      this.socket = null
      if (this.stopped) return
      if (event.code === WS_UNAUTHORIZED) {
        // Reconnecting cannot fix a dead session.
        this.setStatus('unauthorized')
        this.stopped = true
        return
      }
      this.setStatus('closed')
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    this.attempts += 1
    const ceiling = this.options.maxBackoff ?? 20_000
    // 1s, 2s, 4s … capped. Jitter avoids every open tab reconnecting in lockstep
    // after a control-plane restart.
    const base = Math.min(1000 * 2 ** (this.attempts - 1), ceiling)
    const delay = base * (0.7 + Math.random() * 0.6)
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay)
  }
}
