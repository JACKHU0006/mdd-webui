/**
 * Devices.
 *
 * The whole point of this screen is the three independent toggles. The gateway's own
 * architecture note is explicit that 4G, flight mode and VoWiFi are separate states and
 * that one failing must not be rendered as another failing — so each toggle issues its own
 * `PATCH /api/devices/{id}/capabilities` with exactly one key set, and the store is
 * refreshed from the server afterwards rather than optimistically patched.
 *
 * Optimistic updates are deliberately avoided here: a capability change restarts parts of
 * the engine, and showing the desired state as if it were actual is how an operator ends up
 * believing a tunnel is up when it is not.
 */
import { useState } from 'react'
import { api } from '../lib/api.ts'
import { useI18n } from '../lib/i18n.tsx'
import { useGateway } from '../lib/store.tsx'
import { ApiError } from '../lib/types.ts'
import type { Device } from '../lib/types.ts'
import { Badge, CapabilityCard, CopyButton, Empty, SkeletonRows, StatusDot } from '../components/ui.tsx'
import type { Tone } from '../components/ui.tsx'
import { formatEndpoint, formatOperator } from '../lib/format.ts'

function formatBytes(value: number): string {
  if (!value) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${(value / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

function DeviceCard({
  device,
  onChanged,
}: {
  device: Device
  onChanged: () => Promise<void>
}) {
  const { t } = useI18n()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const isReader = device.device_type === 'reader'
  const tone: Tone = !device.present ? 'neutral' : device.capabilities.vowifi.actual === 'on' ? 'ok' : 'warn'

  const toggle = async (key: 'cellular_enabled' | 'vowifi_enabled' | 'flight_mode', next: boolean) => {
    setBusy(key)
    setError(null)
    try {
      await api.devices.setCapabilities(device.id, { [key]: next })
      await onChanged()
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : String(failure))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <div className="row" style={{ gap: 'var(--space-2)', minWidth: 0 }}>
          <StatusDot tone={tone} />
          <strong className="truncate" style={{ fontWeight: 500 }}>
            {device.name}
          </strong>
          <Badge tone="neutral">{isReader ? t('device.reader') : t('device.modem')}</Badge>
          {device.present ? null : <Badge tone="warn">{t('device.absent')}</Badge>}
        </div>
        <div className="row xs faint" style={{ gap: 'var(--space-3)' }}>
          {device.model ? <span className="mono">{device.model}</span> : null}
          {device.firmware ? <span className="mono">{device.firmware}</span> : null}
        </div>
      </div>

      <div className="card-body stack">
        {error ? <div className="alert alert-danger">{error}</div> : null}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
            gap: 'var(--space-3)',
          }}
        >
          <CapabilityCard
            title={t('cap.cellular')}
            capability={device.capabilities.cellular}
            readOnly={isReader}
            busy={busy === 'cellular_enabled'}
            onToggle={(next) => void toggle('cellular_enabled', next)}
          />
          <CapabilityCard
            title={t('cap.flightMode')}
            capability={device.capabilities.flight_mode}
            readOnly={isReader}
            busy={busy === 'flight_mode'}
            onToggle={(next) => void toggle('flight_mode', next)}
          />
          <CapabilityCard
            title={t('cap.vowifi')}
            capability={device.capabilities.vowifi}
            busy={busy === 'vowifi_enabled'}
            onToggle={(next) => void toggle('vowifi_enabled', next)}
          />
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
            gap: 'var(--space-4)',
          }}
        >
          <div className="stack" style={{ gap: 3 }}>
            <div className="xs faint">{t('device.sim')}</div>
            <div className="small">
              {device.sim.present ? device.sim.name || t('device.sim') : t('device.noSim')}
            </div>
            {device.sim.number ? <div className="xs mono muted">{device.sim.number}</div> : null}
            {device.sim.carrier ? (
              <div className="xs muted">{formatOperator(device.sim.carrier)}</div>
            ) : null}
          </div>

          {device.cellular ? (
            <div className="stack" style={{ gap: 3 }}>
              <div className="xs faint">{t('cap.cellular')}</div>
              <div className="small">
                {formatOperator(device.cellular.operator)}{' '}
                {device.cellular.roaming ? <Badge tone="warn">roaming</Badge> : null}
              </div>
              <div className="xs muted">
                {device.cellular.registration}
                {device.cellular.signal !== null ? ` · ${device.cellular.signal} dBm` : ''}
              </div>
              <div className="xs muted mono">
                {device.cellular.ip || 'no ip'} · {formatBytes(device.cellular.rx_bytes)} ↓ /{' '}
                {formatBytes(device.cellular.tx_bytes)} ↑
              </div>
            </div>
          ) : null}

          <div className="stack" style={{ gap: 3 }}>
            <div className="xs faint">{t('device.epdg')}</div>
            <div className="small mono truncate">{formatEndpoint(device.vowifi.epdg)}</div>
            <div className="xs muted">{device.vowifi.ims || '—'}</div>
            <div className="xs faint">
              rekey {device.vowifi.rekey_minutes}m / IKE {device.vowifi.ike_rekey_minutes}m
            </div>
          </div>

          <div className="stack" style={{ gap: 3 }}>
            <div className="xs faint">{t('device.egressNode')}</div>
            <div className="small mono truncate">{device.egress.node || t('common.none')}</div>
            {device.egress.pinned_node ? (
              <div className="xs muted">
                pinned {device.egress.pinned_node} ({device.egress.pin_mode || 'auto'})
              </div>
            ) : null}
          </div>
        </div>

        {!isReader && device.logical_channels.length > 0 ? (
          <div className="stack" style={{ gap: 3 }}>
            <div className="xs faint">{t('device.channels')}</div>
            <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
              {device.logical_channels.map((channel) => (
                <Badge
                  key={channel.index}
                  tone={channel.error ? 'danger' : channel.allocated ? 'ok' : 'neutral'}
                >
                  ch{channel.index}
                  {channel.purpose ? ` · ${channel.purpose}` : ''}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}

        <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
          {device.imei ? (
            <>
              <span className="xs faint">IMEI</span>
              <span className="xs mono">{device.imei_masked || device.imei}</span>
              <CopyButton value={device.imei} />
            </>
          ) : null}
          {device.reader ? (
            <span className="xs faint mono truncate">reader: {device.reader}</span>
          ) : null}
        </div>
      </div>
    </section>
  )
}

export function Devices() {
  const { t } = useI18n()
  const { devices, discovering, loading, refresh, error } = useGateway()

  if (loading && !devices) return <SkeletonRows rows={5} />

  return (
    <div className="stack">
      {error ? <div className="alert alert-danger">{error}</div> : null}
      {discovering ? <div className="alert alert-info">Scanning for devices…</div> : null}

      {!devices || devices.length === 0 ? (
        <div className="card">
          <Empty>
            {t('device.noSim')} — connect a cellular modem or a PC/SC smart-card reader.
          </Empty>
        </div>
      ) : (
        devices.map((device) => (
          <DeviceCard key={device.id} device={device} onChanged={refresh} />
        ))
      )}
    </div>
  )
}
