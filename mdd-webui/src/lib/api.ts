/**
 * Typed client for the MDD Sim Gateway control plane.
 *
 * Two things this layer must get right, both taken from `control/app/main.py`:
 *
 * 1. The session is a cookie named `mdd_session`, set HttpOnly + Secure + SameSite=Strict.
 *    SameSite=Strict means the browser will NOT attach it to a cross-site request, so the
 *    UI must be served from the same origin as the API. In production that is the
 *    Cloudflare Worker in `worker/`; in dev it is the Vite proxy. `credentials: 'include'`
 *    is still required for the cookie to be stored and sent.
 *
 * 2. Every mutating request must carry the session's CSRF token in `x-mdd-csrf-token`.
 *    The token is issued at login/setup and re-readable from `GET /api/auth/status`, which
 *    is what lets a page reload recover without a fresh login.
 */
import { ApiError, type ApiErrorBody, type AtCommandResult, type EsimInventory } from './types.ts'

const RAW_BASE = (import.meta.env.VITE_API_BASE ?? '').trim()
/** Trailing slashes would produce `//api/...`; the control plane routes on exact prefixes. */
export const API_BASE = RAW_BASE.replace(/\/+$/, '')

export const DEMO_MODE = (import.meta.env.VITE_DEMO_MODE ?? '0') === '1'

let csrfToken = ''

export function setCsrfToken(token: string): void {
  csrfToken = token || ''
}

export function clearCsrfToken(): void {
  csrfToken = ''
}

export function getCsrfToken(): string {
  return csrfToken
}

type Query = Record<string, string | number | boolean | undefined | null>

function buildUrl(path: string, query?: Query): string {
  const url = `${API_BASE}${path}`
  if (!query) return url
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    params.append(key, String(value))
  }
  const qs = params.toString()
  return qs ? `${url}?${qs}` : url
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  query?: Query
  signal?: AbortSignal
  /** Set for endpoints that legitimately answer 404/409 and where that is not an error. */
  raw?: boolean
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET'
  const headers: Record<string, string> = { Accept: 'application/json' }

  if (!SAFE_METHODS.has(method) && csrfToken) {
    headers['x-mdd-csrf-token'] = csrfToken
  }

  let body: BodyInit | undefined
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  }

  const response = await fetch(buildUrl(path, options.query), {
    method,
    headers,
    body,
    // Required for `mdd_session` to be stored and returned. Only works same-origin.
    credentials: 'include',
    signal: options.signal,
    cache: 'no-store',
  })

  const text = await response.text()
  let parsed: unknown = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }

  if (!response.ok) {
    const detail =
      (parsed as ApiErrorBody | null)?.detail ??
      (typeof parsed === 'string' && parsed ? parsed : undefined) ??
      `${response.status} ${response.statusText}`
    throw new ApiError(response.status, parsed, detail)
  }

  return parsed as T
}

export const http = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) =>
    request<T>(path, { method: 'GET', query, signal }),
  post: <T>(path: string, body?: unknown, query?: Query) =>
    request<T>(path, { method: 'POST', body, query }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  del: <T>(path: string, query?: Query) => request<T>(path, { method: 'DELETE', query }),
}

/* --------------------------------------------------------------- endpoints */

import type {
  Allowance,
  AllowanceQueryResponse,
  AllowanceQueryRule,
  AuthStatus,
  CallListResponse,
  CallRecord,
  CountryResponse,
  DevicesResponse,
  EgressProfileTest,
  EgressStatus,
  EgressTestResult,
  EngineLogs,
  EsimCachedChip,
  EsimCardView,
  EsimDiscoveryEntry,
  EsimNotification,
  EsimStatus,
  InstancesResponse,
  InstancePatch,
  InstanceUpsertResponse,
  Keepalive,
  KeepalivePatch,
  KeepaliveSummary,
  LineAvailability,
  LineStatusView,
  LoginRequest,
  LoginResponse,
  MessageThread,
  NotificationDeliveries,
  NotificationTestResult,
  PasswordChangeResponse,
  ReadersResponse,
  RegisterResponse,
  Settings,
  SettingsPatch,
  SimCardInfo,
  SmsMessage,
  SoftphoneProvisioning,
  SystemStatus,
  UpdateCheck,
  UpdateRelease,
  VoicemailRecord,
} from './types.ts'

