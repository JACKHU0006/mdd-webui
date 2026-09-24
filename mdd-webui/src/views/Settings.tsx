/**
 * Settings.
 *
 * The save strategy is the whole design of this screen, and it comes straight from
 * `config.update_settings()`: `PUT /api/settings` is a shallow top-level `update()`, so
 * sending only the keys that changed leaves the rest of the document alone. That is why
 * this view keeps an editable draft beside the server's document and diffs the two,
 * instead of round-tripping the whole thing and hoping every field survives validation.
 *
 * Three consequences the code has to respect:
 *
 *  - A nested object is replaced wholesale, so a dirty section is sent as
 *    `{...storedSection, ...editedFields}`. Keys this form does not render are preserved
 *    rather than silently dropped by a UI that only knows part of the schema.
 *  - Nothing is written optimistically. `PUT` answers with the stored document, and the
 *    draft re-baselines against that response — so what the operator sees afterwards is
 *    what the gateway actually kept, not what the form hoped it kept.
 *  - An invalid field blocks the save client-side with the same rules the control plane
 *    enforces, because a rejected `PUT` costs a round trip and the 400 detail is less
 *    specific than the field that caused it.
 *
 * Hardware is the section that matters most on a DJI install: the host orchestrator
 * matches USB `(vid, pid)` against `hardware.modem_profiles` before it will acknowledge a
 * modem at all, so a dongle that is plugged in but unlisted does not exist as far as the
 * gateway is concerned.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../lib/api.ts'
import { useAuth } from '../lib/auth.tsx'
import { useI18n } from '../lib/i18n.tsx'
import { useGateway } from '../lib/store.tsx'
import { ApiError } from '../lib/types.ts'
import type {
  DeviceDefaults,
  HardwareSettings,
  ModemProfile,
  SecuritySettings,
  Settings as SettingsDoc,
  SettingsPatch,
} from '../lib/types.ts'
import { Badge, SkeletonRows } from '../components/ui.tsx'

/* ------------------------------------------------------------------- draft */

type Backend = 'auto' | 'serial'

interface Draft {
  timezone: string
  device_defaults: { cellular_enabled: boolean; vowifi_enabled: boolean; flight_mode: boolean }
  hardware: {
    auto_detect: boolean
    modem_backend: Backend
    vpcd_slots: number
    modem_profiles: ModemProfile[]
  }
  rekey: { minutes: number; ike_minutes: number }
  retry: { max: number; interval: number }
  debug: { asterisk: boolean; charon: boolean; pcap: boolean; ami: boolean }
  /** `trusted_proxies` is edited as newline-separated text, sent as a list. */
  security: { https_only: boolean; audit_enabled: boolean; trusted_proxies: string }
  maintenance: { notification_history_days: number; support_bundle_log_lines: number }
  esim: { lpac_bin: string; download_timeout: number; auto_process_notifications: boolean }
  ring_timeout: number
  vm_enabled: boolean
  vm_ring_seconds: number
  vm_max_seconds: number
}

/** Sections sent as a whole object; every other edited key is a scalar. */
const SECTION_KEYS = [
  'device_defaults',
  'hardware',
  'rekey',
  'retry',
  'debug',
  'security',
  'maintenance',
  'esim',
] as const
type SectionKey = (typeof SECTION_KEYS)[number]

const SCALAR_KEYS = [
  'timezone',
  'ring_timeout',
  'vm_enabled',
  'vm_ring_seconds',
  'vm_max_seconds',
] as const
type ScalarKey = (typeof SCALAR_KEYS)[number]

type EditedKey = SectionKey | ScalarKey

const DJI_DONGLE: ModemProfile = {
  name: 'DJI Cellular Dongle',
  vid: '2ca3',
  pid: '4006',
  at_interface: 2,
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asProfiles(value: unknown): ModemProfile[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => ({
      name: asText(item.name),
      vid: asText(item.vid).toLowerCase(),
      pid: asText(item.pid).toLowerCase(),
      at_interface: asNumber(item.at_interface, 2),
    }))
}

/**
 * Fill a draft from a stored document. Defaults mirror `control/app/config.py::DEFAULTS`
 * so a form the operator never touched diffs clean against the server.
 */
