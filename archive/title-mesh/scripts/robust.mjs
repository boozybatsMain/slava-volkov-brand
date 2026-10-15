#!/usr/bin/env node
// Rebuild/dispose robustness + console errors for the mesh title.
import { chromium } from 'playwright-core'
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
const p = await b.newPage({ viewport: { width: 1440, height: 900 } })
const logs = []
p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`) })
p.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
p.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url()}`))
p.on('response', (r) => { if (r.status() >= 400) logs.push(`[${r.status()}] ${r.url()}`) })
await p.goto('http://localhost:5184/?title=mesh&meshtune')
await p.waitForFunction(() => document.documentElement.dataset.heroReady === '1', null, { timeout: 30000 })
const r = await p.evaluate(async () => {
  for (let i = 0; i < 12; i++) {
    window.__hero.config.title.mode = i % 2 ? 'raster' : 'mesh'
    await window.__hero.rebuild('title')
  }
  window.__hero.config.title.mode = 'mesh'
  await window.__hero.rebuild('title')
  await new Promise((r) => setTimeout(r, 500))
  const c = document.querySelector('.layer--title canvas')
  const gl = c && (c.getContext('webgl2'))
  return { canvases: document.querySelectorAll('.layer--title canvas').length, lost: gl ? gl.isContextLost() : 'n/a', guis: [...document.querySelectorAll('.lil-gui > .title')].map((e) => e.textContent) }
})
console.log(JSON.stringify(r))
await p.screenshot({ path: 'shots/title-mesh/robust.png' })
console.log(logs.join('\n') || 'no errors')
await b.close()
