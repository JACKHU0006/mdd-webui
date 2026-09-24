/**
 * Country exits — the routing half of VoWiFi.
 *
 * Three things about this page are not negotiable, and each one comes from how the gateway
 * actually fails rather than from how it looks:
 *
 *  1. **UDP or it did not pass.** Every non-direct exit is verified over UDP, because IKEv2/ESP
 *     NAT traversal needs UDP 500/4500 reachable. A TCP probe passes nodes that can never carry
 *     a tunnel, so a node that fails UDP is shown as *failed* — never as "slow", and never with
 *     a latency number that would imply it is merely underperforming.
 *
 *  2. **The status is published by the host, not by this panel.** `GET /api/egress/status` reads
 *     a file the orchestrator writes. So `updated_at` age is load-bearing: if it is old the page
 *     must say the orchestrator stopped reconciling, because otherwise every exit silently
 *     freezes at whatever it last looked like and the operator debugs the wrong thing.
 *
 *  3. **A lock is a promise.** `selection: manual` and `mode: direct` mean the gateway will not
 *     move that exit, not even when it is failing. The UI has to say so in words, since the
 *     symptom (an exit that stays broken) looks identical to a bug.
 *
 * Editing lives here, but the stored form is `settings.proxy` — so this page saves through
 * `PUT /api/settings` with the whole `proxy` object, exactly like the Settings page does.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Badge,
  DangerButton,
  Disclosure,
  Empty,
  ErrorNote,
  Field,
  KeyValue,
  SkeletonRows,
  type Tone,
} from '../components/ui'
import { useI18n } from '../lib/i18n'
import { api } from '../lib/api'
import {
  ApiError,
  type EgressExit,
  type EgressStatus,
  type ProxyProfile,
  type ProxySettings,
  type Settings,
} from '../lib/types'

/**
 * Pull `{message, parsed}` out of an `ApiError` body.
 *
 * `POST /api/egress/profile/{id}/test` answers 503 with a structured detail rather than a bare
 * string — the parse summary rides along with the failure on purpose. A plain `message` body
 * (every other route) is handled too, so one helper covers both shapes.
 */
function failureDetail(error: unknown): { message: string; parsed?: Record<string, unknown> } {
  if (!(error instanceof ApiError)) return { message: String(error) }
  const body = error.body as { detail?: unknown; message?: unknown } | undefined
  const detail = body?.detail
  if (detail && typeof detail === 'object') {
    const record = detail as { message?: unknown; parsed?: unknown }
    return {
      message: record.message ? String(record.message) : error.message,
      parsed:
        record.parsed && typeof record.parsed === 'object'
          ? (record.parsed as Record<string, unknown>)
          : undefined,
    }
  }
  if (typeof detail === 'string' && detail) return { message: detail }
  if (typeof body?.message === 'string') return { message: body.message }
  return { message: error.message }
}

/* --------------------------------------------------------------- country names */

/**
 * Region names come from `Intl.DisplayNames` so the page carries no country table of its own.
 * The fallback is the raw code, which is what the API speaks anyway.
 */
function countryLabel(code: string, language: string): string {
  try {
    return (
      new Intl.DisplayNames([language === 'zh' ? 'zh-CN' : 'en'], { type: 'region' }).of(
        code.toUpperCase(),
      ) ?? code.toUpperCase()
    )
  } catch {
    return code.toUpperCase()
  }
}

const PROFILE_TYPES = ['subscription', 'node', 'socks5', 'existing'] as const
type ProfileType = (typeof PROFILE_TYPES)[number]

function toneForExit(exit: EgressExit | undefined): Tone {
  // Deliberately coarse on purpose. There is no "degraded" tone, because there is no degraded
  // state: an exit either carries UDP or it does not.
  if (!exit) return 'neutral'
  if (exit.mode === 'direct') return 'neutral'
  if (exit.error) return 'danger'
  return exit.ready ? 'ok' : 'warn'
}

/** An exit's mode decides whether it is testable at all — a subscription is a source, not a dial. */
function isDirectExit(exit: EgressExit | undefined): boolean {
  return exit?.mode === 'direct'
}

/* ------------------------------------------------------------------ proxy form */

