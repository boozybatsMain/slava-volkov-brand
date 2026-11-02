#!/usr/bin/env node
/**
 * The link-preview picture (og:image) public/og.jpg, 1200×630: the night hero with Нетопырь spreading his wings.
 * Shot from the running site, so it follows the real design. Run with the dev server up:
 *   npx vite --port 5192 &   node scripts/og-image.mjs [--url http://localhost:5192/]
 */
import { openBrowser } from './shared-browser.mjs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const i = process.argv.indexOf('--url')
const url = i > 0 ? process.argv[i + 1] : 'http://localhost:5192/'
const png = fileURLToPath(new URL('../public/og.png', import.meta.url))
const jpg = fileURLToPath(new URL('../public/og.jpg', import.meta.url))

const b = await openBrowser()
const ctx = await b.newContext({ viewport: { width: 1200, height: 630 }, colorScheme: 'dark', reducedMotion: 'reduce' })
const p = await ctx.newPage()
await p.goto(url)
await p.waitForFunction(() => document.documentElement.hasAttribute('data-bat-ready'), null, { timeout: 30000 })
// only the name, the line under it and the bat: no header, button or scroll hint
await p.addStyleTag({
  content: '.scroll-hint,.btn--cta{display:none!important} .head{visibility:hidden} .hero__title{font-size:150px} .hero__sub{font-size:28px}',
})
// with reduced motion he hangs under the header; a pointer close by makes him spread the starry wings
const [x, y] = await p.evaluate(() => {
  const m = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/.exec(document.getElementById("bat").style.transform)
  return [+m[1] + 220, +m[2] + 170]
})
await p.mouse.move(x, y + 40)
await p.waitForTimeout(2500)
// then make him big, turn him head up (as if flying at you) and move him into the empty right half:
// the whole bat layer is scaled and turned about his centre; the halo would show the layer's clipped edge, so it goes
const [tx, ty] = [860, 300]
await p.addStyleTag({
  content: `.bat-layer{overflow:visible;transform-origin:${x}px ${y}px;scale:1.9;rotate:180deg;translate:${tx - x}px ${ty - y}px} .bat-halo{display:none}`,
})
await p.waitForTimeout(800)
await p.screenshot({ path: png })
await b.close()
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', png, '-q:v', '3', jpg])
execFileSync('rm', [png])
console.log('wrote', jpg)
