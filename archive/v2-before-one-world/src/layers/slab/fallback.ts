import { projects } from '../../core/projects'
import type { Pt } from '../../core/quad'
import { slabPose } from '../../core/slab-pose'
import type { Frame, Layer, LayerContext } from '../../core/types'
import { coverCrop, createSlabPictures } from './pictures'
import { BAYER, createSlabShadow, shadowBlob } from './shadow'
import { createArrival, type ArrivalLook } from './show'
import { createSlabSolver, publishPose, slabKnobs, slabPixelSize, type SlabKnobs, type SlabSolution } from './solve'

/**
 * SLAB — fallback without WebGL (no three.js in here).
 *
 * Used when there is no WebGL, when the box shader fails to link, or with `?nogl=slab`. The same
 * solver gives the same live pose (turn toward the cursor, float, arrival travel) and publishes the
 * same slabPose, so the project texts sit exactly where they would.
 *
 * The slab is rasterised on the CPU, straight onto its own pixel lattice — one 2D canvas of the
 * same buffer and CSS size as the WebGL one, magnified with `image-rendering: pixelated` and never
 * transformed (a CSS transform would resample it with smoothing: the compositor has no "nearest").
 * So the rules of the «bad render» hold here too: a lattice pixel is the slab or it is not (its
 * centre decides), the picture is point-sampled, the arrival is the same ordered stipple.
 *   · the face — the current picture, cover-cropped around its focus, through the inverse of the
 *     face's projection; untextured (arrive.blank) and then in coarse blocks while it "loads";
 *   · the side faces that look at the camera — flat colours;
 *   · the shadow — the very same canvas of dots as under the WebGL slab (./shadow.ts).
 * Left out: the glitch pass, the aberration, colour depth and dither, sheen, haze, the switch show —
 * the picture cuts when the texts swap (projects.state.index).
 */

/** Unit-box corners of the four side faces (solve.ts), wound so that a face looking at the camera is clockwise on screen. */
const SIDES: { name: 'side' | 'bottom'; at: [number, number, number][] }[] = [
  { name: 'side', at: [[-0.5, -0.5, -1], [-0.5, -0.5, 0], [-0.5, 0.5, 0], [-0.5, 0.5, -1]] }, // left
  { name: 'side', at: [[0.5, -0.5, 0], [0.5, -0.5, -1], [0.5, 0.5, -1], [0.5, 0.5, 0]] }, // right
  { name: 'bottom', at: [[-0.5, -0.5, -1], [0.5, -0.5, -1], [0.5, -0.5, 0], [-0.5, -0.5, 0]] }, // top
  { name: 'bottom', at: [[-0.5, 0.5, 0], [0.5, 0.5, 0], [0.5, 0.5, -1], [-0.5, 0.5, -1]] }, // bottom
]

/** Twice the signed area of a screen quad: > 0 — clockwise (y down). */
const winding = (q: Pt[]) => q.reduce((s, p, i) => s + p.x * q[(i + 1) % q.length].y - q[(i + 1) % q.length].x * p.y, 0)

/**
 * The side faces are grown by this much, lattice px, and painted under the face: a pixel whose centre
 * sits exactly on the edge they share must not fall between the two tests.
 */
const OVERLAP = 0.02

/**
 * The four edges of a clockwise screen quad as distance functions, 3 numbers each: the distance of
 * (x, y) to edge k, positive inside, is e[3k]·x + e[3k + 1]·y + e[3k + 2].
 */
function edgesOf(q: Pt[]) {
  const e: number[] = []
  for (let k = 0; k < 4; k++) {
    const a = q[k]
    const b = q[(k + 1) % 4]
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
    const nx = -(b.y - a.y) / len
    const ny = (b.x - a.x) / len
    e.push(nx, ny, -(nx * a.x + ny * a.y))
  }
  return e
}

/**
 * Row `y` of a clockwise quad (its edges from edgesOf), each edge moved inward by `inset`: the lattice
 * pixels whose CENTRES lie inside, as into[0] ≤ x < into[1], within 0…w (empty: into[1] ≤ into[0]).
 */