export const api = {
  auth: {
    status: () => http.get<AuthStatus>('/api/auth/status'),
    /** First run only; refuses once an administrator exists. */
    setup: (body: LoginRequest) => http.post<LoginResponse>('/api/auth/setup', body),
    login: (body: LoginRequest) => http.post<LoginResponse>('/api/auth/login', body),
    logout: () => http.post<{ ok: true }>('/api/auth/logout'),
    changePassword: (current_password: string, new_password: string) =>
      http.post<PasswordChangeResponse>('/api/auth/password', { current_password, new_password }),
  },

  devices: {
    list: () => http.get<DevicesResponse>('/api/devices'),
    /** Only the native-reader IMEI is user-editable. */
    setHardware: (deviceId: string, body: { imei: string }) =>
      http.put<{ ok: true }>(`/api/devices/${encodeURIComponent(deviceId)}/hardware`, body),
    forget: (deviceId: string) =>
      http.del<{ ok: true }>(`/api/devices/${encodeURIComponent(deviceId)}`),
    cellular: (deviceId: string) =>
      http.get<Record<string, unknown>>(`/api/devices/${encodeURIComponent(deviceId)}/cellular`),
    diagnostics: (deviceId: string) =>
      http.post<Record<string, unknown>>(`/api/devices/${encodeURIComponent(deviceId)}/diagnostics`),
    /** Drives the three independent toggles. */
    setCapabilities: (
      deviceId: string,
      body: { cellular_enabled?: boolean; vowifi_enabled?: boolean; flight_mode?: boolean },
    ) => http.patch<{ ok: true }>(`/api/devices/${encodeURIComponent(deviceId)}/capabilities`, body),
  },

  instances: {
    list: () => http.get<InstancesResponse>('/api/instances'),
    /** Upsert. Answers with the stored line; `applied` says whether a running engine restarted. */
    upsert: (body: InstancePatch) => http.post<InstanceUpsertResponse>('/api/instances', body),
    /**
     * Delete a line and its engine data. `confirm_id` must match `iid` exactly — the control
     * plane uses it to prove the operator meant this line and not a neighbour. `delete_history`
     * keeps the SMS/call log when false.
     */
    remove: (iid: string, options?: { deleteHistory?: boolean }) =>
      http.del<{ ok: true; history_deleted: boolean; deleted_messages: number; deleted_calls: number }>(
        `/api/instances/${encodeURIComponent(iid)}`,
        { delete_history: options?.deleteHistory ?? true, confirm_id: iid },
      ),
    /** Empty string clears the pin and returns the line to MCC auto-detection. */
    setCountry: (iid: string, country: string) =>
      http.put<CountryResponse>(`/api/instances/${encodeURIComponent(iid)}/country`, { country }),
    /**
     * Start/restart a line. Pass `pin` only on the unlock re-entry path: the control plane
     * checks the SIM's PIN state first and refuses to bring up the engine against a locked card.
     * A 409 carries a structured `card_mismatch` / `pin_required` body rather than a string.
     */
    start: (iid: string, pin?: string) =>
      http.post<{ ok: true; container: string }>(
        `/api/instances/${encodeURIComponent(iid)}/start`,
        pin ? { pin } : {},
      ),
    stop: (iid: string) => http.post<{ ok: true }>(`/api/instances/${encodeURIComponent(iid)}/stop`),
    /** Re-establish using stored config — no PIN re-entry; runs the same PIN preflight as start. */
    reprovision: (iid: string) =>
      http.post<{ ok: true; container: string }>(
        `/api/instances/${encodeURIComponent(iid)}/reprovision`,
        {},
      ),
    /** Forgetting the PIN stops a running line, because the next start must re-ask for it. */
    clearPin: (iid: string) =>
      http.post<{ ok: true; had_pin: boolean }>(`/api/instances/${encodeURIComponent(iid)}/pin/clear`),
    status: (iid: string) =>
      http.get<LineStatusView>(`/api/instances/${encodeURIComponent(iid)}/status`),
    availability: (iid: string) =>
      http.get<LineAvailability>(`/api/instances/${encodeURIComponent(iid)}/availability`),
    /** Three independent streams — `diagnostics` is the only one that survives a rebuild. */
    logs: (iid: string, tail?: number) =>
      http.get<EngineLogs>(`/api/instances/${encodeURIComponent(iid)}/logs`, { tail }),
    register: (iid: string) =>
      http.post<RegisterResponse>(`/api/instances/${encodeURIComponent(iid)}/register`),
    softphone: (iid: string) =>
      http.get<SoftphoneProvisioning>(`/api/instances/${encodeURIComponent(iid)}/softphone`),

    messages: {
      threads: (iid: string) =>
        http.get<{ threads: MessageThread[] }>(`/api/instances/${encodeURIComponent(iid)}/messages/threads`),
      withPeer: (iid: string, peer: string) =>
        http.get<{ messages: SmsMessage[] }>(
          `/api/instances/${encodeURIComponent(iid)}/messages/${encodeURIComponent(peer)}`,
        ),
      binary: (iid: string) =>
        http.get<{ messages: SmsMessage[] }>(`/api/instances/${encodeURIComponent(iid)}/messages/binary`),
      remove: (iid: string, ids: string[]) =>
        http.post<{ ok: true }>(`/api/instances/${encodeURIComponent(iid)}/messages/delete`, { ids }),
      sendSms: (iid: string, to: string, body: string) =>
        http.post<{ ok: true }>(`/api/instances/${encodeURIComponent(iid)}/sms/send`, { to, body }),
    },

    mms: {
      settings: (iid: string) =>
        http.get<Record<string, unknown>>(`/api/instances/${encodeURIComponent(iid)}/mms/settings`),
      saveSettings: (iid: string, body: Record<string, unknown>) =>
        http.put<{ ok: true }>(`/api/instances/${encodeURIComponent(iid)}/mms/settings`, body),
      send: (iid: string, body: Record<string, unknown>) =>
        http.post<{ ok: true }>(`/api/instances/${encodeURIComponent(iid)}/mms/send`, body),
      download: (iid: string, mid: string) =>
        http.post<{ ok: true }>(
          `/api/instances/${encodeURIComponent(iid)}/messages/${encodeURIComponent(mid)}/mms/download`,
        ),
      partUrl: (iid: string, mid: string, pid: string) =>
        `${API_BASE}/api/instances/${encodeURIComponent(iid)}/messages/${encodeURIComponent(mid)}/mms/parts/${encodeURIComponent(pid)}`,
    },

    allowance: {
      get: (iid: string) =>
        http.get<{ allowance: Allowance }>(`/api/instances/${encodeURIComponent(iid)}/allowance`),
      save: (iid: string, body: Partial<Allowance>) =>
        http.put<{ allowance: Allowance }>(
          `/api/instances/${encodeURIComponent(iid)}/allowance`,
          body,
        ),
      getQueryRule: (iid: string) =>
        http.get<{ rule: AllowanceQueryRule }>(
          `/api/instances/${encodeURIComponent(iid)}/allowance/query-rule`,
        ),
      saveQueryRule: (iid: string, recipient: string, body: string) =>
        http.put<{ rule: AllowanceQueryRule }>(
          `/api/instances/${encodeURIComponent(iid)}/allowance/query-rule`,
          { recipient, body },
        ),
      /** Resets to the carrier's built-in rule (or to none, when the carrier is unknown). */
      removeQueryRule: (iid: string) =>
        http.del<{ rule: AllowanceQueryRule }>(
          `/api/instances/${encodeURIComponent(iid)}/allowance/query-rule`,
        ),
      /** Sends the query SMS. 409 when no effective rule exists — disable the button first. */
      query: (iid: string, transport: 'auto' | 'vowifi' | 'cellular' = 'auto') =>
        http.post<AllowanceQueryResponse>(
          `/api/instances/${encodeURIComponent(iid)}/allowance/query`,
          { transport },
        ),
    },

    keepalive: {
      get: (iid: string) =>
        http.get<{ keepalive: Keepalive }>(`/api/instances/${encodeURIComponent(iid)}/keepalive`),
      save: (iid: string, body: KeepalivePatch) =>
        http.put<{ keepalive: Keepalive }>(
          `/api/instances/${encodeURIComponent(iid)}/keepalive`,
          body,
        ),
      /**
       * Sends one real, chargeable SMS — the confirm step is mandatory and lives in the view.
       * 409 when a run for this line is already in progress.
       */
      run: (iid: string) =>
        http.post<{ keepalive: Keepalive }>(
          `/api/instances/${encodeURIComponent(iid)}/keepalive/run`,
        ),
      summary: () => http.get<KeepaliveSummary>('/api/keepalive/summary'),
    },

    calls: {
      list: (iid: string) =>
        http.get<CallListResponse>(`/api/instances/${encodeURIComponent(iid)}/calls`),
      /** `all: true` clears the log; otherwise pass the ids to remove. */
      remove: (iid: string, body: { ids?: number[]; all?: boolean }) =>
        http.post<{ ok: true; deleted: number }>(
          `/api/instances/${encodeURIComponent(iid)}/calls/delete`,
          body,
        ),
      /** VoWiFi path: rings the browser endpoint and bridges it to `number` over IMS. */
      dial: (iid: string, number: string, fromEndpoint = 'webrtc') =>
        http.post<{ ok: boolean; error?: string }>(
          `/api/instances/${encodeURIComponent(iid)}/call`,
          { to: number, from_endpoint: fromEndpoint },
        ),
      hangup: (iid: string) =>
        http.post<{ ok: boolean }>(`/api/instances/${encodeURIComponent(iid)}/hangup`),
      /** Separate physical-modem path — works with no softphone registered. */
      cellularDial: (iid: string, number: string) =>
        http.post<{ ok?: boolean; uncertain?: boolean; error?: string; record?: CallRecord }>(
          `/api/instances/${encodeURIComponent(iid)}/cellular-call`,
          { to: number },
        ),
      cellularStatus: (iid: string) =>
        http.get<{ status?: string; error?: string; record?: CallRecord }>(
          `/api/instances/${encodeURIComponent(iid)}/cellular-call/status`,
        ),
      cellularHangup: (iid: string) =>
        http.post<{ ok?: boolean; error?: string; record?: CallRecord }>(
          `/api/instances/${encodeURIComponent(iid)}/cellular-call/hangup`,
        ),
    },

    /**
     * One AT command against the modem behind this line.
     *
     * Runs through ModemManager, so it works while the line is up. A disruptive command is
     * refused with `needs_confirm` unless `confirm` is set — the check is enforced server-side,
     * so the dialog in the UI is a courtesy rather than the control.
     */
    at: (iid: string, command: string, confirm = false) =>
      http.post<AtCommandResult>(`/api/instances/${encodeURIComponent(iid)}/at`, {
        command,
        confirm,
      }),

    voicemails: {
      list: (iid: string) =>
        http.get<{ voicemails: VoicemailRecord[] }>(
          `/api/instances/${encodeURIComponent(iid)}/voicemails`,
        ),
      /** Inline WAV, served for playback in the call log. */
      audioUrl: (iid: string, vid: number) =>
        `${API_BASE}/api/instances/${encodeURIComponent(iid)}/voicemails/${vid}/audio`,
      markListened: (iid: string, vid: number) =>
        http.post<{ ok: true }>(
          `/api/instances/${encodeURIComponent(iid)}/voicemails/${vid}/listened`,
        ),
      remove: (iid: string, body: { ids?: number[]; all?: boolean }) =>
        http.post<{ deleted: number }>(
          `/api/instances/${encodeURIComponent(iid)}/voicemails/delete`,
          body,
        ),
    },
  },

  esim: {
    /**
     * Every eUICC the gateway knows about.
     *
     * Without `refresh` this reads the cache and touches no card. With it, every reader is
     * read — exclusive and serialised, and it takes the reader from any running engine.
     */
    inventory: (refresh = false) =>
      http.get<EsimInventory>('/api/esim/inventory', { refresh: refresh ? 1 : undefined }),

    /** Whether lpac is installed. Everything else must be hidden when `available` is false. */
    status: () => http.get<EsimStatus>('/api/esim/status'),
    /** Never touches the card, so it is safe while a VoWiFi line holds the reader. */
    cachedChip: (readerIndex = 0) =>
      http.get<EsimCachedChip>('/api/esim/chip/cached', { reader_index: readerIndex }),
    chip: (readerIndex = 0) => http.get<EsimCardView>('/api/esim/chip', { reader_index: readerIndex }),
    profiles: (readerIndex = 0) =>
      http.get<EsimCardView>('/api/esim/profiles', { reader_index: readerIndex }),
    enable: (iccid: string, body: Record<string, unknown> = {}) =>
      http.post<{ ok: true; iccid: string; se_id: string }>(
        `/api/esim/profiles/${encodeURIComponent(iccid)}/enable`,
        body,
      ),
    disable: (iccid: string, body: Record<string, unknown> = {}) =>
      http.post<{ ok: true; iccid: string; se_id: string }>(
        `/api/esim/profiles/${encodeURIComponent(iccid)}/disable`,
        body,
      ),
    remove: (iccid: string, query?: { reader_index?: number; se_id?: string; aid?: string }) =>
      http.del<{ ok: true; iccid: string; se_id: string }>(
        `/api/esim/profiles/${encodeURIComponent(iccid)}`,
        query,
      ),
    nickname: (iccid: string, nickname: string, body: Record<string, unknown> = {}) =>
      http.post<{ ok: true; iccid: string; nickname: string; se_id: string }>(
        `/api/esim/profiles/${encodeURIComponent(iccid)}/nickname`,
        { ...body, nickname },
      ),
    /** Background job; progress arrives over the `esim_download` WebSocket event. */
    download: (body: Record<string, unknown>) =>
      http.post<{ ok: boolean }>('/api/esim/download', body),
    cancelDownload: (body: Record<string, unknown> = {}) =>
      http.post<{ ok: true; cancelled: boolean }>('/api/esim/download/cancel', body),
    discovery: (body: Record<string, unknown> = {}) =>
      http.post<{ ok: true; reader: string; se_id: string; entries: EsimDiscoveryEntry[]; imei: string }>(
        '/api/esim/discovery',
        body,
      ),
    notifications: (readerIndex = 0) =>
      http.get<{ ok: true; reader: string; dual: boolean; notifications: EsimNotification[] }>(
        '/api/esim/notifications',
        { reader_index: readerIndex },
      ),
    processNotifications: (body: Record<string, unknown> = {}) =>
      http.post<{ ok: true; se_id: string }>('/api/esim/notifications/process', body),
    removeNotification: (
      seq: number,
      query?: { reader_index?: number; se_id?: string; aid?: string },
    ) =>
      http.del<{ ok: true; seq: number; se_id: string }>(`/api/esim/notifications/${seq}`, query),
  },

  sim: {
    detect: (readerIndex: number) => http.get<{ card: SimCardInfo }>('/api/sim/detect', { reader_index: readerIndex }),
    verifyPin: (body: { reader_index: number; pin: string }) =>
      http.post<Record<string, unknown>>('/api/sim/verify-pin', body),
    changePin: (body: Record<string, unknown>) => http.post<Record<string, unknown>>('/api/sim/change-pin', body),
    setPinEnabled: (body: Record<string, unknown>) =>
      http.post<Record<string, unknown>>('/api/sim/pin-enabled', body),
  },

  hardware: {
    readers: () => http.get<ReadersResponse>('/api/readers'),
    cards: () => http.get<{ cards: SimCardInfo[] }>('/api/cards'),
    suggestPorts: () => http.get<Record<string, unknown>>('/api/ports/suggest'),
    provision: (body: Record<string, unknown>) => http.post<Record<string, unknown>>('/api/provision', body),
  },

  egress: {
    status: () => http.get<EgressStatus>('/api/egress/status'),
    /** Drops the cached subscription and asks the host orchestrator to republish. */
    refresh: () => http.post<{ ok: true; requested_at: number }>('/api/egress/refresh'),
    /** Only `node` and `socks5` profiles can be tested; a subscription cannot be dialled. */
    testProfile: (profileId: string, body?: Record<string, unknown>) =>
      http.post<EgressProfileTest>(
        `/api/egress/profile/${encodeURIComponent(profileId)}/test`,
        body ?? {},
      ),
    /**
     * Every non-direct exit is UDP-verified, because IKEv2/ESP NAT-T needs UDP 500/4500
     * reachable — a node that passes a TCP probe can still never carry a VoWiFi tunnel.
     * This waits up to 25s for the exit to become ready, so it is a slow call by design.
     */
    testCountry: (country: string) =>
      http.post<EgressTestResult>(`/api/egress/${encodeURIComponent(country)}/test`),
  },

  settings: {
    get: () => http.get<Settings>('/api/settings'),
    /**
     * Shallow top-level merge on the server: send only the keys being changed. Each nested
     * object inside a sent key is replaced wholesale, so send it complete. Returns the
     * stored document, which is what the UI re-baselines against.
     */
    save: (patch: SettingsPatch) => http.put<Settings>('/api/settings', patch),
  },

  notifications: {
    /**
     * Each test builds the payload for one event and delivers it. `event` picks which
     * template renders; it defaults to the incoming-SMS event.
     */
    testWebhook: (event?: string) =>
      http.post<NotificationTestResult>(
        '/api/notifications/webhook/test',
        event ? { _test_event: event } : {},
      ),
    testTelegram: (event?: string) =>
      http.post<NotificationTestResult>(
        '/api/notifications/telegram/test',
        event ? { _test_event: event } : {},
      ),
    testPushplus: (event?: string) =>
      http.post<NotificationTestResult>(
        '/api/notifications/pushplus/test',
        event ? { _test_event: event } : {},
      ),
    testBark: (event?: string) =>
      http.post<NotificationTestResult>(
        '/api/notifications/bark/test',
        event ? { _test_event: event } : {},
      ),
    testEmail: (event?: string) =>
      http.post<NotificationTestResult>(
        '/api/notifications/email/test',
        event ? { _test_event: event } : {},
      ),
    testFeishu: (event?: string, body?: Record<string, unknown>) =>
      http.post<NotificationTestResult>('/api/notifications/feishu/test', {
        ...(body ?? {}),
        ...(event ? { _test_event: event } : {}),
      }),
    /** In-flight plus completed deliveries. Bodies and credentials are never recorded. */
    deliveries: (limit?: number) =>
      http.get<NotificationDeliveries>('/api/notifications/deliveries', { limit }),
    clearDeliveries: () => http.del<{ ok: true }>('/api/notifications/deliveries'),
  },

  system: {
    status: () => http.get<SystemStatus>('/api/system/status'),
    clearHostAlerts: () => http.del<{ ok: true }>('/api/system/host-alerts'),
    updateCheck: (force?: boolean) =>
      http.get<UpdateCheck>('/api/system/update/check', force ? { force: true } : undefined),
    releases: (force?: boolean) =>
      http.get<{ releases: UpdateRelease[] }>(
        '/api/system/update/releases',
        force ? { force: true } : undefined,
      ),
    repositoryStars: () => http.get<{ stars: number }>('/api/system/repository/stars'),
    applyUpdate: (body: Record<string, unknown>) =>
      http.post<{ ok: true }>('/api/system/update/apply', body),
    updateProgress: () => http.get<Record<string, unknown>>('/api/system/update/progress'),
    cancelUpdate: () => http.post<{ ok: true }>('/api/system/update/cancel'),
    createBackup: () => http.post<Record<string, unknown>>('/api/system/backups'),
    removeBackup: (name: string) =>
      http.del<{ ok: true }>(`/api/system/backups/${encodeURIComponent(name)}`),
    maintenance: (body: Record<string, unknown>) =>
      http.post<{ ok: true }>('/api/system/maintenance', body),
    restartProgress: () =>
      http.get<Record<string, unknown>>('/api/system/maintenance/restart-progress'),
    supportBundleUrl: () => `${API_BASE}/api/diagnostics/support-bundle`,
  },
}
