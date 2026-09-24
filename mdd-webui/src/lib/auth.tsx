/**
 * Session state for the console.
 *
 * The bootstrap sequence matters and is easy to get wrong:
 *
 *   1. `GET /api/auth/status` — tells us whether an administrator exists yet (`setup`
 *      needed) and, if a session cookie is still alive, hands back its CSRF token.
 *   2. Only after that do we know whether to render the setup screen, the login screen,
 *      or the console.
 *
 * Step 1 is also how a page reload recovers the CSRF token: the token lives in the
 * session record on the server, so the status endpoint can always re-issue it for a
 * valid cookie without forcing a fresh login.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, clearCsrfToken, setCsrfToken } from './api.ts'
import { ApiError } from './types.ts'

export type AuthPhase = 'booting' | 'needs-setup' | 'anonymous' | 'authenticated'

interface AuthValue {
  phase: AuthPhase
  username: string
  error: string | null
  busy: boolean
  login: (username: string, password: string, remember: boolean) => Promise<boolean>
  setup: (username: string, password: string) => Promise<boolean>
  logout: () => Promise<void>
  /**
   * Changing the password invalidates every session server-side, so this signs the
   * console out rather than leaving a cookie the gateway would already reject.
   */
  changePassword: (current: string, next: string) => Promise<boolean>
  /** Called when any request comes back 401 so the UI returns to the login screen. */
  invalidate: () => void
  clearError: () => void
}

const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<AuthPhase>('booting')
  const [username, setUsername] = useState('admin')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const bootstrap = useCallback(async () => {
    try {
      const status = await api.auth.status()
      // `configured` is authoritative and public, so the setup screen is chosen from it
      // rather than by probing the login endpoint. A probe would burn one of the five
      // failed attempts that trigger the control plane's 60-second lockout.
      if (status.username) setUsername(status.username)
      if (status.authenticated) {
        setCsrfToken(status.csrf)
        setPhase('authenticated')
      } else {
        clearCsrfToken()
        setPhase(status.configured ? 'anonymous' : 'needs-setup')
      }
    } catch {
      // The control plane may be mid-restart. Stay on the login screen rather than
      // showing a fatal error — the user can retry by signing in.
      setPhase('anonymous')
    }
  }, [])

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  const login = useCallback(async (user: string, password: string, remember: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.auth.login({ username: user, password, remember })
      setCsrfToken(result.csrf)
      setUsername(user)
      setPhase('authenticated')
      return true
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : String(failure))
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  const setup = useCallback(async (user: string, password: string) => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.auth.setup({ username: user, password })
      setCsrfToken(result.csrf)
      setUsername(user)
      setPhase('authenticated')
      return true
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : String(failure))
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  const logout = useCallback(async () => {
    try {
      await api.auth.logout()
    } catch {
      /* the cookie is being dropped either way */
    }
    clearCsrfToken()
    setPhase('anonymous')
  }, [])

  const changePassword = useCallback(async (current: string, next: string) => {
    setBusy(true)
    setError(null)
    try {
      await api.auth.changePassword(current, next)
      // The server cleared every session and deleted the cookie; mirror that here so the
      // console does not sit on a credential the gateway has already rejected.
      clearCsrfToken()
      setPhase('anonymous')
      return true
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : String(failure))
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  const invalidate = useCallback(() => {
    clearCsrfToken()
    setPhase('anonymous')
    setError('session-expired')
  }, [])

  const clearError = useCallback(() => setError(null), [])

  const value = useMemo<AuthValue>(
    () => ({
      phase,
      username,
      error,
      busy,
      login,
      setup,
      logout,
      changePassword,
      invalidate,
      clearError,
    }),
    [phase, username, error, busy, login, setup, logout, changePassword, invalidate, clearError],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>')
  return value
}
