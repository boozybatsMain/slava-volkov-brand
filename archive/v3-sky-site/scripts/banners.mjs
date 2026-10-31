#!/usr/bin/env node
/**
 * Social banners from the live index.html hero (system Chrome, real GPU WebGL), pixel-exact:
 * the page is rendered at width/scale × height/scale CSS px with devicePixelRatio = scale, so the
 * file comes straight from the canvas — no resampling of the deliberately crunchy title.
 * Compositions live in src/banners.config.ts (imported directly: Node strips the types).
 *
 *   npm run banners                                # every banner → banners/
 *
 * The hero needs a DEV server (its debug URL params are ignored in a build): a running
 * `npm run dev -- --port 5180` is reused, otherwise the script starts Vite itself and stops it after.
 *
 * Options:
 *   --base http://localhost:5180   use this dev server as is (nothing is started)
 *   --only youtube,x               subset of banners
 *   --spec file.json               { "<name>": { ...partial BannerSpec } } merged over the config —
 *                                  try a composition without editing the config
 *   --out banners                  output dir (files: <name>-<W>x<H>.png | .jpg, preview/<name>-*.png)
 *   --tag v2                       suffix for every file name (<name>-<tag>-…), to keep variants apart
 *   --avatar reference/avatar.webp the profile picture drawn into the previews
 *   --settle 4000                  ms after the hero is ready, for every spring to reach the pinned pose
 *   --no-preview                   skip the preview images
 *   --print-url                    only print the page URL of each banner (open it with ?tune to fiddle)
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openBrowser } from './shared-browser.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { banners } = await import(path.join(root, 'src/banners.config.ts'))

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true'])
    return acc
  }, []),
)
const DEFAULT_BASE = 'http://localhost:5180'
let base = (args.base ?? DEFAULT_BASE).replace(/\/$/, '')
const outDir = path.resolve(root, args.out ?? 'banners')
const tag = args.tag ? `-${args.tag}` : ''
const settle = Number(args.settle ?? 4000)
const avatarPath = path.resolve(root, args.avatar ?? 'reference/avatar.webp')

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
function merge(a, b) {
  const out = { ...a }
  for (const [k, v] of Object.entries(b ?? {})) out[k] = isObj(v) && isObj(a?.[k]) ? merge(a[k], v) : v
  return out
}
/** Nested overrides → set.a.b.c=value pairs (the hero's ?set. debug params). */
function flatten(obj, prefix = 'set', out = []) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (isObj(v)) flatten(v, `${prefix}.${k}`, out)
    else out.push([`${prefix}.${k}`, String(v)])
  }
  return out
}

const extra = args.spec ? JSON.parse(fs.readFileSync(path.resolve(args.spec), 'utf8')) : {}
let specs = Object.fromEntries(Object.entries(banners).map(([n, s]) => [n, merge(s, extra[n])]))
if (args.only) specs = Object.fromEntries(args.only.split(',').map((n) => [n, specs[n]]).filter(([, s]) => s))

function urlFor(spec) {
  const q = new URLSearchParams()
  // no nav ever; the tagline lives on the same overlay layer → keep the layer and hide the nav
  q.set('layers', spec.tagline ? 'sky,title,skyFront,overlay' : 'sky,title,skyFront')
  q.set('freeze', String(spec.time))
  q.set('pointer', `${spec.pointer.x},${spec.pointer.y}`)
  const sets = flatten(spec.overrides)
  if (spec.tagline) sets.push(['set.overlay.nav.opacity', '0'], ['set.overlay.nav.line.opacity', '0'])
  for (const [k, v] of sets) q.set(k, v)
  return `${base}/?${q}`
}

if (args['print-url']) {
  for (const [name, spec] of Object.entries(specs)) console.log(`${name}: ${urlFor(spec)}`)
  process.exit(0)
}

/**
 * Encode with Pillow (python3, run from the temp dir: nothing local on sys.path):
 *   png — optimized truecolor; jpg — the best quality (4:4:4 from q85 up) that fits maxBytes.
 */
