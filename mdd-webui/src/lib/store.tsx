/**
 * Live gateway state.
 *
 * The control plane pushes most changes over `/ws` and expects the UI to treat that as
 * the primary source, with a slow poll as a safety net. The rules this store follows:
 *
 *  - A `cards`, `hardware`, `capability` or `line` event invalidates the device list
 *    wholesale. Those events mean topology moved, and re-deriving one device from a
 *    partial event is how you end up rendering a stale capability.
 *  - `sms` and `call` events are appended to a bounded local buffer so a busy line cannot
 *    grow the tab's memory without limit.
 *  - The store never invents state. `null` means "not loaded yet" and is rendered as a
 *    skeleton, not as zero.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from './api.ts'
import { ApiError } from './types.ts'
import type { Device, EgressStatus, Instance, Settings, SmsMessage, SystemStatus, WsEvent } from './types.ts'
import { WsClient, type WsStatus } from './ws.ts'
import { useAuth } from './auth.tsx'

/** How many pushed messages to keep client-side before dropping the oldest. */
const MESSAGE_BUFFER_LIMIT = 500

interface GatewayValue {
  devices: Device[] | null
  instances: Instance[] | null
  settings: Settings | null
  egress: EgressStatus | null
  system: SystemStatus | null
  discovering: boolean
  /** Newest first. Pushed by `sms` events; not a substitute for the per-line history. */
  liveMessages: SmsMessage[]
  connection: WsStatus
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  refreshSettings: () => Promise<void>
  /**
   * Subscribe to every pushed event.
   *
   * The store handles the events that change its own state; a view sometimes needs one it
   * does not (`esim_download` progress, for instance, which belongs to a single screen).
   * Rather than opening a second WebSocket — a second socket doubles the reconnect logic and
   * can arrive before the first, producing out-of-order events — views subscribe here.
   * Returns an unsubscribe function.
   */
  subscribe: (listener: (event: WsEvent) => void) => () => void
}

const GatewayContext = createContext<GatewayValue | null>(null)

export function GatewayProvider({ children }: { children: ReactNode }) {
  const { phase, invalidate } = useAuth()

  const [devices, setDevices] = useState<Device[] | null>(null)
  const [instances, setInstances] = useState<Instance[] | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [egress, setEgress] = useState<EgressStatus | null>(null)
  const [system, setSystem] = useState<SystemStatus | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [liveMessages, setLiveMessages] = useState<SmsMessage[]>([])
  const [connection, setConnection] = useState<WsStatus>('idle')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const clientRef = useRef<WsClient | null>(null)
  const listenersRef = useRef(new Set<(event: WsEvent) => void>())

  const subscribe = useCallback((listener: (event: WsEvent) => void) => {
    listenersRef.current.add(listener)
    return () => {
      listenersRef.current.delete(listener)
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [deviceResult, instanceResult, egressResult, systemResult] = await Promise.all([
        api.devices.list(),
        api.instances.list(),
        // Egress and system status are secondary: a failure there must not blank the page.
        api.egress.status().catch(() => null),
        api.system.status().catch(() => null),
      ])
      setDevices(deviceResult.devices)
      setDiscovering(deviceResult.discovering)
      setInstances(instanceResult.instances)
      if (egressResult) setEgress(egressResult)
      if (systemResult) setSystem(systemResult)
      setError(null)
    } catch (failure) {
      if (failure instanceof ApiError && failure.isUnauthorized) {
        invalidate()
        return
      }
      setError(failure instanceof ApiError ? failure.message : String(failure))
    } finally {
      setLoading(false)
    }
  }, [invalidate])

  const refreshSettings = useCallback(async () => {
    try {
      setSettings(await api.settings.get())
    } catch (failure) {
      if (failure instanceof ApiError && failure.isUnauthorized) {
        invalidate()
        return
      }
      setError(failure instanceof ApiError ? failure.message : String(failure))
    }
  }, [invalidate])

  // Initial load plus the slow safety-net poll. The socket is authoritative; this exists
  // so a dropped frame or a missed reconnect still converges.
  useEffect(() => {
    if (phase !== 'authenticated') return
    void refresh()
    void refreshSettings()
    const timer = window.setInterval(() => void refresh(), 30_000)
    return () => window.clearInterval(timer)
  }, [phase, refresh, refreshSettings])

  // Event socket.
  useEffect(() => {
    if (phase !== 'authenticated') {
      clientRef.current?.stop()
      clientRef.current = null
      setConnection('idle')
      return
    }

    const client = new WsClient({
      onStatus: setConnection,
      onEvent: (event: WsEvent) => {
        // Fan out first, so a view sees every event even when the switch below has no arm
        // for it — and so a listener throwing cannot stop the store from updating itself.
        for (const listener of listenersRef.current) {
          try {
            listener(event)
          } catch {
            // A broken listener must not take the socket down with it.
          }
        }
        switch (event.type) {
          case 'cards':
          case 'hardware':
          case 'capability':
          case 'line':
            // Topology moved — re-derive rather than patch.
            void refresh()
            break
          case 'status':
            setDevices((current) => {
              if (!current || !event.instance) return current
              return current.map((device) =>
                device.instance_id === event.instance
                  ? {
                      ...device,
                      status: {
                        ...(device.status ?? {}),
                        state: event.state ?? device.status?.state ?? 'unknown',
                        ...(event.label !== undefined ? { label: event.label } : {}),
                        ...(event.detail !== undefined ? { detail: event.detail } : {}),
                      },
                    }
                  : device,
              )
            })
            break
          case 'sms': {
            const message = event.message
            if (!message) {
              void refresh()
              break
            }
            setLiveMessages((current) => {
              if (current.some((item) => item.id === message.id)) return current
              return [message, ...current].slice(0, MESSAGE_BUFFER_LIMIT)
            })
            break
          }
          case 'host_alert':
          case 'engine':
          case 'esim_download':
          case 'socks':
          case 'subscription':
          case 'container':
            // No cheap local patch for these; the next poll picks them up and they are
            // not on the critical path for the primary screens.
            break
          default:
            break
        }
      },
    })

    client.start()
    clientRef.current = client
    return () => {
      client.stop()
      clientRef.current = null
    }
  }, [phase, refresh])

  const value = useMemo<GatewayValue>(
    () => ({
      devices,
      instances,
      settings,
      egress,
      system,
      discovering,
      liveMessages,
      connection,
      loading,
      error,
      refresh,
      refreshSettings,
      subscribe,
    }),
    [
      devices,
      instances,
      settings,
      egress,
      system,
      discovering,
      liveMessages,
      connection,
      loading,
      error,
      refresh,
      refreshSettings,
      subscribe,
    ],
  )

  return <GatewayContext.Provider value={value}>{children}</GatewayContext.Provider>
}

export function useGateway(): GatewayValue {
  const value = useContext(GatewayContext)
  if (!value) throw new Error('useGateway must be used inside <GatewayProvider>')
  return value
}
