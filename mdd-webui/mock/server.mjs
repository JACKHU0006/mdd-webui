#!/usr/bin/env node
/**
 * Mock control plane.
 *
 * Purpose is narrow: let the console be developed and demoed with no modem, no SIM and no
 * Docker. It is NOT a substitute for the gateway and must never be exposed publicly.
 *
 * It deliberately reproduces the parts of the real control plane that the frontend has to
 * cope with, because those are exactly the parts that are easy to get wrong:
 *
 *   - `GET /api/auth/status` is public and reports `configured`, so the setup screen is
 *     reachable without burning a login attempt.
 *   - `POST /api/auth/login` answers 409 before an administrator exists, and 429 once five
 *     failures accumulate.
 *   - Mutating requests are rejected with 403 unless `x-mdd-csrf-token` matches the session.
 *   - `/ws` always accepts, then closes with 4401 when unauthenticated and `auth_close=1`
 *     is present — the same contract the real hub implements.
 *
 * Run: node mock/server.mjs   (listens on 127.0.0.1:8788)
 */
import { createHash, randomUUID } from 'node:crypto'
import http from 'node:http'

const PORT = Number(process.env.MOCK_PORT || 8788)
const HOST = process.env.MOCK_HOST || '127.0.0.1'
const SESSION_COOKIE = 'mdd_session'
const CSRF_HEADER = 'x-mdd-csrf-token'

/* ------------------------------------------------------------------- state */

const state = {
  /** Starts unconfigured so the setup flow can be exercised. Set MOCK_CONFIGURED=1 to skip. */
  configured: process.env.MOCK_CONFIGURED === '1',
  username: 'admin',
  password: 'mdd-demo-password',
  sessions: new Map(),
  failures: new Map(),
}

