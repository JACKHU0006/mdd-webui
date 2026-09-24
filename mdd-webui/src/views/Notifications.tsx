/**
 * Notifications — four delivery channels, ten events, and the delivery log.
 *
 * Four things drive the shape of this page:
 *
 *  1. **A channel is off unless it is on.** `enabled: false` beats any template or event
 *     switch. The per-channel switch is therefore the primary control and reads first.
 *
 *  2. **An event with no switch on is never delivered.** So the per-event grid is per channel,
 *     not global: webhook and Telegram routinely want different subsets, and a single global
 *     grid would silently deliver things nobody asked for.
 *
 *  3. **Templates are server-validated against a fixed token list.** `{{typo}}` is rejected with
 *     a 400 naming one offending token, so the check is mirrored here — that is strictly more
 *     useful than a round-trip that reports one error at a time. The allowed list lives in
 *     `types.ts` next to the event list, because both are part of the API contract.
 *
 *  4. **The delivery log records metadata only** — no bodies, no numbers, no credentials. Its
 *     value is diagnosis: which channel, which event, how many attempts, what status code. The
 *     `pending` list is what is in flight right now, and it is shown separately for that reason.
 *
 * The stored form is `settings.<channel>`, so saving goes through `PUT /api/settings` with each
 * edited channel sent whole — nested objects are replaced, not merged.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { useI18n, type MessageKey } from '../lib/i18n'
import { api } from '../lib/api'
import {
  ApiError,
  NOTIFICATION_EVENTS,
  NOTIFICATION_TEMPLATE_FIELDS,
  type NotificationChannel,
  type NotificationDeliveries,
  type NotificationDelivery,
  type NotificationEvent,
  type NotificationTestResult,
  type Settings,
} from '../lib/types'

const CHANNELS = ['webhook', 'telegram', 'pushplus', 'feishu', 'bark', 'email'] as const

/** Bark's interruption levels; `critical` needs extra permission in the app, so it is not default. */
const BARK_LEVELS = ['active', 'timeSensitive', 'passive', 'critical'] as const

/** Email transport modes. The port follows the mode unless it is set explicitly. */
const EMAIL_TLS_MODES = ['starttls', 'ssl', 'none'] as const

/**
 * `t` takes a literal key union, so these cannot be built with a template string. Spelling the
 * maps out keeps a renamed option a compile error instead of a raw key on screen.
 */
const BARK_LEVEL_LABEL: Record<(typeof BARK_LEVELS)[number], MessageKey> = {
  active: 'notif.barkLevel.active',
  timeSensitive: 'notif.barkLevel.timeSensitive',
  passive: 'notif.barkLevel.passive',
  critical: 'notif.barkLevel.critical',
}

const EMAIL_TLS_LABEL: Record<(typeof EMAIL_TLS_MODES)[number], MessageKey> = {
  starttls: 'notif.emailTls.starttls',
  ssl: 'notif.emailTls.ssl',
  none: 'notif.emailTls.none',
}
type ChannelId = (typeof CHANNELS)[number]

/**
 * `t` takes a literal key union, so the keys cannot be built with a template string. Spelling
 * both maps out keeps a renamed event or channel a compile error instead of a raw key on screen.
 */
const CHANNEL_LABEL: Record<ChannelId, MessageKey> = {
  webhook: 'notif.channel.webhook',
  telegram: 'notif.channel.telegram',
  pushplus: 'notif.channel.pushplus',
  feishu: 'notif.channel.feishu',
  bark: 'notif.channel.bark',
  email: 'notif.channel.email',
}

/**
 * Test endpoints, one per channel.
 *
 * A map rather than a chain of ternaries: the previous form silently fell through to Feishu
 * for any id it did not name, so adding a channel meant a test that reported the wrong
 * channel's result. This way a renamed or added channel is a compile error.
 */
const TEST_SENDER: Record<
  ChannelId,
  (event: NotificationEvent) => Promise<NotificationTestResult>
