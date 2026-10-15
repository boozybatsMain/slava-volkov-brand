import * as THREE from 'three'
import glyphData from './glyphs.json'

/**
 * SLAVA VOLKOV as one extruded mesh, built the way late-90s logo tools (Xara3D / Cool 3D) did it:
 * a front cap + a profile swept along every contour (the archived candidate, archive/title-mesh,
 * reworked).
 *
 * WEIGHT. Russo One is lighter than the letters of the client's render (reference/title-main.jpg):
 * there the S's counters are slits and the stems are fat — the render's tool grew the outline by its
 * bevel. So every outline is EMBOLDENED first (boldX / boldY: each vertex moves along its miter, the
 * x and y parts scaled separately, like FreeType's EmboldenXY), the glyph advance grows by 2·boldX
 * (the spacing stays the font's), and only then the bevel is cut INTO that fat outline.
 *
 * Profile (front → back), o = offset along the outward miter, d = depth behind the front face:
 *   front cap edge (−(b1 + b2), 0) → chamfer 1 → (−b2, b1) → flat step → (−b2, b1 + step)
 *   → chamfer 2 → (0, front) → wall → seam groove → wall → (0, depth) → back cap.
 * Every band has its own vertices (hard lines between bands = the stepped double bevel line); along a
 * contour the normals are smoothed unless the corner is sharper than `crease`.
 *
 * Units: 1 = cap height. Object frame: x right, y UP (font baseline at y = 0), the front face at z = 0
 * facing +z, the back at z = −depth. The line starts at x = 0 (the S's left side bearing).
 */

export interface TitleGeometryParams {
  /** extrusion: front face → back face, cap heights */
  depth: number
  /** the stepped front bevel: outer chamfer (45°) → flat step → inner chamfer (45°), cap heights */
  bevelOuter: number
  bevelStep: number
  bevelInner: number
  /** groove around the wall (0 — none) and where it runs: 0 at the front … 1 at the back */
  seam: number
  seamAt: number
  /** straight pieces per font curve (1–2 — faceted like an old logo tool) */
  curveSegments: number
  /** along a contour, normals are smoothed across corners flatter than this, degrees */
  crease: number
  /** emboldening, cap heights: how far vertical / horizontal edges move out */
  boldX: number
  boldY: number
  /** letters wider than the font (1 — as drawn) */
  condense: number
  /** extra space between letters, cap heights */
  tracking: number
  /** the gap SLAVA ⟷ VOLKOV, cap heights (instead of the font's space) */
  wordSpace: number
  /** the second word's size (VOLKOV), relative to the first (on the same baseline) */
  word2Scale: number
  /** per drawn glyph: an extra shift along the line, cap heights (the render's own kerning) */
  shift?: number[]
  /** per letter (the same for both A, both V, both O): its width (1 — the font's), about its middle */
  widths?: Partial<Record<string, number>>
  /** the line bent around a vertical axis, degrees over the whole title (+ — the far end turns away) */
  bend: number
}

/** Part ids (aPart.x) — the bands of the profile, front to back. */
export const PART = { face: 0, bevel1: 1, step: 2, bevel2: 3, wall: 4, seam: 5, back: 6 } as const

export interface TitleMesh {
  geometry: THREE.BufferGeometry
  /** bounds of the solid, object frame (after the bend) */
  bounds: THREE.Box3
  /** per drawn glyph: its ink box on the front plane (x0, y0, x1, y1, object frame, before the bend) */
  glyphBoxes: [number, number, number, number][]
  /** the text actually drawn */
  text: string
}

type Cmd = (string | number)[]
interface GlyphJson {
  text: string
  unitsPerEm: number
  capHeight: number
  space: number
  glyphs: Record<string, { adv: number; cmds: Cmd[] }>
  kern: Record<string, number>
}
const FONT = glyphData as unknown as GlyphJson

type V2 = { x: number; y: number }

// ── outlines ──────────────────────────────────────────────────────────────────────────────────────

/** Font commands → polylines (cap units, y up), curves cut into `segments` straight pieces. */
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
          P(
            u * u * u * px + 3 * u * u * t * n[0] + 3 * u * t * t * n[2] + t * t * t * n[4],
            u * u * u * py + 3 * u * u * t * n[1] + 3 * u * t * t * n[3] + t * t * t * n[5],
          )
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

