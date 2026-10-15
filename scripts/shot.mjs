#!/usr/bin/env node
/**
 * Headless screenshots of the hero (system Chrome, real GPU WebGL).
 *
 *   node scripts/shot.mjs --url http://localhost:5173/ --out shots/a.png
 *
 * Options:
 *   --url <url>          page to open (query params like ?pointer=0.5,-0.2&set.title.rotation=2 pass through)
 *   --out <file.png>     output path (directories are created)
 *   --w 1440 --h 900     viewport CSS size            --dpr 2   device pixel ratio
 *   --wait 600           extra ms after the page reports ready
 *   --clip x,y,w,h       crop region in CSS px
 *   --mouse "x,y;x,y"    real mouse path in normalized coords (-1…1). Moves through each
 *                        point (smoothly, --moveMs per segment). One screenshot after the last
 *                        point + --settle ms, unless --frames is given.
 *   --moveMs 500         duration of each mouse segment
 *   --settle 1500        ms to wait after the mouse path / the --do actions before the final shot
 *   --frames 8           capture N frames *during* the last mouse segment, every --every ms,
 *                        and tile them into one contact sheet (--out). Good for judging motion.
 *                        With --do the frames are sampled from the LAST action instead; with neither,
 *                        from now. Each cell is labelled: index, ms since the start, scroll pos.
 *                        Cells (here and in --scrub) are captured at device resolution (--dpr) and
 *                        shown 1:1 when the sheet fits 1800 px across (cols × w × dpr; e.g. --cols 1,
 *                        or a --clip), scaled down to fit otherwise.
 *   --every 60
 *   --cols 4             contact sheet columns
 *
 * Version 2 (index.html — the page scrolls between screens). The script also waits (≤ 5 s, silently)
 * for the later screens' layers: html[data-hero-full].
 *   --scrub "0,0.1,…,3"  one load, then for each value: pin the scroll position there
 *                        (__hero.scroll.pin(v), in stops: 0 hero, 1 projects, 2 about, 3 the end of the
 *                        about tour; fractions in between), wait --scrubWait ms, shoot. The shots are
 *                        tiled into one contact sheet (--out), each cell labelled with its value.
 *                        --eval / --stats are printed for every step.
 *   --scrubTarget switch pin the project switch instead (__hero.projects.pin(v), v = 0…1 of the show);
 *                        default: scroll
 *   --scrubWait 450      ms between the pin and the shot
 *   --do "a;b;…"         real input, in order (after --mouse, if both are given):
 *                          wheel:600        mouse wheel, px (negative = up)
 *                          wait:400         pause, ms
 *                          key:ArrowRight   key press (Playwright key names; Shift+Tab works)
 *                          click:<selector> real click in the middle of the first match (no ';' in the selector)
 *                          swipe:x0,y0,x1,y1   one-finger touch drag, CSS px (turns touch on; ≈ 250 ms)
 *                          move:x,y         mouse to normalized coords (-1…1)
 *                          back / forward   browser history
 *                          eval:<js>        run a JS expression in the page (no ';' in it)
 *                        Then one screenshot after --settle ms — or, with --frames, a contact sheet
 *                        sampled while the LAST action plays.
 *   --eval "<js>"        JS expression evaluated in the page right before the shot (a Promise is
 *                        awaited); its value is printed as JSON: [eval] …
 *   --stats <layer>      print __hero.layers.get(<layer>).stats() as JSON right before the shot: [stats] …
 *   --reduced            emulate prefers-reduced-motion: reduce
 *   --mobile             emulate a touch device (touch events, mobile viewport)
 *   --perf 2500          measure requestAnimationFrame intervals for that many ms, starting right
 *                        before the --do actions; with --mouse the path is replayed back and forth
 *                        for the whole window instead of once. Prints [perf] {"frames","p50","p95","max"} (ms).
 *                        Screenshots stall the page: do not combine with --frames.
 */
import { openBrowser } from './shared-browser.mjs'
import fs from 'node:fs'
import path from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true'])
    return acc
  }, []),
)

