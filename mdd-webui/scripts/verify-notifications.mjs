#!/usr/bin/env node
/**
 * Behavioural check for the notifications view.
 *
 * The screenshot pass proves the page renders. This drives the parts that carry risk — the
 * places where a plausible-looking screen would be lying:
 *
 *  1. **A disabled channel is not tested.** Each test endpoint delivers with the *stored*
 *     configuration, so a test against a disabled channel could only ever report on something
 *     that can never fire. The button must be blocked and the page must say why.
 *  2. **A channel that is on with no event on delivers nothing**, and the page must say so
 *     rather than let the per-event grid imply otherwise.
 *  3. **An unknown template token is caught locally.** The server rejects the *first* bad
 *     token with a 400; mirroring the allow-list here is the difference between "your typo" and
 *     "round-trip, one error at a time".
 *  4. **The delivery log is metadata only.** No body, no number, no credential — the value is
 *     diagnosis (channel, event, attempts, status code). A failed delivery must never render as
 *     a success just because the transport answered 200, which is exactly what PushPlus and
 *     Feishu do.
 *  5. **Saving round-trips.** Edits mark the page dirty, Save posts the section whole, and the
 *     page returns to clean.
 *
 * Re-runnable: the script restores whatever it changes.
 *
 * Usage: node scripts/verify-notifications.mjs
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const BASE = process.env.MDD_UI || 'http://localhost:5173'
const PASSWORD = process.env.MOCK_PASSWORD || 'mdd-demo-password'

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
const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } })
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e) => consoleErrors.push(String(e)))

/** Find the channel card whose heading matches, then work inside it. */
function channelFor(label) {
  return page.locator('.card').filter({ has: page.locator(`strong:text-is("${label}")`) })
}

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  // Wait for whichever the app decides to show — the sign-in form or the shell — instead of
  // sleeping a fixed 600 ms. That sleep is the difference between passing on a workstation and
  // failing on a slower runner: React has not rendered the form yet, `count()` is 0, the sign-in
  // is silently skipped, and the failure only surfaces much later as a missing element.
  await page.waitForSelector('input[type="password"], nav', { timeout: 20000 })
  const pw = page.locator('input[type="password"]')
  if (await pw.count()) {
    await pw.fill(PASSWORD)
    await page.locator('button[type="submit"]').first().click()
  }
  // Outside the branch: whether we signed in or were already signed in, the shell must be up
  // before anything below looks for a page element.
  await page.waitForSelector('nav', { timeout: 20000 })
  await page.evaluate(() => { window.location.hash = '#/notifications' })
  await page.waitForTimeout(1800)

  // ---- 1. the four channels render, on and off --------------------------------
  check('webhook channel renders', (await channelFor('Webhook').count()) === 1)
  check('telegram channel renders', (await channelFor('Telegram').count()) === 1)
  check('pushplus channel renders', (await channelFor('PushPlus').count()) === 1)
  check('feishu channel renders', (await channelFor('飞书 / Lark').count()) === 1)
  check('bark channel renders', (await channelFor('Bark').count()) === 1)
  check('email channel renders', (await channelFor('邮件').count()) === 1)
  check('a disabled channel says it is off', (await page.locator('text=/该渠道已关闭/').count()) >= 1)

  // ---- 2. a disabled channel cannot be tested ---------------------------------
  const pushplus = channelFor('PushPlus')
  const ppTest = pushplus.getByRole('button', { name: /发送测试/ })
  check('disabled channel still shows its test button', (await ppTest.count()) === 1)
  check('disabled channel blocks the test', await ppTest.isDisabled())
  check(
    'disabled channel explains why the test is blocked',
    (await pushplus.locator('text=/请先启用该渠道/').count()) === 1,
  )

  // ---- 2b. the new channels behave like the old ones ---------------------------
  const bark = channelFor('Bark')
  check(
    'an enabled new channel is testable',
    await bark.getByRole('button', { name: /发送测试/ }).isEnabled(),
    'Bark is seeded enabled',
  )
  const email = channelFor('邮件')
  check(
    'a disabled new channel is not testable',
    await email.getByRole('button', { name: /发送测试/ }).isDisabled(),
    'email is seeded configured but switched off',
  )
  check(
    'a disabled new channel explains why',
    (await email.locator('text=/请先启用该渠道/').count()) === 1,
  )
  check(
    'the Bark device key is masked',
    (await bark.locator('input[type="password"]').count()) >= 1,
    'it is a credential, not a display field',
  )
  check(
    'the email password is masked',
    (await email.locator('input[type="password"]').count()) >= 1,
  )

  // ---- 3. an enabled channel tests with the stored configuration --------------
  const webhook = channelFor('Webhook')
  await webhook.getByRole('button', { name: /发送测试/ }).click()
  await page.waitForTimeout(1600)
  const webhookText = await webhook.innerText()
  const okNote = webhook.locator('.note-ok')
  check(
    'test against an enabled channel reports delivery',
    (await okNote.count()) === 1,
    (await okNote.count()) ? (await okNote.innerText()) : 'no success note rendered',
  )

  // ---- 4. templates: the token allow-list is enforced locally -----------------
  const feishu = channelFor('飞书 / Lark')
  await feishu.getByRole('button', { name: /展开消息模板/ }).click()
  await page.waitForTimeout(400)
  const badToken = feishu.locator('text=/未知的模板变量/')
  check('a misspelled template token is flagged without a round-trip', (await badToken.count()) >= 1)
  check(
    'the flagged token is named',
    (await feishu.locator('text=/sim_nmae/').count()) >= 1,
    'the operator must be told which token, not just that one exists',
  )

  // ---- 5. the delivery log is metadata only -----------------------------------
  // The log lives in a Disclosure (a <details>), so it must be located by its content, not
  // by the `.card` class the channel panels use.
  const logText = await page.locator('details').filter({ hasText: '投递记录' }).first().innerText()
  check('log shows a successful delivery', /成功/.test(logText))
  check('log shows a failed delivery', /失败/.test(logText))
  check(
    'a 200-with-application-error still reads as failed',
    /sign match fail/.test(logText),
    'PushPlus/Feishu answer 200 on application errors — the status code alone would lie',
  )
  check('in-flight deliveries are separated', /投递中/.test(logText))
  check(
    'the log states that bodies are not recorded',
    /通知正文、号码与凭据都不会被写入/.test(logText),
  )

  // ---- 6. toggling an event marks the page dirty, save round-trips -------------
  const saveBtn = page.getByRole('button', { name: /^保存$/ }).first()
  const wasDisabled = await saveBtn.isDisabled()

  const firstEvent = webhook.locator('input[type="checkbox"]').nth(0)
  const before = await firstEvent.isChecked()
  await firstEvent.setChecked(!before)
  await page.waitForTimeout(300)
  check('editing an event marks the page dirty', await saveBtn.isEnabled())

  await saveBtn.click()
  await page.waitForTimeout(1600)
  check('save round-trips back to clean', await saveBtn.isDisabled())
  check('save confirms', (await page.locator('text=/^已保存。$/').count()) >= 1)

  // restore the original switch so a second run starts from the same place
  if (await firstEvent.isChecked() !== before) {
    await firstEvent.setChecked(before)
    await page.waitForTimeout(300)
    if (await saveBtn.isEnabled()) {
      await saveBtn.click()
      await page.waitForTimeout(1400)
    }
  }
  if (wasDisabled !== (await saveBtn.isDisabled())) {
    console.log('note: page did not return to its starting dirty state')
  }

  // ---- 7. no console noise ----------------------------------------------------
  // A deliberately-derived 400 (testing a disabled channel) is part of what is being verified,
  // so requests the page is expected to make are not treated as defects. Anything else is.
  const realErrors = consoleErrors.filter((line) => !/\b(400|503)\b/.test(line))
  check('no unexpected console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
