import * as THREE from 'three'
import glyphData from './glyphs.json'
import type { MeshTitleParams } from './params'

/**
 * "SLAVA VOLKOV" as one extruded mesh, built the way late-90s logo tools
 * (Xara3D / Cool 3D) did it: front cap + a profile swept along every contour.
 *
 * Profile (front → back), o = outward offset of the contour, d = depth:
 *   front cap edge  (-(b1+b2), 0)
 *   chamfer 1   →   (-b2, b1)
 *   flat step   →   (-b2, b1+step)
 *   chamfer 2   →   (0,  b1+step+b2)
 *   side wall   →   seam groove → side wall → back
 * Every band has its own vertices (hard edges between bands = crisp bevel lines);
 * along the contour, normals are smoothed unless the corner is sharper than `crease`.
 *
 * Units: 1 = cap height. Object space: x right, y up, front face at z = 0 facing +z,
 * then the whole thing is re-centred so rotations pivot around the middle of the title.
 */

/** Part ids written to the `aPart` attribute (read by the shader). */
export const PART = { face: 0, bevel1: 1, step: 2, bevel2: 3, side: 4, seam: 5 } as const

export interface TitleMesh {
  geometry: THREE.BufferGeometry
  /** Silhouette sample points (xyz, centred) — for fitting the projection to layout.title. */
  hull: Float32Array
  /** Same, only for the first glyph "S" — its left edge / vertical middle is the anchor. */
  hullS: Float32Array
  /** Bounds of the silhouette samples after centring (object space). */
  bounds: THREE.Box3
}

type Cmd = (string | number)[]
interface GlyphJson {
  unitsPerEm: number
  capHeight: number
  space: number
  text: string
  glyphs: Record<string, { adv: number; cmds: Cmd[] }>
  kern: Record<string, number>
}
const data = glyphData as unknown as GlyphJson

interface Contour {
  pts: THREE.Vector2[]
  /** per-vertex miter offset vectors (move edges by 1 unit) */
  miter: THREE.Vector2[]
  /** outward unit normal of edge i (from pts[i] to pts[i+1]) */
  edgeN: THREE.Vector2[]
  /** per-vertex smoothed normal, or null if the corner is a crease */
  smoothN: (THREE.Vector2 | null)[]
}

function glyphShapes(ch: string, scaleX: number, offsetX: number, segments: number) {
  const g = data.glyphs[ch]
  const k = 1 / data.capHeight
  const sp = new THREE.ShapePath()
  const X = (v: number) => offsetX + v * k * scaleX
  const Y = (v: number) => v * k
  for (const c of g.cmds) {
    const n = c.slice(1) as number[]
    switch (c[0]) {
      case 'M': sp.moveTo(X(n[0]), Y(n[1])); break
      case 'L': sp.lineTo(X(n[0]), Y(n[1])); break
      case 'Q': sp.quadraticCurveTo(X(n[0]), Y(n[1]), X(n[2]), Y(n[3])); break
      case 'C': sp.bezierCurveTo(X(n[0]), Y(n[1]), X(n[2]), Y(n[3]), X(n[4]), Y(n[5])); break
    }
  }
  return sp.toShapes().map((s) => s.extractPoints(segments))
}

function clean(pts: THREE.Vector2[]) {
  const out: THREE.Vector2[] = []
  for (const p of pts) {
    if (out.length && out[out.length - 1].distanceTo(p) < 1e-5) continue
    out.push(p.clone())
  }
  while (out.length > 2 && out[0].distanceTo(out[out.length - 1]) < 1e-5) out.pop()
  // drop exactly collinear points (keeps facets honest, avoids zero-area slivers)
  for (let i = out.length - 1; i >= 0 && out.length > 3; i--) {
    const a = out[(i - 1 + out.length) % out.length]
    const b = out[i]
    const c = out[(i + 1) % out.length]
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (Math.abs(cross) < 1e-7) out.splice(i, 1)
  }
  return out
}

