#!/usr/bin/env node
/**
 * Dev check: the title when its shader fails to compile. The shaders module is intercepted in
 * THIS browser only (route) and gets a GLSL error injected — no file on disk is touched.
 *   node scripts/title-raster/shaderfail.mjs <url> <out.png>
 */
import { chromium } from 'playwright-core'
const [url, out] = process.argv.slice(2)
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl'] })
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
const logs = []
p.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`))
p.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
let injected = false
await p.route(/title\/raster\/shaders\.ts/, async (route) => {
  const res = await route.fetch()
  let body = await res.text()
  const before = body
  body = body.replace('gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);', 'gl_FragColor = vec4(sat(col), 1.0);')
  injected = body !== before
  await route.fulfill({ response: res, body })
})
await p.goto(url)
await p.waitForTimeout(5000)
const r = await p.evaluate(() => [...document.querySelectorAll('.layer--title > canvas')].map((c) => `${'titleFallback' in c.dataset ? 'fallback' : 'gl'} ${c.width}x${c.height}`))
await p.screenshot({ path: out })
console.log('injected', injected, JSON.stringify(r))
console.log(logs.filter((l) => !l.startsWith('[debug]') && !l.includes('404')).join('\n'))
await b.close()
