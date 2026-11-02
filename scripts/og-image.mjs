#!/usr/bin/env node
/**
 * The link-preview picture (og:image) public/og.jpg, 1200×630.
 *
 *   node scripts/og-image.mjs          (no dev server needed)
 *
 * Нетопырь is rendered by his own 3D viewer (brand/mascot/netopyr.html, opened from disk; three.js is
 * served from node_modules instead of the CDN), on the viewer's dusk sky, gliding diagonally across the
 * frame seen from below: wings from lower left to upper right, head left, cold eyes leaving their trails.
 * The name goes on top in the site's font. Slava's reference for the pose: the bat over the sunset sky
 * in the brand pictures. The dark wings have to read against a light sky, so no night background here.
 */
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { openBrowser } from './shared-browser.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const png = resolve(ROOT, 'public/og.png')
const jpg = process.env.OG_OUT || resolve(ROOT, 'public/og.jpg')

// the shot: camera azimuth and elevation (deg, negative = from below), distance, roll of the bat about the
// line of sight (deg), where his centre sits on the picture, the moment of the glide clip, and which way he
// glides on the picture (deg below straight left)
const SHOT = { az: -35, el: -55, dist: 380, roll: 25, cx: 770, cy: 325, t: 1.2, dir: 30, ...JSON.parse(process.env.OG_SHOT || '{}') }
// how fast he crosses the picture (world units per second): only so that the eye trails stretch out
const SPEED = 400

const b = await openBrowser()
const ctx = await b.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 })
await ctx.addInitScript(() => {
  localStorage.setItem('bat-viewer-bg', 'sky')
  localStorage.setItem('bat-viewer-clip', 'glide')
})
await ctx.route(/cdn\.jsdelivr\.net\/npm\/three@0\.170\.0\/(.*)$/, (r) =>
  r.fulfill({ path: resolve(ROOT, 'node_modules/three', /three@0\.170\.0\/(.*)$/.exec(r.request().url())[1]), contentType: 'text/javascript' }),
)
const p = await ctx.newPage()
p.on('pageerror', (e) => console.error('page error:', e.message))
await p.goto(pathToFileURL(resolve(ROOT, 'brand/mascot/netopyr.html')).href)
await p.waitForFunction(() => window.__viewer, null, { timeout: 30000 })
const font = pathToFileURL(resolve(ROOT, 'node_modules/@fontsource-variable/inter-tight/files/inter-tight-latin-wght-normal.woff2')).href
await p.addStyleTag({
  content: `
  @font-face { font-family: 'OG Inter Tight'; src: url(${font}) format('woff2'); font-weight: 100 900 }
  body>*:not(#app):not(.og), #app>*:not(canvas) { visibility: hidden !important }
  .og { position: fixed; left: 64px; top: 70px; z-index: 9; color: #fff7ec; font-family: 'OG Inter Tight', sans-serif;
        text-shadow: 0 2px 30px rgba(12, 24, 70, .45), 0 1px 3px rgba(12, 24, 70, .35); pointer-events: none }
  .og h1 { margin: 0; font-size: 120px; font-weight: 800; line-height: .88; letter-spacing: -.045em }
  .og p { margin: 26px 0 0 4px; font-size: 28px; font-weight: 500; letter-spacing: -.01em; opacity: .95 }`,
})
await p.evaluate(() => {
  const d = document.createElement('div')
  d.className = 'og'
  d.innerHTML = '<h1>Slava<br>Volkov</h1><p>Independent game developer</p>'
  document.body.append(d)
})
await p.evaluate(() => document.fonts.ready)
await p.waitForTimeout(1000)

await p.evaluate(({ S, SPEED }) => {
  const v = window.__viewer, c = v.cam, D = Math.PI / 180, TAU = 2 * Math.PI
  // camera: fixed on the bat, the bat's centre moved to (cx, cy) of the picture
  c.clearViewOffset()
  c.setViewOffset(1200, 630, 600 - S.cx, 315 - S.cy, 1200, 630)
  v.ctl.target.set(0, 0, 0)
  c.position.setFromSphericalCoords(S.dist, Math.PI / 2 - S.el * D, S.az * D)
  c.lookAt(0, 0, 0)
  v.ctl.update()
  // the bat: the glide clip, turned about the line of sight, and carried across the picture so that he is
  // at the centre exactly at the moment of the shot (the eye trails are what he leaves behind)
  const qm = (a, b) => [a[0]*b[0]-a[1]*b[1]-a[2]*b[2]-a[3]*b[3], a[0]*b[1]+a[1]*b[0]+a[2]*b[3]-a[3]*b[2], a[0]*b[2]-a[1]*b[3]+a[2]*b[0]+a[3]*b[1], a[0]*b[3]+a[1]*b[2]-a[2]*b[1]+a[3]*b[0]]
  const n = c.position.clone().normalize(), a = S.roll * D, s = Math.sin(a / 2)
  const R = [Math.cos(a / 2), n.x * s, n.y * s, n.z * s]
  c.updateMatrixWorld()
  const right = new c.position.constructor().setFromMatrixColumn(c.matrixWorld, 0), up = new c.position.constructor().setFromMatrixColumn(c.matrixWorld, 1)
  const M = right.clone().multiplyScalar(-Math.cos(S.dir * D)).addScaledVector(up, -Math.sin(S.dir * D)), P = up.clone().multiplyScalar(Math.cos(S.dir * D)).addScaledVector(right, -Math.sin(S.dir * D))
  const clip = v.CLIPS.find((k) => k.id === 'glide'), fn = clip.fn
  clip.fn = (t, b) => {
    fn(t, b)
    b.q = qm(R, b.q)
    // he glides toward the lower left of the picture (with a little weave), so his eye trails stream
    // out behind him to the upper right, over the far wing, and not across his own body
    const u = (t - S.t) * SPEED, wv = 5 * Math.sin(TAU * 3 * t)
    const fx = M.x, fy = M.y, fz = M.z, px = P.x, py = P.y, pz = P.z
    b.x += fx * u + px * wv; b.y -= fy * u + py * wv; b.z += fz * u + pz * wv
  }
  v.setSpeed(1)
  v.T = S.t - 0.35
  v.setPlaying(true)
}, { S: SHOT, SPEED })
// let him fly the last 0.35 s into place, then stop on the moment
for (let i = 0; i < 40 && (await p.evaluate(() => window.__viewer.T)) < SHOT.t; i++) await p.waitForTimeout(250)
await p.evaluate(() => window.__viewer.setPlaying(false))
await p.waitForTimeout(150)
await p.screenshot({ path: png })
await b.close()
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', png, '-vf', 'scale=1200:630:flags=lanczos', '-q:v', '3', jpg])
execFileSync('rm', [png])
console.log('wrote', jpg)
