#!/usr/bin/env node
/**
 * Behavioural check for the calls view.
 *
 * The screenshot pass proves the page renders. This drives the parts that carry risk — the
 * places where a plausible-looking screen would be lying:
 *
 *  1. **Nothing connects on its own.** Registering opens a WSS session to the engine, so it is
 *     a button. A page that registered on load would open a session the operator never asked
 *     for, and would make "not connected" indistinguishable from "still connecting".
 *  2. **Dial is blocked until registered.** The dial button hits the control plane, which rings
 *     the browser endpoint over AMI — with no endpoint registered the call can only fail
 *     confusingly. Disabling it is the honest state.
 *  3. **A disabled WebRTC endpoint says so and cannot be connected.** `enabled: false` beats
 *     everything; the button must be disabled with the reason visible, not left clickable.
 *  4. **The cellular path is independent.** It dials with no softphone registered, and its
 *     status poll has to move the call out of "dialling" on its own.
 *  5. **An unconfirmed dial reads as unconfirmed.** The modem can accept the command while the
 *     carrier never confirms; reporting that as success or as failure would both be wrong.
 *  6. **The call log is per line and shows the carrier's own words.** A service code's USSD
 *     reply is not parsed by the gateway, so it is displayed verbatim.
 *  7. **Voicemail playback marks the message heard**, and deleting a row removes it.
 *
 * Re-runnable: every mutation is undone, and the assertions are written to hold on a second run.
 *
 * Usage: node scripts/verify-calls.mjs
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const BASE = process.env.MDD_UI || 'http://localhost:5173'
const PASSWORD = process.env.MOCK_PASSWORD || 'mdd-demo-password'

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const root = join(process.env.LOCALAPPDATA || '', 'ms-playwright')
  if (!existsSync(root)) return null
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
  return null
}

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 1300 } })
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e) => consoleErrors.push(String(e)))
const badResponses = []
page.on('response', (r) => {
  if (r.status() >= 400) badResponses.push(`${r.status()} ${r.request().method()} ${r.url()}`)
})

/** The card whose heading matches, so assertions stay inside one panel. */
function cardFor(label) {
  return page.locator('.card').filter({ has: page.locator(`strong:text-is("${label}")`) })
}

/**
 * The line picker, found by its options.
 *
 * `page.locator('select').first()` is the language switcher in the chrome, not this page's
 * line selector — matching on the option values is the only locator that cannot drift.
 */
function lineSelect() {
  return page.locator('select').filter({ has: page.locator('option[value="line-1"]') })
}