const url = args.url ?? 'http://localhost:5173/'
const out = args.out ?? 'shots/shot.png'
const W = Number(args.w ?? 1440)
const H = Number(args.h ?? 900)
const dpr = Number(args.dpr ?? 2)
const wait = Number(args.wait ?? 600)
const moveMs = Number(args.moveMs ?? 500)
const settle = Number(args.settle ?? 1500)
const frames = Number(args.frames ?? 0)
const every = Number(args.every ?? 60)
const cols = Number(args.cols ?? 4)
const clip = args.clip ? (([x, y, w, h]) => ({ x, y, width: w, height: h }))(args.clip.split(',').map(Number)) : undefined
const scrub = args.scrub ? args.scrub.split(',').map(Number).filter(Number.isFinite) : null
const scrubTarget = args.scrubTarget === 'switch' ? 'switch' : 'scroll'
const scrubWait = Number(args.scrubWait ?? 450)
const perf = Number(args.perf ?? 0)
/** --do: [kind, argument] pairs; the argument is everything after the first ':' */
const actions = (args.do ?? '')
  .split(';')
  .map((a) => a.trim())
  .filter(Boolean)
  .map((a) => (a.includes(':') ? [a.slice(0, a.indexOf(':')), a.slice(a.indexOf(':') + 1)] : [a, '']))
const touch = args.mobile === 'true' || actions.some(([kind]) => kind === 'swipe')

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })

// one shared Chrome for all runs; --perf measures frame timing, so it gets a browser of its own
const browser = await openBrowser({ private: perf > 0 })
const context = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: dpr,
  ...(touch ? { hasTouch: true } : {}),
  ...(args.mobile === 'true' ? { isMobile: true } : {}),
  ...(args.reduced === 'true' ? { reducedMotion: 'reduce' } : {}),
})
const page = await context.newPage()
const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

await page.goto(url, { waitUntil: 'load' })
await page.waitForFunction(() => document.documentElement.dataset.heroReady === '1', null, { timeout: 30000 }).catch(() => {
  logs.push('[shot] hero never reported ready (data-hero-ready) — capturing anyway')
})
// a page that scrolls between screens: its later screens mount after the hero
await page
  .waitForFunction(() => !document.querySelector('.scroll-track') || document.documentElement.dataset.heroFull === '1', null, { timeout: 5000 })
  .catch(() => {})
await page.waitForTimeout(wait)

const toPx = ([nx, ny]) => [((nx + 1) / 2) * W, ((ny + 1) / 2) * H]
const path_ = args.mouse ? args.mouse.split(';').map((p) => toPx(p.split(',').map(Number))) : []

let cur = [W / 2, H / 2]
/** the real mouse has been put somewhere on the page */
let placed = false
const place = async () => {
  if (!placed) await page.mouse.move(cur[0], cur[1])
  placed = true
}
if (path_.length) await place()

/** [{ png, label }] — cells of the contact sheet */
const shots = []
const t0 = () => Date.now()

/** --eval / --stats, printed with a tag saying when */
async function report(tag) {
  if (args.eval) {
    const v = await page.evaluate(args.eval).catch((e) => `error: ${e.message}`)
    console.log(`[eval${tag}] ${JSON.stringify(v)}`)
  }
  if (args.stats) {
    const v = await page.evaluate((name) => window.__hero?.layers.get(name)?.stats?.() ?? null, args.stats).catch((e) => `error: ${e.message}`)
    console.log(`[stats${tag}] ${JSON.stringify(v)}`)
  }
}

/**
 * The viewport as it is on screen right now, at DEVICE resolution (--dpr: W × dpr by H × dpr px)
 * — contact-sheet cells; --clip is applied when the sheet is tiled. Not page.screenshot(): that one
 * reads the scroll offset first and captures a document rectangle after — when the page jumps
 * between the two (the scroll settle does exactly that), the rectangle is off screen and a fixed
 * stage comes out blank. Page.captureScreenshot without a clip returns CSS px (a 390×844 @3 page →
 * 390×844: the stipples and dithers alias into moiré); with one it renders at its `scale` — so the
 * clip is the visual viewport itself, read in the same breath (at x 0, y 0 a page scrolled by real
 * input came out as a blank frame of the page's colour).
 * The document may still move between reading the viewport and the capture (a frame of --frames
 * taken while a wheel or a glide plays: the first one came out half blank), so the viewport is read
 * again after the capture, and a frame whose offset changed in between is taken again — up to
 * CAPTURE_TRIES times; while the document keeps moving (a glide) the try that moved least is kept.
 * captureBeyondViewport: false — with a scaled clip Chrome otherwise re-lays the page out for the
 * capture at devicePixelRatio 1 and back: the hero's ResizeObserver fires on every shot (a resize
 * of every layer, canvases re-made, the nav re-placed), so a film of shots 50 ms apart was a film of
 * resizes. The picture itself is the same either way (≤ 2 levels, measured at 1440×900 @2).
 */
