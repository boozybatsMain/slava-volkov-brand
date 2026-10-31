import { BufferAttribute, BufferGeometry, ShapeUtils, Vector2 } from 'three'
import fontJson from './font.json'

/**
 * ABOUT — the 3D letters: extruded words of black concrete, built from Russo One outlines (SIL OFL
 * 1.1, baked offline into ./font.json by scripts/about-glyphs/bake.py — no font is parsed at runtime).
 *
 * Built the way late-90s logo tools did it (the archived title mesh, archive/title-mesh/src/geometry.ts,
 * generalised): faceted curves (curveSegments ≈ 2), a front cap inset by the bevel, a profile swept
 * along every contour — outer chamfer → flat step → inner chamfer → straight wall with a seam groove —
 * and a flat BACK cap. No bend.
 *
 * FRAME — word units, shared with the sheet (core/about-camera.ts):
 *   1 = the word's FLAT INK WIDTH (the back outline's width, after tracking / kerning / stretch), so a
 *   word placed with `width: w` on the sheet is w sheet units wide;
 *   origin = the centre of the flat ink box; x right, y DOWN (the font's y-up is flipped here);
 *   z toward the camera: the BACK face is the reference plane z = 0, the front face is z = +depth.
 * The profile (depth, chamfers, seam) is given in CAP HEIGHTS (`LetterProfile`), so every word has the
 * same letter proportions whatever its width; `WordOutline.cap` converts (word units per cap height).
 *
 * WINDING. The frame is left-handed (x right, y down, z out of the screen). Every triangle is wound so
 * that it is counter-clockwise ON THE DISPLAY when seen from outside its solid (= the usual WebGL /
 * three.js front face) once projected by core/about-camera.ts → clipMatrix / project3; in sheet numbers
 * that means cross(b − a, c − a) · n < 0. A three.js renderer that puts the model matrix on the mesh
 * (positive determinant) and the camera into projectionMatrix (identity view) gets FrontSide right.
 *
 * Everything here is pure and synchronous (typed arrays; three is used only for its earcut
 * triangulator and by `toBufferGeometry`), cached per look/profile — the canvas, the 2D fallback, the
 * camera (the A's counter → the pull's first frame) and the notes' layout check share it.
 */

// ── font data ───────────────────────────────────────────────────────────────────────────────────────

type Cmd = (string | number)[]
interface FontJson {
  source: string
  license: string
  unitsPerEm: number
  capHeight: number
  space: number
  glyphs: Record<string, { adv: number; cmds: Cmd[] }>
  kern: Record<string, number>
}
const FONT = fontJson as unknown as FontJson

/** The baked character set (A–Z, 0–9, ' ’ & . , - ! ? and space); lowercase is drawn as uppercase. */
export const FONT_CHARS = Object.keys(FONT.glyphs).join('') + ' '

/** Part ids (aPart.x) — the bands of the profile, front to back. */
export const PART = { face: 0, chamfer1: 1, step: 2, chamfer2: 3, wall: 4, seam: 5, back: 6 } as const

/** The letters' cross-section, CAP HEIGHTS (sky.config.ts → about.letters; a word's own depth wins). */
export interface LetterProfile {
  /** extrusion: back face → front face */
  depth: number
  /** the stepped front bevel: outer chamfer (45°) → flat step → inner chamfer (45°) */
  chamferOuter: number
  chamferStep: number
  chamferInner: number
  /** depth of the groove around the wall (0 — none) and where it runs: 0 at the front … 1 at the back */
  seam: number
  seamAt: number
  /** straight pieces per font curve: 1–2 — faceted, like an old logo tool; 8 — smooth */
  curveSegments: number
  /** along a contour, normals are smoothed across corners flatter than this (degrees) */
  crease: number
}

/** What is written: text and its letter spacing / shape (a word's own knobs, else about.word). */
export interface TextLook {
  text: string
  /** extra letter spacing, em (1 em = the font's unitsPerEm) */
  tracking: number
  /** letters taller than the font (1 — as drawn) */
  stretchY: number
  /** letters wider than the font (1 — as drawn) */
  condense: number
}

export const DEFAULT_PROFILE: LetterProfile = {
  depth: 0.6,
  chamferOuter: 0.032,
  chamferStep: 0.02,
  chamferInner: 0.03,
  seam: 0.008,
  seamAt: 0.5,
  curveSegments: 2,
  crease: 38,
}

const DEFAULT_LOOK: Omit<TextLook, 'text'> = { tracking: 0, stretchY: 1, condense: 1 }

// ── outlines ────────────────────────────────────────────────────────────────────────────────────────

