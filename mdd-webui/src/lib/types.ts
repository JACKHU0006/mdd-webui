/**
 * API contract for the MDD Sim Gateway control plane.
 *
 * Derived from `control/app/main.py` (105 routes), `control/app/auth.py` and the
 * WebSocket hub. Field names match the Python responses exactly — do not rename
 * them to camelCase, the client is a thin typed wrapper over the wire format.
 *
 * Where a field is present only under some conditions it is marked optional and
 * the condition is stated, rather than guessed at.
 */

/* ------------------------------------------------------------------ auth */

/** `GET /api/auth/status` — public, needs no session. */
export interface AuthStatus {
  /** False until an administrator has been created; the UI must offer setup. */
  configured: boolean
  authenticated: boolean
  /** The configured administrator name, for pre-filling the login field. */
  username: string
  /** Session CSRF token. Empty string when there is no live session. */
  csrf: string
}

/** Body of `POST /api/auth/setup` (first-run) and `POST /api/auth/login`. */
export interface LoginRequest {
  username: string
  password: string
  /** Extends the session from 12 hours to 30 days. */
  remember?: boolean
}

/** Response of `POST /api/auth/setup` and `POST /api/auth/login`. */
export interface LoginResponse {
  ok: true
  authenticated: true
  csrf: string
}

/**
 * Response of `POST /api/auth/password`.
 *
 * The control plane clears every session and deletes the cookie, so the caller must
 * return to the login screen rather than stay in the console.
 */
export interface PasswordChangeResponse {
  ok: true
  reauthenticate: true
}

/* --------------------------------------------------------------- devices */

/**
 * A physical device. Two kinds share one shape:
 *  - `modem`  — a cellular module (ModemManager object, has radio)
 *  - `reader` — a plain PC/SC smart-card reader (VoWiFi only, no radio)
 */
export type DeviceType = 'modem' | 'reader'

/** Whether a capability is on, off, moving, broken, or impossible on this hardware. */
export type CapabilityActual = 'on' | 'off' | 'starting' | 'stopping' | 'error' | 'unsupported'

/**
 * The three radio-ish states are independent by design: the 4G switch only owns the
 * mobile-data bearer, flight mode owns the RF, VoWiFi starts and stops on its own.
 * One failing must never be rendered as another failing.
 */
export interface DeviceDesired {
  cellular_enabled: boolean
  vowifi_enabled: boolean
  flight_mode: boolean
}

export interface CapabilityView {
  desired?: boolean
  actual?: CapabilityActual
  available: boolean
  /** Human-readable reason when `available` is false or `actual` is `error`. */
  reason?: string
}

/** One of the three logical channels reserved on a modem's UICC (1–3). */
export interface LogicalChannel {
  index: number
  /** `pin` | `swu` | `ims` on a modem; empty for a native reader. */
  purpose?: string
  allocated?: boolean
  capacity?: number
  error?: string
}

/**
 * The carrier identity the engine reports for a registered line.
 *
 * Older builds said `operator` was a plain string. The engine actually answers with this
 * object (AT+COPS / AT+QOPL style fields: the matched name, the home network, the PLMN digits),
 * so rendering it as text threw "objects are not valid as a React child" and blanked the page.
 */
export interface NetworkIdentity {
  name?: string
  home_network?: string
  plmn?: string
  match_source?: string
  specific?: boolean
  database?: string
  database_version?: string
  current_network?: string
}

export interface CellularView {
  registration: string
  /** A bare name on some builds, the full identity object on others. */
  operator: string | NetworkIdentity | null
  /** dBm, or null when the module has not reported yet. */
  signal: number | null
  apn: string
  ip: string
  data_active: boolean
  roaming: boolean
  rx_bytes: number
  tx_bytes: number
  profile: string
  interface: string
}

export interface DeviceVowifiView {
  /** ePDG address as reported by the engine status. */
  epdg: string
  /** IMS registration label. */
  ims: string
  rekey_minutes: number
  ike_rekey_minutes: number
}

export interface DeviceEgressView {
  node: string
  pinned_node: string
  pin_mode: string
  selection: string
  [key: string]: unknown
}

export interface DeviceSimView {
  name: string
  number: string
  present: boolean
  /** A bare carrier name on some builds, the matched identity object on others. */
  carrier: string | NetworkIdentity | null
}

export interface Device {
  id: string
  device_type: DeviceType
  name: string
  present: boolean
  model: string
  firmware: string
  imei: string
  imei_masked: string
  /** Stable USB path binding, so a reader keeps its identity across re-enumeration. */
  stable_path: string
  /** PC/SC reader name; empty for modems. */
  reader: string
  /** The SIM line provisioned for this device, if any. */
  instance_id: string | null
  status: LineStatus | null
  logical_channels: LogicalChannel[]
  sim: DeviceSimView
  /** null for readers and for VoWiFi-only hosts. */
  cellular: CellularView | null
  vowifi: DeviceVowifiView
  egress: DeviceEgressView
  capabilities: {
    cellular: CapabilityView
    vowifi: CapabilityView
    flight_mode: CapabilityView
  }
  desired: DeviceDesired
}

