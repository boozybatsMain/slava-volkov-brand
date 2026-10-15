#!/usr/bin/env node
// Frame-rate / CPU cost of the mesh title layer: node scripts/title-mesh/perf.mjs [--layers title] [--w 1440 --h 900 --dpr 2]
import { chromium } from 'playwright-core'
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') && a.push([v.slice(2), all[i + 1]]), a), []))
const W = +(args.w ?? 1440), H = +(args.h ?? 900), dpr = +(args.dpr ?? 2)
const layers = args.layers ?? 'world,paper,title'
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: dpr })
await p.goto(`http://localhost:${args.port ?? 5184}/?title=mesh&layers=${layers}`)
await p.waitForFunction(() => document.documentElement.dataset.heroReady === '1', null, { timeout: 30000 })
const res = await p.evaluate(async () => {
  const layer = window.__hero.layers.get('title')
  const orig = layer.update.bind(layer)
  const times = []
  layer.update = (f) => { const t0 = performance.now(); orig(f); times.push(performance.now() - t0) }
  const frames = []
  let last = performance.now()
  await new Promise((done) => {
    const t0 = performance.now()
    const tick = (now) => { frames.push(now - last); last = now; if (now - t0 < 3000) requestAnimationFrame(tick); else done() }
    requestAnimationFrame(tick)
    // wiggle the pointer so energy/shimmer paths run
    let k = 0
    const iv = setInterval(() => { k++; window.dispatchEvent(new PointerEvent('pointermove', { clientX: 300 + 400 * Math.sin(k / 10), clientY: 400 + 200 * Math.cos(k / 13) })); if (performance.now() - t0 > 3000) clearInterval(iv) }, 16)
  })
  times.sort((a, b) => a - b); frames.sort((a, b) => a - b)
  const q = (arr, x) => arr[Math.floor(arr.length * x)]
  const geo = layer
  return { frames: frames.length, fps: frames.length / 3, frameP50: q(frames, 0.5), frameP95: q(frames, 0.95), updP50: q(times, 0.5), updP95: q(times, 0.95) }
})
console.log(JSON.stringify(res, null, 1))
await b.close()