/** A closed polygon: x0, y0, x1, y1, … (the last point is not repeated). */
export type Ring = Float64Array

export interface Shape2 {
  outer: Ring
  holes: Ring[]
}

export interface GlyphOutline {
  ch: string
  /** index among the drawn glyphs of the word (= aGlyph; spaces are not glyphs) */
  index: number
  /** index of its character in the text */
  char: number
  /** the BACK face (z = 0) and the walls: the raw outline, word units, y down */
  shapes: Shape2[]
  /** the FRONT cap (z = depth): the outline inset by the whole bevel (chamferOuter + chamferInner) */
  face: Shape2[]
  /** ink box of the raw outline, word units: x0, y0, x1, y1 */
  box: [number, number, number, number]
}

export interface WordOutline {
  /** cache key (look + profile) */
  key: string
  text: string
  glyphs: GlyphOutline[]
  /** the flat word's ink size, cap heights (its width is 1 word unit) */
  inkW: number
  inkH: number
  /** word units per cap height (= 1 / inkW) */
  cap: number
  /** heights above the back plane, word units: the front face; the shoulder (walls end, bevel begins) */
  depth: number
  shoulder: number
  /** bounding box of the whole solid, word units: x0, y0, z0, x1, y1, z1 */
  bounds: [number, number, number, number, number, number]
}

/** The back opening of a glyph's counter (for the A: the triangle), word units, y down, z = 0. */
export interface Counter {
  ring: Ring
  /** the centre of its largest inscribed circle (for a triangle: the incentre) and that circle's radius */
  x: number
  y: number
  r: number
  /** glyph index (aGlyph) it belongs to */
  glyph: number
}

type V2 = { x: number; y: number }

interface Contour {
  pts: V2[]
  /** per-vertex miter offsets (move the edges by 1) */
  miter: V2[]
  /** outward unit normal of edge i (pts[i] → pts[i + 1]) */
  edgeN: V2[]
  /** per-vertex smoothed normal, null at a crease */
  smoothN: (V2 | null)[]
}

interface RawGlyph {
  ch: string
  index: number
  char: number
  /** shapes in the CAP frame (cap heights, y UP, the font's own orientation, placed on the line) */
  shapes: { outer: V2[]; holes: V2[][] }[]
}

interface Built {
  outline: WordOutline
  glyphs: RawGlyph[]
  /** CAP frame → word frame: X = (x − cx) / inkW, Y = (cy − y) / inkW */
  cx: number
  cy: number
}

let warned = ''

function glyphKey(ch: string) {
  const u = ch.toUpperCase()
  if (FONT.glyphs[u]) return u
  if (ch === '‘' || ch === '`') return '’'
  return null
}

/** Font commands → polylines (font units, y up), curves cut into `segments` straight pieces. */
function flatten(cmds: Cmd[], segments: number, ox: number, sx: number, sy: number): V2[][] {
  const out: V2[][] = []
  let cur: V2[] = []
  let px = 0
  let py = 0
  const P = (x: number, y: number) => cur.push({ x: ox + x * sx, y: y * sy })
  for (const c of cmds) {
    const n = c.slice(1) as number[]
    switch (c[0]) {
      case 'M':
        if (cur.length) out.push(cur)
        cur = []
        px = n[0]
        py = n[1]
        P(px, py)
        break
      case 'L':
        px = n[0]
        py = n[1]
        P(px, py)
        break
      case 'Q':
        for (let k = 1; k <= segments; k++) {
          const t = k / segments
          const a = (1 - t) * (1 - t)
          const b = 2 * (1 - t) * t
          const d = t * t
          P(a * px + b * n[0] + d * n[2], a * py + b * n[1] + d * n[3])
        }
        px = n[2]
        py = n[3]
        break
      case 'C':
        for (let k = 1; k <= segments; k++) {
          const t = k / segments
          const u = 1 - t
          const a = u * u * u
          const b = 3 * u * u * t
          const e = 3 * u * t * t
          const d = t * t * t
          P(a * px + b * n[0] + e * n[2] + d * n[4], a * py + b * n[1] + e * n[3] + d * n[5])
        }
        px = n[4]
        py = n[5]
        break
      case 'Z':
        if (cur.length) out.push(cur)
        cur = []
        break
    }
  }
  if (cur.length) out.push(cur)
  return out
}

const dist = (a: V2, b: V2) => Math.hypot(a.x - b.x, a.y - b.y)