const PY = `
import sys, io
from PIL import Image
src, dst, fmt, cap = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
im = Image.open(src).convert('RGB')
if fmt == 'png':
    im.save(dst, 'PNG', optimize=True)
    print('png')
else:
    for q in range(97, 59, -1):
        buf = io.BytesIO()
        im.save(buf, 'JPEG', quality=q, subsampling=0 if q >= 85 else 2, optimize=True)
        if buf.tell() <= cap:
            break
    open(dst, 'wb').write(buf.getvalue())
    print(f'jpg q{q}')
`
const encode = (src, dst, fmt, cap) =>
  execFileSync('python3', ['-c', PY, src, dst, fmt, String(cap)], { cwd: os.tmpdir() }).toString().trim()

/** Is this project's hero served at `url`? (5173/5174 often run other projects' dev servers.) */
async function servesHero(url) {
  try {
    const res = await fetch(`${url}/`, { signal: AbortSignal.timeout(2000) })
    return res.ok && (await res.text()).includes('/src/sky.ts')
  } catch {
    return false
  }
}

let vite = null
if (!args.base && !(await servesHero(base))) {
  const { createServer } = await import('vite')
  vite = await createServer({ root, logLevel: 'warn', server: { port: 5180, strictPort: false } })
  await vite.listen()
  base = vite.resolvedUrls.local[0].replace(/\/$/, '')
  console.log(`started a dev server at ${base}`)
} else if (!(await servesHero(base))) {
  throw new Error(`no hero dev server at ${base}`)
}

fs.mkdirSync(path.join(outDir, 'preview'), { recursive: true })
// one shared Chrome for all runs (same channel and GPU flags); SHARED_BROWSER=0 gives a private one
const browser = await openBrowser()

const results = []
for (const [name, spec] of Object.entries(specs)) {
  const { width: W, height: H, scale } = spec
  const vw = W / scale
  const vh = H / scale
  if (!Number.isInteger(vw) || !Number.isInteger(vh)) throw new Error(`${name}: ${W}×${H} / scale ${scale} is not whole CSS px`)
  const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: scale })
  const logs = []
  // a banner may switch a layer off (opacity 0 → never fetched), so index.html's preload of it goes unused
  const expected = (m) => m.type() === 'debug' || m.text().includes('was preloaded using link preload but not used')
  page.on('console', (m) => !expected(m) && logs.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  await page.goto(urlFor(spec), { waitUntil: 'load' })
  await page
    .waitForFunction(() => document.documentElement.dataset.heroReady === '1', null, { timeout: 30000 })
    .catch(() => logs.push('[banners] hero never reported ready — capturing anyway'))
  await page.waitForTimeout(settle)
  const stem = `${name}${tag}-${W}x${H}`
  const raw = path.join(outDir, `${stem}.raw.png`)
  await page.screenshot({ path: raw, type: 'png' })
  await page.close()

  const files = []
  for (const fmt of spec.export.formats) {
    const file = path.join(outDir, `${stem}.${fmt}`)
    const how = encode(raw, file, fmt, spec.export.maxBytes)
    const size = fs.statSync(file).size
    const over = size > spec.export.maxBytes ? `  ⚠ over the ${Math.round(spec.export.maxBytes / 1024)} KB cap` : ''
    console.log(`${name}: ${path.relative(root, file)}  ${how}, ${Math.round(size / 1024)} KB${over}`)
    files.push(file)
  }
  // the previews read the full-colour frame
  const frame = path.join(outDir, 'preview', `${stem}.frame.png`)
  fs.renameSync(raw, frame)
  if (logs.length) console.log(logs.map((l) => `  ${l}`).join('\n'))
  results.push({ name, spec, files, frame, stem })
}

/**
 * Previews (banners/preview):
 *   *-display — as the platform shows it: display.width CSS px at display.dpr, cropped to
 *               display.crop, the first avatar on top (the browser downsizes like the platform does);
 *   *-guides  — the whole canvas with every crop / safe zone / avatar spot outlined.
 */