/** `GET /api/devices` */
export interface DevicesResponse {
  devices: Device[]
  /** True while the first card scan is still running — render "scanning", not a confident 0. */
  discovering: boolean
  shared: Record<string, unknown>
}

/** `PATCH /api/devices/{id}/capabilities` */
export interface CapabilityPatch {
  cellular_enabled?: boolean
  vowifi_enabled?: boolean
  flight_mode?: boolean
}

/* -------------------------------------------------------------- instances */

/**
 * A provisioned SIM line. One line per physical SIM; the engine container is
 * created per line and lives in its own isolated Docker engine.
 */
export interface LineStatus {
  state: string
  label?: string
  detail?: string
  [key: string]: unknown
}

export interface Instance {
  id: string
  name: string
  enabled?: boolean
  /** Removed from the response — use `has_pin`. */
  has_pin: boolean
  /** Country chosen for the egress exit; falls back to the SIM's MCC when unset. */
  proxy_country_effective: string
  /** Reader index that PHYSICALLY holds this SIM right now, ICCID-matched. */
  reader_index?: number
  /** Stable USB port of the reader currently holding this SIM. */
  reader_port?: string
  iccid?: string
  imsi?: string
  msisdn?: string
  /** `draft` while automatic provisioning is waiting on SIM or hardware info. */
  provisioning_state?: string
  rekey_minutes?: number
  ike_rekey_minutes?: number
  status: LineStatus
  /** `POST /api/instances` only: true when the config was re-applied to a running engine. */
  applied?: boolean
  [key: string]: unknown
}

/** Fields the line editor may send. Everything else is engine-owned. */
export interface InstancePatch {
  id: string
  name?: string
  enabled?: boolean
  iccid?: string
  imsi?: string
  msisdn?: string
  mcc?: string
  mnc?: string
  imei?: string
  imeisv?: string
  smsc?: string
  pcscf?: string
  apn?: string
  /**
   * ePDG identity encoding for the SWu tunnel: `apn` (bare APN, the proven-safe default)
   * or `fqdn` for ePDGs that require the operator APN-FQDN.
   */
  idr_mode?: 'apn' | 'fqdn' | ''
  /** SWu CFG request address family; `auto` uses the discovery ladder + carrier DB. */
  cp_mode?: 'auto' | 'v4' | 'v6' | 'dual' | ''
  /** Overrides the global ESP rekey period. 0 disables proactive rekey. */
  rekey_minutes?: number
  /** Overrides the global IKE SA rekey period. 0 disables proactive rekey. */
  ike_rekey_minutes?: number
  accept_epdg_esp_rekey?: boolean
  /** Re-entry only. A blank value never clears the stored PIN. */
  pin?: string
  sip?: {
    user_agent?: string
    /** Some IMS cores need `;user=phone` on request URIs before they route a voice INVITE. */
    user_eq_phone?: boolean
    pani?: string
    access_type?: string
    ring_timeout?: number
    vm_enabled?: boolean
    vm_ring_seconds?: number
    vm_max_seconds?: number
    webrtc?: { enable?: boolean; username?: string; password?: string }
    /** Stored, but the control plane always writes this back as an empty list. */
    external?: unknown[]
    [key: string]: unknown
  }
  [key: string]: unknown
}

/** `GET /api/instances` */
export interface InstancesResponse {
  instances: Instance[]
}

/** `POST /api/instances` — upsert. `applied` says whether a restart happened. */
export interface InstanceUpsertResponse extends Instance {
  applied?: boolean
}

/** `PUT /api/instances/{iid}/country` */
export interface CountryResponse {
  ok: true
  /** The stored value; empty string means "fall back to MCC auto-detection". */
  country: string
  /** What the orchestrator will actually use right now. */
  effective_country: string
  applied: boolean
}

/* --------------------------------------------------- availability timeline */

/** Segment states: `up`, `down`, `off`, or `unknown` for a monitoring gap. */
export type LineSegmentState = 'up' | 'down' | 'off' | 'unknown'

export interface LineSegment {
  state: LineSegmentState
  /** Unix seconds. */
  start: number
  end: number
  reason?: string
  detail?: string
}

export interface LineAvailabilitySummary {
  up: number
  down: number
  off: number
  /** Time the control plane was not watching. Never counted as availability. */
  unknown: number
  observed_seconds: number
  outages: number
  longest_outage_seconds: number
  /** `up / (up + down)`, or null when nothing has been observed yet. */
  uptime_ratio: number | null
}

/** `GET /api/instances/{iid}/availability` */
export interface LineAvailability {
  instance: string
  start: number
  end: number
  span_seconds: number
  max_span_seconds: number
  /** Oldest retained observation, or null when nothing was ever recorded. */
  recorded_since: number | null
  segments: LineSegment[]
  summary: LineAvailabilitySummary
}

/** `GET /api/instances/{iid}/status` */
export interface LineStatusView {
  state: string
  label?: string
  reason_code?: string
  reason?: string
  detail?: Record<string, unknown>
  /** Retry budget for the health policy, when a line is being rebuilt. */
  retry?: { attempt?: number; max?: number; next_in?: number; [key: string]: unknown }
  active_channels?: unknown
  registration?: unknown
  retry_budget?: number
  [key: string]: unknown
}

