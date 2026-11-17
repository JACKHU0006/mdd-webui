/**
 * Browser softphone: a JsSIP user agent over WSS to the engine's Asterisk WebRTC transport.
 *
 * This is a port of the upstream `softphone.js`, and the comments are deliberately kept: nearly
 * every branch here exists because the obvious version of it failed in the field, and the
 * failure usually looked like something else. The four that matter most:
 *
 *  1. **A call can die ~10 ms after the click with no INVITE sent.** JsSIP's first step on both
 *     `call()` and `answer()` is `getUserMedia`; with no microphone the session fails before any
 *     signalling leaves the browser, and JsSIP reports every such failure as the single cause
 *     `User Denied Media Access`, which says nothing about a machine that simply has no input.
 *     So local media is acquired HERE and JsSIP is handed silence when there is no microphone —
 *     the call is still placed, the operator is told they will not be heard, and a service code
 *     or voicemail box (neither of which needs the mic) still works.
 *
 *  2. **Remote audio must be primed inside a user gesture.** One stable `<audio>` element,
 *     owned by React and injected via a ref, played once (muted) inside the click handler. Every
 *     later `srcObject` swap on that same element then plays without hitting the autoplay policy.
 *     A per-call `new Audio()` does not get this and goes silent.
 *
 *  3. **`#` is not a legal SIP URI user character** (RFC 3261 §25.1) and JsSIP rejects the whole
 *     URI rather than escaping it, so `#225#` would never leave the browser. Asterisk
 *     percent-decodes the user part before dialplan matching, so `%23` keeps EXTEN unchanged.
 *
 *  4. **Rejecting is not hanging up.** A bare `terminate()` on a ringing incoming call sends
 *     480 Temporarily Unavailable, which Asterisk maps to NOANSWER — the call is then logged as
 *     *missed* when the operator actually declined it. 603 makes the disposition "rejected".
 */

import JsSIP from 'jssip'
import type { RTCSession, EndEvent, PeerConnectionEvent } from 'jssip/lib/RTCSession'
import type { SoftphoneProvisioning } from './types.ts'

/* Surface JsSIP internals (registration, ICE) in the console — the only window into a
 * registration that fails without a usable error on the event. */
try {
  JsSIP.debug.disable('JsSIP:*')
} catch {
  /* debug is a debugging aid; never let it break the module */
}

export type SoftphoneEvent =
  | 'ws'
  | 'registered'
  | 'regfail'
  | 'incoming'
  | 'calling'
  | 'progress'
  | 'active'
  | 'ended'
  | 'failed'
  | 'mediafail'
  | 'mediafallback'
  | 'audioblocked'

export interface SoftphonePayload {
  from?: string
  to?: string
  cause?: string
  reason?: string
  detail?: string
}

type Emit = (type: SoftphoneEvent, data?: SoftphonePayload | boolean | string) => void

/** Presence verdict for an audio input, or the DOMException name that stopped us finding out. */
export type AudioInputPresence = 'present' | 'none' | 'unknown' | 'insecure'

/** A microphone problem, named as a message key plus the raw reason for the record. */
export type MicrophoneProblem =
  | 'none'
  | 'blocked'
  | 'busy'
  | 'insecure'
  | 'unknown'

export const MEDIA_FAIL_CAUSE = 'User Denied Media Access'

/**
 * Does this browser have a microphone at all?
 *
 * `enumerateDevices()` needs no permission and does not open the device, and Chromium-family
 * browsers still list one entry per *available* kind before permission is granted — so a
 * non-empty list with no `audioinput` is proof there is no microphone. An empty list means the
 * browser is withholding device info, which proves nothing: report `unknown` rather than warn
 * about a microphone that is probably there.
 */
export async function audioInputPresence(): Promise<AudioInputPresence> {
  const media = navigator.mediaDevices
  if (!media || !media.getUserMedia) return 'insecure'
  if (!media.enumerateDevices) return 'unknown'
  try {
    const devices = await media.enumerateDevices()
    if (!devices.length) return 'unknown'
    return devices.some((device) => device.kind === 'audioinput') ? 'present' : 'none'
  } catch {
    return 'unknown'
  }
}