const cdp = await context.newCDPSession(page)
const CAPTURE_TRIES = 4
/** `box` — a part of the viewport, CSS px (the final single shot with --clip); the whole viewport by default */
const capture = async (box = { x: 0, y: 0, width: W, height: H }) => {
  let best = null
  let bestDrift = Infinity
  for (let i = 0; i < CAPTURE_TRIES; i++) {
    const vp = (await cdp.send('Page.getLayoutMetrics')).cssVisualViewport
    const clip = { x: vp.pageX + box.x, y: vp.pageY + box.y, width: box.width, height: box.height, scale: dpr }
    const png = Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false })).data, 'base64')
    const after = (await cdp.send('Page.getLayoutMetrics')).cssVisualViewport
    const drift = Math.max(Math.abs(after.pageX - vp.pageX), Math.abs(after.pageY - vp.pageY))
    if (drift < bestDrift) {
      best = png
      bestDrift = drift
    }
    if (drift < 0.5) break
  }
  return best
}

/** One frame of a motion sheet: the picture, then where the scroll is. */
async function frame(start) {
  const ms = Date.now() - start
  const png = await capture()
  // read after the capture: a retried one (capture()) shows a later moment than the first try
  const pos = await page.evaluate(() => window.__hero?.scroll?.state.pos ?? null).catch(() => null)
  shots.push({ png, label: `${shots.length} +${ms}ms${pos === null ? '' : ` pos ${pos.toFixed(3)}`}` })
}

/** Capture `frames` frames, one every `every` ms; `tickFn` (the mouse walking its path) runs in between. */
async function sample(tickFn) {
  const start = t0()
  let nextShot = start
  while (shots.length < frames) {
    const now = Date.now()
    await tickFn?.()
    if (now >= nextShot) {
      await frame(start)
      nextShot = now + every
    } else await page.waitForTimeout(8)
  }
}

async function swipe(x0, y0, x1, y1) {
  const at = (x, y) => [{ x: Math.round(x), y: Math.round(y), id: 1, radiusX: 8, radiusY: 8, force: 1 }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(x0, y0) })
  const steps = 14
  for (let i = 1; i <= steps; i++) {
    await page.waitForTimeout(16)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps) })
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

async function act([kind, arg]) {
  switch (kind) {
    case 'wheel':
      await place()
      await page.mouse.wheel(0, Number(arg))
      break
    case 'wait':
      await page.waitForTimeout(Number(arg))
      break
    case 'key':
      await page.keyboard.press(arg)
      break
    case 'click':
      await page.locator(arg).first().click({ force: true, timeout: 5000 })
      break
    case 'swipe':
      await swipe(...arg.split(',').map(Number))
      break
    case 'move':
      cur = toPx(arg.split(',').map(Number))
      placed = true
      await page.mouse.move(cur[0], cur[1], { steps: 8 })
      break
    case 'back':
      await page.evaluate(() => history.back())
      break
    case 'forward':
      await page.evaluate(() => history.forward())
      break
    case 'eval':
      await page.evaluate(arg)
      break
    default:
      throw new Error(`--do: unknown action "${kind}"`)
  }
}

