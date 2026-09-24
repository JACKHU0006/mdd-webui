/**
 * Login and first-run setup.
 *
 * One form serves both because the control plane distinguishes them with a single public
 * field (`configured` on `GET /api/auth/status`), and a separate setup route would just be
 * the same form with a different submit target.
 */
import { useEffect, useState } from 'react'
import { useAuth } from '../lib/auth.tsx'
import { useI18n } from '../lib/i18n.tsx'

export function Login() {
  const { t } = useI18n()
  const { phase, username, error, busy, login, setup, clearError } = useAuth()
  const needsSetup = phase === 'needs-setup'

  const [user, setUser] = useState(username)
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => setUser(username), [username])
  useEffect(() => {
    if (error === 'session-expired') clearError()
  }, [error, clearError])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setLocalError(null)
    if (needsSetup && password.length < 10) {
      setLocalError(t('login.passwordTooShort'))
      return
    }
    if (needsSetup) {
      await setup(user, password)
    } else {
      await login(user, password, remember)
    }
  }

  const shownError =
    localError ??
    (error && error !== 'session-expired' ? error : null) ??
    (error === 'session-expired' ? t('common.sessionExpired') : null)

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--space-5)',
      }}
    >
      <div className="card" style={{ width: '100%', maxWidth: 380 }}>
        <div className="card-head">
          <div>
            <div style={{ fontWeight: 500 }}>{t('app.name')}</div>
            <div className="xs faint">{t('app.tagline')}</div>
          </div>
        </div>

        <form className="card-body" onSubmit={submit}>
          <h2 style={{ marginBottom: 'var(--space-2)' }}>
            {needsSetup ? t('login.setupTitle') : t('login.title')}
          </h2>

          {needsSetup ? (
            <p className="small muted" style={{ marginTop: 0 }}>
              {t('login.setupHint')}
            </p>
          ) : null}

          {shownError ? (
            <div className="alert alert-danger" role="alert" style={{ marginBottom: 'var(--space-3)' }}>
              {shownError}
            </div>
          ) : null}

          <div className="field">
            <label htmlFor="login-user">{t('login.username')}</label>
            <input
              id="login-user"
              className="input"
              autoComplete="username"
              value={user}
              onChange={(event) => setUser(event.target.value)}
              required
            />
          </div>

          <div className="field">
            <label htmlFor="login-password">{t('login.password')}</label>
            <input
              id="login-password"
              className="input"
              type="password"
              autoComplete={needsSetup ? 'new-password' : 'current-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={needsSetup ? 10 : undefined}
            />
          </div>

          {!needsSetup ? (
            <label className="checkbox" style={{ marginBottom: 'var(--space-4)' }}>
              <input
                type="checkbox"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
              />
              <span className="small">{t('login.remember')}</span>
            </label>
          ) : (
            <div style={{ marginBottom: 'var(--space-4)' }} />
          )}

          <button type="submit" className="btn btn-primary" disabled={busy} style={{ width: '100%' }}>
            {busy ? t('login.working') : needsSetup ? t('login.create') : t('login.submit')}
          </button>
        </form>
      </div>
    </div>
  )
}
