import type { Layout } from '../../core/types'
import type { WorldParams } from './params'
import { CUMULUS_SKY_FS, PUFF_FS, PUFF_VS } from './cumulus-shaders'
import { FULLSCREEN_VS } from './shaders'

/**
 * CUMULUS — the full-screen golden-hour sky of version 2 (look.scene = 'cumulus').
 *
 * A pitched camera looks up at a deck of small cumulus / altocumulus (base height 1,
 * horizon below the screen). Every cloud is a heap of soft "cloudlet" sprites standing
 * on one flat base (look.flakes: a few big puffs … many small flakes); the sprites are camera-facing, perspective-projected and drawn far → near,
 * so the field gets denser and smaller toward the bottom of the screen by itself, and
 * near clouds overlap far ones. Each cloudlet is shaped and lit per pixel from the
 * baked billow noise (shaders.ts): lumpy cauliflower outline, sunlit side warm,
 * shaded side / flat base cool grey-violet, aerial haze with distance.
 * Behind the sprites one full-screen pass draws the sky gradient and the warm low haze.
 * Big heaps also get one large, very soft "veil" sprite behind their flakes: the thin,
 * translucent cloud matter that joins the far flakes into hazy bands.
 *
 * Cloud positions live on a periodic deck tile (TILE_X × TILE_Z): the wind slides the
 * tile, sprites wrap around it (far outside the view). Wrapping in depth changes the
 * draw order only at the wrap point, so the far → near order is one rotation of the
 * order sorted once at start-up (two instanced draws).
 */

const TILE_X = 4.8
const TILE_Z = 5.2
/** Nearest deck distance of the tile (cloud-base height = 1). */
const Z0 = 0.3
/** Average distance between cloud centres, world units. */
const SPACING = 0.1
/**
 * Floats per instance: A = (x, z, base height, radius), B = (centre above base, seed,
 * strength, random), C = (height of the whole heap, random per heap, 1 = veil, -).
 */
const STRIDE = 12

const COMMON_UNIFORMS = [
  'uCanvas', 'uPxScale', 'uCenter', 'uF', 'uPitch', 'uSunDir', 'uZenith', 'uHorizon', 'uHazeCol',
  'uShade', 'uLit', 'uGradient', 'uVeil', 'uSunSide', 'uGrain', 'uFrame',
] as const
const PUFF_UNIFORMS = [
  ...COMMON_UNIFORMS, 'uWind', 'uDetail', 'uTileXZ', 'uZ0', 'uView', 'uShift', 'uCoverage', 'uClear', 'uFarCover',
  'uSizeK', 'uThick', 'uVeils', 'uSunV', 'uGlow', 'uErosion', 'uSoft', 'uDensity', 'uShadow', 'uHazeK', 'uFarShade', 'uEvolveZ',
] as const

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Periodic value-noise fbm on the unit square (wraps with the deck tile). */
function periodicFbm(rnd: () => number, px: number, pz: number, octaves: number) {
  const grids: Float32Array[] = []
  for (let o = 0; o < octaves; o++) {
    const nx = px << o
    const nz = pz << o
    const g = new Float32Array(nx * nz)
    for (let i = 0; i < g.length; i++) g[i] = rnd()
    grids.push(g)
  }
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)
  return (u: number, v: number) => {
    let sum = 0
    let amp = 0.5
    let norm = 0
    for (let o = 0; o < octaves; o++) {
      const nx = px << o
      const nz = pz << o
      const g = grids[o]
      const x = (((u % 1) + 1) % 1) * nx
      const z = (((v % 1) + 1) % 1) * nz
      const ix = Math.floor(x)
      const iz = Math.floor(z)
      const fx = fade(x - ix)
      const fz = fade(z - iz)
      const at = (i: number, k: number) => g[((k % nz) + nz) % nz * nx + (((i % nx) + nx) % nx)]
      const a = at(ix, iz) + (at(ix + 1, iz) - at(ix, iz)) * fx
      const b = at(ix, iz + 1) + (at(ix + 1, iz + 1) - at(ix, iz + 1)) * fx
      sum += amp * (a + (b - a) * fz)
      norm += amp
      amp *= 0.5
    }
    return sum / norm
  }
}

/**
 * Cloud layout on the deck tile. Clouds gather in warped groups with clear gaps;
 * strength (0…1, uniformly distributed) decides the order in which clouds appear
 * as `coverage` grows, so coverage is live-tunable without rebuilding anything.
 */