/** Drop repeated, closing and exactly collinear points (honest facets, no zero-area slivers). */
function clean(pts: V2[]) {
  const out: V2[] = []
  for (const p of pts) {
    if (out.length && dist(out[out.length - 1], p) < 1e-6) continue
    out.push({ x: p.x, y: p.y })
  }
  while (out.length > 2 && dist(out[0], out[out.length - 1]) < 1e-6) out.pop()
  for (let i = out.length - 1; i >= 0 && out.length > 3; i--) {
    const a = out[(i - 1 + out.length) % out.length]
    const b = out[i]
    const c = out[(i + 1) % out.length]
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (Math.abs(cross) < 1e-9) out.splice(i, 1)
  }
  return out
}

/** Signed area, y up: > 0 counter-clockwise. */
function area(pts: V2[]) {
  let s = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    s += a.x * b.y - b.x * a.y
  }
  return s / 2
}

function inside(p: V2, poly: V2[]) {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c
  }
  return c
}

/** Outer rings and their holes by nesting (even depth — material, odd — a hole in the ring around it). */
function nest(rings: V2[][]) {
  const n = rings.length
  const areas = rings.map((r) => Math.abs(area(r)))
  const parents = rings.map((r, i) => {
    // a point of ring i that is not on another ring's edge: the midpoint of its first edge
    const p = { x: (r[0].x + r[1].x) / 2, y: (r[0].y + r[1].y) / 2 }
    const outs: number[] = []
    for (let j = 0; j < n; j++) if (j !== i && areas[j] > areas[i] && inside(p, rings[j])) outs.push(j)
    return outs
  })
  const shapes: { outer: V2[]; holes: V2[][] }[] = []
  const byOuter = new Map<number, number>()
  rings.forEach((r, i) => {
    if (parents[i].length % 2 === 0) {
      byOuter.set(i, shapes.length)
      shapes.push({ outer: r, holes: [] })
    }
  })
  rings.forEach((r, i) => {
    if (parents[i].length % 2 === 1) {
      // the smallest ring around it is its outer
      const outer = parents[i].reduce((a, b) => (areas[a] < areas[b] ? a : b))
      const s = byOuter.get(outer)
      if (s !== undefined) shapes[s].holes.push(r)
    }
  })
  return shapes
}

/** A contour with the material on its LEFT (y up: outer CCW, hole CW), with miters and normals. */
function makeContour(raw: V2[], isHole: boolean, creaseDeg: number): Contour {
  let pts = raw.map((p) => ({ x: p.x, y: p.y }))
  const ccw = area(pts) > 0
  if (ccw === isHole) pts = pts.reverse()
  const n = pts.length
  const edgeN: V2[] = []
  for (let i = 0; i < n; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    const l = Math.max(1e-12, dist(a, b))
    edgeN.push({ x: (b.y - a.y) / l, y: -(b.x - a.x) / l }) // right-hand normal = outward
  }
  const cosCrease = Math.cos((creaseDeg * Math.PI) / 180)
  const miter: V2[] = []
  const smoothN: (V2 | null)[] = []
  for (let i = 0; i < n; i++) {
    const n1 = edgeN[(i - 1 + n) % n]
    const n2 = edgeN[i]
    const d = n1.x * n2.x + n1.y * n2.y
    const k = 1 / Math.max(0.15, 1 + d)
    let mx = (n1.x + n2.x) * k
    let my = (n1.y + n2.y) * k
    const ml = Math.hypot(mx, my)
    // acute corners (the A's apex, the counter's top): the bevel is cut a little, as in the archive
    if (ml > 2.6) {
      mx *= 2.6 / ml
      my *= 2.6 / ml
    }
    miter.push({ x: mx, y: my })
    if (d > cosCrease) {
      const sx = n1.x + n2.x
      const sy = n1.y + n2.y
      const sl = Math.max(1e-12, Math.hypot(sx, sy))
      smoothN.push({ x: sx / sl, y: sy / sl })
    } else smoothN.push(null)
  }
  return { pts, miter, edgeN, smoothN }
}

interface ProfilePt {
  /** offset along the outward miter (≤ 0: into the material) */
  o: number
  /** distance from the FRONT face */
  d: number
  /** part of the band that STARTS at this point */
  part: number
}

function profileOf(p: LetterProfile): ProfilePt[] {
  const b1 = Math.max(0, p.chamferOuter)
  const st = Math.max(0, p.chamferStep)
  const b2 = Math.max(0, p.chamferInner)
  const front = b1 + st + b2
  const depth = Math.max(front + 0.02, p.depth)
  const prof: ProfilePt[] = [{ o: -(b1 + b2), d: 0, part: PART.chamfer1 }]
  if (b1 > 0) prof.push({ o: -b2, d: b1, part: PART.step })
  if (st > 0) prof.push({ o: -b2, d: b1 + st, part: PART.chamfer2 })
  if (b2 > 0) prof.push({ o: 0, d: front, part: PART.wall })
  if (prof[prof.length - 1].o !== 0) prof.push({ o: 0, d: front, part: PART.wall })
  prof[prof.length - 1].part = PART.wall
  const seam = Math.max(0, p.seam)
  if (seam > 0) {
    const zc = front + (depth - front) * Math.min(0.95, Math.max(0.05, p.seamAt))
    const w = seam * 0.9
    prof.push({ o: 0, d: zc - w, part: PART.seam })
    prof.push({ o: -seam, d: zc, part: PART.seam })
    prof.push({ o: 0, d: zc + w, part: PART.wall })
  }
  prof.push({ o: 0, d: depth, part: PART.wall })
  return prof
}