/**
 * Classify a media failure into a problem the UI can name.
 *
 * None of these stop a call — they say what the call WILL be, so nobody discovers it by being
 * unheard. The returned value is an enum, not a sentence: the view owns the wording so both
 * languages stay in one place.
 */
export function classifyMicrophone(reason: string): MicrophoneProblem {
  switch (reason) {
    case 'none':
    case 'NotFoundError':
    case 'DevicesNotFoundError': // legacy Chrome name for the same condition
      return 'none'
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'blocked'
    case 'NotReadableError':
    case 'TrackStartError':
      return 'busy'
    case 'insecure':
      return 'insecure'
    default:
      return 'unknown'
  }
}

/**
 * A silence generator for machines with no microphone.
 *
 * WebRTC has no offer to make without a local track, which is why a missing microphone used to
 * end the call before an INVITE was ever sent. Silence is a perfectly good track: an oscillator
 * at zero gain keeps the graph running so the destination really produces (empty) frames rather
 * than nothing at all.
 */
function silentAudioStream(): {
  stream: MediaStream
  ctx: AudioContext
  osc: OscillatorNode
} | null {
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctx) return null
  try {
    const ctx = new Ctx()
    const dest = ctx.createMediaStreamDestination()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    gain.gain.value = 0
    osc.connect(gain).connect(dest)
    osc.start()
    void ctx.resume?.().catch(() => {})
    return { stream: dest.stream, ctx, osc }
  } catch {
    return null
  }
}

interface LocalMedia {
  stream: MediaStream | null
  silent: boolean
  reason?: string
  ctx?: AudioContext
  osc?: OscillatorNode
}

export class Softphone {
  private onEvent: Emit
  private ua: JsSIP.UA | null = null
  private session: RTCSession | null = null
  private remoteAudio: HTMLAudioElement | null
  /** SIP domain of the running UA, captured at start(); `UA.configuration` is not public API. */
  private domain = ''
  /** Set by `stop()` so late JsSIP events cannot clobber a newly started line's state. */
  private dead = false
  private unlocked = false
  private rec: MediaRecorder | null = null
  private recCtx: AudioContext | null = null
  private recChunks: Blob[] = []
  /** Local audio handed to JsSIP; ours to release (JsSIP only stops tracks it made itself). */
  private local: LocalMedia | null = null
  /** Sessions whose listeners are already attached, so a double entry cannot double-fire. */
  private boundSessions = new WeakSet<RTCSession>()

  constructor(onEvent: Emit, audioEl?: HTMLAudioElement | null) {
    this.onEvent = onEvent
    this.remoteAudio = audioEl ?? null
  }

  private emit(type: SoftphoneEvent, data?: SoftphonePayload | boolean | string): void {
    try {
      this.onEvent(type, data)
    } catch {
      /* a throwing listener must not take the UA down with it */
    }
  }

  /** Point the class at the React-owned `<audio>` element, from the component's ref effect. */
  setAudioEl(el: HTMLAudioElement | null): void {
    if (el) this.remoteAudio = el
  }

  private ensureAudio(): HTMLAudioElement {
    if (!this.remoteAudio) {
      // Fallback only: something to render into if no element was injected. Tagged so `stop()`
      // knows this one is ours to remove — the React-owned element is not.
      const el = new Audio()
      el.autoplay = true
      el.setAttribute('playsinline', '')
      el.style.display = 'none'
      el.dataset.mddOwned = '1'
      try {
        document.body.appendChild(el)
      } catch {
        /* detached document */
      }
      this.remoteAudio = el
    }
    return this.remoteAudio
  }