/** Makes a contour with the material on its LEFT (outer = CCW, hole = CW). */
function makeContour(raw: THREE.Vector2[], isHole: boolean, creaseDeg: number): Contour {
  let pts = clean(raw)
  const ccw = !THREE.ShapeUtils.isClockWise(pts)
  if (ccw === isHole) pts = pts.reverse()
  const n = pts.length
  const edgeN: THREE.Vector2[] = []
  for (let i = 0; i < n; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    const e = new THREE.Vector2(b.x - a.x, b.y - a.y).normalize()
    edgeN.push(new THREE.Vector2(e.y, -e.x)) // right-hand normal = outward
  }
  const cosCrease = Math.cos(THREE.MathUtils.degToRad(creaseDeg))
  const miter: THREE.Vector2[] = []
  const smoothN: (THREE.Vector2 | null)[] = []
  for (let i = 0; i < n; i++) {
    const n1 = edgeN[(i - 1 + n) % n]
    const n2 = edgeN[i]
    const d = n1.dot(n2)
    const m = n1.clone().add(n2).divideScalar(Math.max(0.15, 1 + d))
    if (m.length() > 2.6) m.setLength(2.6)
    miter.push(m)
    smoothN.push(d > cosCrease ? n1.clone().add(n2).normalize() : null)
  }
  return { pts, miter, edgeN, smoothN }
}

interface ProfilePt { o: number; d: number; part: number }

function buildProfile(g: MeshTitleParams['geometry']): ProfilePt[] {
  const b1 = Math.max(0, g.bevelOuter)
  const st = Math.max(0, g.bevelStep)
  const b2 = Math.max(0, g.bevelInner)
  const depth = Math.max(b1 + st + b2 + 0.02, g.depth)
  const front = b1 + st + b2
  const prof: ProfilePt[] = [{ o: -(b1 + b2), d: 0, part: PART.bevel1 }]
  if (b1 > 0) prof.push({ o: -b2, d: b1, part: PART.step })
  if (st > 0) prof.push({ o: -b2, d: b1 + st, part: PART.bevel2 })
  if (b2 > 0) prof.push({ o: 0, d: front, part: PART.side })
  // part of a point = part of the band that STARTS at it
  const seam = Math.max(0, g.seam)
  const sAt = THREE.MathUtils.clamp(g.seamAt, 0.05, 0.95)
  if (seam > 0) {
    const zc = front + (depth - front) * sAt
    const w = seam * 0.9
    prof.push({ o: 0, d: zc - w, part: PART.seam })
    prof.push({ o: -seam, d: zc, part: PART.seam })
    prof.push({ o: 0, d: zc + w, part: PART.side })
  }
  prof.push({ o: 0, d: depth, part: PART.side })
  return prof
}

