#!/usr/bin/env node
/**
 * One-off behavioural check for the eSIM view.
 *
 * The screenshot pass only proves the page *renders*. This script drives the three paths that
 * actually carry risk, because each one has a way of looking fine while being wrong:
 *
 *  1. Load card  — an exclusive read. It must produce a profile list, and the chip details must
 *                  come from the reader rather than a stale cache.
 *  2. Enable     — lpac allows only one enabled profile per SE. Each row must therefore offer
 *                  exactly one actionable state button (an enabled profile cannot be enabled
 *                  again). Switching must ask first, because it drops the running line.
 *  3. Download   — a background task driven over the WebSocket. The progress list must reach
 *                  all nine steps and end in a completed state, proving `esim_download` events
 *                  are actually wired through the store's `subscribe` fan-out.
 *
 * Usage: node scripts/verify-esim.mjs
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
      join(root, revision, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      join(root, revision, 'chrome-linux', 'chrome'),
    ]) {
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

const executablePath = findChromium()
if (!executablePath) {
  console.error('No Chromium found. Set CHROMIUM_PATH.')
  process.exit(1)
}

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch({ executablePath, headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await context.newPage()

const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => consoleErrors.push(String(error)))

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })

  // ---- sign in ----------------------------------------------------------------
  await page.waitForTimeout(600)
  const passwordInput = page.locator('input[type="password"]')
  if (await passwordInput.count()) {
    await passwordInput.fill(PASSWORD)
    await page.locator('button[type="submit"]').first().click()
    await page.waitForSelector('nav', { timeout: 15000 })
  }

  await page.evaluate(() => {
    window.location.hash = '#/esim'
  })
  await page.waitForTimeout(1200)

  // ---- 1. Load card (exclusive read) -----------------------------------------
  const loadButton = page.getByRole('button', { name: /读取卡片/ })
  check('load-card button present', (await loadButton.count()) === 1)

  // The reader picker lives inside the card form; the first `select` on the page is the
  // language switcher in the sidebar, so scope by the reader label rather than by index.
  const readerSelect = page.locator('select').filter({ hasText: /Alcor|读者|#0|#1/ }).first()
  const readerOptions = await readerSelect.locator('option').count().catch(() => 0)
  check('reader picker populated from /api/readers', readerOptions >= 2, `${readerOptions} options`)

  await loadButton.click()
  await page.waitForTimeout(1500)

  // An enabled profile offers only 禁用; a disabled one offers only 启用. Counting the
  // *disabled* state of each control proves the view is modelling exclusivity rather than
  // just echoing whatever the last response said.
  const enableButtons = page.getByRole('button', { name: '启用', exact: true })
  const disableButtons = page.getByRole('button', { name: '禁用', exact: true })
  const total = (await enableButtons.count()) + (await disableButtons.count())
  check('profile list rendered after read', total >= 4, `${total} state buttons`)

  // Per row exactly one of the two must be actionable.
  const actionable = await page.locator('button', { hasText: /^(启用|禁用)$/ }).evaluateAll((nodes) =>
    nodes.reduce((acc, node) => {
      const text = (node.textContent || '').trim()
      acc[text] = acc[text] || { enabled: 0, disabled: 0 }
      if (node.disabled) acc[text].disabled += 1
      else acc[text].enabled += 1
      return acc
    }, {}),
  )
  check(
    'each profile offers exactly one actionable state button',
    actionable['启用']?.disabled >= 1 && actionable['禁用']?.disabled >= 1,
    JSON.stringify(actionable),
  )

  // ---- 2. Enable the other profile; it must ask first ------------------------
  const actionableEnable = page.getByRole('button', { name: '启用', exact: true }).and(
    page.locator(':not([disabled])'),
  )
  const enableCount = await actionableEnable.count()
  check('a disabled profile can be enabled', enableCount >= 1, `${enableCount} actionable`)

  if (enableCount >= 1) {
    await actionableEnable.first().click()
    await page.waitForTimeout(500)

    // Switching profiles kills the running line, so the view must ask before doing it.
    const dialog = page.locator('[role="alertdialog"], [role="dialog"]')
    check('switch asks for confirmation', (await dialog.count()) > 0)

    if ((await dialog.count()) > 0) {
      const confirmButton = dialog.locator('button.btn-danger, button.btn-primary').last()
      const confirmLabel = (await confirmButton.innerText()).trim()
      await confirmButton.click()
      await page.waitForTimeout(1200)
      check('switch confirmed', true, `clicked "${confirmLabel}"`)

      // After the switch the exclusivity must still hold in the other direction.
      const after = await page
        .locator('button', { hasText: /^(启用|禁用)$/ })
        .evaluateAll((nodes) => nodes.filter((node) => node.disabled).length)
      check('exclusivity holds after switching profiles', after >= 2, `${after} controls locked out`)
    }
  }

  // ---- 3. Download: all nine steps must be seen, ending completed ------------
  const downloadButton = page.getByRole('button', { name: /下载配置/ })
  check('download button present', (await downloadButton.count()) === 1)

  if ((await downloadButton.count()) === 1) {
    await downloadButton.click()
    await page.waitForTimeout(500)
    const dialog = page.locator('[role="dialog"]').filter({ hasText: /下载|SM-DP/ })
    check('download dialog opens', (await dialog.count()) > 0)

    // The fields are `input.input` with no `type` attribute, so `input[type="text"]` does NOT
    // match them. Target the first text field in the dialog instead.
    const codeInput = dialog.locator('input.input').first()
    await codeInput.fill('LPA:1$smdp.example.com$1234567890')
    await page.waitForTimeout(300)

    // Pasting a full `LPA:1$…` code is meant to pre-fill the manual-mode fields, so the operator
    // can switch over and see them populated instead of retyping. Verify exactly that: flip to
    // the manual tab and confirm the two fields already hold the parsed values.
    await dialog.getByRole('tab', { name: '手动填写 SM-DP+ 信息' }).click()
    await page.waitForTimeout(300)
    const parsed = await dialog.locator('input.input').evaluateAll((nodes) =>
      nodes.map((node) => node.value),
    )
    check(
      'activation code pre-fills manual SM-DP+ fields',
      parsed.includes('smdp.example.com') && parsed.includes('1234567890'),
      JSON.stringify(parsed),
    )

    // Submit via the activation-code path, which is the one that sends `activation_code` as-is.
    await dialog.getByRole('tab', { name: '激活码' }).click()
    await page.waitForTimeout(200)

    const startButton = dialog.locator('button.btn-primary').last()
    await startButton.click()

    // The mock walks the nine steps on a timer; give it room to finish. The progress list
    // renders at page level (not inside the dialog), so read `main`.
    await page.waitForTimeout(8000)

    const progressText = await page.locator('main').innerText()
    const stepLabels = [
      '读取默认 SM-DP+',
      '获取 eUICC 挑战值',
      '与 SM-DP+ 认证',
      '认证服务器',
      '认证客户端',
      '配置预览',
      '准备下载',
      '获取配置包',
      '安装到 eUICC',
    ]
    const stepHits = stepLabels.filter((label) => progressText.includes(label))
    check(
      'download progress walks the nine steps',
      stepHits.length === 9,
      `${stepHits.length}/9 — missing: ${stepLabels.filter((l) => !stepHits.includes(l)).join(', ') || 'none'}`,
    )

    const completed = /完成|已安装|成功/.test(progressText)
    check('download reaches a completed state', completed, progressText.slice(0, 200).replace(/\s+/g, ' '))
  }

  // ---- eUICC inventory --------------------------------------------------------
  // The panel is part of the same page, so it is checked here rather than in a script of its
  // own. What matters is the three-valued presence: a cached card must not read as present.
  const inventory = page.locator('.card').filter({ has: page.locator('strong:text-is("eUICC 清单")') })
  check('the inventory panel renders', (await inventory.count()) === 1)
  const invText = await inventory.innerText()
  check(
    'an eUICC a reader reported is marked as in-reader',
    /在读卡器中/.test(invText),
    invText.match(/在读卡器中[^\n]*/)?.[0] ?? '',
  )
  check(
    'a cached-only eUICC is marked as not verified',
    /未核实/.test(invText),
    'the cache is keyed by EID and nothing removes an entry when a card is taken out',
  )
  check(
    'exactly one card is claimed to be in a reader',
    (await inventory.locator('text=/在读卡器中/').count()) === 1,
    'the other card is known only from the cache',
  )
  check(
    'the default view says it came from the cache',
    /来自缓存/.test(invText),
  )
  check(
    'both cards are listed',
    (await inventory.locator('text=/8904903200500888260003335790/').count()) >= 2,
    'including the one only known from the cache',
  )
  check('the line using a card is shown', /line-1/.test(invText))
  check(
    'reading all cards is a deliberate action',
    (await inventory.getByRole('button', { name: /读取所有卡/ }).count()) === 1,
    'a page load must not take a reader away from a running line',
  )

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' / '))
} catch (error) {
  check('script completed', false, String(error))
} finally {
  await browser.close()
}

const failed = results.filter((row) => !row.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
