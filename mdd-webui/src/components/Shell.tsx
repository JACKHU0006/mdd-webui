/**
 * Console shell: sidebar, top bar, connection indicator.
 *
 * The connection indicator is not decoration. The gateway pushes state over a socket, so
 * an operator staring at a frozen "Off" needs to know whether the line is genuinely off or
 * the socket died. The badge is driven by the socket status, never by a timer.
 */
import type { ReactNode } from 'react'
import { useI18n } from '../lib/i18n.tsx'
import type { MessageKey } from '../lib/i18n.tsx'
import { useAuth } from '../lib/auth.tsx'
import { useGateway } from '../lib/store.tsx'
import { ACCENTS, THEMES, useTheme } from '../lib/theme.ts'
import { Badge, StatusDot } from './ui.tsx'
import type { Tone } from './ui.tsx'

export interface NavItem {
  route: string
  labelKey: MessageKey
  /** Short glyph shown in the collapsed rail. Text, not an icon font. */
  glyph: string
}

export const NAV_ITEMS: NavItem[] = [
  { route: '', labelKey: 'nav.overview', glyph: '◈' },
  { route: 'devices', labelKey: 'nav.devices', glyph: '▤' },
  { route: 'lines', labelKey: 'nav.lines', glyph: '≡' },
  { route: 'calls', labelKey: 'nav.calls', glyph: '☏' },
  { route: 'terminal', labelKey: 'nav.terminal', glyph: '⌘' },
  { route: 'messages', labelKey: 'nav.messages', glyph: '✉' },
  { route: 'keepalive', labelKey: 'nav.keepalive', glyph: '◷' },
  { route: 'esim', labelKey: 'nav.esim', glyph: '▣' },
  { route: 'egress', labelKey: 'nav.egress', glyph: '⇄' },
  { route: 'notifications', labelKey: 'nav.notifications', glyph: '◔' },
  { route: 'settings', labelKey: 'nav.settings', glyph: '⚙' },
]

function connectionTone(status: string): Tone {
  switch (status) {
    case 'open':
      return 'ok'
    case 'connecting':
    case 'closed':
      return 'warn'
    case 'unauthorized':
      return 'danger'
    default:
      return 'neutral'
  }
}

export function Shell({
  active,
  onNavigate,
  children,
}: {
  active: string
  onNavigate: (route: string) => void
  children: ReactNode
}) {
  const { t, language, setLanguage } = useI18n()
  const { theme, accent, setTheme, setAccent } = useTheme()
  const { logout, username } = useAuth()
  const { connection, devices, instances } = useGateway()

  const connectionLabel: Record<string, string> = {
    open: t('common.connected'),
    connecting: t('common.reconnecting'),
    closed: t('common.reconnecting'),
    unauthorized: t('common.disconnected'),
    idle: t('common.disconnected'),
  }

  const presentCount = devices?.filter((device) => device.present).length ?? 0
  const runningCount =
    instances?.filter((line) => (line.status?.state ?? 'STOPPED') !== 'STOPPED').length ?? 0

  return (
    <div className="shell">
      <aside className="shell-aside">
        <div className="shell-brand">
          <div style={{ fontWeight: 500, fontSize: 'var(--text-md)' }}>{t('app.name')}</div>
          <div className="xs faint truncate">{t('app.tagline')}</div>
        </div>

        <nav className="shell-nav">
          {NAV_ITEMS.map((item) => {
            const isActive = item.route === active
            return (
              <button
                key={item.route || 'overview'}
                type="button"
                className="shell-nav-item"
                onClick={() => onNavigate(item.route)}
                aria-current={isActive ? 'page' : undefined}
                style={{
                  background: isActive ? 'var(--accent-soft)' : undefined,
                  color: isActive ? 'var(--accent)' : undefined,
                  fontWeight: isActive ? 500 : 400,
                }}
              >
                <span aria-hidden="true" style={{ width: 14, opacity: 0.75 }}>
                  {item.glyph}
                </span>
                <span className="grow truncate">{t(item.labelKey)}</span>
              </button>
            )
          })}
        </nav>

        <div className="shell-foot">
          <div className="row-between xs">
            <span className="faint">{t('common.connection')}</span>
            <span className="row" style={{ gap: 5 }}>
              <StatusDot tone={connectionTone(connection)} />
              {connectionLabel[connection] ?? t('common.disconnected')}
            </span>
          </div>
          <div className="row-between xs">
            <span className="faint">{t('common.language')}</span>
            <select
              className="select"
              style={{ width: 'auto', padding: '1px 4px', fontSize: 'var(--text-xs)' }}
              value={language}
              onChange={(event) => setLanguage(event.target.value as 'zh' | 'en')}
              aria-label={t('common.language')}
            >
              <option value="zh">中文</option>
              <option value="en">English</option>
            </select>
          </div>
          <div className="row-between xs">
            <span className="faint">{t('common.theme')}</span>
            <select
              className="select"
              style={{ width: 'auto', padding: '1px 4px', fontSize: 'var(--text-xs)' }}
              value={theme}
              onChange={(event) => setTheme(event.target.value as (typeof THEMES)[number])}
              aria-label={t('common.theme')}
            >
              <option value="light">{t('common.themeLight')}</option>
              <option value="dark">{t('common.themeDark')}</option>
            </select>
          </div>
          <div className="row-between xs">
            <span className="faint">{t('common.accent')}</span>
            <select
              className="select"
              style={{ width: 'auto', padding: '1px 4px', fontSize: 'var(--text-xs)' }}
              value={accent}
              onChange={(event) => setAccent(event.target.value as (typeof ACCENTS)[number])}
              aria-label={t('common.accent')}
            >
              {ACCENTS.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </aside>

      <div className="shell-body">
        <header className="shell-topbar">
          <div className="row wrap" style={{ gap: 'var(--space-3)' }}>
            <strong style={{ fontWeight: 500 }}>
              {t(NAV_ITEMS.find((item) => item.route === active)?.labelKey ?? 'nav.overview')}
            </strong>
            <span className="xs faint">
              {presentCount} / {devices?.length ?? 0} devices · {runningCount} lines up
            </span>
          </div>

          <div className="row" style={{ gap: 'var(--space-3)' }}>
            {connection === 'unauthorized' ? (
              <Badge tone="danger">{t('common.sessionExpired')}</Badge>
            ) : null}
            <span className="xs faint">{username}</span>
            <button type="button" className="btn btn-sm" onClick={() => void logout()}>
              {t('action.signOut')}
            </button>
          </div>
        </header>

        <main className="shell-main">{children}</main>
      </div>
    </div>
  )
}