  /**
   * Prime the sink INSIDE a user gesture (Call / Answer click).
   *
   * Playing the element — even empty — while the page has transient activation marks it
   * user-activated, so every later `play()` on this same element resolves and the autoplay
   * policy is defeated. Must be called synchronously from the handler: do not await first.
   */
  unlockAudio(): void {
    if (this.unlocked) return
    const el = this.ensureAudio()
    try {
      el.muted = true
      const p = el.play()
      if (p && typeof p.then === 'function') {
        p.then(() => {
          try {
            el.pause()
            el.currentTime = 0
          } catch {
            /* not seekable yet */
          }
          el.muted = false
        }).catch(() => {
          el.muted = false
        })
      } else {
        try {
          el.pause()
        } catch {
          /* ignore */
        }
        el.muted = false
      }
      this.unlocked = true
    } catch {
      el.muted = false
    }
  }

  /**
   * Attach a remote stream and force playback.
   *
   * The element was primed on the click, so `play()` should resolve. The catch stays as
   * telemetry and arms a one-time gesture retry as a last resort, because a silent call with no
   * explanation is the worst possible outcome.
   */
  attachRemote(stream: MediaStream | null): void {
    if (!stream) return
    const el = this.ensureAudio()
    if (el.srcObject !== stream) el.srcObject = stream
    el.muted = false
    el.volume = 1
    const p = el.play()
    if (p && typeof p.catch === 'function') {
      p.catch((err: DOMException | Error) => {
        this.emit('audioblocked', (err && err.name) || 'play-failed')
        const resume = () => {
          void el.play().finally(() => {
            document.removeEventListener('click', resume, true)
            document.removeEventListener('touchend', resume, true)
          })
        }
        document.addEventListener('click', resume, true)
        document.addEventListener('touchend', resume, true)
      })
    }
  }

  /** Start the UA. `prov` comes from `GET /api/instances/{iid}/softphone`. */
  start(prov: SoftphoneProvisioning, host: string): void {
    if (this.ua) this.stop()
    this.dead = false
    // 后端两个版本对这个字段的处理不同：
    //   v1.14.1+ —— 只给 ws_path，信令是控制面的同源 relay（8443 / 反代后的同一 origin）；
    //   更早的版本 —— 给 ws_port，浏览器直连引擎自己的 WSS 端口。
    // 同源路径优先：它复用页面已经受信的证书，反代后面也不用再开第二个端口。
    const secure = window.location.protocol === 'https:'
    const wsUrl = prov.ws_path
      ? `${secure ? 'wss' : 'ws'}://${window.location.host}${prov.ws_path}`
      : `wss://${host}:${prov.ws_port}/ws`
    const socket = new JsSIP.WebSocketInterface(wsUrl)
    const domain = prov.domain || host
    this.domain = domain
    const ua = new JsSIP.UA({
      sockets: [socket],
      uri: `sip:${prov.username}@${domain}`,
      password: prov.password,
      register: true,
      session_timers: false,
      contact_uri: `sip:${prov.username}@${domain};transport=wss`,
    })
    this.ua = ua

    ua.on('connected', () => this.emit('ws', 'connected'))
    // Only 'disconnected' is gated on `dead`: `stop()` (called when the user switches lines)
    // fires it ASYNCHRONOUSLY about a second later, and that late event from the torn-down UA
    // would otherwise flip the newly registered line's status to red. Every other event must
    // always pass — gating them breaks the incoming-call Answer/Decline overlay.
    ua.on('disconnected', () => {
      if (!this.dead) this.emit('ws', 'disconnected')
    })
    ua.on('registered', () => this.emit('registered', true))
    ua.on('unregistered', () => this.emit('registered', false))
    ua.on('registrationFailed', (e: { cause?: string }) =>
      this.emit('regfail', e?.cause || 'failed'),
    )
    ua.on('newRTCSession', (e: { session: RTCSession }) => this.handleSession(e.session))
    ua.start()
  }