/** Outer rings and their holes by nesting, each oriented with the material on its LEFT (y up). */
function nest(rings: V2[][]) {
  const areas = rings.map((r) => Math.abs(area(r)))
  const depthOf = rings.map((r, i) => {
    const p = { x: (r[0].x + r[1].x) / 2, y: (r[0].y + r[1].y) / 2 }
    return rings.filter((q, j) => j !== i && areas[j] > areas[i] && inside(p, q)).length
  })
  const orient = (r: V2[], hole: boolean) => (area(r) > 0 === !hole ? r : [...r].reverse())
  const shapes: { outer: V2[]; holes: V2[][] }[] = []
  const index = new Map<number, number>()
  rings.forEach((r, i) => {
    if (depthOf[i] % 2 === 0) {
      index.set(i, shapes.length)
      shapes.push({ outer: orient(r, false), holes: [] })
    }
  })
  rings.forEach((r, i) => {
    if (depthOf[i] % 2 === 1) {
      // its outer: the smallest even ring around it
      let best = -1
      rings.forEach((q, j) => {
        const p = { x: (r[0].x + r[1].x) / 2, y: (r[0].y + r[1].y) / 2 }
        if (j !== i && depthOf[j] % 2 === 0 && areas[j] > areas[i] && inside(p, q) && (best < 0 || areas[j] < areas[best])) best = j
      })
      const s = index.get(best)
      if (s !== undefined) shapes[s].holes.push(orient(r, true))
    }
  })
  return shapes
}

interface Contour {
  pts: V2[]
  /** per-vertex miter offsets (move the edges by 1) */
  miter: V2[]
  /** outward unit normal of edge i (pts[i] → pts[i + 1]) */
  edgeN: V2[]
  /** per-vertex smoothed normal, null at a crease */
  smoothN: (V2 | null)[]
}

/** Edge normals and miters of a ring with the material on its left (outward = right-hand normal). */
function makeContour(pts: V2[], creaseDeg: number): Contour {
  const n = pts.length
  const edgeN: V2[] = []
  for (let i = 0; i < n; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    const l = Math.max(1e-12, dist(a, b))
    edgeN.push({ x: (b.y - a.y) / l, y: -(b.x - a.x) / l })
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
    // acute corners (the A's apex, the V's notch): the offset is cut a little, as in the archive
    if (ml > 2.6) {
      mx *= 2.6 / ml
      my *= 2.6 / ml
    }
    miter.push({ x: mx, y: my })
    if (d > cosCrease) {
      const sl = Math.max(1e-12, Math.hypot(n1.x + n2.x, n1.y + n2.y))
      smoothN.push({ x: (n1.x + n2.x) / sl, y: (n1.y + n2.y) / sl })
    } else smoothN.push(null)
  }
  return { pts, miter, edgeN, smoothN }
}

/** Every vertex out along its miter, x and y parts scaled apart (boldX / boldY). */
function embolden(pts: V2[], bx: number, by: number): V2[] {
  if (bx === 0 && by === 0) return pts
  const c = makeContour(pts, 0)
  return clean(pts.map((p, i) => ({ x: p.x + c.miter[i].x * bx, y: p.y + c.miter[i].y * by })))
}

// ── profile ───────────────────────────────────────────────────────────────────────────────────────

interface ProfilePt {
  /** offset along the outward miter (≤ 0: into the material) */
  o: number
  /** distance behind the front face */
  d: number
  /** part of the band that STARTS at this point */
  part: number
}

function profileOf(g: TitleGeometryParams): ProfilePt[] {
  const b1 = Math.max(0, g.bevelOuter)
  const st = Math.max(0, g.bevelStep)
  const b2 = Math.max(0, g.bevelInner)
  const front = b1 + st + b2
  const depth = Math.max(front + 0.02, g.depth)
  const prof: ProfilePt[] = [{ o: -(b1 + b2), d: 0, part: PART.bevel1 }]
  if (b1 > 0) prof.push({ o: -b2, d: b1, part: PART.step })
  if (st > 0) prof.push({ o: -b2, d: b1 + st, part: PART.bevel2 })
  if (b2 > 0) prof.push({ o: 0, d: front, part: PART.wall })
  if (prof[prof.length - 1].o !== 0) prof.push({ o: 0, d: front, part: PART.wall })
  prof[prof.length - 1].part = PART.wall
  const seam = Math.max(0, g.seam)
  if (seam > 0) {
    const zc = front + (depth - front) * THREE.MathUtils.clamp(g.seamAt, 0.05, 0.95)
    const w = seam * 0.9
    prof.push({ o: 0, d: zc - w, part: PART.seam })
    prof.push({ o: -seam, d: zc, part: PART.seam })
    prof.push({ o: 0, d: zc + w, part: PART.wall })
  }
  prof.push({ o: 0, d: depth, part: PART.wall })
  return prof
}

