#!/usr/bin/env node
/**
 * Dev probe: the title's internal render resolution across viewports.
 *   node scripts/title-raster/res_probe.mjs <url> [WxH ...]
 * PATCH='{"raster":{"renderWidth":400}}' env merges into heroConfig.title first (knobs not yet in the file).
 * Prints, per viewport: canvas internal size, title span in CSS px and in render px,
 * effective CSS px per render pixel, and render px per source texel (≈ 0.56 is the 1440 look).
 */
import { chromium } from 'playwright-core'
const [url, ...sizes] = process.argv.slice(2)
const list = sizes.length ? sizes : ['1024x768', '1280x800', '1440x900', '1920x1080', '2560x1440', '390x844']
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl'] })
for (const s of list) {
  const [w, h] = s.split('x').map(Number)
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction(() => document.documentElement.dataset.heroReady === '1', null, { timeout: 30000 })
  const r = await page.evaluate((patch) => {
    const merge = (a, b) => { for (const k in b) (typeof b[k] === 'object' ? merge(a[k], b[k]) : (a[k] = b[k])) }
    if (patch) { merge(window.__hero.config.title, JSON.parse(patch)); window.__hero.refresh() }
    const c = document.querySelector('.layer--title canvas')
    const L = window.__hero.layout
    const ps = L.width / c.width
    return { canvas: `${c.width}x${c.height}`, titleCss: Math.round(L.title.width), titleRender: Math.round(L.title.width / ps), cssPerPx: +ps.toFixed(3), pxPerTexel: +(L.title.width / ps / 1129).toFixed(3) }
  }, process.env.PATCH ?? '')
  console.log(s.padEnd(10), JSON.stringify(r))
  await page.close()
}
await browser.close()