> = {
  webhook: (event) => api.notifications.testWebhook(event),
  telegram: (event) => api.notifications.testTelegram(event),
  pushplus: (event) => api.notifications.testPushplus(event),
  feishu: (event) => api.notifications.testFeishu(event),
  bark: (event) => api.notifications.testBark(event),
  email: (event) => api.notifications.testEmail(event),
}

const EVENT_LABEL: Record<NotificationEvent, MessageKey> = {
  incoming_sms: 'notif.event.incoming_sms',
  incoming_call: 'notif.event.incoming_call',
  host_alert: 'notif.event.host_alert',
  number_changed: 'notif.event.number_changed',
  line_unrecoverable: 'notif.event.line_unrecoverable',
  keepalive_result: 'notif.event.keepalive_result',
  balance_low: 'notif.event.balance_low',
  missed_call: 'notif.event.missed_call',
  voicemail_received: 'notif.event.voicemail_received',
  software_update: 'notif.event.software_update',
}

const EVENT_HINT: Record<NotificationEvent, MessageKey> = {
  incoming_sms: 'notif.event.incoming_sms.hint',
  incoming_call: 'notif.event.incoming_call.hint',
  host_alert: 'notif.event.host_alert.hint',
  number_changed: 'notif.event.number_changed.hint',
  line_unrecoverable: 'notif.event.line_unrecoverable.hint',
  keepalive_result: 'notif.event.keepalive_result.hint',
  balance_low: 'notif.event.balance_low.hint',
  missed_call: 'notif.event.missed_call.hint',
  voicemail_received: 'notif.event.voicemail_received.hint',
  software_update: 'notif.event.software_update.hint',
}

/** A stored event id is a plain string; only the ten known ones get a label. */
function eventLabelOf(event: string): MessageKey | null {
  return (EVENT_LABEL as Record<string, MessageKey>)[event] ?? null
}

/** Channels that never support per-event templates in this UI, and why. */
function channelSupportsTemplates(_id: ChannelId): boolean {
  // All four do: the override is applied by `build_notification_message`, which every channel
  // calls. Kept as a function so a future channel that does not can say so in one place.
  return true
}

function toneForStatus(status: string | undefined): Tone {
  if (status === 'ok') return 'ok'
  if (status === 'failed') return 'danger'
  if (status === 'pending') return 'warn'
  return 'neutral'
}

/**
 * Pull the offending token out of a template so the operator is told which one.
 *
 * The server validates by regex and rejects the first unknown field it finds; reproducing that
 * here means a typo is caught while typing rather than after a round-trip.
 */
function unknownTemplateTokens(text: string): string[] {
  const found = text.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)
  const allowed = new Set<string>(NOTIFICATION_TEMPLATE_FIELDS)
  const bad = new Set<string>()
  for (const match of found) {
    if (!allowed.has(match[1])) bad.add(match[1])
  }
  return [...bad]
}

function formatClock(seconds: number | undefined): string {
  if (!seconds) return '—'
  return new Date(seconds * 1000).toLocaleString()
}

/* ------------------------------------------------------------------ templates */

