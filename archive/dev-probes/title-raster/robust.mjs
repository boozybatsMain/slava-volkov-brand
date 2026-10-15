#!/usr/bin/env node
/**
 * Rebuild / resize / dispose robustness + console errors for the raster title
 * (pattern from scripts/title-mesh/robust.mjs).
 *   node scripts/title-raster/robust.mjs [port]
 * 13 rebuilds (raster ↔ mesh, ending on raster) with ?rtune open, live resizes, a pose-knob edit
 * (fov / recess / meshStep must re-solve without a resize). Expects exactly one title canvas,
 * a live GL context, one raster tuner panel, and no errors from this layer.
 */
import { chromium } from 'playwright-core'
const port = process.argv[2] ?? '5185'
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
const p = await b.newPage({ viewport: { width: 1440, height: 900 } })
const logs = []
p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()} ${m.location()?.url ?? ''}`) })
p.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
p.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url()}`))
p.on('response', (r) => { if (r.status() >= 400) logs.push(`[${r.status()}] ${r.url()}`) })
await p.goto(`http://localhost:${port}/?title=raster&rtune`)
await p.waitForFunction(() => document.documentElement.dataset.heroReady === '1', null, { timeout: 30000 })
await p.waitForTimeout(600)
const r1 = await p.evaluate(async () => {
  const H = window.__hero
  for (let i = 0; i < 13; i++) {
    H.config.title.mode = i % 2 ? 'mesh' : 'raster'
    await H.rebuild('title')
  }
  H.config.title.mode = 'raster'
  await H.rebuild('title')
  await new Promise((r) => setTimeout(r, 800))
  const roots = [...document.querySelectorAll('.lil-gui.lil-root, .lil-gui.root')]
  return { guis: roots.map((e) => e.querySelector('.lil-title, .title')?.textContent ?? '?') }
})
for (const [w, h] of [[390, 844], [1920, 1080], [700, 900], [1280, 800], [1440, 900]]) {
  await p.setViewportSize({ width: w, height: h })
  await p.waitForTimeout(300)
}
// pose knobs edited live (as ?rtune would): must re-solve without a resize, no errors
const r2 = await p.evaluate(async () => {
  const before = document.querySelector('.layer--title canvas').toDataURL().length
  const mod = await import('/src/layers/title/raster/params.ts')
  Object.assign(mod.rasterTitleParams, { fov: 50, recess: 0.3, meshStep: 3 })
  await new Promise((r) => setTimeout(r, 400))
  Object.assign(mod.rasterTitleParams, { fov: 34, recess: 0.13, meshStep: 2 })
  await new Promise((r) => setTimeout(r, 400))
  const c = document.querySelectorAll('.layer--title canvas')
  const gl = c[0] && c[0].getContext('webgl2')
  return { canvases: c.length, lost: gl ? gl.isContextLost() : 'n/a', drew: before > 0 }
})
console.log(JSON.stringify({ ...r1, ...r2 }))
await p.screenshot({ path: 'shots/title-polish/robust.png' })
console.log(logs.join('\n') || 'no errors')
await b.close()