/* ------------------------------------------------------ engine logs/register */

/**
 * `GET /api/instances/{iid}/logs`.
 *
 * Three distinct streams, deliberately not merged: `engine` is the container's own stdout,
 * `charon` is the strongSwan daemon log and `diagnostics` is the control plane's own
 * append-only verdict log — which is the only one that survives a container rebuild.
 */
export interface EngineLogs {
  engine: string
  charon: string
  diagnostics: string
}

/** `POST /api/instances/{iid}/register` */
export interface RegisterResponse {
  output: string
}

/* ---------------------------------------------------------- softphone (VoWiFi) */

/** `GET /api/instances/{iid}/softphone` — provisioning for JsSIP over WSS. */
export interface SoftphoneProvisioning {
  enabled: boolean
  username: string
  password: string
  /**
   * v1.14.1 起的后端不再暴露引擎自己的 WSS 端口：信令统一走控制面的同源 relay。
   * 返回的是 relay 的路径（`/api/instances/{iid}/softphone/ws`），浏览器直接用当前
   * 页面的 origin 连它即可，不需要额外端口，也不需要第二张证书。
   */
  ws_path?: string
  /** 旧后端（引擎直连 WSS 端口）才会带这个字段，仅作退路。 */
  ws_port?: number
  /** Hostname the browser should dial; derived from the request Host header. */
  host: string
  /** SIP realm, derived from MCC/MNC. */
  realm?: string
  domain?: string
  [key: string]: unknown
}

/* -------------------------------------------------------------------- calls */

export type CallDirection = 'in' | 'out'
/** `vowifi` rides the IMS softphone; `cellular` goes out over the physical modem. */
export type CallTransport = 'vowifi' | 'cellular'

export interface CallRecord {
  id: number
  instance: string
  direction: CallDirection
  peer: string
  /** `ringing` | `answered` | `ended` | `missed` | `rejected` | `unknown` | … */
  status: string
  /** Unix seconds. */
  start_ts: number
  /** Unix seconds; null while the call is still open. */
  end_ts?: number | null
  transport?: CallTransport
  /** A carrier USSD reply captured on this call, e.g. from a service code. */
  ussd_text?: string
  [key: string]: unknown
}

/** `GET /api/instances/{iid}/calls` */
export interface CallListResponse {
  calls: CallRecord[]
}

export interface VoicemailRecord {
  id: number
  instance: string
  peer: string
  /** Unix seconds. */
  ts: number
  duration_seconds: number
  size_bytes: number
  listened: boolean
  [key: string]: unknown
}

/**
 * `POST /api/instances/{iid}/at`
 *
 * `blocked` means the server refused the command and it never ran — the request comes back as
 * a 403, so a client that ignores it cannot mistake the refusal for a result. `needs_confirm`
 * means the command is disruptive but permitted: it runs only when the same request is
 * repeated with `confirm: true`. Both carry a `reason` meant to be shown verbatim.
 */
export interface AtCommandResult {
  ok: boolean
  /** The normalised (uppercased) form that was actually sent. */
  command: string
  /** The module's own words, including `ERROR`. */
  response: string
  error: string
  blocked: boolean
  needs_confirm: boolean
  reason: string
}

/* ------------------------------------------------- balance, allowance, keepalive */

/**
 * The allowance snapshot. Every field is a display string on purpose — carriers word
 * balances and units differently and normalising them away loses real information.
 */
export interface Allowance {
  instance: string
  /** e.g. `12.40 GBP`. Displayed, never converted. */
  balance: string
  /** Carrier-formatted expiry, normally normalised to `YYYY-MM-DD`. */
  valid_until: string
  sms_remaining: string
  data_remaining: string
  voice_remaining: string
  /** `YYYY-MM-DD`. */
  activated_at: string
  /** Unix seconds of the last update, or null when never set. */
  updated_ts?: number | null
  /** `manual` or `sms`. */
  source?: string
  [key: string]: unknown
}

/** The rule that asks the carrier for the balance. */
export interface AllowanceQueryRule {
  /** Carrier key the rule was resolved from, e.g. `ultramobile`. */
  carrier_key: string
  carrier_label: string
  /** True when the carrier ships a built-in rule. */
  known: boolean
  /** True when an operator has overridden it for this line. */
  custom: boolean
  /** null when no rule is known and none was set — the query button must stay disabled. */
  effective: { recipient: string; body: string } | null
  default: { recipient: string; body: string } | null
}

/** `POST /api/instances/{iid}/allowance/query` */
export interface AllowanceQueryResponse {
  ok: boolean
  query: { id: number; status: string; recipient: string; body: string; started_ts: number }
  rule: AllowanceQueryRule
  send: SmsSendResult
  [key: string]: unknown
}

/** Shared by SMS send, allowance query and keepalive — `transport` says which path ran. */
export interface SmsSendResult {
  ok: boolean
  error?: string | null
  transport?: 'vowifi' | 'cellular'
  requested_transport?: 'auto' | 'vowifi' | 'cellular'
  /** True when the submission went out but was never acknowledged — unknown, not failed. */
  uncertain?: boolean
  /** True when IMS accepted it but the SMSC report has not landed yet. */
  pending_delivery?: boolean
  [key: string]: unknown
}

