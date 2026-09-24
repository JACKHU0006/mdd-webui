import { Suspense, lazy } from 'react'
import { AuthProvider, useAuth } from './lib/auth.tsx'
import { I18nProvider } from './lib/i18n.tsx'
import { GatewayProvider } from './lib/store.tsx'
import { useRoute } from './lib/router.ts'
import { queryParam } from './lib/router.ts'
import { Shell } from './components/Shell.tsx'
import { Login } from './views/Login.tsx'
import { Overview } from './views/Overview.tsx'
import { Devices } from './views/Devices.tsx'
import { Lines } from './views/Lines.tsx'
import { Keepalive } from './views/Keepalive.tsx'
import { Esim } from './views/Esim.tsx'
import { Egress } from './views/Egress.tsx'
import { Notifications } from './views/Notifications.tsx'
import { Terminal } from './views/Terminal.tsx'
import { Messages } from './views/Messages.tsx'
import { Settings } from './views/Settings.tsx'
import { Placeholder } from './views/Placeholder.tsx'
import { DEMO_MODE } from './lib/api.ts'
import { useI18n } from './lib/i18n.tsx'
import { SkeletonRows } from './components/ui.tsx'

/**
 * Calls is loaded on demand, and only because of JsSIP.
 *
 * The softphone pulls in the whole JsSIP stack — roughly 275 KB raw / 64 KB gzipped — and it is
 * the only runtime dependency here besides React. Bundling it eagerly made every page pay for a
 * feature that only this one uses, which matters on a static host where the first load is the
 * whole story. Everything else stays in the main chunk; this page arrives as its own.
 */
const Calls = lazy(() => import('./views/Calls.tsx').then((module) => ({ default: module.Calls })))

/** Routes with a real view. Everything else falls through to the roadmap placeholder. */
const IMPLEMENTED = new Set([
  '',
  'devices',
  'lines',
  'keepalive',
  'esim',
  'egress',
  'notifications',
  'calls',
  'terminal',
  'messages',
  'settings',
])

function Console() {
  const { phase } = useAuth()
  const { t } = useI18n()
  const { name, params, query, navigate } = useRoute()

  if (phase === 'booting') {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 'var(--space-3)',
        }}
      >
        <span className="spinner" aria-hidden="true" />
        <span className="muted small">{t('common.loading')}</span>
      </div>
    )
  }

  if (phase !== 'authenticated') return <Login />

  return (
    <Shell active={name} onNavigate={navigate}>
      {DEMO_MODE ? (
        <div className="alert alert-info" style={{ marginBottom: 'var(--space-4)' }}>
          {t('common.discDemo')}
        </div>
      ) : null}

      {name === '' ? <Overview onNavigate={navigate} /> : null}
      {name === 'devices' ? <Devices /> : null}
      {name === 'lines' ? <Lines /> : null}
      {name === 'keepalive' ? <Keepalive /> : null}
      {name === 'esim' ? <Esim /> : null}
      {name === 'egress' ? <Egress /> : null}
      {name === 'notifications' ? <Notifications /> : null}
      {name === 'terminal' ? <Terminal /> : null}
      {name === 'calls' ? (
        <Suspense fallback={<SkeletonRows rows={4} />}>
          <Calls />
        </Suspense>
      ) : null}
      {name === 'messages' ? (
        <Messages initialLineId={queryParam(query, 'line') ?? params[0] ?? undefined} />
      ) : null}
      {name === 'settings' ? <Settings onNavigate={navigate} /> : null}
      {!IMPLEMENTED.has(name) ? <Placeholder route={name} /> : null}
    </Shell>
  )
}

export default function App() {
  return (
    <I18nProvider>
      <AuthProvider>
        <GatewayProvider>
          <Console />
        </GatewayProvider>
      </AuthProvider>
    </I18nProvider>
  )
}
