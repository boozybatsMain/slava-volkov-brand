#!/usr/bin/env node
/**
 * Fits the mesh title's base pose / spacing to reference/title-main.jpg (silhouette IoU).
 *
 *   node scripts/title-mesh/fit.mjs [--port 5184] [--iters 40] [--wdark 0.5]
 *        [--params pose.yaw,pose.pitch,...] [--start '{"pose.yaw":40}'] [--eval]
 *
 * Needs the dev server running (the harness page is served by Vite).
 * Writes shots/title-mesh/fit_overlay.png (red = reference only, green = mine only, yellow = both).
 */
import { chromium } from 'playwright-core'
import fs from 'node:fs'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true'])
    return acc
  }, []),
)
const port = args.port ?? 5184
const DEFAULT = {
  'pose.yaw': 3, 'pose.pitch': 3, 'pose.roll': 1.5, 'pose.distance': 1, 'pose.shiftX': 0.06, 'pose.shiftY': 0.04,
  'geometry.depth': 0.06, 'geometry.bend': 4, 'geometry.condense': 0.04, 'geometry.tracking': 0.02, 'geometry.wordSpace': 0.05,
}
const names = (args.params ?? Object.keys(DEFAULT).join(',')).split(',')
const steps = names.map((n) => DEFAULT[n] ?? 0.05)
const start = args.start ? JSON.parse(args.start) : {}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 800, height: 400 } })
page.on('console', (m) => console.log('[page]', m.text()))
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(`http://localhost:${port}/scripts/title-mesh/fit.html`)
await page.waitForFunction(() => window.__fitReady === true, null, { timeout: 30000 })
const box = await page.evaluate(() => window.__fit.loadReference('/reference/title-main.jpg'))
console.log('reference bbox (half res)', box)

let res
if (args.eval) {
  res = await page.evaluate(([s, w]) => window.__fit.evaluate(s, w), [start, Number(args.wdark ?? 0.5)])
  console.log('score', res.score)
} else {
  res = await page.evaluate(
    (o) => window.__fit.run(o),
    { params: names.map((n) => n.split('.')), steps, iters: Number(args.iters ?? 40), random: Number(args.random ?? 0), wDark: Number(args.wdark ?? 0.5), start },
  )
  console.log(res.log.join('\n'))
  console.log('best', res.best)
  console.log('params', JSON.stringify(res.params))
}
const out = args.out ?? 'shots/title-mesh/fit_overlay.png'
fs.writeFileSync(out, Buffer.from(res.overlay.split(',')[1], 'base64'))
console.log('saved', out)
await browser.close()