export type KeepaliveAction = 'sms' | 'balance_watch'

export interface Keepalive {
  enabled: boolean
  action: KeepaliveAction
  sms_to: string
  sms_body: string
  /** Compare the balance before and after the chargeable SMS. */
  verify_charge: boolean
  /** Balance-watch threshold, as display text. Empty means show without judging. */
  threshold: string
  interval_days: number
  /** Unix seconds of the next owed run; 0 when disabled. */
  next_due_ts: number
  /** The same instant as a local calendar date, so the date field round-trips exactly. */
  next_run_date: string
  last_run_ts?: number
  /** `ok` | `sent_unconfirmed` | `failed` | `balance_low`. */
  last_status?: string
  last_detail?: string
  balance_low_since?: number
  [key: string]: unknown
}

export interface KeepalivePatch {
  enabled: boolean
  action: KeepaliveAction
  sms_to: string
  sms_body: string
  verify_charge: boolean
  threshold: string
  interval_days: number
  /** `YYYY-MM-DD`; omit to keep the current schedule. */
  next_run_date?: string
}

/** One row of `GET /api/keepalive/summary` — the whole page in one request. */
export interface KeepaliveSummaryRow {
  instance: string
  name: string
  msisdn: string
  country: string
  carrier: string
  enabled: boolean
  /**
   * Whether this SIM is physically in the gateway right now. A SIM that is out of the box
   * cannot be sent anything, so offering it a switch would promise the undeliverable —
   * although its expiry still matters, since an unused SIM is the one a carrier reclaims.
   */
  in_gateway: boolean
  state: string
  label: string
  reason_code: string
  last_registered_ts: number
  /** Observed uptime over the retained window; null when nothing was recorded. */
  uptime_ratio: number | null
  uptime_span_seconds: number
  allowance: Allowance
  /** Negative once expired. Null when `valid_until` could not be parsed. */
  days_to_expiry: number | null
  has_query_rule: boolean
  keepalive: Keepalive
}

/** `GET /api/keepalive/summary` */
export interface KeepaliveSummary {
  lines: KeepaliveSummaryRow[]
  /** Server time, so "due in" is computed against the gateway clock, not the browser's. */
  now: number
}

/* --------------------------------------------------------------------- esim */

/**
 * One profile as lpac reports it.
 *
 * The field names are lpac's own camelCase, not snake_case, because `lpa.profile_list` passes
 * the tool's parsed JSON straight through — the control plane only ever adds `seId`/`seLabel`.
 * Renaming them here would mean the view silently reads `undefined` for every field, so they
 * are declared exactly as they arrive.
 */
export interface EsimProfile {
  iccid: string
  /** The operator's chosen label. Takes priority over the carrier's own name. */
  profileNickname?: string
  /** Carrier-assigned profile name, e.g. `Demo Mobile`. */
  profileName?: string
  serviceProviderName?: string
  /** `enabled` | `disabled` — compared case-insensitively, because lpac's casing varies. */
  profileState?: string
  /** The eUICC's own classification, e.g. `operational` | `test` | `provisioning`. */
  profileClass?: string
  /** The SE this profile lives on, stamped on by `load_all_ses`. */
  seId?: string
  seLabel?: string
  seEid?: string | null
  [key: string]: unknown
}

/** One Secure Element on a card; a dual-SE card reports two. */
export interface EsimSecureElement {
  id: string
  label?: string
  aid?: string
  eid?: string | null
  /** Free non-volatile memory, in bytes. */
  freeSpace?: number | null
  defaultDpAddress?: string | null
  rootDsAddress?: string | null
  chip?: EsimChipInfo
  profiles?: EsimProfile[]
  notifications?: EsimNotification[]
  /** Set when this SE could not be read; the other SE on a dual card may still have loaded. */
  error?: string | null
  [key: string]: unknown
}

export interface EsimChipInfo {
  eid?: string
  /** `freeNonVolatileMemory` is where the free space lives inside the chip payload. */
  freeNonVolatileMemory?: number
  defaultDpAddress?: string
  rootDsAddress?: string
  production?: Record<string, unknown>
  certificates?: Record<string, unknown>
  [key: string]: unknown
}

/** One queued notification. The eUICC holds these until something forwards them to the SM-DP+. */
export interface EsimNotification {
  seq: number
  /** Notification event, e.g. `install` | `enable` | `disable` | `delete`. */
  event?: string
  address?: string
  iccid?: string
  seId?: string
  seLabel?: string
  [key: string]: unknown
}

/** `GET /api/esim/status` */
export interface EsimStatus {
  /** False when lpac is not installed — every other eSIM action must then be hidden. */
  available: boolean
  lpac_bin: string
  download_timeout: number
  auto_process_notifications: boolean
  /** Readers with an lpac operation in flight. lpac is single-threaded, so this gates the UI. */
  busy_readers: string[]
}