/**
 * The profile's thin bands as depth fractions (0 at the face … 1 at the back — the `part` attribute's
 * second number): the step between the chamfers and the seam groove on the walls — their middles and
 * widths (the groove: its two slopes, 2 × 0.9 × seam). The renderers draw them as lines of at least a
 * pixel, or as their neighbours (shaders.ts → CONCRETE_FS; the 2D fallback the same).
 */
export function thinBands(p: LetterProfile) {
  const b1 = Math.max(0, p.chamferOuter)
  const st = Math.max(0, p.chamferStep)
  const b2 = Math.max(0, p.chamferInner)
  const front = b1 + st + b2
  const depth = Math.max(front + 0.02, p.depth)
  const zc = front + (depth - front) * Math.min(0.95, Math.max(0.05, p.seamAt))
  return {
    step: st / depth,
    stepMid: (b1 + st / 2) / depth,
    seam: (1.8 * Math.max(0, p.seam)) / depth,
    seamMid: zc / depth,
    /** the bevel's width across (the two chamfers), cap heights */
    bevel: b1 + b2,
  }
}

const profileKey = (p: LetterProfile) =>
  [p.depth, p.chamferOuter, p.chamferStep, p.chamferInner, p.seam, p.seamAt, Math.max(1, Math.round(p.curveSegments)), p.crease].join(',')
const lookKey = (l: TextLook) => [l.text, l.tracking, l.stretchY, l.condense].join('\u0002')

/** Lay the text out and cut its glyphs into faceted, nested contours (CAP frame, y up). */
function layout(look: TextLook, segments: number): { glyphs: RawGlyph[]; x0: number; y0: number; x1: number; y1: number } {
  const k = 1 / FONT.capHeight
  const sx = k * Math.max(0.05, look.condense)
  const sy = k * Math.max(0.05, look.stretchY)
  const track = look.tracking * FONT.unitsPerEm
  const glyphs: RawGlyph[] = []
  const chars = [...look.text]
  let cursor = 0
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let ci = 0; ci < chars.length; ci++) {
    const key = glyphKey(chars[ci])
    if (!key) {
      if (chars[ci] !== ' ' && warned !== chars[ci]) {
        warned = chars[ci]
        console.warn(`[about] no baked glyph for ${JSON.stringify(chars[ci])} — drawn as a space (scripts/about-glyphs/bake.py)`)
      }
      cursor += FONT.space + track
      continue
    }
    const g = FONT.glyphs[key]
    const rings = flatten(g.cmds, segments, cursor * sx, sx, sy)
      .map(clean)
      .filter((r) => r.length >= 3 && Math.abs(area(r)) > 1e-9)
    for (const r of rings)
      for (const p of r) {
        x0 = Math.min(x0, p.x)
        y0 = Math.min(y0, p.y)
        x1 = Math.max(x1, p.x)
        y1 = Math.max(y1, p.y)
      }
    glyphs.push({ ch: key, index: glyphs.length, char: ci, shapes: nest(rings) })
    const next = chars[ci + 1] ? glyphKey(chars[ci + 1]) : null
    cursor += g.adv + (next ? FONT.kern[key + next] ?? 0 : 0) + track
  }
  if (!glyphs.length) {
    x0 = y0 = -0.5
    x1 = y1 = 0.5
  }
  return { glyphs, x0, y0, x1, y1 }
}

const cache = new Map<string, Built>()
const CACHE_MAX = 64

function remember<T>(map: Map<string, T>, key: string, make: () => T) {
  const hit = map.get(key)
  if (hit) {
    // keep recently used entries
    map.delete(key)
    map.set(key, hit)
    return hit
  }
  const v = make()
  map.set(key, v)
  if (map.size > CACHE_MAX) map.delete(map.keys().next().value as string)
  return v
}

function lookOf(look: Partial<TextLook> & { text: string }): TextLook {
  return { ...DEFAULT_LOOK, ...look, text: look.text }
}

