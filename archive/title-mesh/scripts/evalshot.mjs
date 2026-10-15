#!/usr/bin/env node
// Screenshot after running JS in the page: node scripts/title-mesh/evalshot.mjs --url ... --out ... --eval "window.__hero.config.title.response.highlight=0; window.__hero.refresh()"
import { chromium } from 'playwright-core'
const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, all) => (v.startsWith('--') && acc.push([v.slice(2), all[i + 1]]), acc), []))
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
const p = await b.newPage({ viewport: { width: +(a.w ?? 1440), height: +(a.h ?? 900) }, deviceScaleFactor: +(a.dpr ?? 1) })
p.on('pageerror', (e) => console.log('[pageerror]', e.message))
await p.goto(a.url)
await p.waitForFunction(() => document.documentElement.dataset.heroReady === '1', null, { timeout: 30000 })
if (a.eval) await p.evaluate(a.eval)
await p.waitForTimeout(+(a.wait ?? 800))
const clip = a.clip ? (([x, y, width, height]) => ({ x, y, width, height }))(a.clip.split(',').map(Number)) : undefined
await p.screenshot({ path: a.out, clip })
await b.close()
console.log('saved', a.out)