/** `GET /api/esim/chip` and `GET /api/esim/profiles`. */
export interface EsimCardView {
  ok: true
  reader: string
  reader_index: number
  dual: boolean
  ses: EsimSecureElement[]
  /** `/chip` only: first SE that loaded successfully. */
  chip?: EsimChipInfo
  /** `/profiles` only: every profile across every SE, flattened. */
  profiles?: EsimProfile[]
  imei: string
  /** True when a VoWiFi line currently holds this reader, so a switch will interrupt it. */
  line_running: boolean
  matched_instance?: string | null
  lpa_busy?: boolean
}

/** `GET /api/esim/chip/cached` — never touches the card. */
export interface EsimCachedChip {
  ok: true
  cached: boolean
  reader: string
  reader_index: number
  ses?: EsimSecureElement[]
  imei?: string
  /** Unix seconds of the cached read. */
  ts?: number
}

export interface EsimDiscoveryEntry {
  matching_id?: string
  smdp?: string
  [key: string]: unknown
}

/* ------------------------------------------------------------------- egress */

/** Why an exit never became testable — three different problems, three different fixes. */
export interface EgressExit {
  ready: boolean
  /** `direct` | `socks` | `node` | `subscription` — direct exits are never UDP tested. */
  mode?: string
  node?: string
  pinned_node?: string
  pin_mode?: string
  /** `auto` | `manual` — `manual` is a deliberate lock and is never auto-moved. */
  selection?: string
  error?: string
  interface?: string
  proxy_host?: string
  proxy_port?: number
  enabled?: boolean
  /** Node names the subscription currently offers, for the pinned-node picker. */
  candidates?: string[]
  /**
   * The pinned node is no longer offered by its subscription, so automatic selection is in use.
   * Surfaced separately from `error` because the exit still works — the operator's *choice*
   * is what stopped applying, and that distinction decides whether they need to act.
   */
  pinned_missing?: boolean
  [key: string]: unknown
}

export interface EgressLine {
  node?: string
  ready?: boolean
  error?: string
  [key: string]: unknown
}

/**
 * `GET /api/egress/status`.
 *
 * Every non-direct exit is UDP-verified, because IKEv2/ESP NAT traversal needs UDP 500/4500
 * reachable — a TCP-only check would pass a node that can never carry a VoWiFi tunnel. A
 * node that fails is reported as failing, never as merely slow.
 */
export interface EgressStatus {
  /** Unix seconds the host orchestrator last published; 0/absent means it is not running. */
  updated_at?: number
  enabled?: boolean
  /** Keyed by lowercase country code, e.g. `jp`. */
  exits: Record<string, EgressExit>
  /** Keyed by line id. */
  lines: Record<string, EgressLine>
  [key: string]: unknown
}

/** `POST /api/egress/{country}/test` */
export interface EgressTestResult {
  ok: true
  country: string
  node: string
  interface: string
  latency_ms: number
}

/* ----------------------------------------------------------- notifications */

export interface WebhookChannel {
  enabled?: boolean
  /** `generic` or `slack`/`discord`-style preset — the control plane owns the vocabulary. */
  format?: string
  method?: string
  body_mode?: string
  url?: string
  /** A JSON document as text, so the form can preserve whatever the operator pasted. */
  headers_json?: string
  payload_template?: string
  message_templates?: Record<string, NotificationEventTemplate>
  verify_tls?: boolean
  events?: Record<string, boolean>
  [key: string]: unknown
}

export interface TelegramChannel {
  enabled?: boolean
  bot_token?: string
  chat_id?: string
  /** `direct` | `library` | `country` | `manual`. */
  proxy_mode?: string
  proxy_profile_id?: string
  proxy_url?: string
  proxy_country?: string
  message_templates?: Record<string, NotificationEventTemplate>
  events?: Record<string, boolean>
  [key: string]: unknown
}

export interface PushplusChannel {
  enabled?: boolean
  token?: string
  topic?: string
  /** `html` | `txt` | `markdown` | `json`. */
  template?: string
  channel?: string
  message_templates?: Record<string, NotificationEventTemplate>
  events?: Record<string, boolean>
  [key: string]: unknown
}

/**
 * One Feishu/Lark destination. As soon as `channels` is non-empty it owns delivery, and the
 * legacy top-level `url` stops being used — otherwise a multi-channel setup would fan out
 * twice.
 */
export interface FeishuChannelEntry {
  id: string
  name?: string
  url: string
  secret?: string
  /** Line ids this destination should receive; empty means every line. */
  instances?: string[]
  enabled?: boolean
  message_templates?: Record<string, NotificationEventTemplate>
  events?: Record<string, boolean>
  [key: string]: unknown
}

export interface FeishuChannel {
  enabled?: boolean
  url?: string
  secret?: string
  channels?: FeishuChannelEntry[]
  message_templates?: Record<string, NotificationEventTemplate>
  events?: Record<string, boolean>
  [key: string]: unknown
}

/** One row of the delivery log. Bodies and credentials are never recorded. */
export interface NotificationDelivery {
  id?: string
  created_at?: number
  finished_at?: number
  channel?: string
  event?: string
  instance?: string
  /** `pending` | `ok` | `failed`. */
  status?: string
  attempts?: number
  status_code?: number
  error?: string
  [key: string]: unknown
}