function profileOrDefault(p?: Partial<LetterProfile>): LetterProfile {
  return { ...DEFAULT_PROFILE, ...(p ?? {}) }
}

function build(lookIn: Partial<TextLook> & { text: string }, profIn?: Partial<LetterProfile>): Built {
  const look = lookOf(lookIn)
  const prof = profileOrDefault(profIn)
  const key = lookKey(look) + '\u0001' + profileKey(prof)
  return remember(cache, key, () => {
    const seg = Math.max(1, Math.round(prof.curveSegments))
    const L = layout(look, seg)
    const inkW = Math.max(1e-6, L.x1 - L.x0)
    const inkH = Math.max(1e-6, L.y1 - L.y0)
    const cx = (L.x0 + L.x1) / 2
    const cy = (L.y0 + L.y1) / 2
    const s = 1 / inkW
    const pr = profileOf(prof)
    const depthCap = pr[pr.length - 1].d
    const shoulderCap = depthCap - (pr.find((q) => q.o === 0)?.d ?? 0)
    const inset = pr[0].o
    const toRing = (pts: V2[]) => {
      const r = new Float64Array(pts.length * 2)
      pts.forEach((p, i) => {
        r[2 * i] = (p.x - cx) * s
        r[2 * i + 1] = (cy - p.y) * s
      })
      return r
    }
    const glyphs: GlyphOutline[] = L.glyphs.map((g) => {
      let bx0 = Infinity
      let by0 = Infinity
      let bx1 = -Infinity
      let by1 = -Infinity
      const shapes: Shape2[] = []
      const face: Shape2[] = []
      for (const sh of g.shapes) {
        for (const p of sh.outer) {
          bx0 = Math.min(bx0, (p.x - cx) * s)
          bx1 = Math.max(bx1, (p.x - cx) * s)
          by0 = Math.min(by0, (cy - p.y) * s)
          by1 = Math.max(by1, (cy - p.y) * s)
        }
        shapes.push({ outer: toRing(sh.outer), holes: sh.holes.map(toRing) })
        const outer = makeContour(sh.outer, false, prof.crease)
        const holes = sh.holes.map((h) => makeContour(h, true, prof.crease))
        const ins = (c: Contour) => c.pts.map((q, i) => ({ x: q.x + c.miter[i].x * inset, y: q.y + c.miter[i].y * inset }))
        face.push({ outer: toRing(ins(outer)), holes: holes.map((h) => toRing(ins(h))) })
      }
      if (!shapes.length) bx0 = by0 = bx1 = by1 = 0
      return { ch: g.ch, index: g.index, char: g.char, shapes, face, box: [bx0, by0, bx1, by1] }
    })
    const outline: WordOutline = {
      key,
      text: look.text,
      glyphs,
      inkW,
      inkH,
      cap: s,
      depth: depthCap * s,
      shoulder: shoulderCap * s,
      bounds: [-0.5, -(inkH * s) / 2, 0, 0.5, (inkH * s) / 2, depthCap * s],
    }
    return { outline, glyphs: L.glyphs, cx, cy }
  })
}

/**
 * The outline of a word (flat, word units): per glyph its raw back-face shapes, its front-cap shapes,
 * its ink box; the word's ink size in cap heights and its depths in word units. `look.text` may hold
 * spaces (they are not glyphs). Cached.
 */
export function wordOutline(look: Partial<TextLook> & { text: string }, profile?: Partial<LetterProfile>): WordOutline {
  return build(look, profile).outline
}

/** Largest inscribed circle of a convex ring (word units): centre and radius. */
function incircle(ring: Ring): { x: number; y: number; r: number } {
  const fit = fitInConvex(ring, [])
  return fit ? { x: fit.x, y: fit.y, r: fit.k } : { x: ring[0], y: ring[1], r: 0 }
}

/**
 * The counter (back opening of the enclosed hole, z = 0) of glyph `glyphIndex` of a word, word units
 * (y down): for the A — its triangle. A glyph with several holes (B) gives its largest. null — the
 * glyph has no hole (or there is no such glyph).
 */
export function counterOf(look: Partial<TextLook> & { text: string } | string, glyphIndex: number, profile?: Partial<LetterProfile>): Counter | null {
  const o = wordOutline(typeof look === 'string' ? { text: look } : look, profile)
  const g = o.glyphs[glyphIndex]
  if (!g) return null
  let best: Ring | null = null
  let bestA = 0
  for (const sh of g.shapes)
    for (const h of sh.holes) {
      const a = Math.abs(ringArea(h))
      if (a > bestA) {
        bestA = a
        best = h
      }
    }
  if (!best) return null
  const c = incircle(best)
  return { ring: best, x: c.x, y: c.y, r: c.r, glyph: glyphIndex }
}