function generate(seed: number, flakes: number): { data: Float32Array; count: number } {
  const rnd = mulberry32(seed * 7919 + 13)
  // Groups run in loose diagonal bands (sheared lattice, still periodic on the tile):
  // on screen they rise from the lower left toward the upper right, as on the reference.
  const bands = periodicFbm(rnd, 9, 4, 4)
  const groups = (u: number, v: number) => bands(u + v, v)
  const warpX = periodicFbm(rnd, 5, 4, 3)
  const warpZ = periodicFbm(rnd, 5, 4, 3)

  interface Cloud { x: number; z: number; s: number; c: number }
  const clouds: Cloud[] = []
  const nx = Math.round(TILE_X / SPACING)
  const nz = Math.round(TILE_Z / SPACING)
  const sx = TILE_X / nx
  const sz = TILE_Z / nz
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const x = (ix + rnd()) * sx - TILE_X / 2
      const z = (iz + rnd()) * sz + Z0
      const u = (x + TILE_X / 2) / TILE_X
      const v = (z - Z0) / TILE_Z
      const wu = u + (warpX(u, v) - 0.5) * 0.12
      const wv = v + (warpZ(u, v) - 0.5) * 0.12
      const c = groups(wu, wv)
      clouds.push({ x, z, s: 0.85 * c + 0.15 * rnd(), c })
    }
  }
  // strength → rank (uniform 0…1): coverage = share of clouds shown; same for the group value
  const rank = (key: 's' | 'c') => {
    const order = clouds.map((_, i) => i).sort((a, b) => clouds[a][key] - clouds[b][key])
    order.forEach((ci, r) => (clouds[ci][key] = (r + 0.5) / order.length))
  }
  rank('s')
  rank('c')

  const out: number[][] = []
  for (const cl of clouds) {
    // Heap half-width: mostly small and medium clouds, bigger ones in the middle of the
    // groups (the shader also shrinks clouds that are only just above the coverage
    // threshold, so sparse sky gets small strays).
    const S = SPACING * (0.35 + 0.5 * Math.pow(rnd(), 2) + 0.8 * Math.pow(cl.c, 4))
    // flakes: the same heap made of more, smaller, lower cloudlets (altocumulus floccus)
    const rf = 1 - 0.5 * flakes
    const n = Math.max(1, Math.min(32, Math.round(1 + ((S / 0.02) * (0.6 + 0.6 * rnd())) / (rf * rf))))
    const base = 1 + (rnd() - 0.5) * 0.06
    const heapRnd = rnd()
    const rows: number[][] = []
    let top = 0
    for (let k = 0; k < n; k++) {
      // cloudlets fill a flattened dome: wide at the base, a few towers toward the middle
      const ang = rnd() * Math.PI * 2
      const dist = k === 0 ? 0 : S * Math.sqrt(rnd()) * 0.85
      const rel = dist / S
      const r = S * rf * (k === 0 ? 0.5 : 0.28 + 0.22 * rnd()) * (1 - 0.35 * rel)
      const hc = r * 0.45 + (1 - rel) * S * rf * (0.15 + 0.45 * rnd())
      top = Math.max(top, hc + r)
      rows.push([cl.x + Math.cos(ang) * dist * 1.2, cl.z + Math.sin(ang) * dist * 0.75, base, r, hc, rnd(), cl.s, rnd()])
    }
    // the heap's height, for top-lit shading of the whole cloud
    for (const row of rows) out.push([...row, top, heapRnd, 0, 0])
    // a thin, soft veil of cloud matter around the heap (drawn just behind its flakes)
    if (S > SPACING * 0.45) out.push([cl.x, cl.z + S * 0.4, base, S * 1.2, S * 0.15, rnd(), cl.s, rnd(), top, heapRnd, 1, 0])
  }
  // far → near (descending z): see the wrap note at the top
  out.sort((a, b) => b[1] - a[1])
  const data = new Float32Array(out.length * STRIDE)
  out.forEach((row, i) => data.set(row, i * STRIDE))
  return { data, count: out.length }
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const make = (type: number, src: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      const log = gl.getShaderInfoLog(s)
      gl.deleteShader(s)
      throw new Error(`[world/cumulus] shader compile failed: ${log}`)
    }
    return s
  }
  const p = gl.createProgram()!
  const v = make(gl.VERTEX_SHADER, vs)
  const f = make(gl.FRAGMENT_SHADER, fs)
  gl.attachShader(p, v)
  gl.attachShader(p, f)
  gl.linkProgram(p)
  gl.deleteShader(v)
  gl.deleteShader(f)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`[world/cumulus] program link failed: ${gl.getProgramInfoLog(p)}`)
  }
  return p
}

