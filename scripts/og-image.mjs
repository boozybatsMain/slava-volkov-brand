#!/usr/bin/env node
/**
 * The link-preview picture (og:image) public/og.jpg, 1200×630.
 *
 *   node scripts/og-image.mjs          (starts its own dev server on port 5193 for the background)
 *
 * Two shots put together:
 *  1. the background is the site's own night hero (stars, the name and the line under it), shot from the
 *     running site with the little site bat hidden;
 *  2. Нетопырь is rendered by his own 3D viewer (brand/mascot/netopyr.html, opened from disk; three.js is
 *     served from node_modules instead of the CDN), big, in a diagonal glide seen from below: wings from
 *     lower left to upper right, head left, cold eyes leaving their trails. Slava's reference for the pose:
 *     the bat over the sunset sky in the brand pictures (the pose only: the background stays the site's).
 *     He is rendered twice, on black and on white, which gives him with his exact transparency.
 * On the night sky his dark wings would vanish, so he gets a cold rim light and a soft glow around the
 * silhouette, and the wings are lifted a little (GLOW below).
 */
import { execFileSync, spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { openBrowser } from './shared-browser.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const TMP = resolve(ROOT, 'public/.og-tmp')
const jpg = process.env.OG_OUT || resolve(ROOT, 'public/og.jpg')
const W = 1200, H = 630, DPR = 2

// the shot: camera azimuth and elevation (deg, negative = from below), distance, roll of the bat about the
// line of sight (deg), where his centre sits on the picture, the moment of the glide clip, and which way he
// glides on the picture (deg below straight left)
const SHOT = { az: -35, el: -55, dist: 470, roll: 25, cx: 950, cy: 250, t: 1.2, dir: 30, ...JSON.parse(process.env.OG_SHOT || '{}') }
// how fast he crosses the picture (world units per second): only so that the eye trails stretch out
const SPEED = 400
// the light around him on the night sky: colour, the tight rim and the wide glow (blur px, strength),
// how much the bat himself is lifted (1 = as rendered) and the cold base added to him, so the near-black
// membranes read as night blue against the darker sky; a0 is explained at the matte
const GLOW = { color: '150, 190, 255', rim: [2.5, 1], wide: [14, 0.5], lift: 2, fill: [26, 38, 70], a0: 0.1, ...JSON.parse(process.env.OG_GLOW || '{}') }

execFileSync('mkdir', ['-p', TMP])
const b = await openBrowser()

/* ---------- 1. the background: the site's night hero without the site bat ---------- */
const PORT = 5193
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' })
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break } catch {}
    if (i > 60) throw new Error('dev server did not start')
    await new Promise((r) => setTimeout(r, 500))
  }
  const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR, colorScheme: 'dark', reducedMotion: 'reduce' })
  const p = await ctx.newPage()
  await p.goto(`http://localhost:${PORT}/`)
  await p.waitForFunction(() => document.documentElement.hasAttribute('data-bat-ready'), null, { timeout: 30000 })
  // only the name and the line under it: no header, button, scroll hint or the small site bat
  await p.addStyleTag({
    content: '.scroll-hint,.btn--cta,.bat-layer{display:none!important} .head{visibility:hidden} .hero__title{font-size:150px} .hero__sub{font-size:28px}',
  })
  await p.evaluate(() => document.fonts.ready)
  await p.waitForTimeout(500)
  await p.screenshot({ path: `${TMP}/bg.png` })
  await ctx.close()
} finally {
  vite.kill()
}

/* ---------- 2. the bat, on black and on white ---------- */
{
  const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR })
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
  await p.addStyleTag({ content: 'body>*:not(#app), #app>*:not(canvas) { visibility: hidden !important }' })
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

  // let him fly the last 0.35 s into place, then stop on the moment (the paused viewer keeps redrawing it)
  for (let i = 0; i < 40 && (await p.evaluate(() => window.__viewer.T)) < SHOT.t; i++) await p.waitForTimeout(250)
  await p.evaluate(() => window.__viewer.setPlaying(false))
  for (const [name, col] of [['black', 0x000000], ['white', 0xffffff]]) {
    await p.evaluate((col) => {
      // a plain background instead of the viewer's sky (THREE.Color taken from one of the scene's lights)
      const scene = window.__viewer.view.g.parent
      let Color = null
      scene.traverse((o) => { if (!Color && o.isLight) Color = o.color.constructor })
      scene.background = new Color(col)
    }, col)
    await p.waitForTimeout(300)
    await p.screenshot({ path: `${TMP}/${name}.png` })
  }
  await ctx.close()
}

/* ---------- 3. put together: matte from the two shots, glow, bat over the background ---------- */
{
  const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  const p = await ctx.newPage()
  const url = (f) => 'data:image/png;base64,' + readFileSync(`${TMP}/${f}.png`).toString('base64')
  await p.setContent('<canvas id="c"></canvas>')
  const out = await p.evaluate(async ({ bg, black, white, G, w, h }) => {
    const load = (s) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = s })
    const [iBg, iB, iW] = await Promise.all([load(bg), load(black), load(white)])
    const cv = (fill) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); if (fill) x.drawImage(fill, 0, 0, w, h); return [c, x] }
    const [, xB] = cv(iB), [, xW] = cv(iW)
    const B = xB.getImageData(0, 0, w, h), Wd = xW.getImageData(0, 0, w, h).data, d = B.data
    // on black a pixel is a·c, on white a·c + (1 − a); so a = 1 − (white − black), c = black / a
    const [bat, xBat] = cv(), out = xBat.createImageData(w, h), o = out.data
    for (let i = 0; i < d.length; i += 4) {
      // (the viewer's post-processing leaves a faint even veil on both shots: below a0 counts as empty sky)
      const a0 = 1 - ((Wd[i] - d[i]) + (Wd[i + 1] - d[i + 1]) + (Wd[i + 2] - d[i + 2])) / 765
      const a = Math.min(1, Math.max(0, (a0 - G.a0) / (1 - G.a0)))
      const c = [0, 1, 2].map((k) => (a > 0.004 ? (Math.max(0, d[i + k] - G.a0 * 255) / a) * G.lift : 0)), dark = 1 - Math.max(...c) / 255
      for (let k = 0; k < 3; k++) o[i + k] = Math.min(255, c[k] + G.fill[k] * Math.max(0, dark)) // the base only where he is dark: the membranes, not the fur
      o[i + 3] = a * 255
    }
    xBat.putImageData(out, 0, 0)
    // the silhouette in the glow colour, blurred: a tight rim and a wide soft glow
    const [sil, xSil] = cv(bat)
    xSil.globalCompositeOperation = 'source-in'; xSil.fillStyle = `rgb(${G.color})`; xSil.fillRect(0, 0, w, h)
    const [res, x] = cv(iBg)
    for (const [r, k] of [G.wide, G.rim]) { x.save(); x.filter = `blur(${r}px)`; x.globalAlpha = k; x.drawImage(sil, 0, 0); x.restore() }
    x.drawImage(bat, 0, 0)
    return res.toDataURL('image/png')
  }, { bg: url('bg'), black: url('black'), white: url('white'), G: GLOW, w: W * DPR, h: H * DPR })
  await ctx.close()
  const png = `${TMP}/og.png`
  writeFileSync(png, Buffer.from(out.split(',')[1], 'base64'))
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', png, '-vf', `scale=${W}:${H}:flags=lanczos`, '-q:v', '3', jpg])
}
await b.close()
rmSync(TMP, { recursive: true, force: true })
console.log('wrote', jpg)