/** Signed area of a ring in its own numbers (y down: > 0 clockwise on screen). */
export function ringArea(r: Ring) {
  let s = 0
  const n = r.length / 2
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    s += r[2 * i] * r[2 * j + 1] - r[2 * j] * r[2 * i + 1]
  }
  return s / 2
}

/**
 * The largest scale k for which a shape fits a CONVEX polygon (non-convex: inside its kernel — on the
 * safe side): the shape is the set of points c + k · v for the vectors `vs` (x0, y0, x1, y1, …; empty —
 * a disc of radius k, i.e. the largest inscribed circle). Returns the scale and the centre c (the middle
 * of what is still free just below the largest scale — unique for a triangle). null — degenerate.
 * Pure, ~50 half-plane clips; used for the pull's first frame (core/about-camera.ts).
 */
export function fitInConvex(ring: Ring, vs: ArrayLike<number>, steps = 48): { k: number; x: number; y: number } | null {
  const n = ring.length / 2
  if (n < 3) return null
  // edges as half-planes n · p ≤ c with the inside on the ring's interior side
  const orient = ringArea(ring) > 0 ? 1 : -1
  const hs: { nx: number; ny: number; c: number; s: number }[] = []
  let span = 0
  for (let i = 0; i < n; i++) {
    const ax = ring[2 * i]
    const ay = ring[2 * i + 1]
    const j = (i + 1) % n
    const ex = ring[2 * j] - ax
    const ey = ring[2 * j + 1] - ay
    const l = Math.hypot(ex, ey)
    if (l < 1e-12) continue
    // outward normal: for a ring with positive area (in its own numbers), the right-hand normal (ey, −ex)
    const nx = (orient * ey) / l
    const ny = (-orient * ex) / l
    let s = 0
    if (vs.length) {
      s = -Infinity
      for (let v = 0; v + 1 < vs.length; v += 2) s = Math.max(s, nx * vs[v] + ny * vs[v + 1])
    } else s = 1
    hs.push({ nx, ny, c: nx * ax + ny * ay, s })
    span = Math.max(span, l)
  }
  // the free region of centres at scale k: the ring with every edge moved in by k · s
  const region = (k: number) => {
    let poly: [number, number][] = []
    for (let i = 0; i < n; i++) poly.push([ring[2 * i], ring[2 * i + 1]])
    for (const h of hs) {
      const lim = h.c - k * h.s
      const out: [number, number][] = []
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]
        const b = poly[(i + 1) % poly.length]
        const da = h.nx * a[0] + h.ny * a[1] - lim
        const db = h.nx * b[0] + h.ny * b[1] - lim
        if (da <= 0) out.push(a)
        if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
          const t = da / (da - db)
          out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
        }
      }
      poly = out
      if (poly.length < 3) return null
    }
    return poly
  }
  // bracket: the shape's own size against the ring's
  let sMin = Infinity
  for (const h of hs) sMin = Math.min(sMin, Math.max(1e-12, h.s))
  let lo = 0
  let hi = span / sMin
  for (let it = 0; it < steps; it++) {
    const mid = (lo + hi) / 2
    if (region(mid)) lo = mid
    else hi = mid
  }
  const poly = region(lo * (1 - 1e-6)) ?? region(lo * 0.999)
  if (!poly) return null
  let x = 0
  let y = 0
  for (const p of poly) {
    x += p[0]
    y += p[1]
  }
  return { k: lo, x: x / poly.length, y: y / poly.length }
}

// ── the mesh ────────────────────────────────────────────────────────────────────────────────────────

export interface GlyphRange {
  ch: string
  /** = aGlyph */
  index: number
  /** first vertex and vertex count of this glyph in the arrays (non-indexed triangles) */
  start: number
  count: number
  /** ink box (raw outline), word units: x0, y0, x1, y1; its centre is aLocal's origin */
  box: [number, number, number, number]
}

/**
 * One word as plain typed arrays (renderer-agnostic), NON-indexed triangles grouped by glyph:
 *   position (3) — word units (frame above); normal (3) — unit, same frame;
 *   part (2) — band id (PART) and depth fraction (0 at the front face … 1 at the back face);
 *   local (2) — the vertex xy relative to its glyph's ink-box centre, word units (texture space that
 *     travels with the letter);
 *   glyph (1) — glyph index (aGlyph; float, as a GL attribute).
 */
export interface WordMesh {
  outline: WordOutline
  position: Float32Array
  normal: Float32Array
  part: Float32Array
  local: Float32Array
  glyph: Float32Array
  /** vertices (= triangles × 3) */
  count: number
  glyphs: GlyphRange[]
  /** build time, ms (first build; a cache hit returns the same object) */
  ms: number
}