function seed() {
  const now = Math.floor(Date.now() / 1000)
  return {
    devices: [
      {
        id: 'modem-2ca3-4006-1',
        device_type: 'modem',
        name: 'DJI Cellular Dongle',
        present: true,
        model: 'EG25-G',
        firmware: 'EG25GGBR07A08M2G',
        imei: '860000000000001',
        imei_masked: '860000******001',
        stable_path: '1-2',
        reader: '',
        instance_id: 'line-1',
        status: { state: 'RUNNING', label: 'Registered', detail: 'epdg.epc.mnc011.mcc234.3gppnetwork.org' },
        logical_channels: [
          { index: 1, purpose: 'pin', allocated: true, capacity: 3 },
          { index: 2, purpose: 'swu', allocated: true, capacity: 3 },
          { index: 3, purpose: 'ims', allocated: true, capacity: 3 },
        ],
        sim: { name: 'Home SIM', number: '+44 7700 900000', present: true, carrier: 'Demo Mobile' },
        cellular: {
          registration: 'home',
          operator: 'Demo Mobile',
          signal: -71,
          apn: 'internet',
          ip: '10.42.0.7',
          data_active: true,
          roaming: false,
          rx_bytes: 128_456_789,
          tx_bytes: 12_345_678,
          profile: 'default',
          interface: 'wwan0',
        },
        vowifi: {
          epdg: 'epdg.epc.mnc011.mcc234.3gppnetwork.org',
          ims: 'Registered',
          rekey_minutes: 30,
          ike_rekey_minutes: 150,
        },
        egress: { node: 'jp-tokyo-01', pinned_node: 'jp-tokyo-01', pin_mode: 'fixed', selection: 'jp' },
        capabilities: {
          cellular: { desired: true, actual: 'on', available: true, reason: '' },
          flight_mode: { desired: false, actual: 'off', available: true, reason: '' },
          vowifi: { desired: true, actual: 'on', available: true, reason: '' },
        },
        desired: { cellular_enabled: true, vowifi_enabled: true, flight_mode: false },
      },
      {
        id: 'modem-2c7c-0125-2',
        device_type: 'modem',
        name: 'Quectel EC25 (unprovisioned)',
        present: true,
        model: 'EC25-E',
        firmware: 'EC25EFAR06A11M4G',
        imei: '860000000000002',
        imei_masked: '860000******002',
        stable_path: '1-3',
        reader: '',
        instance_id: null,
        status: null,
        logical_channels: [
          { index: 1, purpose: 'pin', allocated: false, capacity: 3 },
          { index: 2, purpose: 'swu', allocated: false, capacity: 3 },
          { index: 3, purpose: 'ims', allocated: false, capacity: 3 },
        ],
        sim: { name: '', number: '', present: true, carrier: 'Demo Mobile' },
        cellular: {
          registration: 'searching',
          operator: '',
          signal: null,
          apn: '',
          ip: '',
          data_active: false,
          roaming: false,
          rx_bytes: 0,
          tx_bytes: 0,
          profile: '',
          interface: '',
        },
        vowifi: { epdg: '', ims: '', rekey_minutes: 30, ike_rekey_minutes: 150 },
        egress: { node: '', pinned_node: '', pin_mode: '', selection: '' },
        capabilities: {
          cellular: { desired: false, actual: 'off', available: true, reason: '' },
          flight_mode: { desired: false, actual: 'off', available: true, reason: '' },
          vowifi: {
            desired: false,
            actual: 'off',
            available: false,
            reason: 'Automatic setup is waiting for SIM or hardware information',
          },
        },
        desired: { cellular_enabled: false, vowifi_enabled: false, flight_mode: false },
      },
      {
        id: 'reader-04d9-c001-3',
        device_type: 'reader',
        name: 'SCR Prime',
        present: true,
        model: 'SCR Prime',
        firmware: '',
        imei: '',
        imei_masked: '',
        stable_path: '1-4',
        reader: 'SCR Prime 00 00',
        instance_id: null,
        status: null,
        logical_channels: [],
        sim: { name: 'Travel SIM', number: '', present: true, carrier: 'Roam Demo' },
        cellular: null,
        vowifi: { epdg: '', ims: '', rekey_minutes: 30, ike_rekey_minutes: 150 },
        egress: { node: '', pinned_node: '', pin_mode: '', selection: '' },
        capabilities: {
          cellular: {
            desired: false,
            actual: 'unsupported',
            available: false,
            reason: 'A smart-card reader supports VoWiFi only',
          },
          flight_mode: {
            desired: false,
            actual: 'unsupported',
            available: false,
            reason: 'A smart-card reader supports VoWiFi only',
          },
          vowifi: { desired: true, actual: 'starting', available: true, reason: '' },
        },
        desired: { cellular_enabled: false, vowifi_enabled: true, flight_mode: false },
      },
    ],
    instances: [
      {
        id: 'line-1',
        name: 'Home SIM',
        has_pin: false,
        proxy_country_effective: 'jp',
        iccid: '8944000000000000001',
        imsi: '234150000000001',
        msisdn: '+44 7700 900000',
        mcc: '234',
        mnc: '15',
        imei: '860000000000001',
        apn: 'ims',
        reader_index: 0,
        reader_port: '1-2',
        rekey_minutes: 30,
        ike_rekey_minutes: 150,
        sip: {
          user_agent: 'MDD-Gateway/1.10.0',
          user_eq_phone: false,
          webrtc: { enable: true, username: 'webrtc' },
        },
        status: { state: 'RUNNING', label: 'Registered', detail: 'epdg.epc.mnc011.mcc234.3gppnetwork.org' },
      },
      {
        id: 'line-2',
        name: 'Draft line',
        has_pin: true,
        proxy_country_effective: 'gb',
        iccid: '8944000000000000002',
        imsi: '234150000000002',
        msisdn: '',
        mcc: '234',
        mnc: '15',
        provisioning_state: 'draft',
        reader_index: 1,
        reader_port: '1-3',
        // Deliberately disabled so the page's "endpoint disabled" state is reachable.
        sip: { webrtc: { enable: false, username: 'webrtc' } },
        status: { state: 'STOPPED', label: 'Stopped', detail: '' },
      },
    ],
    // PC/SC reader names, in index order — `/api/readers` returns bare names and the array
    // position IS the `reader_index` every other endpoint takes.
    readers: ['Alcor Micro AU9540 00 00', 'Alcor Micro AU9540 01 00'],
    // Physical cards in readers. `keepalive/summary` uses this to answer "is this SIM
    // physically here right now" — a SIM that is out of the box cannot be sent anything, so
    // offering it a keepalive switch would promise something undeliverable.
    cards: [
      { reader_index: 0, reader_port: '1-2', present: true, matched: 'line-1', iccid: '8944000000000000001' },
      { reader_index: 1, reader_port: '1-3', present: true, matched: 'line-2', iccid: '8944000000000000002' },
    ],
    messages: {
      'line-1': [
        { id: 'm1', peer: '+447700900123', body: 'Your verification code is 000000.', timestamp: now - 5400, inbound: true, unread: true },
        { id: 'm2', peer: '+447700900123', body: 'Received, thanks.', timestamp: now - 5300, inbound: false, delivery: 'DELIVERED' },
        { id: 'm3', peer: '+447700900456', body: 'Balance: 12.40 GBP, valid until 2026-12-31.', timestamp: now - 900, inbound: true, unread: false },
      ],
      'line-2': [],
    },
    settings: {
      proxy: {
        enabled: true,
        profiles: {
          'proxy-jp-sub': {
            name: 'Tokyo subscription',
            type: 'subscription',
            url: 'https://example.invalid/sub/tokyo',
            refresh_minutes: 30,
          },
          'proxy-us-node': {
            name: 'US west node',
            type: 'node',
            value: 'vless://11111111-2222-3333-4444-555555555555@us-west.example.invalid:443?security=reality#us-west-07',
          },
          'proxy-de-socks': {
            name: 'Germany SOCKS5',
            type: 'socks5',
            server: 'de-frankfurt.example.invalid',
            port: 1080,
            username: 'mdd',
            password: 'secret',
          },
        },
        exits: {
          // `profile_id` is what the view reads to say which countries use a profile.
          jp: { enabled: true, mode: '', profile_id: 'proxy-jp-sub' },
          gb: { enabled: true, mode: '', profile_id: 'proxy-jp-sub' },
          us: { enabled: true, mode: '', profile_id: 'proxy-us-node' },
          de: { enabled: true, mode: 'direct', profile_id: '' },
          fr: { enabled: false, mode: '', profile_id: 'proxy-us-node' },
        },
        subscription_url: '',
        refresh_minutes: 30,
      },
      hardware: {
        auto_detect: true,
        modem_backend: 'auto',
        vpcd_slots: 3,
        modem_profiles: [
          { name: 'DJI/Quectel EC25', vid: '2c7c', pid: '0125', at_interface: 2 },
          { name: 'DJI Cellular Dongle', vid: '2ca3', pid: '4006', at_interface: 2 },
        ],
      },
      /**
       * Notification channels. Seeded with one channel in each meaningful shape — a live
       * webhook, a channel that is on but has no event switched on (so nothing is delivered),
       * a channel that is off but fully configured, and a channel with a template override —
       * because those are the four states the page exists to tell apart.
       */
      webhook: {
        enabled: true,
        format: 'generic',
        method: 'POST',
        body_mode: 'json',
        url: 'https://hooks.example.invalid/mdd',
        headers: '{"Authorization": "Bearer demo-token"}',
        verify_tls: true,
        events: { incoming_sms: true, incoming_call: true, host_alert: true },
        message_templates: {
          incoming_sms: { title: 'SMS to {{sim_name}}', content: '{{from}}: {{text}}' },
        },
      },
      telegram: {
        enabled: true,
        bot_token: '123456789:AAH-demo-token-not-real',
        chat_id: '-1001234567890',
        // Enabled, but nothing switched on: the page has to say so rather than imply delivery.
        events: {},
        proxy_mode: 'country',
        proxy_country: 'jp',
      },
      pushplus: {
        enabled: false,
        token: 'demo-pushplus-token',
        template: 'html',
        topic: 'mdd',
        channel: 'wechat',
        events: { balance_low: true, missed_call: true },
      },
      /**
       * Bark is seeded enabled with the public server, and email disabled but fully filled in
       * — between them they cover the two shapes the page has to render: a channel that will
       * deliver, and one that is configured but switched off.
       */
      bark: {
        enabled: true,
        server: '',
        device_key: 'demo-bark-device-key',
        level: 'timeSensitive',
        group: 'mdd',
        sound: '',
        archive: true,
        events: { incoming_sms: true, incoming_call: true, line_unrecoverable: true },
      },
      email: {
        enabled: false,
        host: 'smtp.example.invalid',
        port: '',
        tls_mode: 'starttls',
        username: 'bot@example.invalid',
        password: 'demo-smtp-password',
        from_address: 'bot@example.invalid',
        to: 'me@example.invalid, ops@example.invalid',
        subject_prefix: '[MDD]',
        events: { line_unrecoverable: true, host_alert: true },
      },
      feishu: {
        enabled: false,
        url: 'https://open.feishu.cn/open-apis/bot/v2/hook/demo-hook-id',
        secret: '',
        channels: [],
        events: { line_unrecoverable: true },
        message_templates: {
          // A deliberate typo, so the client-side token check has something to catch.
          incoming_call: { content: 'Call from {{from}} on {{sim_nmae}}' },
        },
      },
      rekey: { minutes: 30, ike_minutes: 150 },
    },
    /**
     * Exit status as the host orchestrator publishes it. Seeded to cover every state the view
     * has to distinguish — ready, UDP-failed, direct, hand-locked, stale pin — because each one
     * reads differently to the operator and the point of the page is not to blur them.
     */
    /**
     * Delivery log. Metadata only, exactly as the gateway records it — no bodies, no numbers,
     * no credentials. Seeded across every status so the log's colour coding is visible.
     */
    notifications: {
      deliveries: [
        {
          id: 'd-1007',
          created_at: now - 40,
          finished_at: now - 39,
          channel: 'webhook',
          event: 'incoming_sms',
          instance: 'sim-jp',
          status: 'pending',
          attempts: 1,
          status_code: 0,
          error: '',
        },
        {
          id: 'd-1006',
          created_at: now - 180,
          finished_at: now - 179,
          channel: 'webhook',
          event: 'incoming_sms',
          instance: 'sim-jp',
          status: 'ok',
          attempts: 1,
          status_code: 200,
          error: '',
        },
        {
          id: 'd-1005',
          created_at: now - 640,
          finished_at: now - 632,
          channel: 'telegram',
          event: 'incoming_call',
          instance: 'sim-jp',
          status: 'failed',
          attempts: 3,
          status_code: 502,
          error: 'upstream returned 502 Bad Gateway',
        },
        {
          id: 'd-1004',
          created_at: now - 1500,
          finished_at: now - 1499,
          channel: 'pushplus',
          event: 'balance_low',
          instance: 'sim-us',
          status: 'ok',
          attempts: 1,
          status_code: 200,
          error: '',
        },
        {
          id: 'd-1003',
          created_at: now - 3600,
          finished_at: now - 3599,
          channel: 'feishu',
          event: 'line_unrecoverable',
          instance: '',
          status: 'failed',
          attempts: 1,
          status_code: 200,
          // PushPlus/Feishu answer 200 with an application-level error — worth showing.
          error: 'application error: code 19021, sign match fail',
        },
      ],
    },
    egress: {
      updated_at: now - 12,
      enabled: true,
      exits: {
        jp: {
          ready: true,
          mode: 'socks',
          node: 'jp-tokyo-01',
          pinned_node: 'jp-tokyo-01',
          pin_mode: 'lock',
          selection: 'manual',
          interface: 'mdd-jp',
          proxy_host: '127.0.0.1',
          proxy_port: 10810,
        },
        gb: {
          ready: false,
          mode: 'subscription',
          node: '',
          error: 'UDP test failed — STUN/4500: no response; DNS/53: no response',
        },
        us: {
          ready: true,
          mode: 'subscription',
          node: 'us-west-07',
          pinned_node: 'us-east-02',
          pin_mode: 'prefer',
          selection: 'auto',
          interface: 'mdd-us',
          candidates: ['us-west-07', 'us-east-03', 'us-central-01'],
        },
        de: { ready: true, mode: 'direct', node: '', selection: 'auto' },
        fr: {
          ready: false,
          mode: 'subscription',
          node: 'fr-paris-01',
          pinned_node: 'fr-paris-09',
          pinned_missing: true,
          selection: 'auto',
        },
      },
      lines: {
        'line-1': { node: 'jp-tokyo-01', ready: true },
        'line-2': { node: 'us-west-07', ready: true },
        'line-3': { node: '', ready: false, error: 'no exit assigned' },
      },
    },
    /**
     * Connectivity history per line, as gap-aware segments. Seeded with one outage and one
     * monitoring gap so the timeline's "unknown" band is exercised, not just the happy path.
     */
    lineStates: {
      'line-1': [
        { state: 'up', start: now - SEGMENT_WINDOW_SECONDS, end: now - 5400, reason: '', detail: '' },
        { state: 'down', start: now - 5400, end: now - 4200, reason: 'attach_rejected', detail: 'carrier rejected the attach' },
        { state: 'up', start: now - 4200, end: now - 900, reason: '', detail: '' },
        { state: 'unknown', start: now - 900, end: now - 600, reason: '', detail: '' },
        { state: 'up', start: now - 600, end: now, reason: '', detail: '' },
      ],
      'line-2': [],
    },
    allowance: {
      'line-1': {
        instance: 'line-1',
        balance: '12.40 GBP',
        valid_until: '2026-12-31',
        sms_remaining: '250 texts',
        data_remaining: '1.2 GB',
        voice_remaining: '120 minutes',
        activated_at: '2026-01-15',
        updated_ts: now - 3600,
        source: 'sms',
      },
      'line-2': {
        instance: 'line-2',
        balance: '',
        valid_until: '',
        sms_remaining: '',
        data_remaining: '',
        voice_remaining: '',
        activated_at: '',
        updated_ts: null,
        source: 'manual',
      },
    },
    allowanceRules: {
      'line-1': { recipient: '150', body: 'BAL', updated_ts: now - 86400 },
    },
    keepalive: {
      'line-1': {
        instance: 'line-1',
        enabled: true,
        action: 'sms',
        sms_to: '+447700900123',
        sms_body: 'Keepalive',
        verify_charge: 1,
        threshold: '',
        interval_days: 30,
        next_due_ts: now + 5 * 86400,
        last_run_ts: now - 25 * 86400,
        last_status: 'ok',
        last_detail: '计费短信已发往 +447700900123',
        balance_low_since: 0,
      },
      'line-2': {
        instance: 'line-2',
        enabled: false,
        action: 'balance_watch',
        sms_to: '',
        sms_body: '',
        verify_charge: 1,
        threshold: '5.00',
        interval_days: 7,
        next_due_ts: 0,
        balance_low_since: 0,
      },
    },
    esim: {
      available: true,
      lpac_bin: '/opt/mdd/lpac/lpac',
      download_timeout: 300,
      auto_process_notifications: true,
      busy_readers: [],
      imei: '860000000000001',
      /** When the last successful exclusive read was cached, for the `cached` hint. */
      cached_ts: now - 1800,
      ses: [
        {
          id: 'se1',
          label: 'eUICC',
          aid: 'a0000005591010ffffffff8900000100',
          eid: '89049032005008882600000000000001',
          freeSpace: 421_000,
          chip: {
            eid: '89049032005008882600000000000001',
            freeNonVolatileMemory: 421_000,
            defaultDpAddress: 'smdp.demo.example.com',
            production: { sgp22_version: '2.2.2' },
          },
          // Field names are lpac's own camelCase: `lpa.profile_list` forwards the tool's JSON
          // verbatim, so renaming them into tidier snake_case here would make the UI read
          // `undefined` for every row.
          profiles: [
            {
              iccid: '8944000000000000001',
              profileNickname: 'Home',
              profileName: 'Demo Mobile',
              profileState: 'enabled',
              profileClass: 'operational',
              seId: 'se1',
            },
            {
              iccid: '8944000000000000009',
              profileNickname: 'Travel',
              profileName: 'Roam Co',
              profileState: 'disabled',
              profileClass: 'operational',
              seId: 'se1',
            },
          ],
          notifications: [
            { seq: 1, event: 'install', iccid: '8944000000000000009', seId: 'se1' },
          ],
        },
      ],
    },
    notificationDeliveries: {
      pending: [],
      history: [
        {
          id: 'd1',
          created_at: now - 7200,
          finished_at: now - 7198,
          channel: 'telegram',
          event: 'incoming_sms',
          instance: 'line-1',
          status: 'ok',
          attempts: 1,
          status_code: 200,
        },
        {
          id: 'd2',
          created_at: now - 5400,
          finished_at: now - 5396,
          channel: 'webhook',
          event: 'balance_low',
          instance: 'line-1',
          status: 'failed',
          attempts: 3,
          error: 'HTTP 502 from the endpoint',
        },
      ],
    },
    calls: {
      'line-1': [
        { id: 1, instance: 'line-1', direction: 'in', peer: '+447700900123', status: 'missed', start_ts: now - 7200, end_ts: now - 7190, transport: 'vowifi' },
        { id: 2, instance: 'line-1', direction: 'out', peer: '+447700900456', status: 'ended', start_ts: now - 3600, end_ts: now - 3480, transport: 'vowifi' },
        { id: 3, instance: 'line-1', direction: 'out', peer: '#225#', status: 'ended', start_ts: now - 1800, end_ts: now - 1790, transport: 'cellular', ussd_text: 'Your balance is 12.40 GBP.' },
      ],
      'line-2': [],
    },
    voicemails: {
      'line-1': [
        { id: 1, instance: 'line-1', peer: '+447700900123', ts: now - 7000, duration_seconds: 14, size_bytes: 224_000, listened: false },
      ],
      'line-2': [],
    },
  }
}

/** The retained connectivity window the mock fabricates a timeline over (24 hours). */
const SEGMENT_WINDOW_SECONDS = 86400

/** Totals over a segment list — the same arithmetic `store.line_state_summary` does. */
function summarizeSegments(segments) {
  const totals = { up: 0, down: 0, off: 0, unknown: 0 }
  let outages = 0
  let longest = 0
  for (const segment of segments) {
    const length = Math.max(0, Number(segment.end) - Number(segment.start))
    totals[segment.state] = (totals[segment.state] || 0) + length
    if (segment.state === 'down') {
      outages += 1
      longest = Math.max(longest, length)
    }
  }
  const observed = totals.up + totals.down
  return {
    ...totals,
    observed_seconds: observed,
    outages,
    longest_outage_seconds: longest,
    uptime_ratio: observed ? totals.up / observed : null,
  }
}

