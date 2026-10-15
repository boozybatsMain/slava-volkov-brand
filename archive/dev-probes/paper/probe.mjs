// Dev probe for the paper layer: open the hero, run a JS snippet, take a screenshot.
//   node scripts/paper/probe.mjs --url ... --out shots/paper/x.png --js "..." [--w --h --dpr --clip x,y,w,h]
import { chromium } from 'playwright-core'
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true'])
  return acc
}, []))
const W = Number(args.w ?? 1440), H = Number(args.h ?? 900), dpr = Number(args.dpr ?? 2)
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: dpr })
page.on('console', (m) => console.log(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`))
page.on('requestfailed', (r) => console.log(`[requestfailed] ${r.url()}`))
page.on('response', (r) => { if (r.status() >= 400) console.log(`[${r.status()}] ${r.url()}`) })
await page.goto(args.url, { waitUntil: 'load' })
await page.waitForFunction(() => document.documentElement.dataset.heroReady === '1', null, { timeout: 30000 }).catch(() => {})
if (args.resize) {
  const [rw, rh] = args.resize.split(',').map(Number)
  await page.setViewportSize({ width: rw, height: rh })
  await page.waitForTimeout(700)
}
if (args.js) console.log('js →', JSON.stringify(await page.evaluate(args.js)))
await page.waitForTimeout(Number(args.wait ?? 500))
if (args.out) {
  const clip = args.clip ? (([x, y, w, h]) => ({ x, y, width: w, height: h }))(args.clip.split(',').map(Number)) : undefined
  await page.screenshot({ path: args.out, clip })
}
await browser.close()