if (args['no-preview'] !== 'true') {
  const avatar = fs.existsSync(avatarPath)
    ? `data:image/${path.extname(avatarPath).slice(1)};base64,${fs.readFileSync(avatarPath).toString('base64')}`
    : ''
  for (const { name, spec, frame, stem } of results) {
    const img = `data:image/png;base64,${fs.readFileSync(frame).toString('base64')}`
    const box = (x, y, w, h, k, css) =>
      `<div style="position:absolute;left:${x * k}px;top:${y * k}px;width:${w * k}px;height:${h * k}px;box-sizing:border-box;${css}">`

    // display
    const crop = spec.display.crop ?? { x: 0, y: 0, w: spec.width, h: spec.height }
    const k = spec.display.width / crop.w
    const av = spec.guides.find((g) => g.kind === 'avatar')
    const below = av ? Math.max(0, av.cy + av.r - (crop.y + crop.h)) * k + 12 : 0
    const ring = Math.max(2, Math.round(4 * (spec.display.width / 600)))
    const avatarHtml = av
      ? `${box(av.cx - av.r - crop.x, av.cy - av.r - crop.y, 2 * av.r, 2 * av.r, k, `border-radius:50%;border:${ring}px solid #000;background:${avatar ? `url(${avatar}) center/cover` : '#888'}`)}</div>`
      : ''
    let page = await browser.newPage({
      viewport: { width: spec.display.width, height: Math.round(crop.h * k + below) },
      deviceScaleFactor: spec.display.dpr,
    })
    await page.setContent(
      `<body style="margin:0;background:#000;overflow:hidden"><div style="position:relative;width:${crop.w * k}px;height:${crop.h * k}px;overflow:visible;background:url(${img}) ${-crop.x * k}px ${-crop.y * k}px/${spec.width * k}px ${spec.height * k}px no-repeat">${avatarHtml}</div></body>`,
    )
    await page.waitForTimeout(100)
    let out = path.join(outDir, 'preview', `${stem}-display.png`)
    await page.screenshot({ path: out })
    await page.close()
    console.log(`${name}: ${path.relative(root, out)}`)

    // guides
    const show = Math.min(1600, spec.width)
    const g1 = show / spec.width
    const shapes = spec.guides
      .map((g) => {
        if (g.kind === 'avatar') {
          return `${box(g.cx - g.r, g.cy - g.r, 2 * g.r, 2 * g.r, g1, 'border-radius:50%;border:2px dashed #ffd400')}<span style="position:absolute;left:50%;top:30%;transform:translateX(-50%);font:12px monospace;color:#ffd400;background:#000a;padding:0 3px">avatar ${g.label}</span></div>`
        }
        const color = g.kind === 'safe' ? '#00ff88' : '#ff3bd4'
        return `${box(g.x, g.y, g.w, g.h, g1, `border:2px ${g.kind === 'safe' ? 'solid' : 'dashed'} ${color}`)}<span style="position:absolute;left:4px;top:2px;font:12px/1.2 monospace;color:${color};background:#000a;padding:0 3px">${g.label}</span></div>`
      })
      .join('')
    const gBelow = Math.max(0, ...spec.guides.filter((g) => g.kind === 'avatar').map((g) => g.cy + g.r - spec.height))
    page = await browser.newPage({ viewport: { width: show, height: Math.round((spec.height + gBelow) * g1) + 8 }, deviceScaleFactor: 1 })
    await page.setContent(
      `<body style="margin:0;background:#000;overflow:hidden"><div style="position:relative;width:${show}px;height:${spec.height * g1}px;background:url(${img}) 0 0/100% 100%">${shapes}</div></body>`,
    )
    await page.waitForTimeout(100)
    out = path.join(outDir, 'preview', `${stem}-guides.png`)
    await page.screenshot({ path: out })
    await page.close()
    fs.rmSync(frame)
    console.log(`${name}: ${path.relative(root, out)}`)
  }
}

await browser.close()
await vite?.close()
