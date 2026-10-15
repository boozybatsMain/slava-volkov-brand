#!/usr/bin/env node
/**
 * Dev check: the title across a WebGL context loss (WEBGL_lose_context) and restore.
 *   node scripts/title-raster/ctxloss.mjs <url> <outPrefix>
 * Writes <outPrefix>-lost.png and <outPrefix>-restored.png and prints the title mount's children.
 * (No fallback is shown during a loss: in Chrome any 2D canvas painted while a sibling WebGL
 * context is lost turns the whole page white; the title comes back on webglcontextrestored.)
 */
import { chromium } from 'playwright-core'
const [url, prefix] = process.argv.slice(2)
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl'] })
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
const logs = []
p.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
p.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
await p.goto(url)
await p.waitForFunction(() => document.documentElement.dataset.heroReady === '1', null, { timeout: 30000 })
const kids = () => p.evaluate(() => [...document.querySelectorAll('.layer--title > canvas')].map((c) => `${'titleFallback' in c.dataset ? 'fallback' : 'gl'} ${c.width}x${c.height}`))
console.log('before  ', JSON.stringify(await kids()))
await p.evaluate(() => {
  const c = document.querySelector('.layer--title canvas')
  window.__lc = (c.getContext('webgl2') || c.getContext('webgl')).getExtension('WEBGL_lose_context')
  window.__lc.loseContext()
})
await p.waitForTimeout(1200)
console.log('lost    ', JSON.stringify(await kids()))
await p.screenshot({ path: `${prefix}-lost.png` })
await p.evaluate(() => window.__lc.restoreContext())
await p.waitForTimeout(1500)
console.log('restored', JSON.stringify(await kids()))
await p.screenshot({ path: `${prefix}-restored.png` })
console.log(logs.filter((l) => !l.startsWith('[debug]') && !l.includes('404')).join('\n'))
await b.close()