  private handleSession(session: RTCSession): void {
    // Already in a call: reject any second incoming session as busy.
    if (this.session && this.session !== session) {
      if (session.direction === 'incoming') {
        try {
          session.terminate({ status_code: 486, reason_phrase: 'Busy Here' })
        } catch {
          /* already gone */
        }
      }
      return
    }
    this.session = session
    // An outgoing call reaches here twice (once from `call()`, once from the UA's own
    // 'newRTCSession' for the same session). Binding twice would double-fire every event.
    // Tracked externally: the session object belongs to JsSIP, not to us.
    if (this.boundSessions.has(session)) return
    this.boundSessions.add(session)

    // 'getusermediafailed' fires BEFORE the session's 'failed', so 'failed' alone can never say
    // why a call died in milliseconds. Pass the DOMException name up so the UI can name it.
    session.on('getusermediafailed', (err: unknown) =>
      this.emit('mediafail', (err as DOMException)?.name || 'MediaError'),
    )

    if (session.direction === 'incoming') {
      const from = session.remote_identity?.uri?.user || 'Unknown'
      this.emit('incoming', { from })
    }

    /**
     * A carrier may return an announcement as early media (183 with SDP) and never answer —
     * for balance, barring or routing failures. Attaching the receiver here, as well as on
     * accepted/confirmed, makes that announcement audible instead of leaving the UI in a silent
     * "ringing" state. Retried briefly because some browsers expose the receiver just after
     * JsSIP emits progress while applying the remote SDP.
     */
    session.on('progress', () => {
      this.emit('progress')
      this.attachFromSession(session)
      setTimeout(() => this.attachFromSession(session), 100)
      setTimeout(() => this.attachFromSession(session), 400)
    })
    session.on('accepted', () => {
      this.emit('active')
      this.attachFromSession(session)
    })
    session.on('confirmed', () => {
      this.emit('active')
      this.attachFromSession(session)
    })

    // 'ended' (BYE) and 'failed' (setup error / non-2xx) are terminal. Always null the session
    // and tell the view, so the UI resets to idle even if only one of them ever fires.
    session.on('ended', (event: EndEvent) => {
      if (this.session === session) this.session = null
      this.releaseLocal()
      this.emit('ended', { cause: event?.cause })
    })
    session.on('failed', (event: EndEvent) => {
      if (this.session === session) this.session = null
      this.releaseLocal()
      this.emit('failed', { cause: event?.cause })
    })

    session.on('peerconnection', (ev: PeerConnectionEvent) => {
      const pc = ev.peerconnection as RTCPeerConnection
      // ontrack fires as the remote audio track arrives. `streams[0]` is the usual source, but
      // some stacks deliver a track with no stream — fall back to wrapping the track.
      pc.ontrack = (te: RTCTrackEvent) => {
        const stream = te.streams?.[0] || new MediaStream([te.track])
        this.attachRemote(stream)
      }
      // Belt and suspenders: if a remote track is already present (ontrack raced or was
      // missed), build a stream from the receivers so audio still renders.
      const grab = () => {
        try {
          const tracks = pc
            .getReceivers()
            .map((r) => r.track)
            .filter((t): t is MediaStreamTrack => Boolean(t) && t.kind === 'audio')
          if (tracks.length) this.attachRemote(new MediaStream(tracks))
        } catch {
          /* pc already closed */
        }
      }
      pc.addEventListener?.('connectionstatechange', () => {
        if (pc.connectionState === 'connected') grab()
      })
    })
  }

  /**
   * Read the remote audio track straight off the session's peer connection.
   *
   * The most reliable path: it does not depend on 'peerconnection'/ontrack having fired in time
   * (the observed failure was `hasStream:false` — ontrack never attached), and by the time the
   * server has confirmed, RTP is flowing so a receiver track is present.
   */
  private attachFromSession(session: RTCSession): void {
    try {
      const pc = session?.connection
      if (!pc) return
      const tracks = pc
        .getReceivers()
        .map((r) => r.track)
        .filter((t): t is MediaStreamTrack => Boolean(t) && t.kind === 'audio')
      if (tracks.length) this.attachRemote(new MediaStream(tracks))
    } catch {
      /* pc already closed */
    }
  }