/** `GET /api/notifications/deliveries` */
export interface NotificationDeliveries {
  /** In-flight deliveries, oldest first. */
  pending: NotificationDelivery[]
  /** Completed deliveries, newest first. */
  history: NotificationDelivery[]
}

/** A test delivery's outcome, shared by all four channel test endpoints. */
export interface NotificationTestResult {
  ok?: boolean
  status_code?: number
  error?: string
  [key: string]: unknown
}

/* --------------------------------------------------------------- messages */

export interface SmsMessage {
  id: string
  peer: string
  body: string
  /** Unix seconds. */
  timestamp: number
  inbound: boolean
  unread?: boolean
  /** Delivery state for outbound messages. */
  delivery?: string
  /** True when the body is a multipart/MMS reference rather than plain text. */
  binary?: boolean
  [key: string]: unknown
}

export interface MessageThread {
  peer: string
  /**
   * The newest message in the thread. The engine omits it for a thread it has a peer for
   * but no retained message body (for example right after a SIM swap), so every read site
   * has to tolerate a missing `last` instead of assuming `last.timestamp` exists.
   */
  last?: SmsMessage | null
  count: number
  unread: number
}

/* -------------------------------------------------------------------- sms */

export interface SendSmsRequest {
  to: string
  body: string
}

/* ------------------------------------------------------------------- esim */

/* EsimProfile / EsimChipInfo / EsimCardView live in the eSIM section above,
 * beside the rest of the lpac contract. */

/* ----------------------------------------------------------------- system */

export interface HostAlert {
  id?: string
  level?: string
  message: string
  [key: string]: unknown
}

export interface SystemStatus {
  /** Control-plane version, e.g. "1.10.0". */
  version?: string
  hostname?: string
  /** Free space etc. — the shape is owned by `sysinfo.py`. */
  [key: string]: unknown
}

export interface UpdateRelease {
  version: string
  kind?: string
  published_at?: string
  notes?: string
  [key: string]: unknown
}

export interface UpdateCheck {
  current?: string
  latest?: string
  available?: boolean
  channel?: string
  [key: string]: unknown
}

/* EgressExit / EgressStatus live in the egress section above. */

/* --------------------------------------------------------------- settings */

/**
 * The control plane persists one settings document, and `GET /api/settings` returns all
 * of it except `system_name` (which the product owns and `PUT` silently drops).
 *
 * How `PUT /api/settings` behaves — this dictates the whole save strategy:
 *
 *  - `config.update_settings()` is a **shallow top-level `update()`**. Sending only the
 *    keys that changed is therefore safe: an untouched top-level key is not reset. (The
 *    old note in this file claiming the document is replaced wholesale was wrong.)
 *  - A nested object *is* replaced wholesale. Every nested object the UI edits must be
 *    sent complete, or its siblings vanish.
 *  - `hardware` is the one exception: the route merges it with the stored value first, so
 *    a backend-only patch cannot wipe `modem_profiles`.
 *  - Validation is per-key and answers `400 {"detail": "..."}`; `proxy`, `updates`,
 *    `webhook`, `telegram`, `pushplus`, `feishu` and `hardware` each have their own rules.
 */
export interface Settings {
  /** IANA zone name; the control plane rejects anything `ZoneInfo` cannot load. */
  timezone?: string
  device_defaults?: DeviceDefaults
  hardware?: HardwareSettings
  rekey?: RekeySettings
  retry?: RetrySettings
  debug?: DebugSettings
  security?: SecuritySettings
  maintenance?: MaintenanceSettings
  esim?: EsimSettings
  /** Seconds an outgoing call rings before the engine CANCELs it. */
  ring_timeout?: number
  vm_enabled?: boolean
  vm_ring_seconds?: number
  vm_max_seconds?: number
  proxy?: ProxySettings
  updates?: UpdateSettings
  webhook?: NotificationChannel
  telegram?: NotificationChannel
  pushplus?: NotificationChannel
  feishu?: NotificationChannel
  [key: string]: unknown
}

/** Body of `PUT /api/settings`. Any subset of the top-level keys. */
export type SettingsPatch = Partial<Settings>

/** Capabilities a newly discovered device starts with. */
export interface DeviceDefaults {
  cellular_enabled?: boolean
  vowifi_enabled?: boolean
  /** Accepted by the control plane although absent from the shipped defaults. */
  flight_mode?: boolean
}

export interface HardwareSettings {
  /** Probe USB for known modem profiles on every reconcile pass. */
  auto_detect?: boolean
  /**
   * `auto` runs ModemManager and exposes the full feature set. `serial` never runs it, so
   * the SIM bridges drive the AT port directly: VoWiFi keeps working, but cellular data,
   * flight mode and cellular SMS do not. Intended for hosts where ModemManager's modem
   * objects are unstable.
   */
  modem_backend?: 'auto' | 'serial'
  /** Logical VPCD slots reserved per modem; three is what the engine expects. */
  vpcd_slots?: number
  /**
   * USB `(vid, pid)` pairs the host orchestrator treats as cellular modems. Matched in
   * `host/mdd_orchestrator.py::usb_modems()`, which then looks for a `ttyUSB*`/`ttyACM*`
   * on the interface named by `at_interface`.
   *
   * A stock DJI Cellular Dongle is `2ca3:4006` (Quectel EG25-G) and needs an entry here
   * before the orchestrator will acknowledge it at all.
   */
  modem_profiles?: ModemProfile[]
  [key: string]: unknown
}