/**
 * Rewrite a line's live connectivity tail so a start/stop visibly moves the timeline.
 *
 * Appends rather than mutates: an outage that just ended has to stay visible, which is the
 * whole reason the chart is drawn from segments instead of a single current state.
 */
function setLineState(iid, state, reason) {
  const now = Math.floor(Date.now() / 1000)
  const segments = db.lineStates[iid] || (db.lineStates[iid] = [])
  const last = segments[segments.length - 1]
  if (last && last.state === state) {
    last.end = now
    return
  }
  if (last) last.end = Math.min(last.end, now)
  segments.push({ state, start: now, end: now, reason: reason || '', detail: '' })
  if (segments.length > 60) segments.splice(0, segments.length - 60)
}

const db = seed()

/* ---------------------------------------------- allowance / keepalive helpers */

/** `store.ALLOWANCE_FIELDS`, in order. Every value is a display string, never a number. */
const ALLOWANCE_FIELDS = [
  'balance',
  'valid_until',
  'sms_remaining',
  'data_remaining',
  'voice_remaining',
  'activated_at',
]

function blankAllowance(iid) {
  const blank = { instance: iid, updated_ts: null, source: 'manual' }
  for (const key of ALLOWANCE_FIELDS) blank[key] = ''
  return blank
}

/** `allowance.parse_expiry_date`, accepting the carrier formats, ISO first. */
function parseExpiry(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (iso) return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(raw)
  if (us) {
    const year = Number(us[3]) < 100 ? 2000 + Number(us[3]) : Number(us[3])
    return Date.UTC(year, Number(us[1]) - 1, Number(us[2]))
  }
  return null
}

/**
 * `main.py::_clean_keepalive`, including the reasoning that is easy to lose in a rewrite:
 * an absent interval defaults to 30, but a present-but-invalid one is an error rather than a
 * silent fallback, because silently rescheduling a run that spends real money is worse than
 * refusing the save.
 */
function cleanKeepalive(body) {
  const source = body || {}
  const action = String(source.action || 'sms').toLowerCase()
  if (!['sms', 'balance_watch'].includes(action)) {
    return { error: 'action must be sms or balance_watch' }
  }
  const raw = source.interval_days
  const interval = raw === undefined || raw === null || raw === '' ? 30 : Number(raw)
  if (!Number.isInteger(interval)) return { error: 'interval_days must be a number' }
  if (interval < 1 || interval > 365) {
    return { error: 'interval_days must be between 1 and 365' }
  }
  const enabled = source.enabled ? 1 : 0
  const smsTo = String(source.sms_to || '').trim()
  const smsBody = String(source.sms_body || '').trim()
  const threshold = String(source.threshold || '').trim()
  if (enabled && action === 'sms') {
    if (!/^\+?[0-9 ()-]{3,32}$/.test(smsTo)) {
      return { error: 'a chargeable SMS needs a valid recipient number' }
    }
    if (!smsBody) return { error: 'a chargeable SMS needs a body' }
  }
  if (smsBody.length > 160) {
    return { error: 'keepalive SMS body must be 160 characters or fewer' }
  }
  const values = {
    enabled,
    action,
    sms_to: smsTo,
    sms_body: smsBody,
    verify_charge: source.verify_charge === false ? 0 : 1,
    threshold,
    interval_days: interval,
  }
  const rawDate = String(source.next_run_date || '').trim()
  if (rawDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      return { error: 'next_run_date must be YYYY-MM-DD' }
    }
    // Anchored at the start of the execution window on that local date, so the stored instant
    // reads back as the date the operator picked.
    values.next_due_ts = Math.floor(new Date(`${rawDate}T10:00:00`).getTime() / 1000)
  }
  return { values }
}

/**
 * `main.py::_keepalive_view` plus `_keepalive_next_due`.
 *
 * The due time is anchored on the last SUCCESSFUL run rather than the last attempt — a line
 * that was offline must not have its schedule quietly pushed a whole interval into the future.
 * `next_run_date` is the same instant rendered as a local calendar date so the date input
 * round-trips exactly instead of shifting a day for a browser in another zone.
 */
function keepaliveView(iid, record, now) {
  const enabled = Boolean(record.enabled)
  const anchor = Number(record.next_due_ts || 0)
  const due = enabled ? anchor || now : 0
  const out = { ...record, instance: iid }
  out.enabled = enabled
  out.verify_charge = Boolean(record.verify_charge)
  out.action = String(record.action || 'sms')
  out.interval_days = Math.max(1, Number(record.interval_days) || 30)
  out.sms_to = String(record.sms_to || '')
  out.sms_body = String(record.sms_body || '')
  out.threshold = String(record.threshold || '')
  out.next_due_ts = due
  if (due) {
    const date = new Date(due * 1000)
    const pad = (value) => String(value).padStart(2, '0')
    out.next_run_date = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  } else {
    out.next_run_date = ''
  }
  return out
}

/* --------------------------------------------------------------- utilities */

function send(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1_048_576) req.destroy()
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve({})
      }
    })
  })
}

function parseCookies(header = '') {
  const out = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return out
}

function sessionOf(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
  if (!token) return null
  const session = state.sessions.get(token)
  if (!session) return null
  if (session.expires < Date.now()) {
    state.sessions.delete(token)
    return null
  }
  return { token, ...session }
}