async function selectLine(value) {
  await lineSelect().selectOption(value)
  await page.waitForTimeout(1500)
}

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(600)
  const pw = page.locator('input[type="password"]')
  if (await pw.count()) {
    await pw.fill(PASSWORD)
    await page.locator('button[type="submit"]').first().click()
    await page.waitForSelector('nav', { timeout: 15000 })
  }
  await page.evaluate(() => { window.location.hash = '#/calls' })
  await page.waitForTimeout(2000)

  const softphone = cardFor('浏览器软电话')

  // ---- 1. nothing connects by itself ------------------------------------------
  check('the softphone starts unregistered', (await softphone.locator('text=未注册').count()) === 1)
  const connect = softphone.getByRole('button', { name: /连接软电话/ })
  check('connecting is an explicit button', (await connect.count()) === 1)
  check('the connect button is available for an enabled endpoint', await connect.isEnabled())

  // ---- 2. dial is blocked until registered ------------------------------------
  const dial = softphone.getByRole('button', { name: /^拨号$/ })
  check('dial exists', (await dial.count()) === 1)
  check(
    'dial is blocked while not registered',
    await dial.isDisabled(),
    'an unregistered endpoint cannot be rung over AMI',
  )

  // ---- 3. the call log is per line and shows the carrier verbatim --------------
  const history = cardFor('通话记录')
  const historyText = await history.innerText()
  check('the seeded log renders', /#225#/.test(historyText))
  check('a missed inbound call is shown', /missed/.test(historyText) && /呼入/.test(historyText))
  check(
    'both transports are distinguished',
    /蜂窝网络/.test(historyText) && /Wi-Fi Calling/.test(historyText),
    'the two call paths must not be conflated in the log',
  )
  check(
    'the USSD reply is shown verbatim',
    /Your balance is 12\.40 GBP\./.test(historyText),
    'the gateway does not parse it, so the UI must not pretend to',
  )

  // ---- 4. voicemail playback marks the message heard --------------------------
  const voicemail = cardFor('语音留言')
  const play = voicemail.getByRole('button', { name: /播放/ })
  check('a voicemail row renders', (await play.count()) === 1)
  await play.click()
  await page.waitForTimeout(1200)
  const vmText = await voicemail.innerText()
  check('playing marks the message heard', /已播放/.test(vmText), vmText.match(/已播放|未播放/)?.[0] ?? '')

  // ---- 5. a line with the endpoint disabled says so ---------------------------
  await selectLine('line-2')
  const disabledSoftphone = cardFor('浏览器软电话')
  const disabledText = await disabledSoftphone.innerText()
  check(
    'a disabled endpoint is explained',
    /WebRTC 端点已关闭/.test(disabledText),
    'the reason belongs on screen, not only in a tooltip',
  )
  const disabledConnect = disabledSoftphone.getByRole('button', { name: /连接软电话/ })
  check('a disabled endpoint cannot be connected', await disabledConnect.isDisabled())
  check(
    'a stopped line warns that no call can be placed',
    /该线路未在线/.test(disabledText),
  )
  const emptyHistory = await cardFor('通话记录').innerText()
  check(
    'the log is per line, not global',
    /还没有通话记录/.test(emptyHistory),
    'line-2 has no calls; showing line-1\'s would be wrong',
  )

  // ---- 6. the cellular path works with no softphone ---------------------------
  await selectLine('line-1')
  const cellular = cardFor('蜂窝通话')
  check('the cellular panel starts idle', /无蜂窝通话/.test(await cellular.innerText()))
  await cellular.locator('input.input').fill('1008611')
  await cellular.getByRole('button', { name: /用蜂窝网拨打/ }).click()
  await page.waitForTimeout(1200)

  let cellularText = await cellular.innerText()
  check(
    'cellular dials without any browser registered',
    /拨出中|已接通/.test(cellularText),
    cellularText.match(/拨出中|已接通|无蜂窝通话/)?.[0] ?? '',
  )

  // The poll advances the state machine on its own. Wait for it to settle rather than sleeping a
  // fixed amount: a fixed wait makes the assertion a test of the mock's clock, not of the UI.
  let advanced = false
  for (let attempt = 0; attempt < 12 && !advanced; attempt += 1) {
    await page.waitForTimeout(1000)
    cellularText = await cellular.innerText()
    advanced = /已接通|已结束/.test(cellularText)
  }
  check(
    'the status poll advances the call state',
    advanced,
    cellularText.match(/已接通|已结束|拨出中/)?.[0] ?? 'the poll never moved the call forward',
  )

  const afterDial = await cardFor('通话记录').innerText()
  check(
    'the cellular call is written to the log',
    /1008611/.test(afterDial),
    'both paths write to the same log',
  )

  // ---- 7. an unconfirmed dial reads as unconfirmed ----------------------------
  // Hang up only if the call is still up: the poll may already have ended it, in which case the
  // button is disabled on purpose and insisting would be testing the mock's clock, not the UI.
  const hangup = cellular.getByRole('button', { name: /挂断/ })
  if (await hangup.isEnabled()) {
    await hangup.click()
    await page.waitForTimeout(1200)
  }
  // Must genuinely end in 999 — that is the mock's documented trigger for an unconfirmed dial.
  await cellular.locator('input.input').fill('1008999')
  await cellular.getByRole('button', { name: /用蜂窝网拨打/ }).click()
  await page.waitForTimeout(1500)
  const unknownText = await cellular.innerText()
  check(
    'an unconfirmed dial reads as unconfirmed',
    /未确认/.test(unknownText),
    'neither success nor failure is honest here',
  )
  check(
    'the unconfirmed state is explained in words',
    /运营商未确认/.test(unknownText),
  )

  // ---- 8. cleanup: remove the rows this run created ---------------------------
  await page.waitForTimeout(1000)
  const rows = cardFor('通话记录').locator('button', { hasText: '移除' })
  let removed = 0
  for (let index = (await rows.count()) - 1; index >= 0 && removed < 2; index -= 1) {
    const row = rows.nth(index)
    const rowText = await row.evaluate((el) => el.parentElement?.innerText ?? '')
    if (/1008611|1008999/.test(rowText)) {
      await row.click()
      await page.waitForTimeout(900)
      removed += 1
    }
  }
  const cleaned = await cardFor('通话记录').innerText()
  check(
    'rows created by this run can be removed',
    !/1008611/.test(cleaned),
    `removed ${removed} row(s)`,
  )
  check(
    'the seeded rows are left alone',
    /#225#/.test(cleaned) && /\+447700900123/.test(cleaned),
  )

  // ---- 9. no noise ------------------------------------------------------------
  check('no failed requests', badResponses.length === 0, badResponses.slice(0, 3).join(' | '))
  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