function toDraft(settings: SettingsDoc): Draft {
  const hardware = (settings.hardware ?? {}) as HardwareSettings
  const security = (settings.security ?? {}) as SecuritySettings
  const defaults = (settings.device_defaults ?? {}) as DeviceDefaults
  const trusted = Array.isArray(security.trusted_proxies) ? security.trusted_proxies : []

  return {
    timezone: asText(settings.timezone, 'UTC'),
    device_defaults: {
      cellular_enabled: asBool(defaults.cellular_enabled, false),
      vowifi_enabled: asBool(defaults.vowifi_enabled, true),
      flight_mode: asBool(defaults.flight_mode, false),
    },
    hardware: {
      auto_detect: asBool(hardware.auto_detect, true),
      modem_backend: hardware.modem_backend === 'serial' ? 'serial' : 'auto',
      vpcd_slots: asNumber(hardware.vpcd_slots, 3),
      modem_profiles: asProfiles(hardware.modem_profiles),
    },
    rekey: {
      minutes: asNumber(settings.rekey?.minutes, 30),
      ike_minutes: asNumber(settings.rekey?.ike_minutes, 150),
    },
    retry: {
      max: asNumber(settings.retry?.max, 3),
      interval: asNumber(settings.retry?.interval, 30),
    },
    debug: {
      asterisk: asBool(settings.debug?.asterisk, false),
      charon: asBool(settings.debug?.charon, false),
      pcap: asBool(settings.debug?.pcap, false),
      ami: asBool(settings.debug?.ami, false),
    },
    security: {
      https_only: asBool(security.https_only, true),
      audit_enabled: asBool(security.audit_enabled, true),
      trusted_proxies: trusted.map((value) => String(value)).join('\n'),
    },
    maintenance: {
      notification_history_days: asNumber(settings.maintenance?.notification_history_days, 30),
      support_bundle_log_lines: asNumber(settings.maintenance?.support_bundle_log_lines, 500),
    },
    esim: {
      lpac_bin: asText(settings.esim?.lpac_bin),
      download_timeout: asNumber(settings.esim?.download_timeout, 300),
      auto_process_notifications: asBool(settings.esim?.auto_process_notifications, true),
    },
    ring_timeout: asNumber(settings.ring_timeout, 35),
    vm_enabled: asBool(settings.vm_enabled, false),
    vm_ring_seconds: asNumber(settings.vm_ring_seconds, 25),
    vm_max_seconds: asNumber(settings.vm_max_seconds, 120),
  }
}

/** The wire form of one section — what gets diffed and what gets sent. */
function serializeSection(draft: Draft, key: SectionKey): Record<string, unknown> {
  if (key === 'security') {
    return {
      https_only: draft.security.https_only,
      audit_enabled: draft.security.audit_enabled,
      trusted_proxies: draft.security.trusted_proxies
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    }
  }
  return { ...(draft[key] as unknown as Record<string, unknown>) }
}

function diffKeys(draft: Draft, baseline: Draft): EditedKey[] {
  const keys: EditedKey[] = []
  for (const key of SECTION_KEYS) {
    if (JSON.stringify(serializeSection(draft, key)) !== JSON.stringify(serializeSection(baseline, key))) {
      keys.push(key)
    }
  }
  for (const key of SCALAR_KEYS) {
    if (draft[key] !== baseline[key]) keys.push(key)
  }
  return keys
}

function buildPatch(keys: EditedKey[], draft: Draft, server: SettingsDoc): SettingsPatch {
  const patch: Record<string, unknown> = {}
  for (const key of keys) {
    if ((SECTION_KEYS as readonly string[]).includes(key)) {
      const section = key as SectionKey
      // Preserve keys this form does not render: a nested object is replaced wholesale.
      const stored = (server[section] ?? {}) as Record<string, unknown>
      patch[section] = { ...stored, ...serializeSection(draft, section) }
    } else {
      patch[key] = draft[key as ScalarKey]
    }
  }
  return patch as SettingsPatch
}

/* ------------------------------------------------------------------ pieces */

function Section({
  title,
  hint,
  dirty,
  children,
}: {
  title: string
  hint?: string
  dirty?: boolean
  children: ReactNode
}) {
  const { t } = useI18n()
  return (
    <section className="card">
      <div className="card-head">
        <div className="row" style={{ gap: 'var(--space-2)', minWidth: 0 }}>
          <strong style={{ fontWeight: 500 }}>{title}</strong>
          {dirty ? <Badge tone="warn">{t('settings.edited')}</Badge> : null}
        </div>
      </div>
      <div className="card-body stack">
        {hint ? (
          <p className="small muted" style={{ margin: 0 }}>
            {hint}
          </p>
        ) : null}
        {children}
      </div>
    </section>
  )
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string
  children: ReactNode
}) {
  return (
    <div className="field" style={{ marginBottom: 0 }}>
      <label>{label}</label>
      {children}
      {error ? (
        <span className="xs" style={{ color: 'var(--danger)' }}>
          {error}
        </span>
      ) : hint ? (
        <span className="xs faint">{hint}</span>
      ) : null}
    </div>
  )
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <div className="stack" style={{ gap: 2 }}>
      <label className="checkbox">
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        <span>{label}</span>
      </label>
      {hint ? <span className="xs faint">{hint}</span> : null}
    </div>
  )
}

