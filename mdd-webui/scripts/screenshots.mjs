#!/usr/bin/env node
/**
 * Capture console screenshots against a running dev server.
 *
 * Uses `playwright-core` with an explicit executablePath so it can drive whatever Chromium
 * is already on the machine — no browser download, and no coupling to a Playwright release
 * whose bundled browser revision would have to match.
 *
 * Prerequisites:
 *   1. node mock/server.mjs
 *   2. MDD_GATEWAY=http://127.0.0.1:8788 npx vite --port 5173
 *   3. the mock must already have an administrator (or pass MOCK_PASSWORD to match)
 *
 * Usage: node scripts/screenshots.mjs [outDir]
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'

const OUT_DIR = resolve(process.argv[2] || 'screenshots-local')
const BASE = process.env.MDD_UI || 'http://localhost:5173'
const USER = process.env.MOCK_USER || 'admin'
// Must match `mock/server.mjs`'s seeded password (see `state.password` there), otherwise the
// sign-in below silently fails and every page times out waiting for `nav`.
const PASSWORD = process.env.MOCK_PASSWORD || 'mdd-demo-password'

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH

  const root = join(process.env.LOCALAPPDATA || '', 'ms-playwright')
  if (!existsSync(root)) return null

  // Highest revision wins.
  const revisions = readdirSync(root)
    .filter((name) => name.startsWith('chromium-'))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))

  for (const revision of revisions) {
    for (const candidate of [
      join(root, revision, 'chrome-win64', 'chrome.exe'),
      join(root, revision, 'chrome-win', 'chrome.exe'),
      join(root, revision, 'chrome-linux', 'chrome'),
      join(root, revision, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    ]) {
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 420, height: 900 },
]

const PAGES = [
  { name: 'overview', hash: '#/' },
  { name: 'devices', hash: '#/devices' },
  { name: 'lines', hash: '#/lines' },
  { name: 'keepalive', hash: '#/keepalive' },
  { name: 'esim', hash: '#/esim' },
  { name: 'egress', hash: '#/egress' },
  { name: 'notifications', hash: '#/notifications' },
  { name: 'calls', hash: '#/calls' },
  { name: 'terminal', hash: '#/terminal' },
  { name: 'messages', hash: '#/messages' },
  { name: 'settings-hardware', hash: '#/settings', tab: 0 },
  { name: 'settings-vowifi', hash: '#/settings', tab: 2 },
  { name: 'settings-admin', hash: '#/settings', tab: 5 },
]

const executablePath = findChromium()
if (!executablePath) {
  console.error('No Chromium found. Set CHROMIUM_PATH or run `npx playwright install chromium`.')
  process.exit(1)
}

mkdirSync(OUT_DIR, { recursive: true })

const browser = await chromium.launch({ executablePath, headless: true })
const context = await browser.newContext({
  viewport: { width: VIEWPORTS[0].width, height: VIEWPORTS[0].height },
  deviceScaleFactor: 2,
  locale: 'zh-CN',
})
const page = await context.newPage()

const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))

await page.goto(BASE, { waitUntil: 'networkidle' })

// Sign in if the console is showing the login form. A gateway with no administrator shows
// the setup form instead, which has the same two inputs.
const passwordField = page.locator('input[type="password"]').first()
if (await passwordField.count()) {
  const userField = page.locator('input[type="text"], input:not([type])').first()
  if (await userField.count()) await userField.fill(USER)
  await passwordField.fill(PASSWORD)
  await page.locator('button[type="submit"]').first().click()
  await page.waitForTimeout(1200)
}

await page.waitForSelector('nav', { timeout: 10_000 })

for (const viewport of VIEWPORTS) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height })
  for (const target of PAGES) {
    await page.evaluate((hash) => {
      window.location.hash = hash
    }, target.hash)
    await page.waitForTimeout(700)
    // Settings is tabbed; the tab strip is a `role="tablist"`, so an index is enough.
    if (target.tab !== undefined) {
      const tabs = page.locator('[role="tab"]')
      if ((await tabs.count()) > target.tab) {
        await tabs.nth(target.tab).click()
        await page.waitForTimeout(400)
      }
    }
    const file = join(OUT_DIR, `${target.name}.${viewport.name}.png`)
    await page.screenshot({ path: file, fullPage: true })
    console.log(`captured ${file}`)
  }
}

await browser.close()

if (consoleErrors.length) {
  console.log('\nconsole errors:')
  for (const message of consoleErrors) console.log(`  - ${message}`)
  process.exitCode = 2
} else {
  console.log('\nno console errors')
}
