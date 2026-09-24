#!/usr/bin/env node
/**
 * Behavioural check for the AT / USSD terminal.
 *
 * The screenshot pass proves the page renders. This drives the parts that carry risk — the
 * places where a plausible-looking terminal would be dangerous or misleading:
 *
 *  1. **A refused command must look like a refusal, not like a result.** The server answers 403
 *     and the command never reaches the modem. If the page rendered that the same way as "the
 *     module said ERROR", an operator would go and debug the wrong thing.
 *
 *  2. **A refused command must not enter the output log at all.** The log is a record of what
 *     the module was asked. Putting a command in it that was never sent would be a false record.
 *
 *  3. **A disruptive command must be confirmed, and cancelling must not run it.** The
 *     confirmation is enforced server-side, but the page still has to ask — and the dialog has
 *     to name the specific consequence, or it trains people to click through.
 *
 *  4. **The module's own ERROR is not a failure.** `ERROR` is the module talking. Showing it as
 *     a transport failure would send the operator looking for a cable problem.
 *
 *  5. **The reply is shown verbatim.** The gateway does not parse USSD, so neither does the UI.
 *
 *  6. **History is per line and survives a reload**, because a terminal without history is
 *     unusable for the thing it is for.
 *
 * Re-runnable: it clears the log it creates and leaves no state behind.
 *
 * Usage: node scripts/verify-terminal.mjs
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
const page = await browser.newPage({ viewport: { width: 1400, height: 1300 } })
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e) => consoleErrors.push(String(e)))

function lineSelect() {
  return page.locator('select').filter({ has: page.locator('option[value="line-1"]') })
}

/** The output card, which is where a command's fate is recorded. */
function outputCard() {
  return page.locator('.card').filter({ has: page.locator('strong:text-is("输出")') })
}

const commandInput = () => page.locator('input.input').first()

async function runCommand(text) {
  await commandInput().fill(text)
  await commandInput().press('Enter')
  await page.waitForTimeout(900)
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

  // Start from a clean log so the run is repeatable.
  await page.evaluate(() => {
    window.localStorage.removeItem('mdd.at.history.line-1')
  })

  await page.evaluate(() => { window.location.hash = '#/terminal' })
  await page.waitForTimeout(1800)

  check('the terminal page renders', (await page.locator('h1').first().innerText()).includes('AT'))
  check('the quick-command buttons render', (await page.getByRole('button', { name: /信号/ }).count()) === 1)
  check('the USSD buttons render', (await page.getByRole('button', { name: /查余额/ }).count()) >= 1)
  check('the output starts empty', /还没有输出/.test(await outputCard().innerText()))

  // ---- 1. a query returns the module's words verbatim --------------------------
  await runCommand('AT+CSQ')
  let log = await outputCard().innerText()
  check('a query is echoed', /AT\+CSQ/.test(log))
  check('the reply is shown verbatim', /\+CSQ: 24,99/.test(log), log.split('\n').slice(0, 3).join(' | '))

  // ---- 2. the module's own ERROR is not a transport failure --------------------
  await runCommand('AT+NOSUCHTHING?')
  log = await outputCard().innerText()
  check('a module ERROR is shown', /ERROR/.test(log))
  check(
    'a module ERROR is labelled as the module talking',
    /模块报错/.test(log),
    'showing it as a failure would send the operator looking for a cable problem',
  )

  // ---- 3. a refused command is a refusal, not a result -------------------------
  await runCommand('AT+EGMR=1,7,"1"')
  const pageText = await page.locator('main, body').first().innerText()
  check(
    'a blocked command is shown as refused',
    /已被拒绝/.test(pageText),
    pageText.match(/已被拒绝[^\n]*/)?.[0] ?? 'no refusal shown',
  )
  check(
    'the refusal explains why',
    /IMEI/.test(pageText),
  )
  log = await outputCard().innerText()
  check(
    'a refused command does not enter the log',
    !/AT\+EGMR/.test(log),
    'the log records what the module was asked, and this was never sent',
  )

  // ---- 4. a disruptive command asks first, and cancelling does not run it ------
  await runCommand('AT+CFUN=0')
  const dialog = page.locator('[role="dialog"], .dialog, .modal').first()
  const dialogText = (await dialog.count()) ? await dialog.innerText() : ''
  check('a disruptive command opens a confirmation', /AT\+CFUN=0/.test(dialogText), dialogText.slice(0, 80))
  check(
    'the confirmation names the consequence',
    /掉线/.test(dialogText),
    'a confirmation without a reason trains people to click through it',
  )

  const before = await outputCard().innerText()
  await page.getByRole('button', { name: /取消|关闭/ }).first().click()
  await page.waitForTimeout(600)
  check(
    'cancelling does not run the command',
    (await outputCard().innerText()) === before,
    'the log must not change when the operator backs out',
  )

  // ---- 5. confirming runs it ---------------------------------------------------
  await runCommand('AT+CFUN=0')
  await page.getByRole('button', { name: /仍然执行/ }).first().click()
  await page.waitForTimeout(1000)
  log = await outputCard().innerText()
  check('confirming runs the command', /AT\+CFUN=0/.test(log), log.split('\n').slice(0, 3).join(' | '))

  // ---- 6. USSD is shown as the carrier sent it --------------------------------
  await runCommand('AT+CUSD=1,"#225#",15')
  log = await outputCard().innerText()
  check(
    'a USSD reply is shown verbatim',
    /Your balance is 12\.40 GBP\./.test(log),
    'the gateway does not parse USSD, so neither does the UI',
  )

  // ---- 7. history: the up arrow recalls the previous command ------------------
  await commandInput().click()
  await commandInput().press('ArrowUp')
  await page.waitForTimeout(300)
  const recalled = await commandInput().inputValue()
  check(
    'the up arrow recalls a previous command',
    recalled.length > 0 && recalled.startsWith('AT'),
    recalled || 'nothing recalled',
  )

  // ---- 8. history survives a reload -------------------------------------------
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1600)
  await page.evaluate(() => { window.location.hash = '#/terminal' })
  await page.waitForTimeout(1500)
  log = await outputCard().innerText()
  check(
    'history survives a reload',
    /AT\+CSQ/.test(log),
    'a terminal without history is unusable for the thing it is for',
  )

  // ---- 9. clearing empties the log --------------------------------------------
  await page.getByRole('button', { name: /^清屏$/ }).first().click()
  await page.waitForTimeout(500)
  check('clearing empties the log', /还没有输出/.test(await outputCard().innerText()))

  // ---- 10. no noise ------------------------------------------------------------
  // The 403 from the blocked-command check is the scenario under test, not a defect.
  const realErrors = consoleErrors.filter((line) => !/\b403\b/.test(line))
  check('no unexpected console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