function ProfileEditor({
  id,
  profile,
  usedBy,
  onChange,
  onRemove,
  onTest,
  test,
}: {
  id: string
  profile: ProxyProfile
  usedBy: string[]
  onChange: (patch: Partial<ProxyProfile>) => void
  onRemove: () => void
  onTest: () => void
  test: { busy: boolean; ok?: boolean; latency?: number; parsed?: Record<string, unknown>; error?: string }
}) {
  const { t } = useI18n()
  // Credentials are masked until asked for, so a shoulder-surfer or a screenshot does not leak
  // a subscription URL or a SOCKS password.
  const [reveal, setReveal] = useState(false)
  const secretType = reveal ? 'text' : 'password'
  const testable = profile.type === 'node' || profile.type === 'socks5'

  return (
    <div className="card">
      <div className="card-body stack" style={{ gap: 'var(--space-3)' }}>
        <div className="row wrap" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
          <Badge tone="neutral">{t(`egress.profileType.${profile.type}`)}</Badge>
          <input
            className="input"
            style={{ flex: '1 1 12rem' }}
            value={profile.name}
            aria-label={t('egress.profileName')}
            onChange={(event) => onChange({ name: event.target.value })}
          />
          <span className="xs faint">
            {usedBy.length
              ? t('egress.usedBy', { countries: usedBy.join(', ') })
              : t('egress.unused')}
          </span>
        </div>

        {profile.type === 'subscription' ? (
          <>
            <Field label={t('egress.subscriptionUrl')}>
              <input
                className="input mono"
                type={secretType}
                autoComplete="off"
                value={profile.url ?? ''}
                placeholder="https://…"
                onChange={(event) => onChange({ url: event.target.value })}
              />
            </Field>
            <Field label={t('egress.refreshMinutes')}>
              <input
                className="input"
                type="number"
                min={1}
                value={profile.refresh_minutes ?? 30}
                onChange={(event) => onChange({ refresh_minutes: Number(event.target.value) })}
              />
            </Field>
          </>
        ) : null}

        {profile.type === 'node' ? (
          <Field label={t('egress.nodeLink')} hint={t('egress.nodeLinkHint')}>
            <input
              className="input mono"
              type={secretType}
              autoComplete="off"
              value={profile.value ?? ''}
              placeholder="vless://…"
              onChange={(event) => onChange({ value: event.target.value })}
            />
          </Field>
        ) : null}

        {profile.type === 'socks5' ? (
          <>
            <div className="kv-grid">
              <Field label={t('egress.server')}>
                <input
                  className="input mono"
                  type={secretType}
                  autoComplete="off"
                  value={profile.server ?? ''}
                  onChange={(event) => onChange({ server: event.target.value })}
                />
              </Field>
              <Field label={t('egress.port')}>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={65535}
                  value={profile.port ?? 1080}
                  onChange={(event) => onChange({ port: Number(event.target.value) })}
                />
              </Field>
              <Field label={t('egress.username')}>
                <input
                  className="input"
                  type={secretType}
                  autoComplete="off"
                  value={profile.username ?? ''}
                  onChange={(event) => onChange({ username: event.target.value })}
                />
              </Field>
              <Field label={t('egress.password')}>
                <input
                  className="input"
                  type={secretType}
                  autoComplete="new-password"
                  value={profile.password ?? ''}
                  onChange={(event) => onChange({ password: event.target.value })}
                />
              </Field>
            </div>
          </>
        ) : null}

        {profile.type === 'existing' ? (
          <Field label={t('egress.outboundTag')}>
            <input
              className="input mono"
              value={profile.outbound_tag ?? ''}
              onChange={(event) => onChange({ outbound_tag: event.target.value })}
            />
          </Field>
        ) : null}

        <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
          <button type="button" className="btn btn-sm" onClick={() => setReveal(!reveal)}>
            {reveal ? t('egress.hideSecrets') : t('egress.showSecrets')}
          </button>
          {testable ? (
            <button type="button" className="btn btn-sm" disabled={test.busy} onClick={onTest}>
              {test.busy ? t('egress.testing') : t('egress.testProfile')}
            </button>
          ) : null}
          <DangerButton
            label={t('action.remove')}
            confirmLabel={t('common.confirmRemove')}
            onConfirm={onRemove}
          />
        </div>

        {/* The verdict and the parsed link are separate lines: the parse summary is what tells an
            operator whether the gateway read their link the way their other client did, and it
            gets truncated to nothing if it shares a row with the verdict. */}
        {testable && !test.busy && test.ok !== undefined ? (
          <div className={`note note-${test.ok ? 'ok' : 'danger'}`}>
            <div>
              {test.ok
                ? t('egress.udpOk', { latency: test.latency ?? 0 })
                : t('egress.udpFailed')}
            </div>
            {test.parsed ? (
              <div className="mono xs" style={{ marginTop: 4 }}>
                {t('egress.parsedAs')}: {JSON.stringify(test.parsed)}
              </div>
            ) : null}
            {!test.ok && test.error ? (
              <div className="xs" style={{ marginTop: 4 }}>
                {test.error}
              </div>
            ) : null}
          </div>
        ) : null}
        <span className="xs faint">{t('egress.profileIdHint', { id })}</span>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------------- view */

export function Egress() {
  const { t, language } = useI18n()
  const [status, setStatus] = useState<EgressStatus | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const [profileTests, setProfileTests] = useState<
    Record<string, { busy: boolean; ok?: boolean; latency?: number; parsed?: Record<string, unknown>; error?: string }>
  >({})
  const [exitTests, setExitTests] = useState<Record<string, { busy: boolean; ok?: boolean; latency?: number; error?: string }>>({})
  const [refreshing, setRefreshing] = useState(false)
  const [newCountry, setNewCountry] = useState('')

  // The last state the server confirmed. Comparing against it is what makes the Save button
  // honest — the exit test buttons consult it too, since they test the *running* exit.
  const [baseline, setBaseline] = useState<string | null>(null)

  const proxy: ProxySettings = useMemo(
    () => settings?.proxy ?? { profiles: {}, exits: {} },
    [settings],
  )
  const profiles = proxy.profiles ?? {}
  const exits = proxy.exits ?? {}

  const dirty = baseline !== null && settings !== null && JSON.stringify(proxy) !== baseline

  const load = useCallback(async () => {
    try {
      const [liveStatus, liveSettings] = await Promise.all([api.egress.status(), api.settings.get()])
      setStatus(liveStatus)
      setSettings(liveSettings)
      setBaseline(JSON.stringify(liveSettings.proxy ?? {}))
      setLoadError(null)
    } catch (failure) {
      setLoadError(failureDetail(failure).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const patchProxy = (patch: Partial<ProxySettings>) => {
    setSaved(false)
    setSettings((current) =>
      current ? { ...current, proxy: { ...(current.proxy ?? {}), ...patch } } : current,
    )
  }

  const patchProfile = (id: string, patch: Partial<ProxyProfile>) => {
    const next = { ...profiles, [id]: { ...profiles[id], ...patch } as ProxyProfile }
    patchProxy({ profiles: next })
  }

  const removeProfile = (id: string) => {
    const next = { ...profiles }
    delete next[id]
    // An exit pointing at a profile that no longer exists would silently become unroutable, so
    // the assignment is cleared with it rather than left dangling.
    const nextExits = { ...exits }
    for (const [country, exit] of Object.entries(nextExits)) {
      if ((exit as EgressExit & { profile_id?: string }).profile_id === id) {
        nextExits[country] = { ...exit, profile_id: '', mode: 'direct' }
      }
    }
    patchProxy({ profiles: next, exits: nextExits })
  }

  const addProfile = (type: ProfileType) => {
    const id = `proxy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const name =
      type === 'subscription'
        ? t('egress.newSubscription')
        : type === 'node'
          ? t('egress.newNode')
          : type === 'socks5'
            ? t('egress.newSocks')
            : t('egress.newExisting')
    patchProfile(id, { name, type } as Partial<ProxyProfile>)
  }

  const patchExit = (country: string, patch: Partial<EgressExit>) => {
    patchProxy({ exits: { ...exits, [country]: { ...exits[country], ...patch } } })
  }

  const removeExit = (country: string) => {
    const next = { ...exits }
    delete next[country]
    patchProxy({ exits: next })
  }

  const save = async () => {
    if (!settings) return
    setSaving(true)
    setSaveError(null)
    try {
      // The whole `proxy` object goes up: nested objects are replaced wholesale, so a partial
      // send would drop every profile and exit not included in it.
      const stored = await api.settings.save({ proxy })
      setSettings(stored)
      setBaseline(JSON.stringify(stored.proxy ?? {}))
      setSaved(true)
      // Re-resolve subscriptions against the new config before reading status back, otherwise
      // the exits shown are the ones the orchestrator resolved from the previous settings.
      await api.egress.refresh()
      await load()
    } catch (failure) {
      setSaveError(failureDetail(failure).message)
    } finally {
      setSaving(false)
    }
  }

  const refresh = async () => {
    setRefreshing(true)
    try {
      await api.egress.refresh()
      // The orchestrator republishes asynchronously; give it a beat so the age field moves.
      await new Promise((resolve) => setTimeout(resolve, 800))
      await load()
    } catch (failure) {
      setSaveError(failureDetail(failure).message)
    } finally {
      setRefreshing(false)
    }
  }

  const testProfile = async (id: string) => {
    const profile = profiles[id]
    setProfileTests((current) => ({ ...current, [id]: { ...current[id], busy: true } }))
    try {
      // The unsaved draft is sent so an operator can verify a freshly pasted link before
      // committing it — that is the only moment the test is actually useful.
      const result = await api.egress.testProfile(id, profile as unknown as Record<string, unknown>)
      setProfileTests((current) => ({
        ...current,
        [id]: { busy: false, ok: true, latency: result.latency_ms, parsed: result.parsed },
      }))
    } catch (failure) {
      // `503 {"message", "parsed"}` — the parse summary explains *why* the link failed to dial.
      const { message, parsed } = failureDetail(failure)
      setProfileTests((current) => ({ ...current, [id]: { busy: false, ok: false, error: message, parsed } }))
    }
  }

  const testExit = async (country: string) => {
    setExitTests((current) => ({ ...current, [country]: { busy: true } }))
    try {
      const result = await api.egress.testCountry(country)
      setExitTests((current) => ({
        ...current,
        [country]: { busy: false, ok: true, latency: result.latency_ms },
      }))
    } catch (failure) {
      setExitTests((current) => ({
        ...current,
        [country]: {
          busy: false,
          ok: false,
          error: failureDetail(failure).message,
        },
      }))
    }
  }

  /* ---- orchestrator freshness ------------------------------------------------ */

  const exitsEntries = useMemo(
    () =>
      Object.entries(exits).sort(([a], [b]) =>
        countryLabel(a, language).localeCompare(countryLabel(b, language)),
      ),
    [exits, language],
  )

  const profileCountryMap = useMemo(() => {
    const map: Record<string, string[]> = {}
    for (const [country, exit] of Object.entries(exits)) {
      const id = (exit as EgressExit & { profile_id?: string }).profile_id
      if (!id) continue
      map[id] = [...(map[id] ?? []), country.toUpperCase()]
    }
    return map
  }, [exits])

  const updatedAge = status?.updated_at
    ? Math.max(0, Math.floor(Date.now() / 1000 - status.updated_at))
    : null

  if (loading) {
    return (
      <div className="card">
        <div className="card-body">
          <SkeletonRows rows={4} />
        </div>
      </div>
    )
  }

  return (
    <div className="stack" style={{ gap: 'var(--space-4)' }}>
      <div>
        <h1 style={{ marginBottom: 4 }}>{t('egress.title')}</h1>
        <p className="muted small" style={{ margin: 0 }}>
          {t('egress.hint')}
        </p>
      </div>

      {loadError ? <ErrorNote>{loadError}</ErrorNote> : null}

      {/* The master switch lives in Settings; without this note a page full of exits that all
          read "not ready" looks like a broken node pool rather than a switched-off feature. */}
      {status && status.enabled === false ? (
        <div className="note note-warn">{t('egress.masterOff')}</div>
      ) : null}

      {updatedAge === null ? (
        <div className="note note-warn">{t('egress.noOrchestrator')}</div>
      ) : updatedAge > 60 ? (
        <div className="note note-warn">{t('egress.stale', { seconds: updatedAge })}</div>
      ) : null}

      <div className="card">
        <div className="card-body row wrap" style={{ gap: 'var(--space-3)', alignItems: 'center' }}>
          <Badge tone={status?.enabled ? 'ok' : 'neutral'}>
            {status?.enabled ? t('egress.routingOn') : t('egress.routingOff')}
          </Badge>
          <span className="xs faint">
            {updatedAge === null
              ? t('egress.neverPublished')
              : t('egress.publishedAgo', { seconds: updatedAge })}
          </span>
          <div className="row" style={{ gap: 'var(--space-2)', marginLeft: 'auto' }}>
            <button type="button" className="btn btn-sm" disabled={refreshing} onClick={() => void refresh()}>
              {refreshing ? `${t('egress.refresh')}…` : t('egress.refresh')}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!dirty || saving}
              title={!dirty ? t('egress.noChanges') : undefined}
              onClick={() => void save()}
            >
              {saving ? `${t('action.save')}…` : t('action.save')}
            </button>
          </div>
        </div>
        <div className="card-body" style={{ paddingTop: 0 }}>
          <span className="xs faint">{t('egress.refreshHint')}</span>
        </div>
      </div>

      {saveError ? <ErrorNote>{saveError}</ErrorNote> : null}
      {saved && !dirty ? <div className="note note-ok">{t('egress.saved')}</div> : null}

      {/* ---- proxy library ------------------------------------------------------ */}

      <Disclosure summary={t('egress.profiles')} open>
        <p className="xs faint" style={{ margin: 0 }}>
          {t('egress.profilesHint')}
        </p>
        <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
          {PROFILE_TYPES.map((type) => (
            <button key={type} type="button" className="btn btn-sm" onClick={() => addProfile(type)}>
              + {t(`egress.profileType.${type}`)}
            </button>
          ))}
        </div>
        {Object.keys(profiles).length === 0 ? (
          <Empty>{t('egress.noProfiles')}</Empty>
        ) : (
          <div className="stack" style={{ gap: 'var(--space-3)' }}>
            {Object.entries(profiles).map(([id, profile]) => (
              <ProfileEditor
                key={id}
                id={id}
                profile={profile}
                usedBy={profileCountryMap[id] ?? []}
                test={profileTests[id] ?? { busy: false }}
                onChange={(patch) => patchProfile(id, patch)}
                onRemove={() => removeProfile(id)}
                onTest={() => void testProfile(id)}
              />
            ))}
          </div>
        )}
      </Disclosure>

      {/* ---- country exits ------------------------------------------------------ */}

      <Disclosure summary={t('egress.exits')} open>
        <div className="row wrap" style={{ gap: 'var(--space-2)', alignItems: 'flex-end' }}>
          <Field label={t('egress.addExit')}>
            <input
              className="input mono"
              style={{ width: '8rem' }}
              value={newCountry}
              placeholder="jp"
              maxLength={2}
              onChange={(event) => setNewCountry(event.target.value.trim().toLowerCase())}
            />
          </Field>
          <button
            type="button"
            className="btn btn-sm"
            disabled={newCountry.length !== 2 || Boolean(exits[newCountry])}
            onClick={() => {
              patchExit(newCountry, { enabled: true, mode: 'direct', profile_id: '' } as Partial<EgressExit>)
              setNewCountry('')
            }}
          >
            + {t('action.add')}
          </button>
        </div>

        {exitsEntries.length === 0 ? (
          <Empty>{t('egress.noExits')}</Empty>
        ) : (
          <div className="stack" style={{ gap: 'var(--space-3)' }}>
            {exitsEntries.map(([country, exit]) => {
              const live = status?.exits?.[country]
              const direct = isDirectExit(live) || exit.mode === 'direct'
              const lines = Object.entries(status?.lines ?? {}).filter(
                ([, line]) => line.node && line.node === live?.node,
              )
              const test = exitTests[country] ?? { busy: false }
              const selectedProfile = profiles[
                (exit as EgressExit & { profile_id?: string }).profile_id ?? ''
              ]
              return (
                <div className="card" key={country}>
                  <div className="card-body stack" style={{ gap: 'var(--space-3)' }}>
                    <div className="row wrap" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
                      <strong>{countryLabel(country, language)}</strong>
                      <Badge tone={toneForExit(live)}>
                        {direct
                          ? t('egress.direct')
                          : live?.error
                            ? t('egress.notReady')
                            : live?.ready
                              ? t('egress.ready')
                              : t('egress.notReady')}
                      </Badge>
                      <label className="checkbox">
                        <input
                          type="checkbox"
                          checked={exit.enabled !== false}
                          onChange={(event) => patchExit(country, { enabled: event.target.checked })}
                        />
                        <span className="small">{t('egress.enabled')}</span>
                      </label>
                      <DangerButton
                        label={t('action.remove')}
                        confirmLabel={t('common.confirmRemove')}
                        onConfirm={() => removeExit(country)}
                      />
                    </div>

                    <div className="kv-grid">
                      <KeyValue label={t('egress.node')}>{live?.node || '—'}</KeyValue>
                      <KeyValue label={t('egress.mode')}>{live?.mode || exit.mode || '—'}</KeyValue>
                      <KeyValue label={t('egress.pin')}>
                        {live?.pinned_node
                          ? live.pinned_node === live.node
                            ? t('egress.pinActive', { node: live.pinned_node })
                            : t('egress.pinInactive', { node: live.pinned_node })
                          : t('egress.pinAuto')}
                      </KeyValue>
                      <KeyValue label={t('egress.lines')}>
                        {lines.length ? lines.map(([id]) => id).join(', ') : '—'}
                      </KeyValue>
                    </div>

                    {/* Pinning only means something for a subscription: a single node link has
                        exactly one node to be pinned to, and a direct exit has none. */}
                    {!direct && selectedProfile?.type === 'subscription' ? (
                      <>
                        <Field label={t('egress.pinNode')} hint={t('egress.pinNodeHint')}>
                          <select
                            className="input"
                            value={exit.pinned_node ?? ''}
                            onChange={(event) =>
                              patchExit(country, {
                                pinned_node: event.target.value,
                              } as Partial<EgressExit>)
                            }
                          >
                            {/* The pinned name is kept even when live status is missing, so
                                opening this page before the host answers cannot drop it. */}
                            <option value="">
                              {live?.node
                                ? t('egress.pinAutoLive', { node: live.node })
                                : t('egress.pinAuto')}
                            </option>
                            {Array.from(
                              new Set([
                                ...(live?.candidates ?? []),
                                ...(exit.pinned_node ? [String(exit.pinned_node)] : []),
                              ]),
                            ).map((name) => (
                              <option key={name} value={name}>
                                {name}
                              </option>
                            ))}
                          </select>
                        </Field>
                        {exit.pinned_node ? (
                          <>
                            <Field label={t('egress.pinMode')} hint={t('egress.pinModeHint')}>
                              <select
                                className="input"
                                value={exit.pin_mode ?? 'lock'}
                                onChange={(event) =>
                                  patchExit(country, {
                                    pin_mode: event.target.value,
                                  } as Partial<EgressExit>)
                                }
                              >
                                <option value="lock">{t('egress.pinModeLock')}</option>
                                <option value="prefer">{t('egress.pinModePrefer')}</option>
                              </select>
                            </Field>
                            <p className="xs faint" style={{ margin: 0 }}>
                              {(exit.pin_mode ?? 'lock') === 'lock'
                                ? t('egress.pinModeLockNote')
                                : t('egress.pinModePreferNote')}
                            </p>
                          </>
                        ) : null}
                      </>
                    ) : null}

                    {/* A lock the gateway will honour even when the exit is broken. Said in
                        words, because the symptom — an exit that stays down — looks like a bug. */}
                    {live?.selection === 'manual' ? (
                      <div className="note note-warn">{t('egress.locked')}</div>
                    ) : null}
                    {direct ? <div className="note">{t('egress.directNote')}</div> : null}

                    {live?.error ? <ErrorNote>{live.error}</ErrorNote> : null}
                    {live?.pinned_missing ? (
                      <div className="note note-warn">{t('egress.pinnedMissing')}</div>
                    ) : null}

                    <div className="row wrap" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={direct || test.busy || dirty}
                        title={dirty ? t('egress.saveFirst') : undefined}
                        onClick={() => void testExit(country)}
                      >
                        {test.busy ? t('egress.testing') : t('egress.testUdp')}
                      </button>
                      <span className="xs faint">{t('egress.whatUdp')}</span>
                      {dirty && !direct ? <span className="xs warn">{t('egress.saveFirst')}</span> : null}
                    </div>

                    {!test.busy && test.ok !== undefined ? (
                      <div className={`note note-${test.ok ? 'ok' : 'danger'}`}>
                        {test.ok
                          ? t('egress.udpOk', { latency: test.latency ?? 0 })
                          : t('egress.udpFailed')}
                        {!test.ok && test.error ? (
                          <div className="xs" style={{ marginTop: 4 }}>
                            {test.error}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Disclosure>

      <p className="xs faint" style={{ margin: 0 }}>
        {t('egress.udpNote')}
      </p>
    </div>
  )
}