function span(e: number[], y: number, inset: number, w: number, into: number[]) {
  const cy = y + 0.5
  let lo = 0
  let hi = w
  for (let k = 0; k < 12; k += 3) {
    // distance to the edge along this row: e[k]·x + c ≥ inset
    const c = e[k + 1] * cy + e[k + 2] - inset
    if (e[k] > 1e-9) lo = Math.max(lo, Math.ceil(-c / e[k] - 0.5))
    else if (e[k] < -1e-9) hi = Math.min(hi, Math.floor(-c / e[k] - 0.5) + 1)
    else if (c < 0) hi = 0
  }
  into[0] = lo
  into[1] = hi
}

/**
 * Screen → the unit square of a quad (the images of (0, 0), (1, 0), (1, 1), (0, 1)), as a 3×3
 * row-major matrix up to scale: s = (m0·x + m1·y + m2) / (m6·x + m7·y + m8), t likewise from row 2.
 * It is the adjugate of the forward map that core/quad.ts → rectToQuad hands to CSS (Heckbert).
 */
function quadToUnit(q: Pt[]) {
  const [q0, q1, q2, q3] = q
  const dx1 = q1.x - q2.x
  const dx2 = q3.x - q2.x
  const dx3 = q0.x - q1.x + q2.x - q3.x
  const dy1 = q1.y - q2.y
  const dy2 = q3.y - q2.y
  const dy3 = q0.y - q1.y + q2.y - q3.y
  const det = dx1 * dy2 - dx2 * dy1
  const g = det ? (dx3 * dy2 - dx2 * dy3) / det : 0
  const k = det ? (dx1 * dy3 - dx3 * dy1) / det : 0
  // forward: x = (a·s + b·t + c) / (g·s + k·t + 1), y = (d·s + e·t + f) / (…)
  const [a, b, c] = [q1.x - q0.x + g * q1.x, q3.x - q0.x + k * q3.x, q0.x]
  const [d, e, f] = [q1.y - q0.y + g * q1.y, q3.y - q0.y + k * q3.y, q0.y]
  return [e - f * k, c * k - b, b * f - c * e, f * g - d, a - c * g, c * d - a * f, d * k - e * g, b * g - a * k, a * e - b * d]
}

