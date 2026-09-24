#!/usr/bin/env node
/**
 * End-to-end check of the Settings screen against the mock control plane.
 *
 * What this is really testing is the save strategy, because that is the part of the screen
 * that can silently destroy configuration:
 *
 *   1. `PUT /api/settings` is a shallow top-level merge, so saving one section must leave
 *      every other section — including ones this UI never renders — untouched.
 *   2. A nested object is replaced wholesale, so an edited section must arrive complete.
 *   3. Invalid input is blocked client-side, with the same rules the control plane applies.
 *   4. The response body is the stored document, and the form re-baselines against it.
 *
 * Prerequisites (same as scripts/screenshots.mjs):
 *   1. MOCK_CONFIGURED=1 node mock/server.mjs
 *   2. npx vite --port 5173
 *
 * Usage: node scripts/verify-settings.mjs
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const BASE = process.env.MDD_UI || 'http://localhost:5173'
const USER = process.env.MOCK_USER || 'admin'
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
      join(root, revision, 'chrome-win', 'chrome.exe'),
      join(root, revision, 'chrome-linux', 'chrome'),
    ]) {
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

const failures = []
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}

const executablePath = findChromium()
if (!executablePath) {
  console.error('No Chromium found. Set CHROMIUM_PATH.')
  process.exit(1)
}

const browser = await chromium.launch({ executablePath, headless: true })
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: 'en-US',
})
// Pin the UI language so selectors stay stable regardless of the host's locale.
await context.addInitScript(() => window.localStorage.setItem('mdd.language', 'en'))
const page = await context.newPage()

const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))

await page.goto(BASE, { waitUntil: 'networkidle' })

const passwordField = page.locator('input[type="password"]').first()
if (await passwordField.count()) {
  const userField = page.locator('input[type="text"], input:not([type])').first()
  if (await userField.count()) await userField.fill(USER)
  await passwordField.fill(PASSWORD)
  await page.locator('button[type="submit"]').first().click()
  await page.waitForTimeout(1200)
}
await page.waitForSelector('nav', { timeout: 10_000 })

const readSettings = () =>
  page.evaluate(async () => {
    const response = await fetch('/api/settings', { credentials: 'include', cache: 'no-store' })
    return response.json()
  })

const before = await readSettings()
const seededProfiles = before.hardware?.modem_profiles?.length ?? 0

console.log('\nhardware tab')
await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle' })
await page.waitForSelector('[role="tab"]', { timeout: 10_000 })

const nameInputs = page.locator('input[placeholder="e.g. DJI Cellular Dongle"]')
const saveButton = page.locator('button:has-text("Save changes")')
const presetButton = page.locator('button:has-text("Add DJI Cellular Dongle")')

check('settings document loaded', (await nameInputs.count()) === seededProfiles, `${await nameInputs.count()} rows vs ${seededProfiles} stored`)
check('nothing dirty on first paint', await saveButton.isDisabled())
check(
  'the DJI preset is offered only once',
  await presetButton.isDisabled(),
  'seed already lists 2ca3:4006',
)

// --- a new row with an empty name must block the save ------------------------
await page.locator('button:has-text("Add profile")').click()
await page.waitForTimeout(200)
check('added row appears', (await nameInputs.count()) === seededProfiles + 1)
check('an incomplete row blocks saving', await saveButton.isDisabled())
check('the incomplete row explains itself', (await page.locator('text=Required.').count()) > 0)

await nameInputs.last().fill('Test dongle')
await page.waitForTimeout(150)
check('a half-filled row still blocks saving', await saveButton.isDisabled(), 'VID/PID are empty')

// VID and PID are the two monospace inputs in each row, in row order.
const hexInputs = page.locator('input.mono')
await hexInputs.nth(seededProfiles * 2).fill('1d6b')
await hexInputs.nth(seededProfiles * 2 + 1).fill('0104')
await page.waitForTimeout(200)
check('a complete row unblocks saving', !(await saveButton.isDisabled()))
check('the duplicate warning stays quiet', (await page.locator('text=Duplicate VID:PID').count()) === 0)

// A second entry for a device already listed is dead weight: the orchestrator builds its
// lookup dict in order, so only the first match is ever used.
await hexInputs.nth(seededProfiles * 2).fill('2ca3')
await hexInputs.nth(seededProfiles * 2 + 1).fill('4006')
await page.waitForTimeout(200)
check('a duplicate VID:PID is called out', (await page.locator('text=Duplicate VID:PID').count()) > 0)
check('a duplicate VID:PID blocks saving', await saveButton.isDisabled())

// --- remove it again, then edit a scalar on another tab ----------------------
await page.locator('button:has-text("Delete")').last().click()
await page.waitForTimeout(200)
check('row removed', (await nameInputs.count()) === seededProfiles)

console.log('\nvowifi tab')
await page.locator('[role="tab"]').nth(2).click()
await page.waitForTimeout(300)
const ikeField = page.locator('.field:has(label:text-is("IKE SA rekey, minutes")) input')
// The mock keeps its state for the life of the process, so write a value that differs from
// whatever is already there rather than a constant — otherwise a second run is a no-op and
// the "dirty" assertions below have nothing to observe.
const storedIke = await ikeField.inputValue()
const nextIke = storedIke === '145' ? '140' : '145'
await ikeField.fill(nextIke)
await page.waitForTimeout(200)
check('edit marks the form dirty', !(await saveButton.isDisabled()))

console.log('\nsave')
await saveButton.click()
await page.waitForTimeout(900)
check('save is acknowledged', (await page.locator('text=Settings saved.').count()) > 0)
check('form is clean again after saving', await saveButton.isDisabled())

const after = await readSettings()
check('the edited scalar was stored', after.rekey?.ike_minutes === Number(nextIke), JSON.stringify(after.rekey))
check('the sibling in the same section survived', after.rekey?.minutes === before.rekey?.minutes)
check(
  'an untouched section survived',
  JSON.stringify(after.proxy) === JSON.stringify(before.proxy),
  'proxy library',
)
check('an untouched scalar survived', after.timezone === before.timezone)
check(
  'the modem profile list survived',
  (after.hardware?.modem_profiles?.length ?? -1) === seededProfiles,
)
check('the backend switch survived', after.hardware?.modem_backend === before.hardware?.modem_backend)
check('system_name was not written back', after.system_name === undefined)

console.log('\nreload')
await page.reload({ waitUntil: 'networkidle' })
await page.waitForSelector('[role="tab"]', { timeout: 10_000 })
await page.locator('[role="tab"]').nth(2).click()
await page.waitForTimeout(400)
check('the stored value is shown after a reload', (await ikeField.inputValue()) === nextIke)

console.log('\nclient-side validation')
await page.locator('[role="tab"]').nth(0).click()
await page.waitForTimeout(300)
const vpcdField = page.locator('.field:has(label:text-is("VPCD logical slots per modem")) input')
await vpcdField.fill('99')
await page.waitForTimeout(200)
check('an out-of-range number blocks saving', await saveButton.isDisabled())
check('the range error is shown', (await page.locator('text=Whole number between 1 and 8.').count()) > 0)

await vpcdField.fill('3')
await page.waitForTimeout(200)
check('restoring the value clears the block', await saveButton.isDisabled(), 'nothing else is dirty')

console.log('\nadmin tab')
await page.locator('[role="tab"]').nth(5).click()
await page.waitForTimeout(300)
check('the password form is present', (await page.locator('input[autocomplete="current-password"]').count()) === 1)
check('the version is shown', (await page.locator('text=1.10.0-mock').count()) > 0)

await browser.close()

if (consoleErrors.length) {
  console.log('\nconsole errors:')
  for (const message of consoleErrors) console.log(`  - ${message}`)
}

console.log(`\n${failures.length === 0 && consoleErrors.length === 0 ? 'PASS' : 'FAIL'} — ${failures.length} failed check(s), ${consoleErrors.length} console error(s)`)
process.exitCode = failures.length === 0 && consoleErrors.length === 0 ? 0 : 1
