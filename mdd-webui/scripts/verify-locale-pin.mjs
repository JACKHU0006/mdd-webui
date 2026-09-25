/**
 * A/B check: does pinning `mdd.language` actually fix the CI locale problem?
 *
 * A GitHub Ubuntu runner reports `navigator.language === 'en-US'`, so the app renders its
 * English UI — and the verify scripts' selectors are Chinese. This reproduces that locale
 * locally (Playwright's `locale` option sets `navigator.language`) and shows the difference
 * the pin makes. Temporary diagnostic; not part of the suite.
 */
import { chromium } from 'playwright-core'

const BASE = process.env.MDD_UI || 'http://localhost:5173'
const PASSWORD = 'mdd-demo-password'

const browser = await chromium.launch({ headless: true })

async function navText(locale, pin) {
  const ctx = await browser.newContext({ locale })
  if (pin) await ctx.addInitScript(() => window.localStorage.setItem('mdd.language', 'zh'))
  const page = await ctx.newPage()
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[type="password"], nav', { timeout: 20000 })
  const pw = page.locator('input[type="password"]')
  if (await pw.count()) {
    await pw.fill(PASSWORD)
    await page.locator('button[type="submit"]').first().click()
  }
  await page.waitForSelector('nav', { timeout: 20000 })
  const text = await page.locator('nav').first().innerText()
  await ctx.close()
  return text
}

const cases = [
  ['en-US', false, 'CI runner, 没有 pin —— 这就是失败现场'],
  ['en-US', true, 'CI runner, 加了 pin —— 应该是中文'],
  ['zh-CN', false, '开发机, 没有 pin —— 一直是中文，所以本地看不出来'],
]

let ok = true
for (const [locale, pin, note] of cases) {
  const nav = await navText(locale, pin)
  const isChinese = nav.includes('概览')
  const expected = locale === 'zh-CN' || pin
  const pass = isChinese === expected
  if (!pass) ok = false
  console.log(
    (pass ? 'PASS  ' : 'FAIL  ') +
      'locale=' + locale.padEnd(6) +
      ' pin=' + String(pin).padEnd(5) +
      ' -> ' + (isChinese ? '中文界面' : '英文界面') +
      '   (' + note + ')',
  )
}

await browser.close()
console.log(ok ? '\npin 确实修好了这个问题' : '\npin 没有生效')
process.exit(ok ? 0 : 1)
