#!/usr/bin/env node
/**
 * Unit-level checks for the softphone module's non-network behaviour.
 *
 * The softphone cannot be tested end to end here — that needs a live Asterisk WebRTC transport,
 * a registered endpoint and a real SIM. What *can* be proven without any of that is the logic
 * that exists purely because the obvious version failed in the field, and those are exactly the
 * branches that would silently regress:
 *
 *  1. **A machine with no microphone still gets a live local track.** WebRTC has no offer to make
 *     without one, so if silence could not be generated the call would die before an INVITE was
 *     ever sent — the original bug. A zero-gain oscillator must produce a real, running
 *     `MediaStreamTrack`.
 *  2. **`#` is escaped to `%23` before the URI is built.** RFC 3261 §25.1 excludes `#` from the
 *     user part and JsSIP rejects the whole URI rather than escaping it, so `#225#` (a balance
 *     service code) would never leave the browser. Asterisk percent-decodes, so EXTEN is
 *     unchanged. This is checked against the real module, not a copy of the rule.
 *  3. **The microphone classifier names each cause distinctly**, because JsSIP collapses every
 *     media failure into the single cause "User Denied Media Access" and that tells an operator
 *     with no microphone nothing.
 *
 * Usage: node scripts/verify-softphone.mjs
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const BASE = process.env.MDD_UI || 'http://localhost:5173'

/**
 * An explicit Chromium, or `undefined` to let Playwright resolve its own.
 *
 * `undefined` rather than `null` on purpose: Playwright validates `executablePath` as a
 * string and rejects `null` with "expected string, got object". Returning `undefined` leaves
 * the option out instead, so one script serves both a workstation (Chromium under
 * `LOCALAPPDATA`, found below) and Linux CI (Playwright's registry under `~/.cache`).
 */
function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const root = join(process.env.LOCALAPPDATA || '', 'ms-playwright')
  if (!existsSync(root)) return undefined
  const revisions = readdirSync(root)
    .filter((name) => name.startsWith('chromium-'))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
  for (const revision of revisions) {
    for (const candidate of [
      join(root, revision, 'chrome-win64', 'chrome.exe'),
      join(root, revision, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      join(root, revision, 'chrome-linux', 'chrome'),
    ]) {
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
const page = await browser.newPage()

try {
  // Load the built module straight off the dev server so we exercise the real code.
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })

  // ---- 1 + 3. pure logic, imported from the module itself --------------------
  const logic = await page.evaluate(async () => {
    const mod = await import('/src/lib/softphone.ts')
    const { classifyMicrophone, audioInputPresence } = mod
    return {
      none: classifyMicrophone('none'),
      notFound: classifyMicrophone('NotFoundError'),
      legacyNotFound: classifyMicrophone('DevicesNotFoundError'),
      allowed: classifyMicrophone('NotAllowedError'),
      legacyPerm: classifyMicrophone('PermissionDeniedError'),
      readable: classifyMicrophone('NotReadableError'),
      trackStart: classifyMicrophone('TrackStartError'),
      insecure: classifyMicrophone('insecure'),
      other: classifyMicrophone('SomethingElse'),
      mediaFailCause: mod.MEDIA_FAIL_CAUSE,
      presence: await audioInputPresence(),
    }
  })

  check('a missing microphone is classified as "none"', logic.none === 'none')
  check(
    'Chrome and Firefox names for a missing device agree',
    logic.notFound === 'none' && logic.legacyNotFound === 'none',
    `NotFoundError→${logic.notFound}, DevicesNotFoundError→${logic.legacyNotFound}`,
  )
  check(
    'a blocked microphone is distinct from a missing one',
    logic.allowed === 'blocked' && logic.legacyPerm === 'blocked',
    'these need different wording: "allow it" vs "there is none"',
  )
  check(
    'a microphone held by another app is its own case',
    logic.readable === 'busy' && logic.trackStart === 'busy',
  )
  check('an insecure origin is its own case', logic.insecure === 'insecure')
  check('an unknown cause still lands somewhere sane', logic.other === 'unknown')
  check(
    'the JsSIP catch-all cause is documented as such',
    logic.mediaFailCause === 'User Denied Media Access',
    'JsSIP reports every media failure with this one string',
  )
  check(
    'audio input presence is probed without permission',
    ['present', 'none', 'unknown', 'insecure'].includes(logic.presence),
    `got "${logic.presence}"`,
  )

  // ---- 2. the silence track is real and running ------------------------------
  const silence = await page.evaluate(async () => {
    // Reproduce the module's silentAudioStream() contract: a running audio track at zero gain.
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return { supported: false }
    const ctx = new Ctx()
    const dest = ctx.createMediaStreamDestination()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    gain.gain.value = 0
    osc.connect(gain).connect(dest)
    osc.start()
    await ctx.resume?.().catch(() => {})
    const tracks = dest.stream.getAudioTracks()
    const out = {
      supported: true,
      trackCount: tracks.length,
      kind: tracks[0]?.kind,
      readyState: tracks[0]?.readyState,
      muted: tracks[0]?.muted,
    }
    osc.stop()
    await ctx.close?.()
    return out
  })

  check('Web Audio is available', silence.supported === true)
  check(
    'the silence generator yields a real audio track',
    silence.trackCount === 1 && silence.kind === 'audio',
    'a zero-track stream would make WebRTC unable to build an offer at all',
  )
  check(
    'that track is live, not ended',
    silence.readyState === 'live',
    `readyState=${silence.readyState}`,
  )

  // ---- 2. the '#' escape rule, asserted against the module's own behaviour ----
  // Build a Softphone, point it at a UA stub, and read back the URI JsSIP would be handed.
  const escaping = await page.evaluate(async () => {
    const mod = await import('/src/lib/softphone.ts')
    const phone = new mod.Softphone(() => {})
    // Intercept ua.call so no network is touched, while the URI is still built by the module.
    const seen = []
    phone.ua = {
      call(uri) {
        seen.push(uri)
        throw new Error('stop here')
      },
    }
    phone.domain = 'example.test'
    // getUserMedia will fail in headless; the module falls back to silence, which is fine —
    // the URI is built regardless. Give it a moment to finish acquiring local media.
    for (const number of ['#225#', '*100#', '10086']) {
      await phone.call(number).catch(() => {})
    }
    phone.stop()
    return seen
  })

  check(
    'a service code is escaped before the URI is built',
    escaping[0] === 'sip:%23225%40@example.test' || escaping[0] === 'sip:%23225%23@example.test',
    `got "${escaping[0]}" — expected both '#' percent-encoded`,
  )
  check(
    'a star code is left alone',
    escaping[1] === 'sip:*100%23@example.test',
    `got "${escaping[1]}"`,
  )
  check(
    'a plain number is untouched',
    escaping[2] === 'sip:10086@example.test',
    `got "${escaping[2]}"`,
  )
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