export function buildTitleMesh(p: MeshTitleParams): TitleMesh {
  const g = p.geometry
  const seg = Math.max(1, Math.round(g.curveSegments))
  const prof = buildProfile(g)
  const depth = prof[prof.length - 1].d
  const front = prof.find((q) => q.o === 0)?.d ?? 0

  const pos: number[] = []
  const nor: number[] = []
  const part: number[] = []
  const local: number[] = []
  const hull: number[] = []
  const hullS: number[] = []

  // glyph-local coords (x from the glyph centre, y from mid cap height) → "pillow" normals in the shader
  let glyphCx = 0
  const pushV = (x: number, y: number, z: number, nx: number, ny: number, nz: number, pt: number, dFrac: number) => {
    pos.push(x, y, z)
    nor.push(nx, ny, nz)
    part.push(pt, dFrac)
    local.push(x - glyphCx, y - 0.5)
  }

  let cursor = 0
  const text = data.text
  for (let ci = 0; ci < text.length; ci++) {
    const ch = text[ci]
    if (ch === ' ') {
      cursor += g.wordSpace
      continue
    }
    const glyph = data.glyphs[ch]
    const shapes = glyphShapes(ch, g.condense, cursor, seg)
    glyphCx = cursor + ((glyph.adv / data.capHeight) * g.condense) / 2

    for (const sh of shapes) {
      const outer = makeContour(sh.shape, false, g.crease)
      const holes = sh.holes.map((h) => makeContour(h, true, g.crease))

      // ── front cap (inset by the full bevel) ───────────────────────────────
      const o0 = prof[0].o
      const inset = (c: Contour) => c.pts.map((q, i) => q.clone().addScaledVector(c.miter[i], o0))
      const fo = inset(outer)
      const fh = holes.map(inset)
      const tris = THREE.ShapeUtils.triangulateShape(fo, fh)
      const all = fo.concat(...fh)
      for (const t of tris) {
        let [a, b, c] = t.map((i) => all[i])
        const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
        if (area < 0) [b, c] = [c, b]
        for (const v of [a, b, c]) pushV(v.x, v.y, 0, 0, 0, 1, PART.face, 0)
      }

      // ── swept profile bands ───────────────────────────────────────────────
      for (const c of [outer, ...holes]) {
        const n = c.pts.length
        for (let k = 0; k < prof.length - 1; k++) {
          const A = prof[k]
          const B = prof[k + 1]
          const dO = B.o - A.o
          const dD = B.d - A.d
          const len = Math.hypot(dO, dD) || 1
          const pd = dD / len
          const pz = dO / len
          for (let i = 0; i < n; i++) {
            const j = (i + 1) % n
            const nI = c.smoothN[i] ?? c.edgeN[i]
            const nJ = c.smoothN[j] ?? c.edgeN[i]
            const P = (idx: number, q: ProfilePt) => {
              const v = c.pts[idx]
              const m = c.miter[idx]
              return [v.x + m.x * q.o, v.y + m.y * q.o, -q.d] as const
            }
            const a = P(i, A)
            const b = P(j, A)
            const a1 = P(i, B)
            const b1 = P(j, B)
            const NI = [nI.x * pd, nI.y * pd, pz] as const
            const NJ = [nJ.x * pd, nJ.y * pd, pz] as const
            const fa = A.d / depth
            const fb = B.d / depth
            // (a, b1, b) and (a, a1, b1) → outward winding
            pushV(...a, ...NI, A.part, fa)
            pushV(...b1, ...NJ, A.part, fb)
            pushV(...b, ...NJ, A.part, fa)
            pushV(...a, ...NI, A.part, fa)
            pushV(...a1, ...NI, A.part, fb)
            pushV(...b1, ...NJ, A.part, fb)
          }
        }
        // silhouette samples: outer outline at the front of the side wall and at the back
        if (c === outer) {
          for (let i = 0; i < n; i++) {
            for (const d of [front, depth]) {
              const v = c.pts[i]
              hull.push(v.x, v.y, -d)
              if (ci === 0) hullS.push(v.x, v.y, -d)
            }
          }
        }
      }
    }

    const next = text[ci + 1]
    const kern = next ? data.kern[ch + next] ?? 0 : 0
    cursor += ((glyph.adv + kern) / data.capHeight) * g.condense + g.tracking
  }

  // ── bend: wrap the line of text around a vertical cylinder behind it ────────
  // The far end turns away faster (VOLKOV shrinks quicker than SLAVA), the near end
  // becomes more frontal — like the reference render.
  const bendRad = THREE.MathUtils.degToRad(g.bend)
  if (Math.abs(bendRad) > 1e-4) {
    let x0 = Infinity
    let x1 = -Infinity
    for (let i = 0; i < hull.length; i += 3) {
      x0 = Math.min(x0, hull[i])
      x1 = Math.max(x1, hull[i])
    }
    const xm = (x0 + x1) / 2
    const Rr = (x1 - x0) / bendRad
    const wrap = (arr: number[], isNormal: boolean, ref?: number[]) => {
      for (let i = 0; i < arr.length; i += 3) {
        const px = ref ? ref[i] : arr[i]
        const a = (px - xm) / Rr
        const c = Math.cos(a)
        const sn = Math.sin(a)
        if (isNormal) {
          const nx = arr[i]
          const nz = arr[i + 2]
          arr[i] = nx * c + nz * sn
          arr[i + 2] = -nx * sn + nz * c
        } else {
          const r = Rr + arr[i + 2]
          arr[i] = xm + r * sn
          arr[i + 2] = r * c - Rr
        }
      }
    }
    wrap(nor, true, pos)
    wrap(pos, false)
    wrap(hull, false)
    wrap(hullS, false)
  }

  // ── centre ────────────────────────────────────────────────────────────────
  const box = new THREE.Box3()
  for (let i = 0; i < hull.length; i += 3) box.expandByPoint(new THREE.Vector3(hull[i], hull[i + 1], hull[i + 2]))
  const center = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())
  const shift = (arr: number[]) => {
    for (let i = 0; i < arr.length; i += 3) {
      arr[i] -= center.x
      arr[i + 1] -= center.y
      arr[i + 2] -= center.z
    }
  }
  shift(pos)
  shift(hull)
  shift(hullS)

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  geometry.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 2))
  geometry.setAttribute('aLocal', new THREE.Float32BufferAttribute(local, 2))
  const bounds = new THREE.Box3(size.clone().multiplyScalar(-0.5), size.clone().multiplyScalar(0.5))
  return { geometry, hull: new Float32Array(hull), hullS: new Float32Array(hullS), bounds }
}
