#!/usr/bin/env node
/**
 * Dev check: the title without WebGL (Chrome with 3D APIs disabled).
 *   node scripts/title-raster/nogl.mjs <url> <out.png> [w h]
 * Prints mounted layers, what the title mount contains, and console errors.
 */
import { chromium } from 'playwright-core'
const [url, out, w = '1440', h = '900'] = process.argv.slice(2)
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-3d-apis', '--disable-webgl', '--disable-webgl2'] })
const p = await b.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 })
const logs = []
p.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
p.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
await p.goto(url)
await p.waitForTimeout(4000)
const r = await p.evaluate(() => ({
  ready: document.documentElement.dataset.heroReady,
  layers: [...(window.__hero?.layers.keys() ?? [])],
  webgl: !!document.createElement('canvas').getContext('webgl'),
  title: [...document.querySelectorAll('.layer--title > *')].map((e) => `${e.tagName}${e.width ? ` ${e.width}x${e.height}` : ''}`),
}))
await p.screenshot({ path: out })
console.log(JSON.stringify(r))
console.log(logs.filter((l) => !l.startsWith('[debug]')).join('\n'))
await b.close()