  /**
   * Open local audio. JsSIP would do this itself, but only by calling `getUserMedia` and killing
   * the whole session if it rejects — which is how a PC with no microphone lost the call ~10 ms
   * after the click. Take it over: hand JsSIP a real stream when there is one, silence when
   * there is not, so the call is placed either way and the UI can say which it got.
   */
  private async acquireLocal(): Promise<LocalMedia> {
    this.releaseLocal() // never leave a previous call's track open
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      this.local = { stream, silent: false }
    } catch (err) {
      // `navigator.mediaDevices` is absent on an insecure origin, so the failure there is a
      // TypeError from the call itself rather than a DOMException naming a device fault.
      const reason = !navigator.mediaDevices ? 'insecure' : (err as DOMException)?.name || 'MediaError'
      const silent = silentAudioStream()
      this.local = silent
        ? { stream: silent.stream, ctx: silent.ctx, osc: silent.osc, silent: true, reason }
        : { stream: null, silent: true, reason }
    }
    return this.local
  }

  /** JsSIP only stops tracks it generated itself, so ours stay live unless released here. */
  private releaseLocal(): void {
    const local = this.local
    this.local = null
    if (!local) return
    try {
      local.stream?.getTracks().forEach((track) => track.stop())
    } catch {
      /* already stopped */
    }
    try {
      local.osc?.stop()
    } catch {
      /* already stopped */
    }
    try {
      void local.ctx?.close()
    } catch {
      /* already closed */
    }
  }

  async call(number: string): Promise<void> {
    if (!this.ua) return
    const domain = this.domain
    this.emit('calling', { to: number })
    const local = await this.acquireLocal()
    // `stop()` can land while getUserMedia is still deciding (user switched lines, page
    // navigated away). Do not raise a call on a torn-down UA.
    if (this.dead || !this.ua) {
      this.releaseLocal()
      return
    }
    if (local.silent) this.emit('mediafallback', local.reason || 'unknown')
    const opts = {
      mediaConstraints: { audio: true, video: false },
      mediaStream: local.stream || undefined,
      pcConfig: { rtcpMuxPolicy: 'require' as RTCIceTransportPolicy, iceServers: [] },
    }
    // '#' is not a legal SIP URI user character and JsSIP rejects the whole URI rather than
    // escaping it, so service codes would never leave the browser without this.
    const user = String(number).replace(/#/g, '%23')
    try {
      const session = this.ua.call(`sip:${user}@${domain}`, opts as never)
      this.session = session
      this.handleSession(session)
    } catch (err) {
      // `ua.call()` can throw synchronously (bad target, no media) before any session event
      // fires — surface it as terminal so the UI does not hang on "calling".
      this.session = null
      this.releaseLocal()
      this.emit('failed', { cause: (err as Error)?.message || 'Call failed' })
    }
  }

  /**
   * Answering runs the same media path as dialling, so an incoming call is answerable without a
   * microphone too — the caller is heard and the UI says they cannot hear back.
   */
  async answer(): Promise<void> {
    const session = this.session
    if (!session) return
    const local = await this.acquireLocal()
    if (this.dead || this.session !== session) {
      this.releaseLocal()
      return
    }
    if (local.silent) this.emit('mediafallback', local.reason || 'unknown')
    try {
      session.answer({
        mediaConstraints: { audio: true, video: false },
        mediaStream: local.stream || undefined,
        pcConfig: { iceServers: [] },
      })
    } catch (err) {
      // `answer()` throws synchronously on a session that is no longer answerable. Awaiting the
      // media above means that throw would otherwise surface as an unhandled rejection and leave
      // the overlay ringing at a call that is already gone.
      this.session = null
      this.releaseLocal()
      this.emit('failed', { cause: (err as Error)?.message || 'Answer failed' })
    }
  }

  hangup(): void {
    const s = this.session
    if (s) {
      this.session = null
      try {
        s.terminate()
      } catch {
        /* already gone */
      }
    }
    this.releaseLocal()
  }

  /**
   * Reject an unanswered INCOMING call.
   *
   * A bare `terminate()` on a ringing incoming session sends 480 Temporarily Unavailable, which
   * Asterisk's Dial maps to NOANSWER, so the call is logged as *missed* when the operator
   * declined it. 603 makes the disposition "rejected". Falls back to hangup() for an
   * outgoing/active session.
   */
  reject(): void {
    const s = this.session
    if (!s) return
    if (s.direction === 'incoming' && !s.isEstablished?.()) {
      this.session = null
      try {
        s.terminate({ status_code: 603, reason_phrase: 'Decline' })
      } catch {
        try {
          s.terminate()
        } catch {
          /* already gone */
        }
      }
    } else {
      this.hangup()
    }
  }

  sendDTMF(tone: string): void {
    if (this.session) {
      try {
        this.session.sendDTMF(tone)
      } catch {
        /* session ended mid-press */
      }
    }
  }

  setMuted(muted: boolean): void {
    if (!this.session) return
    try {
      muted ? this.session.mute({ audio: true }) : this.session.unmute({ audio: true })
    } catch {
      /* session ended */
    }
  }

  /* ---- call recording: mix local + remote audio into a downloadable blob ---- */

  async startRecording(): Promise<boolean> {
    if (!this.session?.connection || this.rec) return false
    const pc = this.session.connection
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return false
    const ctx = new Ctx()
    const dest = ctx.createMediaStreamDestination()
    const local = pc
      .getSenders()
      .map((s) => s.track)
      .filter((t): t is MediaStreamTrack => t !== null && t.kind === 'audio')
    const remote = pc
      .getReceivers()
      .map((r) => r.track)
      .filter((t): t is MediaStreamTrack => t !== null && t.kind === 'audio')
    if (local.length) {
      try {
        ctx.createMediaStreamSource(new MediaStream(local)).connect(dest)
      } catch {
        /* unusable track */
      }
    }
    if (remote.length) {
      try {
        ctx.createMediaStreamSource(new MediaStream(remote)).connect(dest)
      } catch {
        /* unusable track */
      }
    }
    this.recChunks = []
    try {
      this.rec = new MediaRecorder(dest.stream)
    } catch {
      try {
        void ctx.close()
      } catch {
        /* already closed */
      }
      return false
    }
    this.recCtx = ctx
    this.rec.ondataavailable = (ev: BlobEvent) => {
      if (ev.data && ev.data.size) this.recChunks.push(ev.data)
    }
    this.rec.start()
    return true
  }

  stopRecording(): Promise<Blob | null> {
    return new Promise((resolve) => {
      const rec = this.rec
      if (!rec) {
        resolve(null)
        return
      }
      rec.onstop = () => {
        const type = rec.mimeType || 'audio/webm'
        const blob = new Blob(this.recChunks, { type })
        try {
          void this.recCtx?.close()
        } catch {
          /* already closed */
        }
        this.rec = null
        this.recCtx = null
        this.recChunks = []
        resolve(blob)
      }
      try {
        rec.stop()
      } catch {
        resolve(null)
      }
    })
  }

  get recording(): boolean {
    return Boolean(this.rec)
  }

  stop(): void {
    // Mark dead FIRST so any late JsSIP event from `ua.stop()` (async 'disconnected' /
    // 'unregistered') is swallowed and cannot clobber a newly started line's state.
    this.dead = true
    this.hangup() // releases the local track on its way through
    if (this.rec) {
      try {
        this.rec.stop()
      } catch {
        /* already stopped */
      }
      this.rec = null
    }
    if (this.ua) {
      try {
        this.ua.stop()
      } catch {
        /* already stopped */
      }
      this.ua = null
    }
    if (this.remoteAudio) {
      // Only remove an element we created ourselves; the React-owned one is not ours to detach.
      const el = this.remoteAudio
      try {
        el.srcObject = null
      } catch {
        /* ignore */
      }
      if (el.dataset?.mddOwned === '1') el.remove()
      this.remoteAudio = null
    }
  }
}