if (scrub) {
  // one load, the scroll (or the project switch) pinned at each value in turn
  for (const v of scrub) {
    const ok = await page.evaluate(
      ([target, value]) => {
        const hero = window.__hero
        const pin = target === 'switch' ? hero?.projects : hero?.scroll
        pin?.pin(value)
        return !!pin
      },
      [scrubTarget, v],
    )
    if (!ok) logs.push(`[shot] --scrub: no __hero.${scrubTarget === 'switch' ? 'projects' : 'scroll'} on this page (a dev / debug build of index.html is needed)`)
    await page.waitForTimeout(scrubWait)
    await report(` ${scrubTarget} ${v}`)
    shots.push({ png: await capture(), label: `${scrubTarget} ${v}` })
  }
} else {
  if (perf) {
    await page.evaluate(() => {
      const p = (window.__shotPerf = { t: [], on: true })
      const loop = (now) => {
        p.t.push(now)
        if (p.on) requestAnimationFrame(loop)
      }
      requestAnimationFrame(loop)
    })
  }
  const perfStart = t0()

  // --perf replays the mouse path for its whole window (below) instead of walking it once here
  const walk = perf ? [] : path_
  for (let i = 0; i < walk.length; i++) {
    const [x, y] = walk[i]
    const last = i === walk.length - 1
    const steps = Math.max(2, Math.round(moveMs / 16))
    if (last && frames > 0 && !actions.length) {
      // capture frames while moving along the last segment and just after
      let step = 0
      const from = cur
      await sample(async () => {
        if (step < steps) {
          step++
          const k = step / steps
          await page.mouse.move(from[0] + (x - from[0]) * k, from[1] + (y - from[1]) * k)
        }
      })
    } else {
      await page.mouse.move(x, y, { steps })
    }
    cur = [x, y]
  }

  for (let i = 0; i < actions.length; i++) {
    if (i === actions.length - 1 && frames > 0) {
      // sample while the last action plays (it is not awaited first)
      const playing = act(actions[i])
      await sample()
      await playing
    } else await act(actions[i])
  }
  if (frames > 0 && !shots.length) await sample()

  if (perf) {
    if (path_.length) {
      // keep the mouse travelling along the path, back and forth, until the window is over
      await place()
      const loop = [...path_, ...path_.slice(1, -1).reverse()]
      for (let i = 0; Date.now() - perfStart < perf; i++) {
        const [x, y] = loop[i % loop.length]
        const steps = Math.max(2, Math.round(moveMs / 16))
        for (let s = 1; s <= steps && Date.now() - perfStart < perf; s++) {
          await page.mouse.move(cur[0] + ((x - cur[0]) * s) / steps, cur[1] + ((y - cur[1]) * s) / steps)
          await page.waitForTimeout(12)
        }
        cur = [x, y]
      }
    } else await page.waitForTimeout(Math.max(0, perf - (Date.now() - perfStart)))
    const r = await page.evaluate(() => {
      const p = window.__shotPerf
      p.on = false
      const d = p.t.slice(1).map((t, i) => t - p.t[i]).sort((a, b) => a - b)
      const q = (f) => (d.length ? +d[Math.min(d.length - 1, Math.floor(f * d.length))].toFixed(2) : 0)
      return { frames: d.length, p50: q(0.5), p95: q(0.95), max: +(d[d.length - 1] ?? 0).toFixed(2) }
    })
    console.log(`[perf] ${JSON.stringify(r)}`)
  }
}

if (shots.length) {
  // contact sheet: tile frames in a blank page and screenshot it
  const sheet = await browser.newPage({ deviceScaleFactor: 1 })
  const box = clip ?? { x: 0, y: 0, width: W, height: H }
  const fw = box.width * dpr
  const scale = Math.min(1, 1800 / (fw * cols))
  const cell = Math.round(fw * scale)
  // sheet px per CSS px of the page: every cell is the whole viewport, cropped to the clip here
  const k = cell / box.width
  await sheet.setViewportSize({ width: cell * cols, height: 100 })
  await sheet.setContent(
    `<body style="margin:0;background:#111;display:grid;grid-template-columns:repeat(${cols},${cell}px);gap:0">` +
      shots
        .map(
          ({ png, label }) =>
            `<div style="position:relative;overflow:hidden;height:${Math.round(box.height * k)}px">` +
            `<img src="data:image/png;base64,${png.toString('base64')}" style="width:${W * k}px;display:block;margin:${-box.y * k}px 0 0 ${-box.x * k}px">` +
            `<span style="position:absolute;left:4px;top:2px;padding:0 3px;background:rgba(0,0,0,.55);color:#f6f;font:12px monospace">${label}</span></div>`,
        )
        .join('') +
      '</body>',
  )
  await sheet.waitForTimeout(200)
  await sheet.screenshot({ path: out, fullPage: true })
  if (!scrub) await report('')
} else {
  if (path_.length || actions.length) await page.waitForTimeout(settle)
  await report('')
  // the same capture as the sheets' cells (not page.screenshot: with a clip it resizes the page too)
  fs.writeFileSync(out, await capture(clip))
}

await browser.close()
if (logs.length) console.log(logs.join('\n'))
console.log(`saved ${out}`)
