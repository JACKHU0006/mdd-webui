#!/usr/bin/env node
/**
 * Behavioural check for the egress view.
 *
 * The screenshot pass proves the page renders. This drives the parts that carry risk, all of
 * which can look fine while being wrong:
 *
 *  1. **A failed UDP test must read as failed.** The gateway's whole reason for UDP-probing is
 *     that a TCP probe passes nodes which can never carry IKEv2/ESP NAT-T. If the view showed a
 *     failed test as "slow" or as a latency figure, the operator would chase the wrong thing.
 *  2. **A direct exit is not testable.** There is no tunnel to probe, so the button must be
 *     disabled rather than firing a request that can only fail confusingly.
 *  3. **Testing is blocked while dirty.** The test hits the *running* exit. Allowing it against
 *     unsaved edits would report on a configuration the operator is not looking at.
 *  4. **Editing marks the page dirty and Save becomes clickable** — then a save round-trips and
 *     returns to clean.
 *
 * Usage: node scripts/verify-egress.mjs
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
const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } })
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e) => consoleErrors.push(String(e)))

/** Find the exit card whose heading matches, then work inside it. */
function cardFor(label) {
  return page.locator('.card').filter({ has: page.locator(`strong:text-is("${label}")`) })
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
  await page.evaluate(() => { window.location.hash = '#/egress' })
  await page.waitForTimeout(1800)

  // ---- 1. seeded states render distinctly -------------------------------------
  check('ready exit shows 就绪', (await page.locator('text=就绪').count()) >= 1)
  check('failed exit shows 未就绪', (await page.locator('text=未就绪').count()) >= 1)
  check('direct exit shows 直连', (await page.locator('text=直连').count()) >= 1)
  check('UDP failure reason surfaces verbatim', (await page.locator('text=/STUN\\/4500: no response/').count()) >= 1)
  check('manual lock is explained in words', (await page.locator('text=/已被手动锁定/').count()) >= 1)
  check('stale pin is explained in words', (await page.locator('text=/锁定于 us-east-02.*实际运行在别处/').count()) >= 1)
  check('missing pin is explained in words', (await page.locator('text=/已不再由其订阅提供/').count()) >= 1)

  // ---- 2. a direct exit cannot be UDP tested ----------------------------------
  const de = cardFor('德国')
  const deTest = de.getByRole('button', { name: /测试 UDP/ })
  check('direct exit offers no UDP test', (await deTest.count()) === 0 || (await deTest.isDisabled()))
  check('direct exit explains why', (await de.locator('text=/没有隧道，因此无需 UDP 检测/').count()) === 1)

  // ---- 3. UDP test reports failure as failure ---------------------------------
  const gb = cardFor('英国')
  const gbTest = gb.getByRole('button', { name: /测试 UDP/ })
  check('failed exit has a test button', (await gbTest.count()) === 1)
  await gbTest.click()
  await page.waitForTimeout(1500)
  const gbText = await gb.innerText()
  check('failed UDP test reads as a failure', /UDP 检测未通过/.test(gbText), gbText.match(/UDP[^。\n]*/)?.[0] ?? '')
  check(
    'failed UDP test shows no latency figure',
    !/UDP 检测通过/.test(gbText),
    'must not present a failed probe as a successful one',
  )

  // ---- 4. a passing exit reports a latency ------------------------------------
  const jp = cardFor('日本')
  await jp.getByRole('button', { name: /测试 UDP/ }).click()
  await page.waitForTimeout(1500)
  const jpText = await jp.innerText()
  const jpFlat = jpText.replace(/\s+/g, ' ')
  check('passing UDP test shows a latency', /可达\s*·\s*\d+\s*毫秒/.test(jpFlat), jpFlat.match(/可达[^。]*/)?.[0] ?? '')

  // ---- 5. dirty blocks testing, save clears dirty -----------------------------
  const saveButton = page.getByRole('button', { name: /^保存$/ }).first()
  check('save is disabled while clean', await saveButton.isDisabled())

  // Toggle rather than set a fixed value: this script writes through to a stateful mock, so
  // hardcoding `false` makes the second run a no-op and the dirty checks would fail on a
  // rerun while the app is fine.
  const jpEnabled = jp.getByRole('checkbox').first()
  const wasEnabled = await jpEnabled.isChecked()
  await jpEnabled.setChecked(!wasEnabled)
  await page.waitForTimeout(400)
  check('editing enables save', !(await saveButton.isDisabled()), `${wasEnabled} → ${!wasEnabled}`)

  const jpTestAfterEdit = jp.getByRole('button', { name: /测试 UDP/ })
  check('testing is blocked while dirty', await jpTestAfterEdit.isDisabled())
  check('dirty state says why testing is blocked', (await jp.locator('text=/请先保存并应用修改/').count()) >= 1)

  await saveButton.click()
  await page.waitForTimeout(2500)
  const saved = page.locator('text=/已保存，订阅已重新解析/')
  check('save reports success', (await saved.count()) >= 1)
  check('save returns the page to clean', await page.getByRole('button', { name: /^保存$/ }).first().isDisabled())

  // Put the switch back so the next run starts from the seeded state.
  const restored = jp.getByRole('checkbox').first()
  if ((await restored.isChecked()) !== wasEnabled) {
    await restored.setChecked(wasEnabled)
    await page.waitForTimeout(300)
    await page.getByRole('button', { name: /^保存$/ }).first().click()
    await page.waitForTimeout(2000)
  }

  // The GB exit is seeded to fail its UDP probe, so its 503 is the scenario under test — not
  // a defect. Anything else in the console is still a real error.
  const unexpected = consoleErrors.filter((line) => !/503/.test(line))
  check('no unexpected console errors', unexpected.length === 0, unexpected.slice(0, 2).join(' / '))
} catch (error) {
  check('script completed', false, String(error))
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