const meshes = new Map<string, WordMesh>()

/**
 * The extruded word (cached per look + profile). An empty / unknown text gives an empty mesh.
 * The arrays are shared by every caller: do not modify them.
 */
export function buildWordMesh(lookIn: Partial<TextLook> & { text: string }, profileIn?: Partial<LetterProfile>): WordMesh {
  const B = build(lookIn, profileIn)
  return remember(meshes, B.outline.key, () => {
    const t0 = performance.now()
    const prof = profileOrDefault(profileIn)
    const pr = profileOf(prof)
    const depth = pr[pr.length - 1].d
    const s = B.outline.cap
    const { cx, cy } = B
    const pos: number[] = []
    const nor: number[] = []
    const part: number[] = []
    const local: number[] = []
    const gl: number[] = []
    const ranges: GlyphRange[] = []
    let gcx = 0
    let gcy = 0
    let gi = 0
    // CAP frame (y up, front at d = 0, back at d = depth) → word frame (y down, back z = 0, front z = depth)
    const push = (x: number, y: number, d: number, nx: number, ny: number, nz: number, pt: number, f: number) => {
      const X = (x - cx) * s
      const Y = (cy - y) * s
      pos.push(X, Y, (depth - d) * s)
      nor.push(nx, -ny, nz)
      part.push(pt, f)
      local.push(X - gcx, Y - gcy)
      gl.push(gi)
    }
    for (const g of B.glyphs) {
      const o = B.outline.glyphs[g.index]
      gcx = (o.box[0] + o.box[2]) / 2
      gcy = (o.box[1] + o.box[3]) / 2
      gi = g.index
      const start = pos.length / 3
      for (const sh of g.shapes) {
        const outer = makeContour(sh.outer, false, prof.crease)
        const holes = sh.holes.map((h) => makeContour(h, true, prof.crease))
        // ── caps: the front one inset by the whole bevel, the back one the raw outline ──
        const cap = (off: number, d: number, front: boolean) => {
          // three's earcut wants Vector2 (it calls .equals)
          const at = (c: Contour) => c.pts.map((q, i) => new Vector2(q.x + c.miter[i].x * off, q.y + c.miter[i].y * off))
          const fo = at(outer)
          const fh = holes.map(at)
          const tris = ShapeUtils.triangulateShape(fo, fh)
          const all = fo.concat(...fh)
          for (const t of tris) {
            let a = all[t[0]]
            let b = all[t[1]]
            let c = all[t[2]]
            const ar = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
            // y up: the front cap counter-clockwise (faces +z), the back cap clockwise (faces −z)
            if (front ? ar < 0 : ar > 0) [b, c] = [c, b]
            for (const v of [a, b, c]) push(v.x, v.y, d, 0, 0, front ? 1 : -1, front ? PART.face : PART.back, front ? 0 : 1)
          }
        }
        cap(pr[0].o, 0, true)
        cap(0, depth, false)
        // ── the profile swept along every contour ──
        for (const c of [outer, ...holes]) {
          const n = c.pts.length
          for (let k = 0; k < pr.length - 1; k++) {
            const A = pr[k]
            const Bp = pr[k + 1]
            const dO = Bp.o - A.o
            const dD = Bp.d - A.d
            const len = Math.hypot(dO, dD) || 1
            const pd = dD / len
            const pz = dO / len
            const fa = A.d / depth
            const fb = Bp.d / depth
            for (let i = 0; i < n; i++) {
              const j = (i + 1) % n
              const nI = c.smoothN[i] ?? c.edgeN[i]
              const nJ = c.smoothN[j] ?? c.edgeN[i]
              const P = (idx: number, q: ProfilePt): [number, number] => [c.pts[idx].x + c.miter[idx].x * q.o, c.pts[idx].y + c.miter[idx].y * q.o]
              const a = P(i, A)
              const b = P(j, A)
              const a1 = P(i, Bp)
              const b1 = P(j, Bp)
              // (y up, front at +z) the band faces outward with (a, b1, b), (a, a1, b1)
              push(a[0], a[1], A.d, nI.x * pd, nI.y * pd, pz, A.part, fa)
              push(b1[0], b1[1], Bp.d, nJ.x * pd, nJ.y * pd, pz, A.part, fb)
              push(b[0], b[1], A.d, nJ.x * pd, nJ.y * pd, pz, A.part, fa)
              push(a[0], a[1], A.d, nI.x * pd, nI.y * pd, pz, A.part, fa)
              push(a1[0], a1[1], Bp.d, nI.x * pd, nI.y * pd, pz, A.part, fb)
              push(b1[0], b1[1], Bp.d, nJ.x * pd, nJ.y * pd, pz, A.part, fb)
            }
          }
        }
      }
      ranges.push({ ch: g.ch, index: g.index, start, count: pos.length / 3 - start, box: o.box })
    }
    return {
      outline: B.outline,
      position: new Float32Array(pos),
      normal: new Float32Array(nor),
      part: new Float32Array(part),
      local: new Float32Array(local),
      glyph: new Float32Array(gl),
      count: pos.length / 3,
      glyphs: ranges,
      ms: performance.now() - t0,
    }
  })
}