export interface CumulusFrame {
  p: WorldParams
  layout: Layout
  /** Canvas size, render px. */
  W: number
  H: number
  /** Screen shift of the sky (world offset + parallax), CSS px. */
  shift: [number, number]
  /** Cloud-field offset (deck units; the clouds move by −wind). */
  wind: [number, number]
  /** Slow change of shape: offset along the time axis of the billow noise (3D noise tiles). */
  evolveZ: number
  /** Film-grain frame number (24 fps). */
  frame: number
  /** Baked 3D billow noise (shared with version 1). */
  detail: WebGLTexture
  vao: WebGLVertexArrayObject
  /** sRGB hex → linear RGB. */
  lin: (hex: string) => [number, number, number]
}

export interface CumulusRenderer {
  render(f: CumulusFrame): void
  dispose(): void
}

export function createCumulus(gl: WebGL2RenderingContext): CumulusRenderer {
  const skyProg = compile(gl, FULLSCREEN_VS, CUMULUS_SKY_FS)
  const puffProg = compile(gl, PUFF_VS, PUFF_FS)
  const loc = <T extends string>(prog: WebGLProgram, names: readonly T[]) => {
    const u = {} as Record<T, WebGLUniformLocation | null>
    for (const n of names) u[n] = gl.getUniformLocation(prog, n)
    return u
  }
  const us = loc(skyProg, COMMON_UNIFORMS)
  const up = loc(puffProg, PUFF_UNIFORMS)

  const buf = gl.createBuffer()!
  const vao = gl.createVertexArray()!
  let count = 0
  let layoutKey = ''
  /** Base z of every instance (descending), for the wrap split. */
  let zs = new Float32Array(0)

  function upload(seed: number, flakes: number) {
    const g = generate(seed, flakes)
    count = g.count
    layoutKey = `${seed}/${flakes}`
    zs = new Float32Array(count)
    for (let i = 0; i < count; i++) zs[i] = g.data[i * STRIDE + 1]
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, g.data, gl.STATIC_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
  }

  /** Instances [0, k) have wrapped to the near side: z − Z0 + shift ≥ TILE_Z. */
  function wrapSplit(shift: number) {
    const lim = Z0 + TILE_Z - shift
    let lo = 0
    let hi = count
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (zs[mid] >= lim) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /** Points the instance attributes at instance `first` (draw ranges without base-instance). */
  function attribs(first: number) {
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    const bytes = STRIDE * 4
    for (let i = 0; i < 3; i++) {
      gl.enableVertexAttribArray(i)
      gl.vertexAttribPointer(i, 4, gl.FLOAT, false, bytes, first * bytes + i * 16)
      gl.vertexAttribDivisor(i, 1)
    }
  }

  function render(f: CumulusFrame) {
    const { p, layout, W, H } = f
    const seed = Math.round(p.cloudSeed)
    const flakes = Math.round(Math.min(1, Math.max(0, p.flakes)) * 20) / 20
    if (`${seed}/${flakes}` !== layoutKey) upload(seed, flakes)

    const pxScale = W / layout.width
    const vfov = (Math.max(5, Math.min(90, p.vfov)) * Math.PI) / 180
    const F = layout.height / 2 / Math.tan(vfov / 2)
    const pitch = (Math.max(1, Math.min(85, p.pitch)) * Math.PI) / 180
    const cp = Math.cos(pitch)
    const sp = Math.sin(pitch)
    const cx = layout.width / 2 + f.shift[0]
    const cy = layout.height / 2 + f.shift[1]

    const az = (p.sunAzimuth * Math.PI) / 180
    const el = (p.sunElevation * Math.PI) / 180
    const sun = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)]
    // view space: x right, y up (screen), z toward the camera
    const sunV = [sun[0], sun[1] * cp - sun[2] * sp, -(sun[1] * sp + sun[2] * cp)]
    const sl = Math.hypot(sunV[0], sunV[1], sunV[2]) || 1

    const zen = f.lin(p.zenith)
    const hor = f.lin(p.horizon)
    const haze = f.lin(p.hazeColor)
    const shade = f.lin(p.cloudShade)
    const lit = f.lin(p.cloudLit)
    const glow = f.lin(p.cloudGlow)

    const common = (u: Record<(typeof COMMON_UNIFORMS)[number], WebGLUniformLocation | null>) => {
      gl.uniform2f(u.uCanvas, W, H)
      gl.uniform1f(u.uPxScale, pxScale)
      gl.uniform2f(u.uCenter, cx, cy)
      gl.uniform1f(u.uF, F)
      gl.uniform2f(u.uPitch, cp, sp)
      gl.uniform3f(u.uSunDir, sun[0], sun[1], sun[2])
      gl.uniform3fv(u.uZenith, zen)
      gl.uniform3fv(u.uHorizon, hor)
      gl.uniform3fv(u.uHazeCol, haze)
      gl.uniform3fv(u.uShade, shade)
      gl.uniform3fv(u.uLit, lit)
      gl.uniform1f(u.uGradient, (Math.max(1, p.gradient) * Math.PI) / 180)
      gl.uniform1f(u.uVeil, Math.max(0, p.veil))
      gl.uniform1f(u.uSunSide, p.sunSide)
      gl.uniform1f(u.uGrain, Math.max(0, p.grain))
      gl.uniform1f(u.uFrame, f.frame)
    }

    gl.viewport(0, 0, W, H)
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.BLEND)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_3D, f.detail)

    const clear = [Math.min(1, Math.max(0, p.clearTop)), Math.max(0.05, p.clearDepth), p.clearTilt] as const

    // 1. sky
    gl.useProgram(skyProg)
    common(us)
    gl.bindVertexArray(f.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    if (p.coverage <= 0) {
      gl.bindVertexArray(null)
      return
    }

    // 2. clouds, far → near, premultiplied "over"
    gl.useProgram(puffProg)
    common(up)
    gl.uniform1i(up.uDetail, 0)
    gl.uniform2f(up.uWind, f.wind[0], f.wind[1])
    gl.uniform2f(up.uTileXZ, TILE_X, TILE_Z)
    gl.uniform1f(up.uZ0, Z0)
    gl.uniform2f(up.uView, layout.width, layout.height)
    gl.uniform1f(up.uCoverage, Math.min(1, Math.max(0, p.coverage)))
    gl.uniform2f(up.uShift, f.shift[0], f.shift[1])
    gl.uniform3f(up.uClear, clear[0], clear[1], clear[2])
    gl.uniform1f(up.uFarCover, p.farCover)
    gl.uniform1f(up.uSizeK, Math.max(0.05, p.size))
    gl.uniform1f(up.uThick, Math.max(0, p.thickness))
    gl.uniform1f(up.uVeils, Math.max(0, p.veils))
    gl.uniform3f(up.uSunV, sunV[0] / sl, sunV[1] / sl, sunV[2] / sl)
    gl.uniform3fv(up.uGlow, glow)
    gl.uniform1f(up.uErosion, Math.max(0, p.puffiness))
    gl.uniform1f(up.uSoft, Math.max(0.01, p.softness))
    gl.uniform1f(up.uDensity, Math.max(0, p.density))
    gl.uniform1f(up.uShadow, Math.max(0, p.selfShadow))
    gl.uniform1f(up.uHazeK, p.haze > 0 ? p.haze / 11 : 0)
    gl.uniform1f(up.uFarShade, Math.max(0, p.farShade))
    gl.uniform1f(up.uEvolveZ, f.evolveZ)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    // instances are sorted by base z, descending; the wind moved them by −wind.z (mod tile)
    const shiftZ = ((-f.wind[1] % TILE_Z) + TILE_Z) % TILE_Z
    const k = wrapSplit(shiftZ)
    // instances [0, k) wrapped to the near side → drawn last
    if (count - k > 0) {
      attribs(k)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count - k)
    }
    if (k > 0) {
      attribs(0)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, k)
    }
    gl.disable(gl.BLEND)
    gl.bindVertexArray(null)
  }

  return {
    render,
    dispose() {
      if (!gl.isContextLost()) {
        gl.deleteProgram(skyProg)
        gl.deleteProgram(puffProg)
        gl.deleteBuffer(buf)
        gl.deleteVertexArray(vao)
      }
    },
  }
}
