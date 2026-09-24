/**
 * Overview.
 *
 * Everything here is read-only and derived from the store. The one thing worth noting is
 * that a device with no provisioned line is not an error — the control plane creates a
 * draft line when a readable SIM appears, and until then the device legitimately has no
 * line. The UI says so instead of rendering an empty status.
 */
import { useI18n } from '../lib/i18n.tsx'
import { useGateway } from '../lib/store.tsx'
import { Badge, Empty, SkeletonRows, StatTile, StatusDot, useActualLabel } from '../components/ui.tsx'
import type { Tone } from '../components/ui.tsx'

export function Overview({ onNavigate }: { onNavigate: (route: string) => void }) {
  const { t } = useI18n()
  const actualLabel = useActualLabel()
  const { devices, instances, egress, discovering, liveMessages, loading, error } = useGateway()

  if (loading && !devices) {
    return (
      <div className="stack">
        <SkeletonRows rows={4} />
      </div>
    )
  }

  const present = devices?.filter((device) => device.present) ?? []
  const runningLines =
    instances?.filter((line) => (line.status?.state ?? 'STOPPED') !== 'STOPPED') ?? []
  const readyExits = egress ? Object.values(egress.exits).filter((exit) => exit.ready).length : 0
  const totalExits = egress ? Object.keys(egress.exits).length : 0

  return (
    <div className="stack">
      {error ? <div className="alert alert-danger">{error}</div> : null}

      {discovering ? (
        <div className="alert alert-info">
          Scanning for smart-card readers and modems. Counts below may still be incomplete.
        </div>
      ) : null}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: 'var(--space-3)',
        }}
      >
        <StatTile
          label={t('overview.devices')}
          value={`${present.length} / ${devices?.length ?? 0}`}
          hint={`${present.filter((device) => device.device_type === 'modem').length} modem · ${
            present.filter((device) => device.device_type === 'reader').length
          } reader`}
        />
        <StatTile
          label={t('overview.lines')}
          value={runningLines.length}
          hint={`${instances?.length ?? 0} provisioned`}
        />
        <StatTile
          label={t('overview.exits')}
          value={`${readyExits} / ${totalExits}`}
          tone={totalExits > 0 && readyExits === 0 ? 'danger' : readyExits > 0 ? 'ok' : 'neutral'}
        />
        <StatTile label={t('overview.recentMessages')} value={liveMessages.length} />
      </div>

      <section className="card">
        <div className="card-head">
          <strong style={{ fontWeight: 500 }}>{t('nav.devices')}</strong>
          <button type="button" className="btn btn-sm" onClick={() => onNavigate('devices')}>
            {t('nav.devices')}
          </button>
        </div>
        {!devices || devices.length === 0 ? (
          <Empty>No devices detected. Connect a modem or a PC/SC reader.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>{t('cap.cellular')}</th>
                <th>{t('cap.vowifi')}</th>
                <th>{t('device.sim')}</th>
                <th>{t('device.egressNode')}</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((device) => {
                const tone: Tone = !device.present
                  ? 'neutral'
                  : device.capabilities.vowifi.actual === 'on'
                    ? 'ok'
                    : 'warn'
                return (
                  <tr key={device.id}>
                    <td>
                      <span className="row" style={{ gap: 'var(--space-2)' }}>
                        <StatusDot tone={tone} />
                        <span className="truncate">{device.name}</span>
                      </span>
                    </td>
                    <td className="muted">
                      {device.device_type === 'modem' ? t('device.modem') : t('device.reader')}
                    </td>
                    <td>
                      {device.cellular
                        ? actualLabel(device.capabilities.cellular.actual)
                        : t('state.unsupported')}
                    </td>
                    <td>{actualLabel(device.capabilities.vowifi.actual)}</td>
                    <td className="muted">
                      {device.sim.present ? device.sim.name || t('device.sim') : t('device.noSim')}
                    </td>
                    <td className="mono xs muted truncate">{device.egress.node || t('common.none')}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <strong style={{ fontWeight: 500 }}>{t('overview.recentMessages')}</strong>
          <button type="button" className="btn btn-sm" onClick={() => onNavigate('messages')}>
            {t('nav.messages')}
          </button>
        </div>
        {liveMessages.length === 0 ? (
          <Empty>{t('overview.noMessages')}</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Peer</th>
                <th>Body</th>
                <th>Direction</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {liveMessages.slice(0, 8).map((message) => (
                <tr key={message.id}>
                  <td className="mono xs">{message.peer}</td>
                  <td className="truncate" style={{ maxWidth: 320 }}>
                    {message.body}
                  </td>
                  <td>
                    <Badge tone={message.inbound ? 'info' : 'neutral'}>
                      {message.inbound ? 'in' : 'out'}
                    </Badge>
                  </td>
                  <td className="xs muted">
                    {new Date(message.timestamp * 1000).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