function cookieHeader(token, maxAge) {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict`
}

/* ------------------------------------------------------------------ routing */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const path = url.pathname
  const method = req.method || 'GET'
  const peer = req.socket.remoteAddress || 'local'

  if (method === 'OPTIONS') {
    return send(res, 204, {}, { Allow: 'GET,POST,PUT,PATCH,DELETE' })
  }

  /* -------------------------------------------------------------- public */

  if (path === '/api/auth/status' && method === 'GET') {
    const session = sessionOf(req)
    return send(res, 200, {
      configured: state.configured,
      authenticated: Boolean(session),
      username: state.username,
      csrf: session ? session.csrf : '',
    })
  }

  if (path === '/api/auth/setup' && method === 'POST') {
    if (state.configured) return send(res, 409, { detail: 'administrator account is already configured' })
    const body = await readBody(req)
    const password = String(body.password || '')
    if (password.length < 10) return send(res, 400, { detail: 'password must contain 10-256 characters' })
    state.password = password
    state.username = String(body.username || 'admin')
    state.configured = true
    return issueSession(res, Boolean(body.remember))
  }

  if (path === '/api/auth/login' && method === 'POST') {
    if (!state.configured) return send(res, 409, { detail: 'administrator setup is required' })

    const attempts = (state.failures.get(peer) || []).filter((stamp) => Date.now() - stamp < 900_000)
    state.failures.set(peer, attempts)
    if (attempts.length >= 5) {
      const retry = Math.max(1, 60 - Math.floor((Date.now() - attempts.at(-1)) / 1000))
      return send(res, 429, { detail: 'too many attempts', retry_after: retry }, { 'Retry-After': String(retry) })
    }

    const body = await readBody(req)
    const okUser = String(body.username || '') === state.username
    const okPass = String(body.password || '') === state.password
    if (!okUser || !okPass) {
      attempts.push(Date.now())
      state.failures.set(peer, attempts)
      return send(res, 401, { detail: 'invalid username or password' })
    }
    state.failures.delete(peer)
    return issueSession(res, Boolean(body.remember))
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    const session = sessionOf(req)
    if (session) state.sessions.delete(session.token)
    return send(res, 200, { ok: true }, { 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0` })
  }

  /* ----------------------------------------------------------- protected */

  const session = sessionOf(req)
  if (path.startsWith('/api/')) {
    if (!session) return send(res, 401, { detail: 'authentication required' })
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const supplied = req.headers[CSRF_HEADER] || ''
      if (supplied !== session.csrf) return send(res, 403, { detail: 'invalid CSRF token' })
    }
  }

  if (path === '/api/auth/password' && method === 'POST') {
    const body = await readBody(req)
    if (String(body.current_password || '') !== state.password) {
      return send(res, 400, { detail: 'current password is incorrect' })
    }
    state.password = String(body.new_password || '')
    state.sessions.clear()
    return send(res, 200, { ok: true, reauthenticate: true }, { 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0` })
  }

  if (path === '/api/devices' && method === 'GET') {
    return send(res, 200, { devices: db.devices, discovering: false, shared: {} })
  }

  const capabilityMatch = path.match(/^\/api\/devices\/([^/]+)\/capabilities$/)
  if (capabilityMatch && method === 'PATCH') {
    const device = db.devices.find((item) => item.id === decodeURIComponent(capabilityMatch[1]))
    if (!device) return send(res, 404, { detail: 'device not found' })
    const body = await readBody(req)
    // One key per request, exactly like the real client. Each capability is independent.
    for (const [key, capability] of [
      ['cellular_enabled', 'cellular'],
      ['flight_mode', 'flight_mode'],
      ['vowifi_enabled', 'vowifi'],
    ]) {
      if (typeof body[key] === 'boolean') {
        if (!device.capabilities[capability].available) {
          return send(res, 409, { detail: `capability ${capability} is not available on this device` })
        }
        device.capabilities[capability].desired = body[key]
        device.desired[key] = body[key]
        // Move to an intermediate state so the UI exercises its transitional rendering.
        device.capabilities[capability].actual = body[key] ? 'starting' : 'stopping'
        setTimeout(() => {
          device.capabilities[capability].actual = body[key] ? 'on' : 'off'
          broadcast({ type: 'capability', device: device.id, event: 'settled' })
        }, 1500)
      }
    }
    broadcast({ type: 'capability', device: device.id, event: 'changed' })
    return send(res, 200, { ok: true })
  }

  if (path === '/api/instances' && method === 'GET') return send(res, 200, { instances: db.instances })
  if (path === '/api/instances' && method === 'POST') {
    const body = await readBody(req)
    if (!body.id) return send(res, 400, { detail: 'id required' })
    const existing = db.instances.find((item) => item.id === body.id)
    if (
      body.name &&
      db.instances.some((item) => item.id !== body.id && item.name === body.name)
    ) {
      return send(res, 409, { detail: 'another line already uses that name' })
    }
    // Mirrors config.upsert_instance: a blank PIN never clears a stored one, the display
    // name is the only change the engine does not need a restart for.
    const { pin, ...rest } = body
    const merged = { ...(existing || {}), ...rest }
    if (pin) merged.has_pin = true
    if (!existing) {
      merged.has_pin = Boolean(pin)
      merged.proxy_country_effective = ''
      merged.status = { state: 'STOPPED', label: 'Stopped', detail: '' }
      db.instances.push(merged)
      return send(res, 200, { ...merged, applied: false })
    }
    const nameOnly =
      Object.keys(rest).filter((key) => key !== 'id').every((key) => key === 'name')
    Object.assign(existing, merged)
    return send(res, 200, { ...existing, applied: !nameOnly })
  }

  const deleteInstanceMatch = path.match(/^\/api\/instances\/([^/]+)$/)
  if (deleteInstanceMatch && method === 'DELETE') {
    const iid = decodeURIComponent(deleteInstanceMatch[1])
    // The real route refuses unless confirm_id matches exactly — it is the control plane's
    // proof that the operator meant this line and not a neighbour.
    if (url.searchParams.get('confirm_id') !== iid) {
      return send(res, 400, { detail: 'confirm_id must exactly match the SIM line id' })
    }
    const index = db.instances.findIndex((item) => item.id === iid)
    if (index < 0) return send(res, 404, { detail: 'no such instance' })
    const deleteHistory = url.searchParams.get('delete_history') !== 'false'
    db.instances.splice(index, 1)
    const deletedMessages = deleteHistory ? (db.messages[iid] || []).length : 0
    const deletedCalls = deleteHistory ? (db.calls[iid] || []).length : 0
    if (deleteHistory) {
      delete db.messages[iid]
      delete db.calls[iid]
    }
    delete db.lineStates[iid]
    delete db.allowance[iid]
    delete db.keepalive[iid]
    broadcast({ type: 'line', instance: iid, event: 'deleted' })
    return send(res, 200, {
      ok: true,
      history_deleted: deleteHistory,
      deleted_messages: deletedMessages,
      deleted_calls: deletedCalls,
    })
  }

  const countryMatch = path.match(/^\/api\/instances\/([^/]+)\/country$/)
  if (countryMatch && method === 'PUT') {
    const iid = decodeURIComponent(countryMatch[1])
    const line = db.instances.find((item) => item.id === iid)
    if (!line) return send(res, 404, { detail: 'no such instance' })
    const raw = String((await readBody(req)).country || '').trim()
    if (raw && !/^[a-z]{2}$/i.test(raw)) {
      return send(res, 400, { detail: 'country must be a two-letter ISO code' })
    }
    const country = raw.toLowerCase()
    line.proxy_country_effective = country
    return send(res, 200, {
      ok: true,
      country,
      effective_country: country || 'gb',
      applied: true,
    })
  }

  const instanceAction = path.match(
    /^\/api\/instances\/([^/]+)\/(start|stop|reprovision|register|pin\/clear)$/,
  )
  if (instanceAction && method === 'POST') {
    const iid = decodeURIComponent(instanceAction[1])
    const action = instanceAction[2]
    const line = db.instances.find((item) => item.id === iid)
    if (!line) return send(res, 404, { detail: 'no such instance' })
    if (action === 'start') {
      const body = await readBody(req)
      // A line flagged has_pin with no PIN supplied is refused with the structured body the
      // real control plane sends, so the UI's unlock prompt is exercised in the mock too.
      if (line.has_pin && !body.pin) {
        return send(res, 409, {
          detail: { code: 'pin_required', message: 'this SIM needs a PIN' },
        })
      }
      line.status = { state: 'STARTING', label: 'Starting', detail: '' }
      setLineState(iid, 'STARTING', 'Starting')
      setTimeout(() => {
        line.status = { state: 'RUNNING', label: 'Registered', detail: 'epdg.demo' }
        setLineState(iid, 'up', 'Registered')
        broadcast({ type: 'status', instance: iid, state: 'RUNNING', label: 'Registered' })
      }, 1200)
      return send(res, 200, { ok: true, container: `mdd-engine-${iid}` })
    }
    if (action === 'stop') {
      line.status = { state: 'STOPPED', label: 'Stopped', detail: '' }
      setLineState(iid, 'off', 'Stopped')
      broadcast({ type: 'status', instance: iid, state: 'STOPPED', label: 'Stopped' })
      return send(res, 200, { ok: true })
    }
    if (action === 'reprovision') {
      line.status = { state: 'STARTING', label: 'Reprovisioning', detail: '' }
      setLineState(iid, 'STARTING', 'Reprovisioning')
      return send(res, 200, { ok: true, container: `mdd-engine-${iid}` })
    }
    if (action === 'pin/clear') {
      const had = Boolean(line.has_pin)
      line.has_pin = false
      line.status = { state: 'STOPPED', label: 'Stopped', detail: '' }
      setLineState(iid, 'off', 'Stopped')
      return send(res, 200, { ok: true, had_pin: had })
    }
    return send(res, 200, { output: 'REGISTER sent to volte_ims' })
  }

  const availabilityMatch = path.match(/^\/api\/instances\/([^/]+)\/availability$/)
  if (availabilityMatch && method === 'GET') {
    const iid = decodeURIComponent(availabilityMatch[1])
    const segments = db.lineStates[iid] || []
    const now = Math.floor(Date.now() / 1000)
    const span = SEGMENT_WINDOW_SECONDS
    return send(res, 200, {
      instance: iid,
      start: now - span,
      end: now,
      span_seconds: span,
      max_span_seconds: 30 * 86400,
      recorded_since: now - span,
      segments,
      summary: summarizeSegments(segments),
    })
  }

  const logsMatch = path.match(/^\/api\/instances\/([^/]+)\/logs$/)
  if (logsMatch && method === 'GET') {
    const iid = decodeURIComponent(logsMatch[1])
    const now = Math.floor(Date.now() / 1000)
    return send(res, 200, {
      engine: [
        `[${new Date().toISOString()}] container mdd-engine-${iid} started`,
        '[info] swu_ike: resolving ePDG',
        '[info] swu_ike: IKE_SA established',
        '[info] asterisk: IMS registered',
      ].join('\n'),
      charon: [
        'charon: loaded plugins',
        'charon: IKE_SA swu[1] established between 10.42.0.7[10.42.0.7]...203.0.113.9[203.0.113.9]',
      ].join('\n'),
      diagnostics: [
        JSON.stringify({ ts: now, state: 'up', reason_code: '', detail: 'registered' }),
      ].join('\n'),
    })
  }
  /* ------------------------------------------- allowance / number keeping */

  // Mirrors main.py::_allowance_rule + allowance.query_rule: a carrier default overridden by a
  // per-line custom rule, with `effective` null when neither exists. The query button depends
  // on that null — it is the only honest way to say "I cannot ask this carrier anything".
  const allowanceSummary = (iid) => {
    const line = db.instances.find((item) => item.id === iid) || {}
    const custom = db.allowanceRules[iid] || null
    const known = iid === 'line-1'
    const fallback = known ? { recipient: '6700', body: 'BAL' } : null
    const effective = custom
      ? { recipient: custom.recipient, body: custom.body }
      : fallback
    return {
      carrier_key: known ? 'ultramobile' : '',
      carrier_label: known ? 'Ultra Mobile' : String(line.carrier || ''),
      known,
      custom: Boolean(custom),
      effective,
      default: fallback,
    }
  }

  const allowanceMatch = path.match(/^\/api\/instances\/([^/]+)\/allowance$/)
  if (allowanceMatch && method === 'GET') {
    const iid = decodeURIComponent(allowanceMatch[1])
    return send(res, 200, { allowance: db.allowance[iid] || blankAllowance(iid) })
  }
  if (allowanceMatch && method === 'PUT') {
    const iid = decodeURIComponent(allowanceMatch[1])
    const body = await readBody(req)
    // Every field is a display string; lengths and the activated_at date shape are the only
    // validation the real control plane applies (allowance.clean_allowance).
    const next = blankAllowance(iid)
    for (const key of ALLOWANCE_FIELDS) {
      const value = String(body[key] ?? '').trim()
      if (value.length > 160) return send(res, 422, { detail: `${key} must be at most 160 characters` })
      next[key] = value
    }
    if (next.activated_at && !/^\d{4}-\d{2}-\d{2}$/.test(next.activated_at)) {
      return send(res, 422, { detail: 'activated_at must use YYYY-MM-DD format' })
    }
    next.updated_ts = Math.floor(Date.now() / 1000)
    next.source = 'manual'
    db.allowance[iid] = next
    return send(res, 200, { allowance: next })
  }

  const queryRuleMatch = path.match(/^\/api\/instances\/([^/]+)\/allowance\/query-rule$/)
  if (queryRuleMatch && ['GET', 'PUT', 'DELETE'].includes(method)) {
    const iid = decodeURIComponent(queryRuleMatch[1])
    if (method === 'PUT') {
      const body = await readBody(req)
      const recipient = String(body.recipient ?? '').trim()
      const text = String(body.body ?? '').trim()
      // allowance.validate_rule: a short code or international number, and a non-empty body.
      if (!/^\+?\d{1,32}$/.test(recipient)) {
        return send(res, 422, {
          detail: 'recipient must be a service short code or international number',
        })
      }
      if (!text) return send(res, 422, { detail: 'query message body is required' })
      if (text.length > 500) {
        return send(res, 422, { detail: 'query message body must be at most 500 characters' })
      }
      db.allowanceRules[iid] = {
        recipient,
        body: text,
        updated_ts: Math.floor(Date.now() / 1000),
      }
    }
    if (method === 'DELETE') delete db.allowanceRules[iid]
    return send(res, 200, { rule: allowanceSummary(iid) })
  }

  const allowanceQueryMatch = path.match(/^\/api\/instances\/([^/]+)\/allowance\/query$/)
  if (allowanceQueryMatch && method === 'POST') {
    const iid = decodeURIComponent(allowanceQueryMatch[1])
    const rule = allowanceSummary(iid)
    // No effective rule is a 409, not a 400: the request is well formed, the gateway simply
    // has no way to ask this carrier. The UI shows that as guidance, not as an input error.
    if (!rule.effective) {
      return send(res, 409, {
        detail: 'allowance query method is unknown; configure it in the allowance panel',
      })
    }
    const body = await readBody(req)
    const transport = String(body.transport || 'auto').toLowerCase()
    if (!['auto', 'vowifi', 'cellular'].includes(transport)) {
      return send(res, 422, { detail: 'transport must be auto, vowifi, or cellular' })
    }
    const now = Math.floor(Date.now() / 1000)
    return send(res, 200, {
      ok: true,
      query: {
        id: now,
        status: 'sent',
        recipient: rule.effective.recipient,
        body: rule.effective.body,
        started_ts: now,
      },
      rule,
      send: { ok: true, transport: 'vowifi', requested_transport: transport },
    })
  }

  const keepaliveMatch = path.match(/^\/api\/instances\/([^/]+)\/keepalive$/)
  if (keepaliveMatch && ['GET', 'PUT'].includes(method)) {
    const iid = decodeURIComponent(keepaliveMatch[1])
    if (method === 'PUT') {
      const body = await readBody(req)
      const clean = cleanKeepalive(body)
      if (clean.error) return send(res, 422, { detail: clean.error })
      const now = Math.floor(Date.now() / 1000)
      const previous = db.keepalive[iid] || {}
      const chosenDue = clean.values.next_due_ts
      delete clean.values.next_due_ts
      // The schedule rules from main.py::api_keepalive_save, in order: switched off clears the
      // due time; an explicit date wins; switching on without a date runs at the next
      // opportunity rather than making the operator wait a whole interval to see it work.
      if (!clean.values.enabled) {
        clean.values.next_due_ts = 0
      } else if (chosenDue !== undefined) {
        clean.values.next_due_ts = chosenDue
      } else if (!previous.enabled) {
        clean.values.next_due_ts = now
      } else {
        clean.values.next_due_ts = previous.next_due_ts || 0
      }
      const merged = { ...previous, ...clean.values, instance: iid }
      db.keepalive[iid] = merged
      return send(res, 200, { keepalive: keepaliveView(iid, merged, now) })
    }
    const now = Math.floor(Date.now() / 1000)
    return send(res, 200, { keepalive: keepaliveView(iid, db.keepalive[iid] || {}, now) })
  }

  const keepaliveRunMatch = path.match(/^\/api\/instances\/([^/]+)\/keepalive\/run$/)
  if (keepaliveRunMatch && method === 'POST') {
    const iid = decodeURIComponent(keepaliveRunMatch[1])
    const now = Math.floor(Date.now() / 1000)
    const current = db.keepalive[iid] || {}
    const action = String(current.action || 'sms')
    const interval = Math.max(1, Number(current.interval_days) || 30) * 86400
    // A manual run ignores the schedule but not the safety rules. balance_watch with no
    // resolvable rule fails the way the real one does — shown, never faked as a success.
    const noRule = action === 'balance_watch' && !allowanceSummary(iid).effective
    const status = noRule ? 'failed' : action === 'sms' ? 'ok' : 'balance_low'
    const detail = noRule
      ? '该线路没有余额查询规则'
      : action === 'sms'
        ? `计费短信已发往 ${current.sms_to}`
        : `余额 ${db.allowance[iid]?.balance || '—'} 低于阈值 ${current.threshold}`
    const updated = {
      ...current,
      instance: iid,
      last_run_ts: now,
      last_status: status,
      last_detail: detail,
      next_due_ts: now + interval,
    }
    db.keepalive[iid] = updated
    broadcast({ type: 'keepalive', instance: iid, status })
    return send(res, 200, { keepalive: keepaliveView(iid, updated, now) })
  }

  if (path === '/api/keepalive/summary' && method === 'GET') {
    const now = Math.floor(Date.now() / 1000)
    const rows = db.instances.map((line) => {
      const iid = line.id
      const record = db.keepalive[iid] || {}
      const segments = db.lineStates[iid] || []
      const summary = summarizeSegments(segments)
      const rule = allowanceSummary(iid)
      const expiry = parseExpiry(db.allowance[iid]?.valid_until)
      const running = line.status?.state === 'RUNNING'
      // `in_gateway` is deliberately broader than "the engine is running": a card sitting in a
      // reader counts too, because a stopped line can still be started.
      const inGateway =
        running || Boolean(db.cards?.some((card) => card.present && card.matched === iid))
      return {
        instance: iid,
        name: line.name || iid,
        msisdn: line.msisdn || '',
        country: line.country || '',
        carrier: iid === 'line-1' ? 'Ultra Mobile' : '',
        enabled: line.enabled !== false,
        in_gateway: inGateway,
        state: line.status?.state || 'DRAFT',
        label: line.status?.label || 'Draft',
        reason_code: line.status?.reason_code || '',
        last_registered_ts: record.last_registered_ts || 0,
        uptime_ratio: summary.uptime_ratio,
        uptime_span_seconds: SEGMENT_WINDOW_SECONDS,
        allowance: db.allowance[iid] || blankAllowance(iid),
        days_to_expiry: expiry
          ? Math.round((expiry - Date.now()) / 86_400_000)
          : null,
        has_query_rule: Boolean(rule.effective),
        keepalive: keepaliveView(iid, record, now),
      }
    })
    return send(res, 200, { lines: rows, now })
  }

  /* ------------------------------------------------------------------- esim */

  if (path === '/api/readers' && method === 'GET') {
    return send(res, 200, { readers: db.readers, stale: false })
  }
  if (path === '/api/cards' && method === 'GET') {
    return send(res, 200, {
      cards: db.cards.map((card, index) => ({
        index,
        name: db.readers[card.reader_index] || `Reader ${card.reader_index}`,
        present: card.present,
        iccid: card.iccid,
        matched: card.matched,
        reader_port: card.reader_port,
      })),
    })
  }

  if (path === '/api/esim/status' && method === 'GET') {
    return send(res, 200, {
      available: db.esim.available,
      lpac_bin: db.esim.lpac_bin,
      download_timeout: db.esim.download_timeout,
      auto_process_notifications: db.esim.auto_process_notifications,
      busy_readers: [...db.esim.busy_readers],
    })
  }

  // `/chip/cached` never touches the card, so it is safe while a line holds the reader.
  if (path === '/api/esim/chip/cached' && method === 'GET') {
    const idx = Number(url.searchParams.get('reader_index') || 0)
    const iccid = db.cards.find((card) => card.reader_index === idx)?.iccid || ''
    const matches = iccid && db.esim.ses.some((se) =>
      (se.profiles || []).some((profile) => profile.iccid === iccid))
    if (!matches) {
      return send(res, 200, {
        ok: true,
        cached: false,
        reader: db.readers[idx] || '',
        reader_index: idx,
      })
    }
    return send(res, 200, {
      ok: true,
      cached: true,
      reader: db.readers[idx] || '',
      reader_index: idx,
      ses: db.esim.ses,
      imei: db.esim.imei,
      ts: db.esim.cached_ts,
    })
  }

  if ((path === '/api/esim/chip' || path === '/api/esim/profiles') && method === 'GET') {
    const idx = Number(url.searchParams.get('reader_index') || 0)
    const matched = db.cards.find((card) => card.reader_index === idx)?.matched || null
    const flat = db.esim.ses.flatMap((se) => se.profiles || [])
    return send(res, 200, {
      ok: true,
      reader: db.readers[idx] || '',
      reader_index: idx,
      dual: db.esim.ses.length > 1,
      ses: db.esim.ses,
      ...(path.endsWith('/chip')
        ? { chip: db.esim.ses[0]?.chip }
        : { profiles: flat, lpa_busy: false }),
      imei: db.esim.imei,
      line_running: Boolean(matched),
      matched_instance: matched,
    })
  }

  if (path === '/api/esim/notifications' && method === 'GET') {
    const idx = Number(url.searchParams.get('reader_index') || 0)
    return send(res, 200, {
      ok: true,
      reader: db.readers[idx] || '',
      dual: db.esim.ses.length > 1,
      ses: db.esim.ses,
      notifications: db.esim.ses.flatMap((se) => se.notifications || []),
    })
  }

  if (path === '/api/esim/notifications/process' && method === 'POST') {
    const body = await readBody(req)
    // Processing removes every queued notification by default, which is what makes the
    // "some cards refuse further operations until these are forwarded" state clear.
    for (const se of db.esim.ses) se.notifications = []
    db.esim.notifications = []
    broadcast({ type: 'cards', cards: [] })
    return send(res, 200, { ok: true, se_id: body.se_id || 'se1' })
  }

  const notificationRemove = path.match(/^\/api\/esim\/notifications\/(\d+)$/)
  if (notificationRemove && method === 'DELETE') {
    const seq = Number(notificationRemove[1])
    for (const se of db.esim.ses) {
      se.notifications = (se.notifications || []).filter((item) => item.seq !== seq)
    }
    return send(res, 200, { ok: true, seq, se_id: 'se1' })
  }

  const esimProfileAction = path.match(
    /^\/api\/esim\/profiles\/([^/]+)\/(enable|disable|nickname)$/,
  )
  if (esimProfileAction && method === 'POST') {
    const iccid = decodeURIComponent(esimProfileAction[1])
    const action = esimProfileAction[2]
    const body = await readBody(req)
    let hit = null
    for (const se of db.esim.ses) {
      const found = (se.profiles || []).find((profile) => profile.iccid === iccid)
      if (!found) continue
      hit = found
      if (action === 'enable') {
        // Enabling one profile disables the rest — a card has exactly one active profile.
        for (const other of se.profiles || []) {
          if (String(other.profileState || '').toLowerCase() === 'enabled') {
            other.profileState = 'disabled'
          }
        }
        found.profileState = 'enabled'
      } else if (action === 'disable') {
        found.profileState = 'disabled'
      } else {
        found.profileNickname = String(body.nickname || '')
      }
    }
    if (!hit) return send(res, 404, { detail: 'no such profile on this eUICC' })
    broadcast({ type: 'cards', cards: [] })
    return send(res, 200, {
      ok: true,
      iccid,
      se_id: hit.seId || 'se1',
      ...(action === 'nickname' ? { nickname: String(body.nickname || '') } : {}),
    })
  }

  const esimProfileDelete = path.match(/^\/api\/esim\/profiles\/([^/]+)$/)
  if (esimProfileDelete && method === 'DELETE') {
    const iccid = decodeURIComponent(esimProfileDelete[1])
    let removed = false
    for (const se of db.esim.ses) {
      const before = (se.profiles || []).length
      se.profiles = (se.profiles || []).filter((profile) => profile.iccid !== iccid)
      if (se.profiles.length !== before) removed = true
    }
    if (!removed) return send(res, 404, { detail: 'no such profile on this eUICC' })
    broadcast({ type: 'cards', cards: [] })
    return send(res, 200, { ok: true, iccid, se_id: 'se1' })
  }

  if (path === '/api/esim/download' && method === 'POST') {
    const body = await readBody(req)
    const idx = Number(body.reader_index || 0)
    const reader = db.readers[idx] || ''
    if (db.esim.busy_readers.includes(reader)) {
      return send(res, 409, { detail: 'an eSIM operation is already running on this reader' })
    }
    if (!body.activation_code && !body.smdp) {
      return send(res, 400, { detail: 'an activation code or an SM-DP+ address is required' })
    }
    // Claim the reader before returning, exactly like the real route: a second concurrent
    // POST must not be able to start a second job.
    db.esim.busy_readers.push(reader)
    const seId = String(body.se_id || db.esim.ses[0]?.id || 'se1')
    // The ICCID the mock pretends to install. Shared by the preview event and the final
    // profile insert so the two cannot drift apart.
    const NEW_PROFILE_ICCID = '8944000000000000010'
    // Run the pipeline as a background task and narrate it over the socket, so the UI's
    // progress list is exercised against the same event shapes the control plane sends.
    ;(async () => {
      const steps = [
        'es10a_get_euicc_configured_addresses',
        'es10b_get_euicc_challenge_and_info',
        'es9p_initiate_authentication',
        'es10b_authenticate_server',
        'es9p_authenticate_client',
        'es8p_metadata_parse',
        'es10b_prepare_download',
        'es9p_get_bound_profile_package',
        'es10b_load_bound_profile_package',
      ]
      const base = { type: 'esim_download', reader, reader_index: idx, se_id: seId }
      broadcast({ ...base, event: 'started', step: 'started' })
      for (const step of steps) {
        await new Promise((resolve) => setTimeout(resolve, 320))
        const isPreview = step === 'es8p_metadata_parse'
        broadcast({
          ...base,
          event: isPreview ? 'preview' : 'progress',
          step,
          ...(isPreview
            ? { metadata: { profileName: 'Downloaded profile', iccid: NEW_PROFILE_ICCID } }
            : {}),
        })
      }
      await new Promise((resolve) => setTimeout(resolve, 320))
      // A real eUICC holds at most one profile per ICCID — installing the same package again
      // replaces it. Pushing unconditionally would hand the UI two rows sharing an ICCID, and
      // since the view keys rows by `<se>:<iccid>` (correctly, mirroring lpac) React would warn
      // about duplicate keys. Mirrors the real constraint instead of papering over it.
      const target = db.esim.ses[0]
      const existing = target.profiles.find((p) => p.iccid === NEW_PROFILE_ICCID)
      if (existing) {
        existing.seId = seId
      } else {
        target.profiles.push({
          iccid: NEW_PROFILE_ICCID,
          profileName: 'Downloaded profile',
          profileState: 'disabled',
          profileClass: 'operational',
          seId,
        })
      }
      db.esim.cached_ts = Math.floor(Date.now() / 1000)
      db.esim.busy_readers = db.esim.busy_readers.filter((name) => name !== reader)
      broadcast({ ...base, event: 'completed', step: 'completed', result: { ok: true } })
      broadcast({ type: 'cards', cards: [] })
    })().catch(() => {
      db.esim.busy_readers = db.esim.busy_readers.filter((name) => name !== reader)
    })
    return send(res, 200, {
      ok: true,
      started: true,
      reader,
      reader_index: idx,
      se_id: seId,
      imei: db.esim.imei,
    })
  }

  if (path === '/api/esim/download/cancel' && method === 'POST') {
    const body = await readBody(req)
    const idx = Number(body.reader_index || 0)
    const reader = db.readers[idx] || ''
    const wasBusy = db.esim.busy_readers.includes(reader)
    db.esim.busy_readers = db.esim.busy_readers.filter((name) => name !== reader)
    if (wasBusy) {
      broadcast({ type: 'esim_download', reader, event: 'cancelling', step: 'cancelling' })
    }
    return send(res, 200, { ok: true, cancelled: wasBusy })
  }

  if (path === '/api/esim/discovery' && method === 'POST') {
    const body = await readBody(req)
    const idx = Number(body.reader_index || 0)
    // SM-DS discovery: the returned address is what the operator then pastes into SM-DP+.
    return send(res, 200, {
      ok: true,
      reader: db.readers[idx] || '',
      se_id: String(body.se_id || 'se1'),
      entries: [{ smdp: 'smdp.demo.example.com', matching_id: 'DEMO-MATCHING-ID' }],
      imei: db.esim.imei,
    })
  }

  if (path === '/api/egress/status' && method === 'GET') return send(res, 200, db.egress)
  if (path === '/api/egress/refresh' && method === 'POST') {
    // The real route deletes the subscription cache, asks the host to republish, and returns a
    // timestamp. Here publishing is instant, so the age field visibly resets.
    const nowSeconds = Math.floor(Date.now() / 1000)
    db.egress.updated_at = nowSeconds
    return send(res, 200, { ok: true, requested_at: nowSeconds })
  }

  /**
   * `POST /api/egress/profile/{id}/test`
   *
   * Mirrors the real route's shape: only `node` and `socks5` can be dialled, and a failure
   * answers 503 with `{message, parsed}` so the UI can show *how the gateway read the link*
   * alongside why it did not dial. Seeded so a `fail` marker in the link fails, letting the
   * failure path be exercised without editing the mock.
   */
  const profileTest = path.match(/^\/api\/egress\/profile\/([^/]+)\/test$/)
  if (profileTest && method === 'POST') {
    const id = decodeURIComponent(profileTest[1])
    const body = await readBody(req)
    const saved = (db.settings.proxy?.profiles || {})[id]
    const profile = body && Object.keys(body).length ? body : saved
    if (!profile || typeof profile !== 'object') {
      return send(res, 404, { detail: 'save this proxy before testing it' })
    }
    if (profile.type !== 'node' && profile.type !== 'socks5') {
      return send(res, 400, { detail: 'only individual nodes and SOCKS5 proxies can be tested here' })
    }
    // How the gateway parsed the link — travels with the failure too, on purpose.
    const parsed = profile.type === 'socks5'
      ? { kind: 'socks5', server: profile.server || '', port: Number(profile.port || 1080) }
      : { kind: 'share-link', protocol: String(profile.value || '').split('://')[0] || 'unknown' }
    const value = String(profile.value || profile.server || '')
    if (value.includes('fail')) {
      return send(res, 503, {
        detail: { message: 'UDP test failed — STUN/4500: no response; DNS/53: no response', parsed },
      })
    }
    return send(res, 200, { ok: true, profile_id: id, latency_ms: 42, parsed })
  }

  /**
   * `POST /api/egress/{country}/test`
   *
   * Blocking by design (up to 25s in the real gateway) — it waits for the exit to become
   * ready, then UDP-probes it. Reproduced here including the failure vocabulary: a direct
   * exit has no tunnel to probe, and an exit with a recorded error reports that error rather
   * than a timeout, because "why" is the whole value of the call.
   */
  const countryTest = path.match(/^\/api\/egress\/([a-z]{2})\/test$/)
  if (countryTest && method === 'POST') {
    const country = countryTest[1]
    const exit = db.egress.exits[country]
    if (!exit) return send(res, 404, 'country exit is not configured')
    if (exit.mode === 'direct') {
      return send(res, 503, 'country exit has no UDP test endpoint')
    }
    if (exit.error) return send(res, 503, exit.error)
    if (!exit.ready) {
      return send(res, 503, 'the exit did not come up within 25s and reported no error — check the orchestrator log for sing-box startup failures')
    }
    return send(res, 200, {
      ok: true,
      country,
      node: exit.node || '',
      interface: exit.interface || '',
      latency_ms: 38,
    })
  }

  /* ------------------------------------------------------------ calls & voicemail */

  /**
   * `GET /api/instances/{iid}/softphone`
   *
   * The real route derives `host` from the request's Host header, which is the browser's own
   * host in a same-origin deployment — that is why the UI can dial it as-is. `enabled` mirrors
   * the line's `sip.webrtc.enable`, so the page can disable Connect with a reason rather than
   * letting registration fail.
   */
  const softphoneRoute = path.match(/^\/api\/instances\/([^/]+)\/softphone$/)
  if (softphoneRoute && method === 'GET') {
    const iid = decodeURIComponent(softphoneRoute[1])
    const inst = (db.instances || []).find((item) => item.id === iid)
    if (!inst) return send(res, 404, { detail: 'no such instance' })
    const wr = inst.sip?.webrtc || {}
    const host = String(req.headers.host || '').split(':')[0] || 'localhost'
    return send(res, 200, {
      enabled: wr.enable !== false,
      username: wr.username || 'webrtc',
      password: 'demo-webrtc-password',
      ws_port: 8089,
      host,
      realm: `ims.mnc0${inst.mnc || '15'}.mcc${inst.mcc || '234'}.3gppnetwork.org`,
    })
  }

  /** `GET /api/instances/{iid}/calls` — newest first, as the store's ORDER BY returns them. */
  const callsList = path.match(/^\/api\/instances\/([^/]+)\/calls$/)
  if (callsList && method === 'GET') {
    const iid = decodeURIComponent(callsList[1])
    const rows = [...(db.calls[iid] || [])].sort((a, b) => b.start_ts - a.start_ts)
    return send(res, 200, { calls: rows })
  }

  /** `POST /api/instances/{iid}/calls/delete` — `{ids:[...]}` or `{all:true}`. */
  const callsDelete = path.match(/^\/api\/instances\/([^/]+)\/calls\/delete$/)
  if (callsDelete && method === 'POST') {
    const iid = decodeURIComponent(callsDelete[1])
    const body = await readBody(req)
    const rows = db.calls[iid] || []
    if (body?.all) {
      const deleted = rows.length
      db.calls[iid] = []
      broadcast({ type: 'call', instance: iid, deleted })
      return send(res, 200, { ok: true, deleted })
    }
    const ids = Array.isArray(body?.ids) ? body.ids.map(Number) : []
    if (!ids.length) return send(res, 400, { detail: 'provide ids or all' })
    const keep = rows.filter((row) => !ids.includes(row.id))
    const deleted = rows.length - keep.length
    db.calls[iid] = keep
    broadcast({ type: 'call', instance: iid, deleted })
    return send(res, 200, { ok: true, deleted })
  }

  /**
   * `POST /api/instances/{iid}/call` — the VoWiFi path.
   *
   * Rings the browser endpoint and bridges it over IMS. Here it just opens a log row, which is
   * what the call log shows; the audio leg needs a real Asterisk and is out of scope.
   */
  const dialRoute = path.match(/^\/api\/instances\/([^/]+)\/call$/)
  if (dialRoute && method === 'POST') {
    const iid = decodeURIComponent(dialRoute[1])
    const body = await readBody(req)
    const to = String(body?.to || '').trim()
    if (!to) return send(res, 422, { detail: 'to is required' })
    const inst = (db.instances || []).find((item) => item.id === iid)
    if (!inst || String(inst.status?.state || '').toUpperCase() === 'STOPPED') {
      // The real route answers 409 when the engine is not running.
      return send(res, 409, { detail: 'instance not running' })
    }
    const row = {
      id: (db.call_seq = (db.call_seq || 100) + 1),
      instance: iid,
      direction: 'out',
      peer: to,
      status: 'ringing',
      start_ts: Math.floor(Date.now() / 1000),
      end_ts: null,
      transport: 'vowifi',
    }
    ;(db.calls[iid] = db.calls[iid] || []).push(row)
    broadcast({ type: 'call', instance: iid, call: row })
    return send(res, 200, { ok: true, record: row })
  }

  const hangupRoute = path.match(/^\/api\/instances\/([^/]+)\/hangup$/)
  if (hangupRoute && method === 'POST') {
    const iid = decodeURIComponent(hangupRoute[1])
    const inst = (db.instances || []).find((item) => item.id === iid)
    if (!inst || String(inst.status?.state || '').toUpperCase() === 'STOPPED') {
      return send(res, 409, { detail: 'instance not running' })
    }
    const nowSeconds = Math.floor(Date.now() / 1000)
    for (const row of db.calls[iid] || []) {
      if (row.end_ts === null || row.end_ts === undefined) {
        row.end_ts = nowSeconds
        row.status = 'ended'
      }
    }
    broadcast({ type: 'call', instance: iid })
    return send(res, 200, { ok: true })
  }

  /**
   * The cellular path.
   *
   * `uncertain` is a real outcome the modem can produce: the AT command was accepted but the
   * carrier never confirmed. The mock reproduces it for one specific number so the UI's
   * "unknown" branch is reachable, and runs a small clock so the status poll sees the call move
   * from dialling to answered to ended instead of freezing.
   */
  const cellularDial = path.match(/^\/api\/instances\/([^/]+)\/cellular-call$/)
  if (cellularDial && method === 'POST') {
    const iid = decodeURIComponent(cellularDial[1])
    const body = await readBody(req)
    const to = String(body?.to || '').trim()
    const inst = (db.instances || []).find((item) => item.id === iid)
    if (!inst) return send(res, 404, { detail: 'instance not found' })
    // Cellular capability lives on the DEVICE bound to the line, not on the line itself — a
    // line whose modem was never recognised has no cellular path at all.
    const device = (db.devices || []).find((item) => item.instance_id === iid)
    if (!device || !device.cellular) {
      return send(res, 409, { detail: 'Cellular calling is unavailable' })
    }
    // Any number ending in 999 is treated as "the carrier never confirmed". Documented here
    // because the test that exercises it has to dial a number that actually matches.
    const uncertain = to.endsWith('999')
    const row = {
      id: (db.call_seq = (db.call_seq || 100) + 1),
      instance: iid,
      direction: 'out',
      peer: to,
      status: uncertain ? 'unknown' : 'ringing',
      start_ts: Math.floor(Date.now() / 1000),
      end_ts: null,
      transport: 'cellular',
    }
    ;(db.calls[iid] = db.calls[iid] || []).push(row)
    db.cellular_calls = db.cellular_calls || {}
    db.cellular_calls[iid] = {
      record_id: row.id,
      started_at: Date.now(),
      uncertain,
      // Advance the state machine on a clock so a poll actually observes progress.
      phases: uncertain ? ['unknown'] : ['dialing', 'ringing-out', 'active', 'terminated'],
    }
    broadcast({ type: 'call', instance: iid, call: row })
    return send(res, 200, uncertain ? { ok: false, uncertain: true, record: row } : { ok: true, record: row })
  }

  const cellularStatus = path.match(/^\/api\/instances\/([^/]+)\/cellular-call\/status$/)
  if (cellularStatus && method === 'GET') {
    const iid = decodeURIComponent(cellularStatus[1])
    const inst = (db.instances || []).find((item) => item.id === iid)
    if (!inst) return send(res, 404, { detail: 'instance not found' })
    const state = (db.cellular_calls || {})[iid]
    if (!state) return send(res, 200, { status: 'idle' })
    const elapsed = Date.now() - state.started_at
    const index = Math.min(state.phases.length - 1, Math.floor(elapsed / 2000))
    const status = state.phases[index]
    // Parenthesised on purpose: an unresolved `unknown` is also a settled answer here.
    const ended = status === 'terminated' || (status === 'unknown' && state.phases.length === 1)
    const row = (db.calls[iid] || []).find((item) => item.id === state.record_id)
    if (row) {
      row.status = status === 'active' ? 'answered' : status === 'terminated' ? 'ended' : status
      if (status === 'terminated') row.end_ts = Math.floor(Date.now() / 1000)
    }
    if (status === 'terminated') delete db.cellular_calls[iid]
    return send(res, 200, { status, record: row || undefined, ended })
  }

  const cellularHangup = path.match(/^\/api\/instances\/([^/]+)\/cellular-call\/hangup$/)
  if (cellularHangup && method === 'POST') {
    const iid = decodeURIComponent(cellularHangup[1])
    const inst = (db.instances || []).find((item) => item.id === iid)
    if (!inst) return send(res, 404, { detail: 'instance not found' })
    const nowSeconds = Math.floor(Date.now() / 1000)
    for (const row of db.calls[iid] || []) {
      if (row.transport === 'cellular' && (row.end_ts === null || row.end_ts === undefined)) {
        row.end_ts = nowSeconds
        row.status = 'ended'
      }
    }
    if (db.cellular_calls) delete db.cellular_calls[iid]
    broadcast({ type: 'call', instance: iid })
    return send(res, 200, { ok: true })
  }

  /** `GET /api/instances/{iid}/voicemails` */
  const voicemailList = path.match(/^\/api\/instances\/([^/]+)\/voicemails$/)
  if (voicemailList && method === 'GET') {
    const iid = decodeURIComponent(voicemailList[1])
    return send(res, 200, { voicemails: db.voicemails[iid] || [] })
  }

  /**
   * `GET /api/instances/{iid}/voicemails/{vid}/audio`
   *
   * Served inline, not as an attachment: the point is playback in the call log. The bytes are a
   * real (if silent) 8 kHz mono WAV so the browser's audio element can actually decode it —
   * a stub body would make the player look broken.
   */
  const voicemailAudio = path.match(/^\/api\/instances\/([^/]+)\/voicemails\/(\d+)\/audio$/)
  if (voicemailAudio && method === 'GET') {
    const iid = decodeURIComponent(voicemailAudio[1])
    const vid = Number(voicemailAudio[2])
    const row = (db.voicemails[iid] || []).find((item) => item.id === vid)
    if (!row) return send(res, 404, { detail: 'no such voicemail' })
    const seconds = Math.max(1, Math.min(30, Number(row.duration_seconds) || 1))
    const rate = 8000
    const samples = rate * seconds
    const buf = Buffer.alloc(44 + samples * 2)
    buf.write('RIFF', 0)
    buf.writeUInt32LE(36 + samples * 2, 4)
    buf.write('WAVE', 8)
    buf.write('fmt ', 12)
    buf.writeUInt32LE(16, 16)
    buf.writeUInt16LE(1, 20)
    buf.writeUInt16LE(1, 22)
    buf.writeUInt32LE(rate, 24)
    buf.writeUInt32LE(rate * 2, 28)
    buf.writeUInt16LE(2, 32)
    buf.writeUInt16LE(16, 34)
    buf.write('data', 36)
    buf.writeUInt32LE(samples * 2, 40)
    // A quiet tone rather than pure silence, so "playing" is audibly distinguishable.
    for (let i = 0; i < samples; i += 1) {
      buf.writeInt16LE(Math.round(2000 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2)
    }
    res.writeHead(200, {
      'content-type': 'audio/wav',
      'content-length': String(buf.length),
      'content-disposition': 'inline',
      'cache-control': 'no-store',
    })
    return res.end(buf)
  }

  const voicemailListened = path.match(/^\/api\/instances\/([^/]+)\/voicemails\/(\d+)\/listened$/)
  if (voicemailListened && method === 'POST') {
    const iid = decodeURIComponent(voicemailListened[1])
    const vid = Number(voicemailListened[2])
    const row = (db.voicemails[iid] || []).find((item) => item.id === vid)
    if (!row) return send(res, 404, { detail: 'no such voicemail' })
    row.listened = true
    broadcast({ type: 'voicemail', instance: iid, listened: vid })
    return send(res, 200, { ok: true })
  }

  const voicemailDelete = path.match(/^\/api\/instances\/([^/]+)\/voicemails\/delete$/)
  if (voicemailDelete && method === 'POST') {
    const iid = decodeURIComponent(voicemailDelete[1])
    const body = await readBody(req)
    const rows = db.voicemails[iid] || []
    if (body?.all) {
      db.voicemails[iid] = []
      broadcast({ type: 'voicemail', instance: iid, deleted: rows.length })
      return send(res, 200, { deleted: rows.length })
    }
    const ids = Array.isArray(body?.ids) ? body.ids.map(Number) : []
    if (!ids.length) return send(res, 422, { detail: 'provide ids or all:true' })
    const keep = rows.filter((row) => !ids.includes(row.id))
    const deleted = rows.length - keep.length
    db.voicemails[iid] = keep
    broadcast({ type: 'voicemail', instance: iid, deleted })
    return send(res, 200, { deleted })
  }

  /**
   * `GET /api/esim/inventory`
   *
   * Two eUICCs on purpose: one a reader is reporting right now, and one that exists only in
   * the cache. The second is the interesting case — it must render as "not verified" rather
   * than as present or absent, because the cache is keyed by EID and nothing removes an entry
   * when a card is taken out.
   */
  if (path === '/api/esim/inventory' && method === 'GET') {
    const refresh = url.searchParams.get('refresh') === '1'
    const readers = db.readers || []
    const nowSeconds = Math.floor(Date.now() / 1000)
    const euiccs = [
      {
        eid: '89049032005008882600033357901234',
        imei: '860000000000001',
        reader: readers[0] || '',
        present: true,
        ses: 1,
        profiles: 2,
        enabled: 1,
        errors: [],
        read_at: refresh ? nowSeconds : nowSeconds - 180,
        age_seconds: refresh ? 0 : 180,
        stale: false,
        line: 'line-1',
      },
      {
        // Only in the cache: no reader reported it, so presence is unknown.
        eid: '89049032005008882600033357909999',
        imei: '',
        reader: '',
        present: null,
        ses: 1,
        profiles: 1,
        enabled: 0,
        errors: [],
        read_at: nowSeconds - 9 * 3600,
        age_seconds: 9 * 3600,
        stale: true,
        line: null,
      },
    ]
    return send(res, 200, {
      ok: true,
      refreshed: refresh,
      now: nowSeconds,
      readers,
      euiccs,
      count: euiccs.length,
      unseen: refresh ? 1 : 0,
      errors: [],
    })
  }

  /* ------------------------------------------------------------ AT / USSD terminal */

  /**
   * `POST /api/instances/{iid}/at`
   *
   * Mirrors the control plane's three buckets, because the whole point of the page is how it
   * renders each of them: a refusal that never reached the module, a confirmation naming the
   * consequence, and a real answer. A mock that only ever answered `OK` would leave the two
   * interesting branches untested.
   */
  const atRoute = path.match(/^\/api\/instances\/([^/]+)\/at$/)
  if (atRoute && method === 'POST') {
    const iid = decodeURIComponent(atRoute[1])
    const body = await readBody(req)
    const raw = String(body?.command || '')
    const confirm = Boolean(body?.confirm)
    const command = raw.trim().replace(/\s+/g, ' ').toUpperCase()

    const BLOCKED = [
      [/^AT\+EGMR/, 'IMEI/IMEISV 写入会改写模块身份，且可能永久损坏'],
      [/^AT\+QPRTPARA/, 'NV 参数区操作不可逆（=3 恢复出厂会清掉射频校准）'],
      [/^AT\+CSIM/, '原始 SIM APDU 可以永久锁死 SIM 卡'],
      [/^AT\+CRSM/, '受限 SIM 访问同样可以永久锁死 SIM 卡'],
      [/^AT\+IPR/, '修改串口波特率会让这个端口再也连不上'],
      [/^AT\+(?:QDL|QFOTADL|QDOWNLOAD)/, '进入固件下载模式会中断正常通信'],
    ]
    const CONFIRM = [
      [/^AT\+CFUN=/, '会改变射频状态；AT+CFUN=0 或 =4 会让线路立刻掉线'],
      [/^AT\+CPIN=/, 'PIN 连续输错 3 次会永久锁卡，需要 PUK 才能解开'],
      [/^AT&F/, '恢复出厂设置会清掉当前全部配置'],
      [/^AT\+CGDCONT=/, '会改写 PDP 上下文，影响数据与 IMS'],
      [/^AT\+CMG[SDW]=/, '会发送或写入短信，可能产生费用'],
    ]
    const BARE_INFO = new Set([
      'AT', 'ATI', 'AT+CGMI', 'AT+CGMM', 'AT+CGMR', 'AT+CGSN', 'AT+CSQ',
      'AT+CGPADDR', 'AT+CPAS', 'AT+CGATT', 'AT+CREG', 'AT+CGREG', 'AT+CEREG',
      'AT+COPS', 'AT+CGDCONT', 'AT+GCAP', 'AT+CFUN', 'AT+QNWINFO', 'AT+QCSQ',
    ])

    const reply = (extra) => send(res, 200, {
      ok: false, command, response: '', error: '', blocked: false,
      needs_confirm: false, reason: '', ...extra,
    })

    if (!command) return reply({ error: '命令为空' })
    if (!/^AT[\w+&^*#;>]*(?:[=?!].*)?$/.test(command)) {
      return reply({ error: '只接受 AT 命令（需以 AT 开头）' })
    }

    for (const [pattern, reason] of BLOCKED) {
      if (pattern.test(command)) {
        // 403, exactly like the control plane: a refused command did not run, and the body is
        // the bare reason so the client can add its own framing.
        return send(res, 403, { detail: reason })
      }
    }

    if (/\?\s*$/.test(command) || command.startsWith('AT+CUSD') || BARE_INFO.has(command)) {
      // allowed below
    } else {
      for (const [pattern, reason] of CONFIRM) {
        if (pattern.test(command)) {
          if (!confirm) {
            return reply({ needs_confirm: true, error: `需要确认：${reason}`, reason: `需要确认：${reason}` })
          }
          break
        }
      }
    }

    const inst = (db.instances || []).find((item) => item.id === iid)
    if (!inst) return send(res, 404, { detail: '找不到这条线路' })
    const device = (db.devices || []).find((item) => item.instance_id === iid)
    if (!device || !device.cellular) {
      return reply({ error: '没有可用的蜂窝模块' })
    }

    // Canned answers for the commands the page offers as buttons, so the output pane shows
    // something shaped like a real module's reply rather than a placeholder.
    const ANSWERS = {
      ATI: 'Quectel\r\nEG25-G\r\nRevision: EG25GGBR07A08M2G',
      'AT+CGMI': 'Quectel',
      'AT+CGMM': 'EG25-G',
      'AT+CGMR': 'EG25GGBR07A08M2G',
      'AT+CGSN': '860000000000001',
      'AT+CSQ': '+CSQ: 24,99',
      'AT+CREG?': '+CREG: 0,1',
      'AT+CEREG?': '+CEREG: 0,1',
      'AT+COPS?': '+COPS: 0,0,"Demo Mobile",7',
      'AT+CGPADDR': '+CGPADDR: 1,"10.42.0.7"',
      'AT+CGDCONT?': '+CGDCONT: 1,"IP","ims","10.42.0.7",0,0',
      'AT+CFUN?': '+CFUN: 1',
      'AT+CPAS': '+CPAS: 0',
    }

    let response = ANSWERS[command]
    if (response === undefined) {
      // USSD comes back as a URC carrying the carrier's own text, which the gateway does not
      // parse — so the mock hands back the raw line, not a parsed balance.
      const ussd = command.match(/^AT\+CUSD=1,"([^"]+)"/)
      if (ussd) {
        response = `+CUSD: 0,"Your balance is 12.40 GBP.",15`
      } else if (/\?\s*$/.test(command) || BARE_INFO.has(command)) {
        response = 'ERROR'
      } else {
        response = 'OK'
      }
    }

    return send(res, 200, {
      ok: true, command, response, error: '', blocked: false,
      needs_confirm: false, reason: '',
    })
  }

  /**
   * Notification test endpoints.
   *
   * They exist to prove the delivery path end to end with the *stored* configuration, which is
   * why each one is gated on its channel being enabled — a test against a disabled channel
   * would report success for something that can never fire. The event to render comes in as
   * `_test_event` (the real control plane uses the same private key).
   */
  const notifTest = path.match(
    /^\/api\/notifications\/(webhook|telegram|pushplus|feishu|bark|email)\/test$/,
  )
  if (notifTest && method === 'POST') {
    const channel = notifTest[1]
    const body = await readBody(req)
    const config = db.settings[channel] || {}
    if (!config.enabled) {
      return send(res, 400, { detail: `the ${channel} channel is disabled` })
    }
    const event = String(body?._test_event || 'incoming_sms')
    db.notifications.deliveries.unshift({
      id: `d-${Date.now()}`,
      created_at: Math.floor(Date.now() / 1000),
      finished_at: Math.floor(Date.now() / 1000),
      channel,
      event,
      instance: 'sim-jp',
      status: 'ok',
      attempts: 1,
      status_code: 200,
      error: '',
    })
    return send(res, 200, {
      ok: true,
      channel,
      event,
      message: `test payload delivered to ${channel}`,
    })
  }

  /**
   * `GET /api/notifications/deliveries`
   *
   * `limit` is clamped the way the gateway clamps it, and the history comes back newest-first
   * while pending comes back separately — in flight is not the same thing as recently done.
   */
  if (path === '/api/notifications/deliveries' && method === 'GET') {
    const raw = Number(url.searchParams.get('limit') || 100)
    const limit = Math.min(500, Math.max(1, Number.isFinite(raw) ? raw : 100))
    const all = db.notifications.deliveries
    return send(res, 200, {
      pending: all.filter((d) => d.status === 'pending').slice(0, limit),
      history: all.filter((d) => d.status !== 'pending').slice(0, limit),
    })
  }

  if (path === '/api/notifications/deliveries' && method === 'DELETE') {
    db.notifications.deliveries = []
    return send(res, 200, { ok: true })
  }

  if (path === '/api/system/status' && method === 'GET') {
    return send(res, 200, { version: '1.10.0-mock', hostname: 'mock-gateway', disk_free_bytes: 8_589_934_592 })
  }
  if (path === '/api/settings' && method === 'GET') return send(res, 200, db.settings)
  if (path === '/api/settings' && method === 'PUT') {
    // Mirrors control/app/main.py::api_put_settings, including the parts the UI depends on:
    // a shallow top-level merge (so a partial patch never resets an untouched key), per-key
    // validation answering 400 {"detail": ...}, the hardware merge, and the stored document
    // as the response body rather than `{ok: true}`.
    const patch = { ...(await readBody(req)) }
    delete patch.system_name

    if (patch.timezone !== undefined && !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(String(patch.timezone))) {
      return send(res, 400, { detail: 'unknown timezone' })
    }
    if (patch.device_defaults !== undefined) {
      const allowed = ['cellular_enabled', 'vowifi_enabled', 'flight_mode']
      const defaults = patch.device_defaults
      if (
        typeof defaults !== 'object' ||
        defaults === null ||
        Object.keys(defaults).some((key) => !allowed.includes(key)) ||
        Object.values(defaults).some((value) => typeof value !== 'boolean')
      ) {
        return send(res, 400, { detail: 'invalid new-device defaults' })
      }
    }
    if (patch.hardware !== undefined) {
      if (typeof patch.hardware !== 'object' || patch.hardware === null) {
        return send(res, 400, { detail: 'invalid hardware settings' })
      }
      const backend = String(patch.hardware.modem_backend ?? 'auto') || 'auto'
      if (!['auto', 'serial'].includes(backend)) {
        return send(res, 400, { detail: 'modem_backend must be auto or serial' })
      }
      // Settings updates replace top-level keys wholesale; a client sending only the backend
      // switch must not wipe the modem profiles beside it.
      patch.hardware = { ...db.settings.hardware, ...patch.hardware, modem_backend: backend }
    }

    Object.assign(db.settings, patch)
    return send(res, 200, db.settings)
  }

  const threadMatch = path.match(/^\/api\/instances\/([^/]+)\/messages\/threads$/)
  if (threadMatch && method === 'GET') {
    const iid = decodeURIComponent(threadMatch[1])
    const messages = db.messages[iid] || []
    const byPeer = new Map()
    for (const message of messages) {
      const entry = byPeer.get(message.peer) || { peer: message.peer, last: message, count: 0, unread: 0 }
      entry.count += 1
      if (message.unread) entry.unread += 1
      if (message.timestamp > entry.last.timestamp) entry.last = message
      byPeer.set(message.peer, entry)
    }
    return send(res, 200, { threads: [...byPeer.values()] })
  }

  const historyMatch = path.match(/^\/api\/instances\/([^/]+)\/messages\/([^/]+)$/)
  if (historyMatch && method === 'GET') {
    const iid = decodeURIComponent(historyMatch[1])
    const peer = decodeURIComponent(historyMatch[2])
    if (peer === 'binary') return send(res, 200, { messages: [] })
    const messages = (db.messages[iid] || []).filter((message) => message.peer === peer)
    return send(res, 200, { messages })
  }

  const sendMatch = path.match(/^\/api\/instances\/([^/]+)\/sms\/send$/)
  if (sendMatch && method === 'POST') {
    const iid = decodeURIComponent(sendMatch[1])
    const body = await readBody(req)
    const to = String(body.to || '')
    const text = String(body.body || '')
    if (!to || !text) return send(res, 400, { detail: 'to and body are required' })
    const message = {
      id: randomUUID(),
      peer: to,
      body: text,
      timestamp: Math.floor(Date.now() / 1000),
      inbound: false,
      delivery: 'PENDING',
    }
    db.messages[iid] = [...(db.messages[iid] || []), message]
    broadcast({ type: 'sms', instance: iid, message })
    // Deliver shortly after, so the UI can render a delivery transition.
    setTimeout(() => {
      message.delivery = 'DELIVERED'
      broadcast({ type: 'sms', instance: iid, message })
    }, 1800)
    return send(res, 200, { ok: true })
  }

  if (path.startsWith('/api/')) return send(res, 404, { detail: `no mock route for ${method} ${path}` })
  return send(res, 404, { detail: 'mock backend serves the API only; run `npm run dev` for the UI' })
})

function issueSession(res, remember) {
  const token = randomUUID()
  const csrf = randomUUID()
  const maxAge = remember ? 30 * 24 * 3600 : 12 * 3600
  state.sessions.set(token, { csrf, expires: Date.now() + maxAge * 1000 })
  return send(res, 200, { ok: true, authenticated: true, csrf }, { 'Set-Cookie': cookieHeader(token, maxAge) })
}

/* -------------------------------------------------------------- websocket */

const clients = new Set()

function broadcast(payload) {
  const frame = encodeTextFrame(JSON.stringify(payload))
  for (const socket of clients) {
    try {
      socket.write(frame)
    } catch {
      clients.delete(socket)
    }
  }
}

function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.from([0x81, length])
  } else if (length < 65_536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  if (url.pathname !== '/ws') {
    socket.destroy()
    return
  }

  const key = req.headers['sec-websocket-key']
  if (!key) {
    socket.destroy()
    return
  }

  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64')

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )

  // Same contract as the real hub: accept first, then decide.
  const session = sessionOf(req)
  if (!session) {
    if (url.searchParams.get('auth_close') === '1') {
      socket.write(encodeCloseFrame(4401))
      socket.end()
    }
    return
  }

  clients.add(socket)
  socket.on('data', () => {
    /* inbound frames are ignored, exactly like the real endpoint */
  })
  socket.on('close', () => clients.delete(socket))
  socket.on('error', () => clients.delete(socket))

  socket.write(encodeTextFrame(JSON.stringify({ type: 'existing', cards: [] })))
})

function encodeCloseFrame(code) {
  const payload = Buffer.alloc(2)
  payload.writeUInt16BE(code, 0)
  return Buffer.concat([Buffer.from([0x88, payload.length]), payload])
}

/* ------------------------------------------------------------- demo events */

setInterval(() => {
  const line = db.instances[0]
  broadcast({
    type: 'status',
    instance: line.id,
    state: line.status.state,
    label: line.status.label,
    detail: line.status.detail,
  })
}, 20_000)

server.listen(PORT, HOST, () => {
  console.log(`[mock] control plane listening on http://${HOST}:${PORT}`)
  console.log(`[mock] configured=${state.configured} username=${state.username}`)
  if (!state.configured) {
    console.log('[mock] no administrator yet — the console will show the setup screen')
  }
})