// ── the mesh ──────────────────────────────────────────────────────────────────────────────────────

export function buildTitleMesh(g: TitleGeometryParams, text = FONT.text): TitleMesh {
  const seg = Math.max(1, Math.round(g.curveSegments))
  const prof = profileOf(g)
  const depth = prof[prof.length - 1].d
  const k = 1 / FONT.capHeight
  const sx = k * Math.max(0.05, g.condense)

  const pos: number[] = []
  const nor: number[] = []
  const part: number[] = []
  const local: number[] = []
  const glyphId: number[] = []
  const glyphBoxes: [number, number, number, number][] = []

  let gi = 0
  let gcx = 0
  let gcy = 0.5
  const pushV = (x: number, y: number, z: number, nx: number, ny: number, nz: number, pt: number, dFrac: number) => {
    pos.push(x, y, z)
    nor.push(nx, ny, nz)
    part.push(pt, dFrac)
    local.push(x - gcx, y - gcy)
    glyphId.push(gi)
  }
  const tri = (a: V2, b: V2, c: V2, z: number, nz: number, pt: number, dFrac: number) => {
    // wound counter-clockwise as seen from the side the normal points to
    const cr = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
    if (cr * nz < 0) [b, c] = [c, b]
    for (const v of [a, b, c]) pushV(v.x, v.y, z, 0, 0, nz, pt, dFrac)
  }
  const cap = (outer: V2[], holes: V2[][], z: number, nz: number, pt: number, dFrac: number) => {
    const all = outer.concat(...holes)
    const tris = THREE.ShapeUtils.triangulateShape(
      outer.map((p) => new THREE.Vector2(p.x, p.y)),
      holes.map((h) => h.map((p) => new THREE.Vector2(p.x, p.y))),
    )
    for (const t of tris) tri(all[t[0]], all[t[1]], all[t[2]], z, nz, pt, dFrac)
  }

  const chars = [...text]
  let cursor = 0
  // size of the current word (the second and later: word2Scale), and where it starts
  let ws = 1
  let w0 = 0
  for (let ci = 0; ci < chars.length; ci++) {
    const ch = chars[ci]
    const glyph = FONT.glyphs[ch]
    if (!glyph) {
      cursor += g.wordSpace
      ws = Math.max(0.2, g.word2Scale ?? 1)
      w0 = cursor
      continue
    }
    // laid out unscaled (the word's own scale is applied about w0 below); the glyph's own shift on top
    const dx = (g.shift?.[gi] ?? 0) / ws
    const gw = g.widths?.[ch] ?? 1
    const ox = w0 + (cursor - w0) / ws + Math.max(0, g.boldX) + dx
    const mid = ox + (glyph.adv * sx) / 2
    const rings = flatten(glyph.cmds, seg, ox, sx, k)
      .map((r) => (gw === 1 ? r : r.map((q) => ({ x: mid + (q.x - mid) * gw, y: q.y }))))
      .map(clean)
      .filter((r) => r.length >= 3 && Math.abs(area(r)) > 1e-9)
    // the word's size: scaled about its start on the baseline (the weight scales with it)
    const sc = (r: V2[]) => (ws === 1 ? r : r.map((q) => ({ x: w0 + (q.x - w0) * ws, y: q.y * ws })))
    const shapes = nest(rings.map(sc)).map((s) => ({
      outer: embolden(s.outer, g.boldX * ws, g.boldY * ws),
      holes: s.holes.map((h) => embolden(h, g.boldX * ws, g.boldY * ws)),
    }))
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const s of shapes)
      for (const p of s.outer) {
        x0 = Math.min(x0, p.x)
        y0 = Math.min(y0, p.y)
        x1 = Math.max(x1, p.x)
        y1 = Math.max(y1, p.y)
      }
    glyphBoxes.push([x0, y0, x1, y1])
    gcx = (x0 + x1) / 2
    gcy = (y0 + y1) / 2

    for (const s of shapes) {
      const outer = makeContour(s.outer, g.crease)
      const holes = s.holes.map((h) => makeContour(h, g.crease))
      const inset = (c: Contour, o: number) => c.pts.map((q, i) => ({ x: q.x + c.miter[i].x * o, y: q.y + c.miter[i].y * o }))

      // front cap (inset by the whole bevel) and back cap (the fat outline itself)
      cap(inset(outer, prof[0].o), holes.map((h) => inset(h, prof[0].o)), 0, 1, PART.face, 0)
      cap(outer.pts, holes.map((h) => h.pts), -depth, -1, PART.back, 1)

      // the profile swept along every contour
      for (const c of [outer, ...holes]) {
        const n = c.pts.length
        for (let b = 0; b < prof.length - 1; b++) {
          const A = prof[b]
          const B = prof[b + 1]
          const dO = B.o - A.o
          const dD = B.d - A.d
          const len = Math.hypot(dO, dD) || 1
          // band normal in (outward, toward the viewer): perpendicular to its slope in the profile
          const pn = dD / len
          const pz = dO / len
          const fa = A.d / depth
          const fb = B.d / depth
          for (let i = 0; i < n; i++) {
            const j = (i + 1) % n
            const nI = c.smoothN[i] ?? c.edgeN[i]
            const nJ = c.smoothN[j] ?? c.edgeN[i]
            const P = (idx: number, q: ProfilePt) =>
              [c.pts[idx].x + c.miter[idx].x * q.o, c.pts[idx].y + c.miter[idx].y * q.o, -q.d] as const
            const a = P(i, A)
            const bb = P(j, A)
            const a1 = P(i, B)
            const b1 = P(j, B)
            const NI = [nI.x * pn, nI.y * pn, pz] as const
            const NJ = [nJ.x * pn, nJ.y * pn, pz] as const
            pushV(...a, ...NI, A.part, fa)
            pushV(...b1, ...NJ, A.part, fb)
            pushV(...bb, ...NJ, A.part, fa)
            pushV(...a, ...NI, A.part, fa)
            pushV(...a1, ...NI, A.part, fb)
            pushV(...b1, ...NJ, A.part, fb)
          }
        }
      }
    }
    gi++

    const next = chars[ci + 1]
    const kern = next ? FONT.kern[ch + next] ?? 0 : 0
    // within a scaled word the advance is scaled too: cursor = w0 + ws · (unscaled run)
    cursor += ((glyph.adv + kern) * sx + 2 * Math.max(0, g.boldX) + g.tracking) * ws
  }

  // ── bend: the line wrapped around a vertical cylinder behind it (the far end turns away) ──
  const bendRad = THREE.MathUtils.degToRad(g.bend)
  if (Math.abs(bendRad) > 1e-4) {
    let x0 = Infinity
    let x1 = -Infinity
    for (let i = 0; i < pos.length; i += 3) {
      x0 = Math.min(x0, pos[i])
      x1 = Math.max(x1, pos[i])
    }
    const xm = (x0 + x1) / 2
    const R = (x1 - x0) / bendRad
    for (let i = 0; i < pos.length; i += 3) {
      const a = (pos[i] - xm) / R
      const c = Math.cos(a)
      const s = Math.sin(a)
      const nx = nor[i]
      const nz = nor[i + 2]
      nor[i] = nx * c + nz * s
      nor[i + 2] = -nx * s + nz * c
      const r = R + pos[i + 2]
      pos[i] = xm + r * s
      pos[i + 2] = r * c - R
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  geometry.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 2))
  geometry.setAttribute('aLocal', new THREE.Float32BufferAttribute(local, 2))
  geometry.setAttribute('aGlyph', new THREE.Float32BufferAttribute(glyphId, 1))
  geometry.computeBoundingBox()
  return { geometry, bounds: geometry.boundingBox!.clone(), glyphBoxes, text }
}
