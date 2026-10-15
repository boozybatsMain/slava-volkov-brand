#!/usr/bin/env node
/**
 * Fits the mesh title (src/layers/title/mesh) to the client's render: letter weight, spacing, depth,
 * pose and the image-plane fit — silhouette IoU + the front outlines on the render's edges
 * (fit.ts), against public/assets/title-raster.
 *
 *   node scripts/title-mesh/fit.mjs [--port 5181] [--start params.json] [--iters 30] [--wedge 0.5]
 *        [--names pose.yaw,geometry.boldX,…] [--es 3000 [--seed 1]] [--blur 1] [--eval] [--env public/assets/title-mesh/env.png] [--outline [--zoom 2]] [--grad] [--out shots/title-mesh2/fit]
 *
 * Needs the dev server (the stand page is served by Vite). Writes <out>.json (the best params, ready
 * for hero.config.ts → title.mesh), <out>.png (silhouettes: red — render only, green — mesh only,
 * yellow — both), with --outline <out>_outline.png (the mesh's outlines over the render), with --grad
 * <out>_grad.png (the edges `edge` reads). Without --start: the archived candidate's numbers.
 */
import fs from 'node:fs'
import path from 'node:path'
import { openBrowser } from '../shared-browser.mjs'

const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (!a.startsWith('--')) continue
  const next = process.argv[i + 1]
  args[a.slice(2)] = next && !next.startsWith('--') ? (i++, next) : 'true'
}
const port = args.port ?? 5181
const out = args.out ?? 'shots/title-mesh2/fit'

const START = {
  geometry: {
    depth: 0.55, bevelOuter: 0.032, bevelStep: 0.02, bevelInner: 0.03, seam: 0.008, seamAt: 0.5,
    curveSegments: 2, crease: 38, boldX: 0.04, boldY: 0.04, condense: 1.03, tracking: 0, wordSpace: 0.71, word2Scale: 1, bend: -7.5,
  },
  pose: { yaw: 46.5, pitch: -6.5, roll: -1.3, distance: 11.3, shiftX: 0.13, shiftY: 0.08 },
  fit: { scale: 1, rotation: 0, x: 0, y: 0 },
}
/** search steps (the first sweep's) */
const STEPS = {
  'pose.yaw': 3, 'pose.pitch': 2, 'pose.roll': 1, 'pose.distance': 1, 'pose.shiftX': 0.04, 'pose.shiftY': 0.03,
  'geometry.depth': 0.05, 'geometry.bend': 3, 'geometry.boldX': 0.015, 'geometry.boldY': 0.015,
  'geometry.condense': 0.03, 'geometry.tracking': 0.02, 'geometry.wordSpace': 0.05, 'geometry.word2Scale': 0.03,
  'geometry.bevelOuter': 0.01, 'geometry.bevelInner': 0.01,
  'fit.rotation': 0.5, 'adj.scale': 0.01, 'adj.x': 2, 'adj.y': 2,
  // per-glyph shifts and widths (geometry.shift.0 … .10, geometry.widths.S … K): not in the default set
  'geometry.shift.*': 0.03,
  'geometry.widths.S': 0.03, 'geometry.widths.L': 0.03, 'geometry.widths.A': 0.03, 'geometry.widths.V': 0.03, 'geometry.widths.O': 0.03, 'geometry.widths.K': 0.03,
}
const start = args.start ? JSON.parse(fs.readFileSync(args.start, 'utf8')) : START
const names = (args.names ?? Object.keys(STEPS).join(',')).split(',')
const steps = names.map((n) => STEPS[n] ?? STEPS[n.replace(/\.\d+$/, '.*')] ?? 0.02)
const wEdge = Number(args.wedge ?? 0.5)

const browser = await openBrowser()
const context = await browser.newContext({ viewport: { width: 1300, height: 900 } })
const page = await context.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
page.on('console', (m) => m.type() === 'error' && console.log('[page]', m.text()))
await page.goto(`http://localhost:${port}/scripts/title-mesh/fit.html`)
await page.waitForFunction(() => window.__fitReady === true, null, { timeout: 30000 })

// --blur r: the edge map's blur radius, texels (default 1; 3–5 for a coarse first pass)
if (args.blur) await page.evaluate((b) => window.__fit.makeReference(0.42, b), Number(args.blur))
let best = start
if (args.eval) {
  console.log('score', await page.evaluate(([p, w]) => window.__fit.evaluate(p, w), [best, wEdge]))
  best = await page.evaluate((p) => window.__fit.finish(p), best)
} else {
  // --es N: N evaluations of the evolution strategy instead of the coordinate search
  const res = args.es
    ? await page.evaluate((o) => window.__fit.es(o), { start, names, steps, evals: Number(args.es), wEdge, seed: Number(args.seed ?? 1) })
    : await page.evaluate((o) => window.__fit.run(o), { start, names, steps, iters: Number(args.iters ?? 30), wEdge })
  console.log(res.log.join('\n'))
  best = res.best
  console.log('best', res.score)
}
// Vite may have reloaded the stand meanwhile (a watched file changed): wait for it again
const ready = () => page.waitForFunction(() => window.__fitReady === true, null, { timeout: 30000 })
await ready()
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out + '.json', JSON.stringify(best, null, 2))
const png = await page.evaluate((p) => window.__fit.overlay(p), best)
fs.writeFileSync(out + '.png', Buffer.from(png.split(',')[1], 'base64'))
if (args.outline) {
  const o = await page.evaluate(([p, z]) => window.__fit.outline(p, z), [best, Number(args.zoom ?? 2)])
  fs.writeFileSync(out + '_outline.png', Buffer.from(o.split(',')[1], 'base64'))
}
if (args.grad) {
  const ref = await page.evaluate(() => window.__fit.gradientImage())
  fs.writeFileSync(out + '_grad.png', Buffer.from(ref.split(',')[1], 'base64'))
}
// --env <file.png>: learn the chrome environment from the render with these params (fit.ts → learnEnv)
if (args.env) {
  const env = await page.evaluate((p) => window.__fit.learnEnv(p), best)
  fs.mkdirSync(path.dirname(args.env), { recursive: true })
  fs.writeFileSync(args.env, Buffer.from(env.png.split(',')[1], 'base64'))
  console.log('env', args.env, 'coverage (faces, walls)', env.coverage.map((v) => v.toFixed(3)).join(', '))
}
console.log('saved', out + '.json', out + '.png')
await context.close()
await browser.close()