/**
 * The word as a THREE.BufferGeometry: position, normal, aPart, aLocal, aGlyph (the arrays are shared,
 * not copied). One group per glyph (materialIndex 0), for drawing glyphs separately.
 */
export function toBufferGeometry(m: WordMesh): BufferGeometry {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(m.position, 3))
  g.setAttribute('normal', new BufferAttribute(m.normal, 3))
  g.setAttribute('aPart', new BufferAttribute(m.part, 2))
  g.setAttribute('aLocal', new BufferAttribute(m.local, 2))
  g.setAttribute('aGlyph', new BufferAttribute(m.glyph, 1))
  for (const r of m.glyphs) g.addGroup(r.start, r.count, 0)
  g.computeBoundingBox()
  g.computeBoundingSphere()
  return g
}

// ── the card box ────────────────────────────────────────────────────────────────────────────────────

/** Face ids of the card box (aFace). */
export const CARD_FACE = { front: 0, left: 1, right: 2, top: 3, bottom: 4, back: 5 } as const

export interface BoxArrays {
  position: Float32Array
  normal: Float32Array
  /** front: u right, v DOWN (0 at the top edge); sides: s from the front (0) to the back (1) */
  uv: Float32Array
  face: Float32Array
  index: Uint16Array
}

/**
 * The unit card box in the same frame and winding as the words: x, y ∈ ±½ (y down), z ∈ −1…0, the
 * FRONT face (the picture) at z = 0 facing +z, cut into cellsX × cellsY quads (an affine "swim" per
 * polygon, like the slab's box). core/about-pose.ts → cardModel scales it to the card.
 */
export function cardBox(cellsX = 1, cellsY = 1): BoxArrays {
  const pos: number[] = []
  const nor: number[] = []
  const uv: number[] = []
  const face: number[] = []
  const index: number[] = []
  const quad = (id: number, nx: number, ny: number, n: [number, number, number], at: (s: number, t: number) => [number, number, number]) => {
    const base = pos.length / 3
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i <= nx; i++) {
        pos.push(...at(i / nx, j / ny))
        nor.push(...n)
        uv.push(i / nx, j / ny)
        face.push(id)
      }
    // orient each quad so that cross(b − a, c − a) · n < 0 (counter-clockwise on the display)
    const p = (k: number) => [pos[3 * k], pos[3 * k + 1], pos[3 * k + 2]]
    const a = p(base)
    const b = p(base + nx + 1)
    const c = p(base + 1)
    const cr = [
      (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
      (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
    ]
    const flip = cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] > 0
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const a0 = base + j * (nx + 1) + i
        const c0 = a0 + nx + 1
        if (flip) index.push(a0, a0 + 1, c0, a0 + 1, c0 + 1, c0)
        else index.push(a0, c0, a0 + 1, a0 + 1, c0, c0 + 1)
      }
  }
  quad(CARD_FACE.front, cellsX, cellsY, [0, 0, 1], (s, t) => [s - 0.5, t - 0.5, 0])
  quad(CARD_FACE.left, 1, 1, [-1, 0, 0], (s, t) => [-0.5, t - 0.5, -s])
  quad(CARD_FACE.right, 1, 1, [1, 0, 0], (s, t) => [0.5, t - 0.5, -s])
  quad(CARD_FACE.top, 1, 1, [0, -1, 0], (s, t) => [t - 0.5, -0.5, -s])
  quad(CARD_FACE.bottom, 1, 1, [0, 1, 0], (s, t) => [t - 0.5, 0.5, -s])
  quad(CARD_FACE.back, 1, 1, [0, 0, -1], (s, t) => [s - 0.5, t - 0.5, -1])
  return {
    position: new Float32Array(pos),
    normal: new Float32Array(nor),
    uv: new Float32Array(uv),
    face: new Float32Array(face),
    index: new Uint16Array(index),
  }
}

/** The font's provenance (for stats / credits). */
export const FONT_SOURCE = { source: FONT.source, license: FONT.license, unitsPerEm: FONT.unitsPerEm, capHeight: FONT.capHeight }