function NumberInput({
  value,
  onChange,
  min,
  max,
  invalid,
}: {
  value: number
  onChange: (next: number) => void
  min: number
  max: number
  invalid?: boolean
}) {
  return (
    <input
      className="input"
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={Number.isFinite(value) ? String(value) : ''}
      aria-invalid={invalid ? true : undefined}
      style={invalid ? { borderColor: 'var(--danger)' } : undefined}
      onChange={(event) => {
        const raw = event.target.value
        onChange(raw === '' ? Number.NaN : Number(raw))
      }}
    />
  )
}

const PROFILE_GRID = 'minmax(150px, 2fr) 84px 84px 84px auto'

function ModemProfiles({
  profiles,
  errors,
  onChange,
}: {
  profiles: ModemProfile[]
  errors: Record<string, string>
  onChange: (next: ModemProfile[]) => void
}) {
  const { t } = useI18n()

  const patch = (index: number, changes: Partial<ModemProfile>) => {
    onChange(profiles.map((profile, at) => (at === index ? { ...profile, ...changes } : profile)))
  }

  const alreadyListed = profiles.some(
    (profile) => profile.vid.toLowerCase() === DJI_DONGLE.vid && profile.pid.toLowerCase() === DJI_DONGLE.pid,
  )

  return (
    <div className="stack" style={{ gap: 'var(--space-3)' }}>
      <div style={{ overflowX: 'auto' }}>
        <div className="stack" style={{ gap: 'var(--space-2)', minWidth: 520 }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: PROFILE_GRID,
              gap: 'var(--space-2)',
              alignItems: 'center',
            }}
          >
            <span className="xs faint">{t('settings.hardware.colName')}</span>
            <span className="xs faint">{t('settings.hardware.colVid')}</span>
            <span className="xs faint">{t('settings.hardware.colPid')}</span>
            <span className="xs faint">{t('settings.hardware.colAt')}</span>
            <span />
          </div>

          {profiles.length === 0 ? (
            <div className="alert alert-warn">{t('settings.hardware.noProfiles')}</div>
          ) : null}

          {profiles.map((profile, index) => {
            const at = `hardware.profile.${index}`
            return (
              <div key={index} className="stack" style={{ gap: 2 }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: PROFILE_GRID,
                    gap: 'var(--space-2)',
                    alignItems: 'center',
                  }}
                >
                  <input
                    className="input"
                    value={profile.name}
                    placeholder={t('settings.hardware.namePlaceholder')}
                    aria-invalid={errors[`${at}.name`] ? true : undefined}
                    style={errors[`${at}.name`] ? { borderColor: 'var(--danger)' } : undefined}
                    onChange={(event) => patch(index, { name: event.target.value })}
                  />
                  <input
                    className="input mono"
                    value={profile.vid}
                    maxLength={4}
                    aria-invalid={errors[`${at}.vid`] ? true : undefined}
                    style={errors[`${at}.vid`] ? { borderColor: 'var(--danger)' } : undefined}
                    onChange={(event) => patch(index, { vid: event.target.value.toLowerCase() })}
                  />
                  <input
                    className="input mono"
                    value={profile.pid}
                    maxLength={4}
                    aria-invalid={errors[`${at}.pid`] ? true : undefined}
                    style={errors[`${at}.pid`] ? { borderColor: 'var(--danger)' } : undefined}
                    onChange={(event) => patch(index, { pid: event.target.value.toLowerCase() })}
                  />
                  <NumberInput
                    value={profile.at_interface ?? 2}
                    min={0}
                    max={15}
                    invalid={!!errors[`${at}.at_interface`]}
                    onChange={(next) => patch(index, { at_interface: next })}
                  />
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => onChange(profiles.filter((_, at2) => at2 !== index))}
                  >
                    {t('action.delete')}
                  </button>
                </div>
                {errors[`${at}.name`] ||
                errors[`${at}.vid`] ||
                errors[`${at}.pid`] ||
                errors[`${at}.at_interface`] ||
                errors[`${at}.duplicate`] ? (
                  <div className="xs" style={{ color: 'var(--danger)' }}>
                    {errors[`${at}.name`] ??
                      errors[`${at}.vid`] ??
                      errors[`${at}.pid`] ??
                      errors[`${at}.at_interface`] ??
                      errors[`${at}.duplicate`]}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>

      <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => onChange([...profiles, { name: '', vid: '', pid: '', at_interface: 2 }])}
        >
          {t('settings.hardware.addProfile')}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={alreadyListed}
          onClick={() => onChange([...profiles, { ...DJI_DONGLE }])}
        >
          {t('settings.hardware.presetDji')}
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------- admin */

function AdministratorTab() {
  const { t } = useI18n()
  const { changePassword, busy, error, clearError } = useAuth()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [local, setLocal] = useState<string | null>(null)

  const submit = async () => {
    clearError()
    setLocal(null)
    if (next.length < 10) {
      setLocal(t('login.passwordTooShort'))
      return
    }
    if (next !== repeat) {
      setLocal(t('settings.admin.mismatch'))
      return
    }
    // On success the provider drops every session, so the console returns to the login
    // screen; there is nothing left here to render a confirmation into.
    await changePassword(current, next)
  }

  return (
    <Section title={t('settings.admin.title')} hint={t('settings.admin.hint')}>
      <div style={{ maxWidth: 420 }} className="stack">
        <Field label={t('settings.admin.current')}>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
        </Field>
        <Field label={t('settings.admin.new')}>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
        </Field>
        <Field label={t('settings.admin.confirm')}>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={repeat}
            onChange={(event) => setRepeat(event.target.value)}
          />
        </Field>

        {local ? <div className="alert alert-danger">{local}</div> : null}
        {error && error !== 'session-expired' ? <div className="alert alert-danger">{error}</div> : null}

        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !current || !next}
            onClick={() => void submit()}
          >
            {t('settings.admin.submit')}
          </button>
        </div>
      </div>
    </Section>
  )
}

/* ------------------------------------------------------------------ screen */

const TABS = [
  { key: 'hardware', labelKey: 'settings.tabs.hardware' },
  { key: 'devices', labelKey: 'settings.tabs.devices' },
  { key: 'vowifi', labelKey: 'settings.tabs.vowifi' },
  { key: 'host', labelKey: 'settings.tabs.host' },
  { key: 'esim', labelKey: 'settings.tabs.esim' },
  { key: 'admin', labelKey: 'settings.tabs.admin' },
] as const

type TabKey = (typeof TABS)[number]['key']

/** Which tab owns each edited key, so the tab bar can mark the ones with pending edits. */
const KEY_TAB: Record<EditedKey, TabKey> = {
  hardware: 'hardware',
  device_defaults: 'devices',
  rekey: 'vowifi',
  ring_timeout: 'vowifi',
  vm_enabled: 'vowifi',
  vm_ring_seconds: 'vowifi',
  vm_max_seconds: 'vowifi',
  timezone: 'host',
  retry: 'host',
  debug: 'host',
  security: 'host',
  maintenance: 'host',
  esim: 'esim',
}

export function Settings({ onNavigate }: { onNavigate: (route: string) => void }) {
  const { t } = useI18n()
  const { settings, system, refreshSettings } = useGateway()

  const [tab, setTab] = useState<TabKey>('hardware')
  const [server, setServer] = useState<SettingsDoc | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'danger' | 'info'; text: string } | null>(null)

  const dirtyRef = useRef<EditedKey[]>([])

  const baseline = useMemo(() => (server ? toDraft(server) : null), [server])
  const dirty = useMemo(
    () => (draft && baseline ? diffKeys(draft, baseline) : []),
    [draft, baseline],
  )

  // Must run before the sync effect below: that effect decides whether the incoming
  // document may overwrite the draft, and it needs the *current* dirty set to decide.
  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  // The store holds one copy of the document. Adopt it only while the form is clean, or a
  // background refresh would overwrite what the operator is in the middle of typing.
  useEffect(() => {
    if (!settings) return
    setServer(settings)
    if (dirtyRef.current.length === 0) setDraft(toDraft(settings))
  }, [settings])

  useEffect(() => {
    if (!settings) void refreshSettings()
  }, [settings, refreshSettings])

  const errors = useMemo(() => {
    const found: Record<string, string> = {}
    if (!draft) return found

    const integerIn = (key: string, value: number, min: number, max: number) => {
      if (!Number.isInteger(value) || value < min || value > max) {
        found[key] = t('settings.err.intRange', { min, max })
      }
    }

    if (!draft.timezone.trim()) found.timezone = t('settings.err.required')
    integerIn('hardware.vpcd_slots', draft.hardware.vpcd_slots, 1, 8)
    integerIn('rekey.minutes', draft.rekey.minutes, 0, 1440)
    integerIn('rekey.ike_minutes', draft.rekey.ike_minutes, 0, 1440)
    integerIn('retry.max', draft.retry.max, 0, 50)
    integerIn('retry.interval', draft.retry.interval, 0, 3600)
    integerIn('ring_timeout', draft.ring_timeout, 5, 300)
    integerIn('vm_ring_seconds', draft.vm_ring_seconds, 0, 120)
    integerIn('vm_max_seconds', draft.vm_max_seconds, 10, 600)
    integerIn('maintenance.notification_history_days', draft.maintenance.notification_history_days, 0, 3650)
    integerIn('maintenance.support_bundle_log_lines', draft.maintenance.support_bundle_log_lines, 0, 100000)
    integerIn('esim.download_timeout', draft.esim.download_timeout, 10, 3600)

    // VID/PID are matched literally against `/sys/bus/usb/devices/*/idVendor`, so a typo is
    // indistinguishable from a device that is simply not plugged in. Reject it here.
    const seen = new Set<string>()
    draft.hardware.modem_profiles.forEach((profile, index) => {
      const at = `hardware.profile.${index}`
      if (!profile.name.trim()) found[`${at}.name`] = t('settings.err.required')
      if (!/^[0-9a-fA-F]{4}$/.test(profile.vid)) found[`${at}.vid`] = t('settings.err.hex4')
      if (!/^[0-9a-fA-F]{4}$/.test(profile.pid)) found[`${at}.pid`] = t('settings.err.hex4')
      const iface = profile.at_interface ?? 2
      if (!Number.isInteger(iface) || iface < 0 || iface > 15) {
        found[`${at}.at_interface`] = t('settings.err.intRange', { min: 0, max: 15 })
      }
      const pair = `${profile.vid.toLowerCase()}:${profile.pid.toLowerCase()}`
      if (/^[0-9a-f]{4}:[0-9a-f]{4}$/.test(pair)) {
        if (seen.has(pair)) found[`${at}.duplicate`] = t('settings.err.duplicate')
        seen.add(pair)
      }
    })

    return found
  }, [draft, t])

  const dirtyTabs = useMemo(() => new Set(dirty.map((key) => KEY_TAB[key])), [dirty])
  const blocked = Object.keys(errors).length > 0

  const save = useCallback(async () => {
    if (!draft || !server) return
    if (dirty.length === 0) {
      setNotice({ tone: 'info', text: t('settings.noChanges') })
      return
    }
    if (blocked) {
      setNotice({ tone: 'danger', text: t('common.failed') })
      return
    }
    setSaving(true)
    setNotice(null)
    try {
      const saved = await api.settings.save(buildPatch(dirty, draft, server))
      setServer(saved)
      setDraft(toDraft(saved))
      setNotice({ tone: 'ok', text: t('settings.saved') })
      // Keep the store's copy in step with what was just stored.
      void refreshSettings()
    } catch (failure) {
      setNotice({
        tone: 'danger',
        text: failure instanceof ApiError ? failure.message : String(failure),
      })
    } finally {
      setSaving(false)
    }
  }, [blocked, dirty, draft, refreshSettings, server, t])

  const discard = useCallback(() => {
    if (!baseline) return
    setDraft(baseline)
    setNotice(null)
  }, [baseline])

  if (!draft || !baseline) {
    return (
      <div className="stack">
        {settings === null ? <div className="alert alert-info">{t('common.loading')}</div> : null}
        <SkeletonRows rows={6} />
      </div>
    )
  }

  const patchDraft = (changes: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...changes } : current))

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head" style={{ flexWrap: 'wrap', rowGap: 'var(--space-2)' }}>
          <div className="row wrap" style={{ gap: 'var(--space-1)' }} role="tablist">
            {TABS.map((item) => {
              const active = item.key === tab
              return (
                <button
                  key={item.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className="btn btn-sm"
                  onClick={() => setTab(item.key)}
                  style={{
                    background: active ? 'var(--accent-soft)' : 'transparent',
                    color: active ? 'var(--accent)' : 'var(--text)',
                    borderColor: active ? 'transparent' : 'var(--border)',
                    fontWeight: active ? 500 : 400,
                  }}
                >
                  {t(item.labelKey)}
                  {dirtyTabs.has(item.key) ? <span aria-hidden="true">•</span> : null}
                </button>
              )
            })}
          </div>

          <div className="row" style={{ gap: 'var(--space-2)' }}>
            {dirty.length > 0 ? (
              <Badge tone="warn">{t('settings.dirty', { count: dirty.length })}</Badge>
            ) : null}
            <button type="button" className="btn btn-sm" disabled={dirty.length === 0 || saving} onClick={discard}>
              {t('settings.discard')}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={dirty.length === 0 || saving || blocked}
              onClick={() => void save()}
            >
              {saving ? t('settings.saving') : t('settings.save')}
            </button>
          </div>
        </div>

        <div className="card-body stack" style={{ paddingTop: 'var(--space-3)' }}>
          {notice ? <div className={`alert alert-${notice.tone}`}>{notice.text}</div> : null}
          <p className="xs faint" style={{ margin: 0 }}>
            {t('settings.onlyChanged')}
          </p>
        </div>
      </div>

      {tab === 'hardware' ? (
        <>
          <Section
            title={t('settings.hardware.title')}
            hint={t('settings.hardware.hint')}
            dirty={dirty.includes('hardware')}
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
                gap: 'var(--space-4)',
              }}
            >
              <Field label={t('settings.hardware.backend')} hint={t('settings.hardware.backendHint')}>
                <select
                  className="select"
                  value={draft.hardware.modem_backend}
                  onChange={(event) =>
                    patchDraft({
                      hardware: { ...draft.hardware, modem_backend: event.target.value as Backend },
                    })
                  }
                >
                  <option value="auto">{t('settings.hardware.backendAuto')}</option>
                  <option value="serial">{t('settings.hardware.backendSerial')}</option>
                </select>
              </Field>

              <Field
                label={t('settings.hardware.vpcdSlots')}
                hint={t('settings.hardware.vpcdSlotsHint')}
                error={errors['hardware.vpcd_slots']}
              >
                <NumberInput
                  value={draft.hardware.vpcd_slots}
                  min={1}
                  max={8}
                  invalid={!!errors['hardware.vpcd_slots']}
                  onChange={(next) => patchDraft({ hardware: { ...draft.hardware, vpcd_slots: next } })}
                />
              </Field>

              <Toggle
                label={t('settings.hardware.autoDetect')}
                hint={t('settings.hardware.autoDetectHint')}
                checked={draft.hardware.auto_detect}
                onChange={(next) => patchDraft({ hardware: { ...draft.hardware, auto_detect: next } })}
              />
            </div>
          </Section>

          <Section
            title={t('settings.hardware.profiles')}
            hint={t('settings.hardware.profilesHint')}
            dirty={dirty.includes('hardware')}
          >
            <ModemProfiles
              profiles={draft.hardware.modem_profiles}
              errors={errors}
              onChange={(next) => patchDraft({ hardware: { ...draft.hardware, modem_profiles: next } })}
            />
          </Section>
        </>
      ) : null}

      {tab === 'devices' ? (
        <Section
          title={t('settings.devices.title')}
          hint={t('settings.devices.hint')}
          dirty={dirty.includes('device_defaults')}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
              gap: 'var(--space-4)',
            }}
          >
            <Toggle
              label={t('cap.cellular')}
              checked={draft.device_defaults.cellular_enabled}
              onChange={(next) =>
                patchDraft({ device_defaults: { ...draft.device_defaults, cellular_enabled: next } })
              }
            />
            <Toggle
              label={t('cap.vowifi')}
              checked={draft.device_defaults.vowifi_enabled}
              onChange={(next) =>
                patchDraft({ device_defaults: { ...draft.device_defaults, vowifi_enabled: next } })
              }
            />
            <Toggle
              label={t('cap.flightMode')}
              hint={t('settings.devices.flightModeHint')}
              checked={draft.device_defaults.flight_mode}
              onChange={(next) => patchDraft({ device_defaults: { ...draft.device_defaults, flight_mode: next } })}
            />
          </div>
        </Section>
      ) : null}

      {tab === 'vowifi' ? (
        <>
          <Section
            title={t('settings.vowifi.title')}
            hint={t('settings.vowifi.hint')}
            dirty={dirty.includes('rekey')}
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
                gap: 'var(--space-4)',
              }}
            >
              <Field
                label={t('settings.vowifi.rekey')}
                hint={t('settings.vowifi.rekeyHint')}
                error={errors['rekey.minutes']}
              >
                <NumberInput
                  value={draft.rekey.minutes}
                  min={0}
                  max={1440}
                  invalid={!!errors['rekey.minutes']}
                  onChange={(next) => patchDraft({ rekey: { ...draft.rekey, minutes: next } })}
                />
              </Field>
              <Field
                label={t('settings.vowifi.ikeRekey')}
                hint={t('settings.vowifi.ikeHint')}
                error={errors['rekey.ike_minutes']}
              >
                <NumberInput
                  value={draft.rekey.ike_minutes}
                  min={0}
                  max={1440}
                  invalid={!!errors['rekey.ike_minutes']}
                  onChange={(next) => patchDraft({ rekey: { ...draft.rekey, ike_minutes: next } })}
                />
              </Field>
            </div>
          </Section>

          <Section title={t('settings.vowifi.vm')} dirty={dirty.includes('vm_enabled')}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
                gap: 'var(--space-4)',
              }}
            >
              <Field
                label={t('settings.vowifi.ring')}
                hint={t('settings.vowifi.ringHint')}
                error={errors.ring_timeout}
              >
                <NumberInput
                  value={draft.ring_timeout}
                  min={5}
                  max={300}
                  invalid={!!errors.ring_timeout}
                  onChange={(next) => patchDraft({ ring_timeout: next })}
                />
              </Field>
              <Field label={t('settings.vowifi.vmMax')} error={errors.vm_max_seconds}>
                <NumberInput
                  value={draft.vm_max_seconds}
                  min={10}
                  max={600}
                  invalid={!!errors.vm_max_seconds}
                  onChange={(next) => patchDraft({ vm_max_seconds: next })}
                />
              </Field>
              <Field label={t('settings.vowifi.vmRing')} error={errors.vm_ring_seconds}>
                <NumberInput
                  value={draft.vm_ring_seconds}
                  min={0}
                  max={120}
                  invalid={!!errors.vm_ring_seconds}
                  onChange={(next) => patchDraft({ vm_ring_seconds: next })}
                />
              </Field>
            </div>

            <Toggle
              label={t('settings.vowifi.vmEnable')}
              hint={t('settings.vowifi.vmHint')}
              checked={draft.vm_enabled}
              onChange={(next) => patchDraft({ vm_enabled: next })}
            />
          </Section>
        </>
      ) : null}

      {tab === 'host' ? (
        <>
          <Section title={t('settings.host.title')} dirty={dirty.includes('timezone')}>
            <div style={{ maxWidth: 420 }}>
              <Field
                label={t('settings.host.timezone')}
                hint={t('settings.host.timezoneHint')}
                error={errors.timezone}
              >
                <input
                  className="input mono"
                  value={draft.timezone}
                  placeholder="Asia/Shanghai"
                  aria-invalid={errors.timezone ? true : undefined}
                  style={errors.timezone ? { borderColor: 'var(--danger)' } : undefined}
                  onChange={(event) => patchDraft({ timezone: event.target.value })}
                />
              </Field>
            </div>
          </Section>

          <Section title={t('settings.host.retry')} dirty={dirty.includes('retry')}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
                gap: 'var(--space-4)',
              }}
            >
              <Field label={t('settings.host.retryMax')} error={errors['retry.max']}>
                <NumberInput
                  value={draft.retry.max}
                  min={0}
                  max={50}
                  invalid={!!errors['retry.max']}
                  onChange={(next) => patchDraft({ retry: { ...draft.retry, max: next } })}
                />
              </Field>
              <Field label={t('settings.host.retryInterval')} error={errors['retry.interval']}>
                <NumberInput
                  value={draft.retry.interval}
                  min={0}
                  max={3600}
                  invalid={!!errors['retry.interval']}
                  onChange={(next) => patchDraft({ retry: { ...draft.retry, interval: next } })}
                />
              </Field>
            </div>
          </Section>

          <Section title={t('settings.host.maintenance')} dirty={dirty.includes('maintenance')}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
                gap: 'var(--space-4)',
              }}
            >
              <Field
                label={t('settings.host.notificationDays')}
                error={errors['maintenance.notification_history_days']}
              >
                <NumberInput
                  value={draft.maintenance.notification_history_days}
                  min={0}
                  max={3650}
                  invalid={!!errors['maintenance.notification_history_days']}
                  onChange={(next) =>
                    patchDraft({ maintenance: { ...draft.maintenance, notification_history_days: next } })
                  }
                />
              </Field>
              <Field label={t('settings.host.bundleLines')} error={errors['maintenance.support_bundle_log_lines']}>
                <NumberInput
                  value={draft.maintenance.support_bundle_log_lines}
                  min={0}
                  max={100000}
                  invalid={!!errors['maintenance.support_bundle_log_lines']}
                  onChange={(next) =>
                    patchDraft({ maintenance: { ...draft.maintenance, support_bundle_log_lines: next } })
                  }
                />
              </Field>
            </div>
          </Section>

          <Section title={t('settings.host.security')} dirty={dirty.includes('security')}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
                gap: 'var(--space-4)',
              }}
            >
              <Toggle
                label={t('settings.host.httpsOnly')}
                checked={draft.security.https_only}
                onChange={(next) => patchDraft({ security: { ...draft.security, https_only: next } })}
              />
              <Toggle
                label={t('settings.host.audit')}
                checked={draft.security.audit_enabled}
                onChange={(next) => patchDraft({ security: { ...draft.security, audit_enabled: next } })}
              />
            </div>
            <Field
              label={t('settings.host.trustedProxies')}
              hint={t('settings.host.trustedProxiesHint')}
            >
              <textarea
                className="textarea"
                rows={3}
                value={draft.security.trusted_proxies}
                placeholder={t('settings.host.trustedProxiesPlaceholder')}
                onChange={(event) => patchDraft({ security: { ...draft.security, trusted_proxies: event.target.value } })}
              />
            </Field>
          </Section>

          <Section title={t('settings.host.debug')} hint={t('settings.host.debugHint')} dirty={dirty.includes('debug')}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                gap: 'var(--space-3)',
              }}
            >
              {(['asterisk', 'charon', 'pcap', 'ami'] as const).map((flag) => (
                <Toggle
                  key={flag}
                  label={flag}
                  checked={draft.debug[flag]}
                  onChange={(next) => patchDraft({ debug: { ...draft.debug, [flag]: next } })}
                />
              ))}
            </div>
          </Section>
        </>
      ) : null}

      {tab === 'esim' ? (
        <Section title={t('settings.esim.title')} hint={t('settings.esim.hint')} dirty={dirty.includes('esim')}>
          <Field label={t('settings.esim.bin')} hint={t('settings.esim.binHint')}>
            <input
              className="input mono"
              value={draft.esim.lpac_bin}
              onChange={(event) => patchDraft({ esim: { ...draft.esim, lpac_bin: event.target.value } })}
            />
          </Field>
          <div style={{ maxWidth: 320 }}>
            <Field label={t('settings.esim.timeout')} error={errors['esim.download_timeout']}>
              <NumberInput
                value={draft.esim.download_timeout}
                min={10}
                max={3600}
                invalid={!!errors['esim.download_timeout']}
                onChange={(next) => patchDraft({ esim: { ...draft.esim, download_timeout: next } })}
              />
            </Field>
          </div>
          <Toggle
            label={t('settings.esim.autoNotifications')}
            checked={draft.esim.auto_process_notifications}
            onChange={(next) =>
              patchDraft({ esim: { ...draft.esim, auto_process_notifications: next } })
            }
          />
        </Section>
      ) : null}

      {tab === 'admin' ? (
        <>
          <AdministratorTab />

          <Section title={t('settings.system.title')}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: 'var(--space-4)',
              }}
            >
              <div className="stack" style={{ gap: 2 }}>
                <span className="xs faint">{t('settings.system.version')}</span>
                <span className="small mono">{String(system?.version ?? '—')}</span>
              </div>
              <div className="stack" style={{ gap: 2 }}>
                <span className="xs faint">{t('settings.system.hostname')}</span>
                <span className="small mono">{String(system?.hostname ?? '—')}</span>
              </div>
            </div>

            <div className="stack" style={{ gap: 'var(--space-2)' }}>
              <span className="xs faint">{t('settings.related')}</span>
              <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
                <button type="button" className="btn btn-sm" onClick={() => onNavigate('notifications')}>
                  {t('nav.notifications')}
                </button>
                <button type="button" className="btn btn-sm" onClick={() => onNavigate('egress')}>
                  {t('nav.egress')}
                </button>
                <button type="button" className="btn btn-sm" onClick={() => onNavigate('lines')}>
                  {t('nav.lines')}
                </button>
              </div>
              <span className="xs faint">{t('settings.notificationsNote')}</span>
            </div>
          </Section>
        </>
      ) : null}
    </div>
  )
}
