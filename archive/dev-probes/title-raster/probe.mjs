#!/usr/bin/env node
/**
 * Dev probe for the raster title: applies config edits through window.__hero, re-lays out,
 * screenshots, and marks layout.title.{x,y} with a 1-px magenta cross so the anchor can be checked.
 *   node scripts/title-raster/probe.mjs <url> <out.png> '<json patch for heroConfig.title>' [w h]
 */
import { chromium } from 'playwright-core'
const [url, out, patch = '{}', w = '1440', h = '900'] = process.argv.slice(2)
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl'] })
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(url, { waitUntil: 'load' })
await page.waitForFunction(() => document.documentElement.dataset.heroReady === '1', null, { timeout: 30000 })
const lay = await page.evaluate((p) => {
  const H = window.__hero
  const merge = (a, b) => { for (const k in b) (typeof b[k] === 'object' ? merge(a[k], b[k]) : (a[k] = b[k])) }
  merge(H.config.title, JSON.parse(p))
  H.refresh()
  const t = H.layout.title
  const m = document.createElement('div')
  m.style.cssText = `position:absolute;left:${t.x - 12}px;top:${t.y}px;width:24px;height:1px;background:#f0f;z-index:9`
  const n = document.createElement('div')
  n.style.cssText = `position:absolute;left:${t.x}px;top:${t.y - 12}px;width:1px;height:24px;background:#f0f;z-index:9`
  document.getElementById('hero').append(m, n)
  return t
}, patch)
await page.waitForTimeout(1500)
await page.screenshot({ path: out })
console.log(JSON.stringify(lay))
await browser.close()