export interface ModemProfile {
  name: string
  /** Lowercase hex, no `0x`, e.g. `2ca3`. */
  vid: string
  /** Lowercase hex, no `0x`, e.g. `4006`. */
  pid: string
  /** USB interface index that exposes the AT port. Defaults to 2. */
  at_interface?: number
}

export interface RekeySettings {
  /**
   * Proactive CHILD (ESP) SA rekey, minutes from establishment. IKEv2 does not negotiate
   * SA lifetime on the wire, so this is local policy; `0` disables it and leaves the SA
   * to be refreshed only if the ePDG initiates.
   */
  minutes?: number
  /**
   * Same local policy for the IKE SA itself. The engine only rekeys as initiator, so this
   * has to fire before the carrier's own session clock — giffgaff/O2 UK silently drop a
   * SWu session at ~2h50m, EE at ~12h. `0` disables it.
   */
  ike_minutes?: number
}

export interface RetrySettings {
  max?: number
  interval?: number
}

/** Engine debug switches. `pcap` writes packet captures to the data directory. */
export interface DebugSettings {
  asterisk?: boolean
  charon?: boolean
  pcap?: boolean
  ami?: boolean
}

export interface SecuritySettings {
  https_only?: boolean
  /** Reverse proxies whose `X-Forwarded-For` may be trusted. */
  trusted_proxies?: string[]
  audit_enabled?: boolean
}

export interface MaintenanceSettings {
  notification_history_days?: number
  support_bundle_log_lines?: number
}

export interface EsimSettings {
  /** Empty falls back to the locally built `$MDD_DATA/lpac/lpac`. */
  lpac_bin?: string
  download_timeout?: number
  auto_process_notifications?: boolean
}

export interface ProxySettings {
  enabled?: boolean
  missing_policy?: string
  /** Keyed by profile id; ids must match `[A-Za-z0-9_.-]{1,80}`. */
  profiles?: Record<string, ProxyProfile>
  /** Keyed by lowercase country code. */
  exits?: Record<string, EgressExit>
  subscription_url?: string
  refresh_minutes?: number
  [key: string]: unknown
}

/**
 * One reusable proxy definition, referenced by country exits via `profile_id`.
 *
 * Four shapes share one record rather than a discriminated union, because that is what the
 * control plane stores and what `PUT /api/settings` expects back — adding a `type`-keyed union
 * here would force a cast on every round-trip. The fields below are grouped by which `type`
 * reads them.
 */
export interface ProxyProfile {
  name: string
  type: 'subscription' | 'node' | 'socks5' | 'existing'
  /** `subscription` — the link the node list is fetched from. */
  url?: string
  /** `subscription` — how often to re-fetch; minutes. */
  refresh_minutes?: number
  /** `node` — the share link itself (`vless://…`, `trojan://…`). */
  value?: string
  /** `socks5` */
  server?: string
  port?: number
  username?: string
  password?: string
  /** `existing` — the outbound tag inside a pre-existing sing-box config. */
  outbound_tag?: string
  [key: string]: unknown
}

/** What `POST /api/egress/profile/{id}/test` returns alongside a failure, wrapped in `detail`. */
export interface EgressProfileTest {
  ok: true
  profile_id: string
  latency_ms: number
  /**
   * How the gateway parsed the share link. Travels with failures too: it is what tells an
   * operator whether the gateway read their link the way their other client did.
   */
  parsed?: Record<string, unknown>
}

export interface UpdateSettings {
  proxy_mode?: 'auto' | 'library' | 'country' | 'manual'
  proxy_profile_id?: string
  proxy_country?: string
  update_mode?: 'automatic' | 'notify'
  version_scope?: 'all' | 'main'
  [key: string]: unknown
}

/** Which events a channel delivers, and the per-event text overrides. */
export interface NotificationEventTemplate {
  title?: string
  content?: string
}

/**
 * One notification channel's configuration.
 *
 * All four channels share this record, the way the control plane stores them: `enabled`,
 * `events`, and `message_templates` behave identically everywhere, while the delivery fields
 * (`url`, `token`, …) are read only by the channel that owns them. A discriminated union here
 * would not survive a `PUT /api/settings` round-trip without a cast.
 */