function TemplateEditor({
  template,
  onChange,
}: {
  template: { title?: string; content?: string } | undefined
  onChange: (next: { title?: string; content?: string } | undefined) => void
}) {
  const { t } = useI18n()
  const title = template?.title ?? ''
  const content = template?.content ?? ''
  const badTokens = [
    ...new Set([...unknownTemplateTokens(title), ...unknownTemplateTokens(content)]),
  ]

  const patch = (field: 'title' | 'content', value: string) => {
    const next = { title, content, ...{ [field]: value } }
    // A fully blank template is stored as absent rather than as an empty override, which is
    // what `_render_notification_message` treats as "use the default text".
    if (!next.title.trim() && !next.content.trim()) onChange(undefined)
    else onChange(next)
  }

  return (
    <div className="stack" style={{ gap: 'var(--space-2)' }}>
      <div className="row wrap" style={{ gap: 'var(--space-3)' }}>
        <Field label={t('notif.templateTitle')} inline>
          <input
            className="input"
            style={{ minWidth: '12rem' }}
            value={title}
            aria-label={t('notif.templateTitle')}
            onChange={(e) => patch('title', e.target.value)}
          />
        </Field>
        <Field label={t('notif.templateBody')} inline>
          <input
            className="input"
            style={{ minWidth: '18rem' }}
            value={content}
            aria-label={t('notif.templateBody')}
            onChange={(e) => patch('content', e.target.value)}
          />
        </Field>
      </div>
      {badTokens.length ? (
        <span className="xs" style={{ color: 'var(--danger)' }}>
          {t('notif.unknownTokens', { tokens: badTokens.join(', ') })}
        </span>
      ) : (
        <span className="xs faint">
          {t('notif.templateFields', { fields: NOTIFICATION_TEMPLATE_FIELDS.join(', ') })}
        </span>
      )}
    </div>
  )
}

/* --------------------------------------------------------------------- channel */