export function createSlabFallback(mount: HTMLElement, ctx: LayerContext): Layer {
  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'position:absolute;left:0;top:0;display:block;image-rendering:pixelated;pointer-events:none;'
  canvas.setAttribute('aria-hidden', 'true')
  canvas.dataset.slabFallback = ''
  const g = canvas.getContext('2d')
  const shadow = createSlabShadow()
  mount.append(shadow.canvas, canvas)

  const solver = createSlabSolver()
  const arrival = createArrival()
  /** the pose at rest for the current layout and config (resize()): SlabPose.rest */
  let restSol: SlabSolution = solver.solve(ctx.layout, ctx.config, true)
  /** what the canvas shows (nothing is painted while it stays the same) */
  let painted = ''
  /** the canvas as packed pixels (0xAABBGGRR), and the rectangle of it that is not empty: x0, y0, x1, y1 */
  let image: ImageData | null = null
  let out = new Uint32Array(0)
  let dirty = [0, 0, 0, 0]
  const size = { w: 0, h: 0, ps: 1 }
  /** what the last frame showed (stats()) */
  let shown: ArrivalLook | null = null

  /** per project: the picture's texels, read back once per load */
  const texels: ({ version: number; w: number; h: number; data: Uint32Array } | null)[] = []
  const pictures = createSlabPictures(() => {
    painted = ''
  })
  const texelsOf = (i: number) => {
    const pic = pictures.get(i)
    if (!pic) return null
    let t = texels[i]
    if (!t || t.version !== pic.version) {
      const { width: w, height: h } = pic.canvas
      const data = pic.canvas.getContext('2d')?.getImageData(0, 0, w, h).data
      t = texels[i] = data ? { version: pic.version, w, h, data: new Uint32Array(data.buffer) } : null
    }
    return t
  }

  /** Any CSS colour → an opaque packed pixel. */
  const packed = new Map<string, number>()
  const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (probe) probe.canvas.width = probe.canvas.height = 1
  const pack = (color: string) => {
    let v = packed.get(color)
    if (v === undefined) {
      v = 0xff808080
      if (probe) {
        probe.fillStyle = '#808080'
        probe.fillStyle = color
        probe.fillRect(0, 0, 1, 1)
        const [r, gr, b] = probe.getImageData(0, 0, 1, 1).data
        v = (0xff000000 | (b << 16) | (gr << 8) | r) >>> 0
      }
      packed.set(color, v)
    }
    return v
  }

  /** The slab in this pose on its lattice (size.w × size.h pixels of size.ps CSS px): side faces, then the face over them. */
  function paint(sol: SlabSolution, K: SlabKnobs, arr: ArrivalLook) {
    if (!g) return
    const { w, h, ps } = size
    const i = projects.state.index
    const item = Object.values(K.items)[i]
    const tex = arr.textured ? texelsOf(i) : null
    const k = K.slab
    const toLattice = (p: Pt) => ({ x: p.x / ps, y: p.y / ps })
    const face = sol.corners.map(toLattice)
    const key =
      `${sol.key}|${ps}|${w}|${h}|${sol.d.toFixed(2)}|${arr.stipple}|${i}|${tex ? `${tex.version}|${arr.lod}` : 'blank'}|${item?.focus.x},${item?.focus.y}` +
      `|${k.aspect}|${k.side}|${k.bottom}|${k.seam}|${k.seamWidth}|${K.arrive.blank}`
    if (key === painted) return
    painted = key

    if (!image || image.width !== w || image.height !== h) {
      canvas.width = w
      canvas.height = h
      image = g.createImageData(w, h)
      out = new Uint32Array(image.data.buffer)
      dirty = [0, 0, 0, 0]
    }
    const css = `${w * ps}px|${h * ps}px`
    if (canvas.dataset.css !== css) {
      canvas.dataset.css = css
      canvas.style.width = `${w * ps}px`
      canvas.style.height = `${h * ps}px`
    }
    // what was there
    const was = dirty
    for (let y = was[1]; y < was[3]; y++) out.fill(0, y * w + was[0], y * w + was[2])
    dirty = [0, 0, 0, 0]

    // the stipple of the arrival: a lattice pixel is drawn while its Bayer rank is under the coverage
    const limit = arr.stipple * 16
    if (limit > 0) {
      const quads: { q: Pt[]; color: number }[] = []
      if (sol.d > 0) {
        for (const side of SIDES) {
          const q = side.at.map(([x, y, z]) => toLattice(sol.point(x, y, z)))
          if (winding(q) > 0) quads.push({ q, color: pack(k[side.name]) })
        }
      }
      const all = [face, ...quads.map((s) => s.q)].flat()
      const box = (q: Pt[]) => [
        Math.max(0, Math.floor(Math.min(...q.map((p) => p.x)) - 1)),
        Math.max(0, Math.floor(Math.min(...q.map((p) => p.y)) - 1)),
        Math.min(w, Math.ceil(Math.max(...q.map((p) => p.x)) + 1)),
        Math.min(h, Math.ceil(Math.max(...q.map((p) => p.y)) + 1)),
      ]
      dirty = box(all)

      const row = [0, 0]
      const inner = [0, 0]
      for (const { q, color } of quads) {
        const e = edgesOf(q)
        const [, y0, , y1] = box(q)
        for (let y = y0; y < y1; y++) {
          span(e, y, -OVERLAP, w, row)
          const rank = (y & 3) * 4
          for (let x = row[0]; x < row[1]; x++) if (BAYER[rank + (x & 3)] < limit) out[y * w + x] = color
        }
      }

      // the face (a slab turned away from the camera has none to show)
      if (winding(face) > 0) {
        const e = edgesOf(face)
        const m = quadToUnit(face)
        const blank = pack(K.arrive.blank)
        const seam = pack(k.seam)
        // the seam around the picture: a line of whole lattice pixels along the face's edges
        const seamWidth = tex ? Math.max(0, k.seamWidth) : 0
        const crop = tex && item ? coverCrop(tex.w / tex.h, k.aspect, item.focus) : null
        // "loading": whole blocks of 2^lod texels show their middle one
        const lod = Math.max(0, Math.round(arr.lod))
        const mid = (1 << lod) >> 1
        const [, y0, , y1] = box(face)
        for (let y = y0; y < y1; y++) {
          span(e, y, 0, w, row)
          if (row[1] <= row[0]) continue
          span(e, y, seamWidth, w, inner)
          const rank = (y & 3) * 4
          const at = y * w
          // the picture's place under this pixel: the inverse projection, stepped along the row
          const [cx, cy] = [row[0] + 0.5, y + 0.5]
          let sn = m[0] * cx + m[1] * cy + m[2]
          let tn = m[3] * cx + m[4] * cy + m[5]
          let den = m[6] * cx + m[7] * cy + m[8]
          for (let x = row[0]; x < row[1]; x++, sn += m[0], tn += m[3], den += m[6]) {
            if (BAYER[rank + (x & 3)] >= limit) continue
            if (!tex || !crop) out[at + x] = blank
            else if (x < inner[0] || x >= inner[1]) out[at + x] = seam
            else {
              let tx = Math.floor((crop.x + Math.min(1, Math.max(0, sn / den)) * crop.w) * tex.w)
              let ty = Math.floor((crop.y + Math.min(1, Math.max(0, tn / den)) * crop.h) * tex.h)
              if (lod) {
                tx = ((tx >> lod) << lod) + mid
                ty = ((ty >> lod) << lod) + mid
              }
              out[at + x] = (tex.data[Math.min(tex.h - 1, ty) * tex.w + Math.min(tex.w - 1, tx)] | 0xff000000) >>> 0
            }
          }
        }
      }
    }

    // out: everything that was painted before or is now
    const [ux0, uy0] = [Math.min(was[0], dirty[0]), Math.min(was[1], dirty[1])]
    const [ux1, uy1] = [Math.max(was[2], dirty[2]), Math.max(was[3], dirty[3])]
    const empty = (r: number[]) => r[2] <= r[0] || r[3] <= r[1]
    if (empty(was) && empty(dirty)) return
    const [px0, py0, px1, py1] = empty(was) ? dirty : empty(dirty) ? was : [ux0, uy0, ux1, uy1]
    g.putImageData(image, 0, 0, px0, py0, px1 - px0, py1 - py0)
  }

  const layer: Layer & { stats(): unknown } = {
    /** Debug (__hero.layers.get('slab').stats()). */
    stats: () => ({
      gl: false,
      ps: size.ps,
      buffer: [size.w, size.h],
      corners: slabPose.current?.corners,
      flat: slabPose.current?.flat,
      arrival: slabPose.current?.arrival,
      stipple: shown?.stipple,
      textured: shown?.textured,
      lod: shown ? [shown.lod, shown.lod] : null,
      load: arrival.load,
      pictures: pictures.state(),
    }),

    resize(l, c) {
      const K = slabKnobs(c)
      pictures.sync(K, projects.state.to)
      painted = ''
      restSol = solver.solve(l, c, true)
      publishPose(solver.solve(l, c), restSol)
    },

    update(frame: Frame) {
      projects.step(frame)
      const K = slabKnobs(frame.config)
      // every frame: with no show the target is on screen at once, and must not wait behind the idle preloads
      pictures.hurry(projects.state.to)
      solver.step(frame, null)
      const sol = solver.solve(frame.layout, frame.config)
      publishPose(sol, restSol)
      const arr = arrival.step(frame, K, !!pictures.get(projects.state.index))
      shown = arr
      // the stage on the slab's lattice, rounded up to whole lattice pixels — as the WebGL canvas is (index.ts → fit)
      size.ps = slabPixelSize(sol.w, K)
      size.w = Math.max(1, Math.ceil(sol.W / size.ps - 1e-4))
      size.h = Math.max(1, Math.ceil(sol.H / size.ps - 1e-4))
      paint(sol, K, arr)
      shadow.draw(size.w, size.h, size.ps, shadowBlob(sol, K, size.ps, arr.stipple))
    },

    dispose() {
      slabPose.current = null
      pictures.dispose()
      shadow.dispose()
      canvas.remove()
    },
  }

  layer.resize(ctx.layout, ctx.config)
  return layer
}