export interface NotificationChannel {
  enabled?: boolean
  /** Event id → on/off. An event with no switch on is never delivered, templates or not. */
  events?: Record<string, boolean>
  /**
   * Event id → title/content override. Values may use `{{token}}` placeholders drawn from
   * `NOTIFICATION_TEMPLATE_FIELDS`; an unknown token is rejected by the server.
   */
  message_templates?: Record<string, NotificationEventTemplate>
  /* webhook */
  /** `generic` | `custom`. `custom` unlocks `payload_template` + `body_mode`. */
  format?: string
  method?: string
  url?: string
  /** JSON object of extra headers, used for authentication. */
  headers?: string
  headers_json?: string
  payload_template?: string
  body_mode?: string
  verify_tls?: boolean
  /* telegram */
  bot_token?: string
  chat_id?: string
  /** `direct` | `library` | `country` | `manual`. */
  proxy_mode?: string
  proxy_profile_id?: string
  proxy_country?: string
  proxy_url?: string
  /* pushplus */
  token?: string
  template?: string
  topic?: string
  channel?: string
  /* feishu */
  secret?: string
  /* bark */
  /** Self-hosted Bark servers are common, so the base URL is configurable. */
  server?: string
  device_key?: string
  /** `active` | `timeSensitive` | `passive` | `critical`. */
  level?: string
  sound?: string
  /** Keep the message in Bark's own history. */
  archive?: boolean
  /* email */
  host?: string
  port?: number | string
  /** `ssl` (465) | `starttls` (587) | `none` (25). The port follows unless set. */
  tls_mode?: string
  username?: string
  password?: string
  from_address?: string
  /** One address, or several separated by commas or semicolons. */
  to?: string | string[]
  subject_prefix?: string
  [key: string]: unknown
}

/**
 * Placeholders a message template may use. The server rejects anything else, so this list is
 * mirrored client-side to catch a typo before a round-trip — the 400 only names one token.
 */
export const NOTIFICATION_TEMPLATE_FIELDS = [
  'event',
  'instance',
  'sim_name',
  'iccid',
  'msisdn',
  'from',
  'text',
  'title',
  'content',
] as const

/** The ten events both channels and the settings UI agree on. */
export const NOTIFICATION_EVENTS = [
  'incoming_sms',
  'incoming_call',
  'host_alert',
  'number_changed',
  'line_unrecoverable',
  'keepalive_result',
  'balance_low',
  'missed_call',
  'voicemail_received',
  'software_update',
] as const

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number]

/**
 * One eUICC in the inventory.
 *
 * `present` is deliberately three-valued. `true` means a reader reported it just now; `null`
 * means it is only known from the cache, and the cache is keyed by EID so a card that was
 * taken out leaves its entry behind. Reporting that as `false` would claim knowledge the
 * gateway does not have.
 */
export interface EsimInventoryEntry {
  eid: string
  imei: string
  /** The reader it was last seen in, empty when it is only known from the cache. */
  reader: string
  present: boolean | null
  /** Number of secure elements (a dual-SE card presents two). */
  ses: number
  profiles: number
  enabled: number
  errors: string[]
  read_at?: number | null
  age_seconds?: number | null
  /** A cached reading old enough that it may no longer describe the card. */
  stale: boolean
  /** The line provisioned from this card, when one can be matched. */
  line?: string | null
}

/** `GET /api/esim/inventory` */
export interface EsimInventory {
  ok: true
  /** True when this response came from reading the cards rather than the cache. */
  refreshed: boolean
  now: number
  readers: string[]
  euiccs: EsimInventoryEntry[]
  count: number
  /** Cached cards no reader reported during a refresh. */
  unseen: number
  errors: string[]
}

/* ---------------------------------------------------------------- readers */

export interface SimCardInfo {
  present: boolean
  iccid?: string
  imsi?: string
  /** Display name chosen by the control plane, e.g. `SIM 1` or the carrier. */
  display_name?: string
  name?: string
  reader_port?: string
  /** True when the card needs a PIN before the SIM is readable. */
  pin_required?: boolean
  [key: string]: unknown
}

/**
 * `GET /api/readers`.
 *
 * The control plane returns bare reader names, not objects: the index is the array position,
 * which is what every other endpoint takes as `reader_index`. Wrapping them in objects here
 * would invent a field the API does not send.
 */
export interface ReadersResponse {
  readers: string[]
  /** True when PC/SC enumeration failed and the last-known list was served instead. */
  stale?: boolean
}

/* ------------------------------------------------------------- websocket */

export type WsEventType =
  | 'status'
  | 'engine'
  | 'sms'
  | 'call'
  | 'voicemail'
  | 'cards'
  | 'hardware'
  | 'capability'
  | 'esim_download'
  | 'socks'
  | 'subscription'
  | 'line'
  | 'host_alert'
  | 'field'
  | 'container'
  | 'existing'

export interface WsEvent {
  type: WsEventType
  instance?: string
  device?: string
  event?: string
  /** `status` events carry the new line status inline. */
  state?: string
  label?: string
  detail?: string
  /** `sms` events carry the affected message. */
  message?: SmsMessage
  /** `cards` events carry the full refreshed card list. */
  cards?: SimCardInfo[]
  /** `engine` events carry raw engine arguments. */
  args?: unknown[]
  [key: string]: unknown
}

/* ----------------------------------------------------------------- errors */

/** Every non-2xx control-plane response is `{"detail": "..."}`. */
export interface ApiErrorBody {
  detail?: string
}

export class ApiError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, body: unknown, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }

  /** True when the session cookie was missing or expired. */
  get isUnauthorized(): boolean {
    return this.status === 401
  }
}