function ChannelPanel({
  id,
  config,
  onChange,
  onTest,
  testing,
  testResult,
}: {
  id: ChannelId
  config: NotificationChannel
  onChange: (patch: Partial<NotificationChannel>) => void
  onTest: (event: NotificationEvent) => void
  testing: boolean
  testResult: { ok: boolean; message?: string } | null
}) {
  const { t } = useI18n()
  const [testEvent, setTestEvent] = useState<NotificationEvent>('incoming_sms')
  // A 13-event template grid is a lot of screen for something most operators leave alone.
  const [showTemplates, setShowTemplates] = useState(false)

  const events = config.events ?? {}
  const templates = config.message_templates ?? {}
  const enabled = Boolean(config.enabled)

  // An event id the UI does not know about still has to render, so the raw id is the fallback.
  const eventLabel = (event: string) => {
    const key = eventLabelOf(event)
    return key ? t(key) : event
  }

  return (
    <div className="card">
      <div className="card-body stack" style={{ gap: 'var(--space-3)' }}>
        <div className="row wrap" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
          <Badge tone={enabled ? 'ok' : 'neutral'}>
            {enabled ? t('notif.on') : t('notif.off')}
          </Badge>
          <strong>{t(CHANNEL_LABEL[id])}</strong>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => onChange({ enabled: e.target.checked })}
            />
            <span className="small">{t('notif.enable')}</span>
          </label>
        </div>

        {/* ---- per-channel delivery settings ---- */}

        {id === 'webhook' ? (
          <>
            <Field label={t('notif.webhookUrl')}>
              <input
                className="input mono"
                value={String(config.url ?? '')}
                placeholder="https://…"
                onChange={(e) => onChange({ url: e.target.value })}
              />
            </Field>
            <div className="kv-grid">
              <Field label={t('notif.webhookFormat')}>
                <select
                  className="input"
                  value={String(config.format ?? 'generic')}
                  onChange={(e) => onChange({ format: e.target.value })}
                >
                  <option value="generic">{t('notif.formatGeneric')}</option>
                  <option value="custom">{t('notif.formatCustom')}</option>
                </select>
              </Field>
              <Field label={t('notif.webhookMethod')}>
                <select
                  className="input"
                  value={String(config.method ?? 'POST')}
                  onChange={(e) => onChange({ method: e.target.value })}
                >
                  <option value="POST">POST</option>
                  <option value="GET">GET</option>
                </select>
              </Field>
            </div>
            <Field
              label={t('notif.webhookHeaders')}
              hint={t('notif.webhookHeadersHint')}
            >
              <input
                className="input mono"
                value={String(config.headers_json ?? config.headers ?? '')}
                placeholder='{"Authorization": "Bearer …"}'
                onChange={(e) => onChange({ headers_json: e.target.value })}
              />
            </Field>
            {String(config.format ?? 'generic') === 'custom' ? (
              <>
                <Field label={t('notif.webhookPayload')}>
                  <textarea
                    className="input mono"
                    rows={4}
                    value={String(config.payload_template ?? '')}
                    onChange={(e) => onChange({ payload_template: e.target.value })}
                  />
                </Field>
                <Field label={t('notif.webhookBodyMode')}>
                  <select
                    className="input"
                    value={String(config.body_mode ?? 'json')}
                    onChange={(e) => onChange({ body_mode: e.target.value })}
                  >
                    <option value="json">{t('notif.bodyJson')}</option>
                    <option value="raw">{t('notif.bodyRaw')}</option>
                  </select>
                </Field>
              </>
            ) : null}
            <label className="checkbox">
              <input
                type="checkbox"
                checked={config.verify_tls !== false}
                onChange={(e) => onChange({ verify_tls: e.target.checked })}
              />
              <span className="small">{t('notif.webhookVerifyTls')}</span>
            </label>
            {config.verify_tls === false ? (
              <div className="note note-warn">{t('notif.webhookVerifyTlsHint')}</div>
            ) : null}
          </>
        ) : null}

        {id === 'telegram' ? (
          <>
            <div className="kv-grid">
              <Field label={t('notif.botToken')}>
                <input
                  className="input mono"
                  type="password"
                  autoComplete="off"
                  value={String(config.bot_token ?? '')}
                  onChange={(e) => onChange({ bot_token: e.target.value })}
                />
              </Field>
              <Field label={t('notif.chatId')}>
                <input
                  className="input mono"
                  value={String(config.chat_id ?? '')}
                  onChange={(e) => onChange({ chat_id: e.target.value })}
                />
              </Field>
            </div>
            <Field label={t('notif.proxyMode')}>
              <select
                className="input"
                value={String(config.proxy_mode ?? 'direct')}
                onChange={(e) => onChange({ proxy_mode: e.target.value })}
              >
                <option value="direct">{t('notif.proxyDirect')}</option>
                <option value="library">{t('notif.proxyLibrary')}</option>
                <option value="country">{t('notif.proxyCountry')}</option>
                <option value="manual">{t('notif.proxyManual')}</option>
              </select>
            </Field>
            {String(config.proxy_mode) === 'manual' ? (
              <Field label={t('notif.proxyUrl')}>
                <input
                  className="input mono"
                  value={String(config.proxy_url ?? '')}
                  placeholder="socks5://…"
                  onChange={(e) => onChange({ proxy_url: e.target.value })}
                />
              </Field>
            ) : null}
            {String(config.proxy_mode) === 'country' ? (
              <Field label={t('notif.proxyCountry')}>
                <input
                  className="input mono"
                  maxLength={2}
                  value={String(config.proxy_country ?? '')}
                  placeholder="jp"
                  onChange={(e) => onChange({ proxy_country: e.target.value.toLowerCase() })}
                />
              </Field>
            ) : null}
          </>
        ) : null}

        {id === 'pushplus' ? (
          <>
            <div className="kv-grid">
              <Field label={t('notif.pushplusToken')} hint={t('notif.pushplusTokenHint')}>
                <input
                  className="input mono"
                  type="password"
                  autoComplete="off"
                  value={String(config.token ?? '')}
                  onChange={(e) => onChange({ token: e.target.value })}
                />
              </Field>
              <Field label={t('notif.pushplusTemplate')}>
                <select
                  className="input"
                  value={String(config.template ?? 'html')}
                  onChange={(e) => onChange({ template: e.target.value })}
                >
                  {['html', 'txt', 'markdown', 'json'].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('notif.pushplusTopic')}>
                <input
                  className="input mono"
                  value={String(config.topic ?? '')}
                  onChange={(e) => onChange({ topic: e.target.value })}
                />
              </Field>
            </div>
          </>
        ) : null}

        {id === 'feishu' ? (
          <>
            <Field label={t('notif.feishuUrl')} hint={t('notif.feishuUrlHint')}>
              <input
                className="input mono"
                value={String(config.url ?? '')}
                placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"
                onChange={(e) => onChange({ url: e.target.value })}
              />
            </Field>
            <Field label={t('notif.feishuSecret')} hint={t('notif.feishuSecretHint')}>
              <input
                className="input mono"
                type="password"
                autoComplete="off"
                value={String(config.secret ?? '')}
                onChange={(e) => onChange({ secret: e.target.value })}
              />
            </Field>
          </>
        ) : null}

        {id === 'bark' ? (
          <>
            <div className="kv-grid">
              <Field label={t('notif.barkServer')} hint={t('notif.barkServerHint')}>
                <input
                  className="input mono"
                  value={String(config.server ?? '')}
                  placeholder="https://api.day.app"
                  onChange={(e) => onChange({ server: e.target.value })}
                />
              </Field>
              <Field label={t('notif.barkKey')} hint={t('notif.barkKeyHint')}>
                <input
                  className="input mono"
                  type="password"
                  autoComplete="off"
                  value={String(config.device_key ?? '')}
                  onChange={(e) => onChange({ device_key: e.target.value })}
                />
              </Field>
            </div>
            <div className="kv-grid">
              <Field label={t('notif.barkLevel')} hint={t('notif.barkLevelHint')}>
                <select
                  className="input"
                  value={String(config.level ?? 'active')}
                  onChange={(e) => onChange({ level: e.target.value })}
                >
                  {BARK_LEVELS.map((value) => (
                    <option key={value} value={value}>
                      {t(BARK_LEVEL_LABEL[value])}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('notif.barkGroup')} hint={t('notif.barkGroupHint')}>
                <input
                  className="input"
                  value={String(config.group ?? '')}
                  onChange={(e) => onChange({ group: e.target.value })}
                />
              </Field>
            </div>
            <Field label={t('notif.barkSound')}>
              <input
                className="input"
                value={String(config.sound ?? '')}
                onChange={(e) => onChange({ sound: e.target.value })}
              />
            </Field>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={config.archive !== false}
                onChange={(e) => onChange({ archive: e.target.checked })}
              />
              <span className="small">{t('notif.barkArchive')}</span>
            </label>
          </>
        ) : null}

        {id === 'email' ? (
          <>
            <div className="kv-grid">
              <Field label={t('notif.emailHost')}>
                <input
                  className="input mono"
                  value={String(config.host ?? '')}
                  placeholder="smtp.example.com"
                  onChange={(e) => onChange({ host: e.target.value })}
                />
              </Field>
              <Field label={t('notif.emailTls')} hint={t('notif.emailTlsHint')}>
                <select
                  className="input"
                  value={String(config.tls_mode ?? 'starttls')}
                  onChange={(e) => onChange({ tls_mode: e.target.value })}
                >
                  {EMAIL_TLS_MODES.map((value) => (
                    <option key={value} value={value}>
                      {t(EMAIL_TLS_LABEL[value])}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label={t('notif.emailPort')} hint={t('notif.emailPortHint')}>
              <input
                className="input mono"
                value={String(config.port ?? '')}
                placeholder="587"
                onChange={(e) => onChange({ port: e.target.value })}
              />
            </Field>
            <div className="kv-grid">
              <Field label={t('notif.emailUser')}>
                <input
                  className="input mono"
                  autoComplete="off"
                  value={String(config.username ?? '')}
                  onChange={(e) => onChange({ username: e.target.value })}
                />
              </Field>
              <Field label={t('notif.emailPassword')}>
                <input
                  className="input mono"
                  type="password"
                  autoComplete="off"
                  value={String(config.password ?? '')}
                  onChange={(e) => onChange({ password: e.target.value })}
                />
              </Field>
            </div>
            <div className="kv-grid">
              <Field label={t('notif.emailFrom')} hint={t('notif.emailFromHint')}>
                <input
                  className="input mono"
                  value={String(config.from_address ?? '')}
                  placeholder="bot@example.com"
                  onChange={(e) => onChange({ from_address: e.target.value })}
                />
              </Field>
              <Field label={t('notif.emailSubjectPrefix')}>
                <input
                  className="input"
                  value={String(config.subject_prefix ?? '')}
                  onChange={(e) => onChange({ subject_prefix: e.target.value })}
                />
              </Field>
            </div>
            <Field label={t('notif.emailTo')} hint={t('notif.emailToHint')}>
              <input
                className="input mono"
                value={
                  Array.isArray(config.to)
                    ? config.to.join(', ')
                    : String(config.to ?? '')
                }
                placeholder="me@example.com, other@example.com"
                onChange={(e) => onChange({ to: e.target.value })}
              />
            </Field>
          </>
        ) : null}

        {/* ---- events ---- */}

        <div className="stack" style={{ gap: 'var(--space-2)' }}>
          <div className="row wrap" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
            <strong className="small">{t('notif.events')}</strong>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onChange({ events: Object.fromEntries(NOTIFICATION_EVENTS.map((e) => [e, true])) })}
            >
              {t('notif.selectAll')}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onChange({ events: {} })}
            >
              {t('notif.selectNone')}
            </button>
            <span className="xs faint">{t('notif.eventsHint')}</span>
          </div>
          <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
            {NOTIFICATION_EVENTS.map((event) => (
              <label className="checkbox" key={event} title={t(EVENT_HINT[event])}>
                <input
                  type="checkbox"
                  checked={Boolean(events[event])}
                  onChange={(e) => onChange({ events: { ...events, [event]: e.target.checked } })}
                />
                <span className="small">{eventLabel(event)}</span>
              </label>
            ))}
          </div>
          {!enabled ? <span className="xs faint">{t('notif.disabledNote')}</span> : null}
        </div>

        {/* ---- templates ---- */}

        {channelSupportsTemplates(id) ? (
          <>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setShowTemplates(!showTemplates)}
            >
              {showTemplates ? t('notif.hideTemplates') : t('notif.showTemplates')}
            </button>
            {showTemplates ? (
              <div className="stack" style={{ gap: 'var(--space-2)' }}>
                <span className="xs faint">{t('notif.templatesHint')}</span>
                {NOTIFICATION_EVENTS.map((event) => (
                  <TemplateEditor
                    key={event}
                    template={templates[event]}
                    onChange={(next) => {
                      const nextTemplates = { ...templates }
                      if (next === undefined) delete nextTemplates[event]
                      else nextTemplates[event] = next
                      onChange({ message_templates: nextTemplates })
                    }}
                  />
                ))}
              </div>
            ) : null}
          </>
        ) : null}

        {/* ---- test ---- */}

        <div className="row wrap" style={{ gap: 'var(--space-2)', alignItems: 'flex-end' }}>
          <Field label={t('notif.testEvent')} inline>
            <select
              className="input"
              value={testEvent}
              onChange={(e) => setTestEvent(e.target.value as NotificationEvent)}
            >
              {NOTIFICATION_EVENTS.map((event) => (
                <option key={event} value={event}>
                  {eventLabel(event)}
                </option>
              ))}
            </select>
          </Field>
          {/*
            Disabled while the channel is off, not just while a test is in flight: the test
            endpoint delivers with the *stored* config, so it could only ever report on
            something that can never fire. Blocking it here beats a 400 after a round-trip.
          */}
          <button
            type="button"
            className="btn btn-sm"
            disabled={!enabled || testing}
            onClick={() => onTest(testEvent)}
          >
            {testing ? t('notif.testing') : t('notif.test')}
          </button>
        </div>
        {testResult ? (
          <div className={`note note-${testResult.ok ? 'ok' : 'danger'}`}>
            {testResult.ok ? t('notif.testOk') : t('notif.testFailed', { error: testResult.message ?? '' })}
          </div>
        ) : null}
        {!enabled ? <span className="xs faint">{t('notif.testDisabledHint')}</span> : null}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------- delivery row */

function DeliveryRow({ row }: { row: NotificationDelivery }) {
  const { t } = useI18n()
  return (
    <div className="row wrap" style={{ gap: 'var(--space-3)', alignItems: 'center' }}>
      <Badge tone={toneForStatus(row.status)}>
        {row.status === 'ok'
          ? t('notif.statusOk')
          : row.status === 'failed'
            ? t('notif.statusFailed')
            : t('notif.statusPending')}
      </Badge>
      <span className="small">{row.channel || '—'}</span>
      <span className="small muted">{row.event || '—'}</span>
      <span className="small muted">{row.instance || '—'}</span>
      <KeyValue label={t('notif.attempts', { count: row.attempts ?? 0 })}>
        {row.status_code ? `HTTP ${row.status_code}` : '—'}
      </KeyValue>
      <span className="xs faint" style={{ marginLeft: 'auto' }}>
        {formatClock(row.finished_at ?? row.created_at)}
      </span>
      {row.error ? <span className="xs" style={{ color: 'var(--danger)', width: '100%' }}>{row.error}</span> : null}
    </div>
  )
}

/* ------------------------------------------------------------------------- view */

export function Notifications() {
  const { t } = useI18n()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [deliveries, setDeliveries] = useState<NotificationDeliveries | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [baseline, setBaseline] = useState<string | null>(null)
  const [testing, setTesting] = useState<ChannelId | null>(null)
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message?: string } | null>>({})

  // Polled rather than pushed: the delivery log has no WebSocket event, and the pending list
  // only matters while this page is open.
  const pollRef = useRef<number | null>(null)

  const loadDeliveries = useCallback(async () => {
    try {
      setDeliveries(await api.notifications.deliveries(100))
    } catch {
      // A log that cannot be read is not worth an error banner; the channel controls still work.
    }
  }, [])

  const load = useCallback(async () => {
    try {
      const liveSettings = await api.settings.get()
      setSettings(liveSettings)
      setBaseline(JSON.stringify(pickChannels(liveSettings)))
      setError(null)
      await loadDeliveries()
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : String(failure))
    } finally {
      setLoading(false)
    }
  }, [loadDeliveries])

  useEffect(() => {
    void load()
    pollRef.current = window.setInterval(() => void loadDeliveries(), 5000)
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current)
    }
  }, [load, loadDeliveries])

  const channels = useMemo(() => pickChannels(settings), [settings])
  const dirty = baseline !== null && JSON.stringify(channels) !== baseline

  const patchChannel = (id: ChannelId, patch: Partial<NotificationChannel>) => {
    setSaved(false)
    setSettings((current) =>
      current ? { ...current, [id]: { ...((current[id] as NotificationChannel) ?? {}), ...patch } } : current,
    )
  }

  const save = async () => {
    if (!settings) return
    setSaving(true)
    setSaveError(null)
    try {
      // Each channel is a nested object, so it is replaced wholesale — the full record for every
      // channel is sent, not just the edited one, so a partial send cannot drop an event grid.
      const patch: Record<string, unknown> = {}
      for (const id of CHANNELS) {
        const value = settings[id]
        if (value !== undefined) patch[id] = value
      }
      const stored = await api.settings.save(patch as never)
      setSettings(stored)
      setBaseline(JSON.stringify(pickChannels(stored)))
      setSaved(true)
    } catch (failure) {
      setSaveError(failure instanceof ApiError ? failure.message : String(failure))
    } finally {
      setSaving(false)
    }
  }

  const runTest = async (id: ChannelId, event: NotificationEvent) => {
    setTesting(id)
    setTestResults((current) => ({ ...current, [id]: null }))
    try {
      // Tests post to the *stored* config, so an unsaved edit is not what gets exercised. The
      // page says so rather than silently testing something else.
      const result = await TEST_SENDER[id](event)
      setTestResults((current) => ({
        ...current,
        [id]: { ok: result.ok !== false, message: String(result.error ?? '') },
      }))
    } catch (failure) {
      setTestResults((current) => ({
        ...current,
        [id]: { ok: false, message: failure instanceof ApiError ? failure.message : String(failure) },
      }))
    } finally {
      setTesting(null)
      await loadDeliveries()
    }
  }

  const clearLog = async () => {
    try {
      await api.notifications.clearDeliveries()
      await loadDeliveries()
    } catch (failure) {
      setSaveError(failure instanceof ApiError ? failure.message : String(failure))
    }
  }

  if (loading) {
    return (
      <div className="card">
        <div className="card-body">
          <SkeletonRows rows={4} />
        </div>
      </div>
    )
  }

  const pending = deliveries?.pending ?? []
  const history = deliveries?.history ?? []

  return (
    <div className="stack" style={{ gap: 'var(--space-4)' }}>
      <div>
        <h1 style={{ marginBottom: 4 }}>{t('notif.title')}</h1>
        <p className="muted small" style={{ margin: 0 }}>
          {t('notif.hint')}
        </p>
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <div className="card">
        <div className="card-body row wrap" style={{ gap: 'var(--space-3)', alignItems: 'center' }}>
          <span className="xs faint">{t('notif.savedConfigNote')}</span>
          <div className="row" style={{ gap: 'var(--space-2)', marginLeft: 'auto' }}>
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
      </div>

      {saveError ? <ErrorNote>{saveError}</ErrorNote> : null}
      {saved && !dirty ? <div className="note note-ok">{t('notif.saved')}</div> : null}

      {CHANNELS.map((id) => (
        <ChannelPanel
          key={id}
          id={id}
          config={(channels[id] as NotificationChannel) ?? {}}
          onChange={(patch) => patchChannel(id, patch)}
          onTest={(event) => void runTest(id, event)}
          testing={testing === id}
          testResult={testResults[id] ?? null}
        />
      ))}

      <Disclosure summary={t('notif.deliveries')} open>
        <p className="xs faint" style={{ margin: 0 }}>
          {t('notif.deliveriesHint')}
        </p>
        <div className="row wrap" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
          <Badge tone={pending.length ? 'warn' : 'neutral'}>
            {t('notif.pending')} · {pending.length}
          </Badge>
          <button type="button" className="btn btn-sm" onClick={() => void loadDeliveries()}>
            {t('action.refresh')}
          </button>
          <DangerButton
            label={t('notif.clearDeliveries')}
            confirmLabel={t('common.confirmRemove')}
            onConfirm={() => void clearLog()}
          />
        </div>

        {pending.length ? (
          <div className="stack" style={{ gap: 'var(--space-2)' }}>
            {pending.map((row, index) => (
              <DeliveryRow key={row.id ?? `pending-${index}`} row={row} />
            ))}
          </div>
        ) : null}

        {history.length === 0 ? (
          <Empty>{t('notif.noDeliveries')}</Empty>
        ) : (
          <div className="stack" style={{ gap: 'var(--space-2)' }}>
            {history.map((row, index) => (
              <DeliveryRow key={row.id ?? `row-${index}`} row={row} />
            ))}
          </div>
        )}
      </Disclosure>
    </div>
  )
}

/** The four channel subtrees, which is the slice of `Settings` this page owns. */
function pickChannels(settings: Settings | null): Record<string, unknown> {
  if (!settings) return {}
  const picked: Record<string, unknown> = {}
  for (const id of CHANNELS) {
    if (settings[id] !== undefined) picked[id] = settings[id]
  }
  return picked
}
