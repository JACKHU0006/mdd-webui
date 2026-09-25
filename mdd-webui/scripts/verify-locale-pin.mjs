/**
 * The locale contract every other check depends on.
 *
 * A GitHub runner reports `navigator.language === 'en-US'`; a developer's machine usually does
 * not. Every other script's selectors are Chinese, so when this premise breaks they all fail at
 * once with no visible common cause — which is exactly what happened the first time CI ran.
 *
 * This check exists to fail first and explain why.
 *
 * It also pins down *which mechanism* controls the locale, because there are two and only one
 * of them works:
 *
 *   `newContext({ locale })`  sets `navigator.language` AND the browser's `Intl` locale.
 *   overriding `navigator.language` in an init script  changes only what app code reads;
 *                                                      `Intl` keeps using the host's locale.
 *
 * That distinction is not academic. The app has `toLocaleString()` calls with no explicit
 * locale (`src/lib/format.ts`), so the second approach silently leaves date formatting following
 * the host — a fix that looks right and is not. The check below asserts it fails, so nobody
 * reaches for it again.
 *
 * Playwright's `locale` option makes a runner's environment reproducible locally, which is the
 * point: all of this is verifiable without pushing.
 *
 * Usage: node scripts/verify-locale-pin.mjs
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const BASE = process.env.MDD_UI || 'http://localhost:5173'
const PASSWORD = process.env.MOCK_PASSWORD || 'mdd-demo-password'

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
      join(root, revision, 'chrome-win', 'chrome.exe'),
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

/**
 * Load the app once and report both halves of the locale.
 *
 * `host` is what the machine would report; `pin` is how the script tries to override it.
 */
async function probe(host, pin) {
  const opts = { viewport: { width: 1400, height: 1000 } }
  if (pin === 'locale-option') opts.locale = 'zh-CN'
  else opts.locale = host

  const ctx = await browser.newContext(opts)
  if (pin === 'navigator-override') {
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'language', { get: () => 'zh-CN' })
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] })
    })
  }
  if (pin === 'locale-option') {
    await ctx.addInitScript(() => window.localStorage.setItem('mdd.language', 'zh'))
  }

  const page = await ctx.newPage()
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[type="password"], nav', { timeout: 20_000 })
  const pw = page.locator('input[type="password"]')
  if (await pw.count()) {
    await pw.fill(PASSWORD)
    await page.locator('button[type="submit"]').first().click()
  }
  await page.waitForSelector('nav', { timeout: 20_000 })
  const nav = await page.locator('nav').first().innerText()
  // A date whose zh-CN and en-US renderings are unmistakably different:
  //   zh-CN -> "2024/1/15 10:30:00"      en-US -> "1/15/2024, 10:30:00 AM"
  const env = await page.evaluate(() => ({
    language: navigator.language,
    formatted: new Date(2024, 0, 15, 10, 30).toLocaleString(),
  }))
  await ctx.close()
  return { nav: nav.includes('概览'), ...env }
}

try {
  // ---- 1. the bug this exists to catch ---------------------------------------
  const bare = await probe('en-US', 'none')
  check(
    'an unpinned page follows the host locale',
    bare.language === 'en-US' && !bare.nav,
    `navigator.language=${bare.language}，导航=${bare.nav ? '中文' : '英文'}`,
  )
  check(
    'and its date formatting follows the host too',
    /^\d{1,2}\/\d{1,2}\/\d{4}/.test(bare.formatted),
    `toLocaleString() = ${bare.formatted}`,
  )

  // ---- 2. the pin that works -------------------------------------------------
  const pinned = await probe('en-US', 'locale-option')
  check(
    'the context locale option overrides navigator.language',
    pinned.language === 'zh-CN',
    `navigator.language=${pinned.language}`,
  )
  check(
    'so the UI renders in the pinned language on a foreign host',
    pinned.nav,
    '其他所有脚本都依赖这些中文标签',
  )
  check(
    'and date formatting follows the pin, not the host',
    pinned.formatted.startsWith('2024/'),
    `toLocaleString() = ${pinned.formatted}`,
  )

  // ---- 3. the pin that looks right and is not --------------------------------
  const override = await probe('en-US', 'navigator-override')
  check(
    'overriding navigator.language alone does NOT control Intl',
    override.language === 'zh-CN' && !override.formatted.startsWith('2024/'),
    `navigator.language=${override.language} 但 toLocaleString() = ${override.formatted} —— ` +
      '这正是它危险的地方：读起来是对的，日期格式却仍然跟着宿主机',
  )

  // ---- 4. why this was invisible locally ------------------------------------
  const native = await probe('zh-CN', 'none')
  check(
    'a zh-CN host looks correct with no pin at all',
    native.nav,
    '这是本地一直看不出问题的原因',
  )
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
