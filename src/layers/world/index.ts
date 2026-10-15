import type { Frame, LayerFactory, Layout, Rect, ResolvedConfig } from '../../core/types'
import { createCumulus, type CumulusRenderer } from './cumulus'
import { getWorldParams, type WorldParams } from './params'
import { BAKE_DETAIL_FS, BAKE_MAP_FS, FULLSCREEN_VS, SKY_FS } from './shaders'

/**
 * WORLD — a continuous sky behind the paper.
 *
 * One page-space pinhole camera (centre of the hero; shared sun / wind / colours /
 * cloud field). The two cutouts are rendered with a scissor each. Per window
 * (config.world.windows.<w>) three things quietly differ:
 *   horizon    — where the horizon sits (a vertical lens shift);
 *   zoom       — the lens: < 1 widens the view around the same viewing direction,
 *                so the low window still reaches up into blue sky;
 *   cloudScale — the cloud deck sits lower (clouds closer, larger) in that window,
 *                so near the horizon they read as the same clouds, not as ripple.
 *   drift      — (optional, default 1) wind multiplier, so the far wide-angle
 *                window does not look like a still photo next to the square.
 * Inside each window the view is self-consistent; compared with each other they
 * cannot be the same sky.
 *
 * Clouds: a cumulus deck at height 1 (world units), sampled through baked, mip-
 * mapped noise textures (see shaders.ts), lit by a low sun behind the viewer.
 * Overhead the deck is a thin slice; toward the horizon (only the secondary window
 * looks there) clouds get their height via a short heightfield march.
 * Dev URL helper: ?worldDebug=1|4 shows the baked cloud maps top-down.
 *
 * look.scene = 'cumulus' (version 2, index.html) swaps all of the above for a
 * full-screen golden-hour sky of perspective cloud sprites — see cumulus.ts. It
 * shares the baked noise, the wind and the canvas; the default ('deck') never
 * touches it.
 */

const MAP_SIZE = 1024
const DETAIL_SIZE = 64
/** 3D detail tiles per world unit at size = 1 (puff size). */
const DETAIL_SCALE = 1.1
/** World units (cloud-base height = 1) covered by one texture tile at size = 1. */
const TILE = 8.4
/** Max render pixels per draw call (see the banded draw in render()). */
const BAND_PIXELS = 40000

type WindowName = 'main' | 'secondary'
const WINDOWS: WindowName[] = ['main', 'secondary']
/** ?worldDebug=1|2|3|4 shows the baked cloud fields top-down (dev only). */
const DEBUG = Number(new URLSearchParams(location.search).get('worldDebug')) || 0

const SKY_UNIFORMS = [
  'uMap', 'uDetail', 'uCanvas', 'uPxScale', 'uShift', 'uCx', 'uHy', 'uF', 'uWind', 'uEvolve', 'uSunDir',
  'uZenith', 'uHorizon', 'uLit', 'uShade', 'uGround', 'uGradient', 'uCoverage', 'uSoft',
  'uDensity', 'uShadow', 'uErosion', 'uTile', 'uDetailScale', 'uHaze', 'uVeil', 'uGrain', 'uFrame', 'uDebug',
  'uThick', 'uDeck',
] as const
type SkyUniform = (typeof SKY_UNIFORMS)[number]

const linearCache = new Map<string, [number, number, number]>()
function hexToLinear(hex: string): [number, number, number] {
  const hit = linearCache.get(hex)
  if (hit) return hit
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const v = parseInt(h.slice(0, 6), 16)
  const ch = (x: number) => {
    const c = x / 255
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  const out: [number, number, number] = [ch((v >> 16) & 255), ch((v >> 8) & 255), ch(v & 255)]
  if (linearCache.size > 64) linearCache.clear()
  linearCache.set(hex, out)
  return out
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const make = (type: number, src: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      const log = gl.getShaderInfoLog(s)
      gl.deleteShader(s)
      throw new Error(`[world] shader compile failed: ${log}`)
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
    throw new Error(`[world] program link failed: ${gl.getProgramInfoLog(p)}`)
  }
  return p
}

interface GLState {
  sky: WebGLProgram
  vao: WebGLVertexArrayObject
  map: WebGLTexture
  detail: WebGLTexture
  u: Record<SkyUniform, WebGLUniformLocation | null>
}

/** Bakes the tileable cloud field into a mip-mapped texture (once). */
function bakeMap(gl: WebGL2RenderingContext, vao: WebGLVertexArrayObject): WebGLTexture {
  const prog = compile(gl, FULLSCREEN_VS, BAKE_MAP_FS)
  const tex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, tex)

  const fb = gl.createFramebuffer()!
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
  const levels = Math.log2(MAP_SIZE) + 1
  // Half-float keeps the thresholded cloud edges free of 8-bit contouring.
  let ok = false
  if (gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float')) {
    gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA16F, MAP_SIZE, MAP_SIZE)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
  }
  let texture = tex
  if (!ok) {
    gl.deleteTexture(tex)
    texture = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, MAP_SIZE, MAP_SIZE)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
  }

  gl.viewport(0, 0, MAP_SIZE, MAP_SIZE)
  gl.disable(gl.SCISSOR_TEST)
  gl.disable(gl.BLEND)
  gl.useProgram(prog)
  gl.uniform1f(gl.getUniformLocation(prog, 'uSize'), MAP_SIZE)
  gl.uniform2f(gl.getUniformLocation(prog, 'uSeed'), 17.0, 43.0)
  gl.bindVertexArray(vao)
  gl.drawArrays(gl.TRIANGLES, 0, 3)

  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.deleteFramebuffer(fb)
  gl.deleteProgram(prog)

  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.generateMipmap(gl.TEXTURE_2D)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT)
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic')
  if (aniso) {
    const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number
    gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max))
  }
  return texture
}

/** Bakes the tileable 3D billow noise, one z-slice per draw (once). */
function bakeDetail(gl: WebGL2RenderingContext, vao: WebGLVertexArrayObject): WebGLTexture {
  const prog = compile(gl, FULLSCREEN_VS, BAKE_DETAIL_FS)
  const tex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_3D, tex)
  const levels = Math.log2(DETAIL_SIZE) + 1
  gl.texStorage3D(gl.TEXTURE_3D, levels, gl.RGBA8, DETAIL_SIZE, DETAIL_SIZE, DETAIL_SIZE)
  const fb = gl.createFramebuffer()!
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
  gl.viewport(0, 0, DETAIL_SIZE, DETAIL_SIZE)
  gl.disable(gl.SCISSOR_TEST)
  gl.disable(gl.BLEND)
  gl.useProgram(prog)
  gl.bindVertexArray(vao)
  gl.uniform1f(gl.getUniformLocation(prog, 'uSize'), DETAIL_SIZE)
  const uZ = gl.getUniformLocation(prog, 'uZ')
  for (let z = 0; z < DETAIL_SIZE; z++) {
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, z)
    gl.uniform1f(uZ, z)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.deleteFramebuffer(fb)
  gl.deleteProgram(prog)
  gl.bindTexture(gl.TEXTURE_3D, tex)
  gl.generateMipmap(gl.TEXTURE_3D)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  for (const wrap of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, wrap, gl.REPEAT)
  return tex
}

function initGL(gl: WebGL2RenderingContext): GLState {
  const vao = gl.createVertexArray()!
  const map = bakeMap(gl, vao)
  const detail = bakeDetail(gl, vao)
  const sky = compile(gl, FULLSCREEN_VS, SKY_FS)
  const u = {} as Record<SkyUniform, WebGLUniformLocation | null>
  for (const name of SKY_UNIFORMS) u[name] = gl.getUniformLocation(sky, name)
  return { sky, vao, map, detail, u }
}

/** Fallback when WebGL2 is unavailable: a plain photographic-ish gradient. */
function cssFallback(mount: HTMLElement, scene: WorldParams['scene']) {
  mount.style.background =
    scene === 'cumulus'
      ? 'linear-gradient(#53698d, #7488a6 45%, #a99ea6 85%, #c4a79c)' // golden hour, version 2
      : 'linear-gradient(#4f72a6, #9fb4cf 70%, #c6d0da)'
  return {
    resize() {},
    update() {},
    dispose() {
      mount.style.background = ''
    },
  }
}

export const createWorldLayer: LayerFactory = (mount, ctx) => {
  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;'
  mount.appendChild(canvas)

  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  })
  if (!gl) {
    canvas.remove()
    return cssFallback(mount, getWorldParams(ctx.config).scene)
  }

  let state: GLState | null = initGL(gl)
  /** Version-2 renderer, created on first use (look.scene = 'cumulus'). */
  let cumulus: CumulusRenderer | null = null
  let layout: Layout = ctx.layout
  let renderScale = -1
  // cloud-field offset per window (each window may drift at its own rate)
  let wind: Record<WindowName, [number, number]> | null = null
  let evolve: [number, number, number] = [0, 0, 0]
  let lastTime = 0

  const onLost = (e: Event) => {
    e.preventDefault()
    state = null
    cumulus = null
  }
  const onRestored = () => {
    try {
      state = initGL(gl)
      renderScale = -1
    } catch (err) {
      console.error(err)
    }
  }
  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)

  function sizeCanvas(p: WorldParams) {
    // render pixels per CSS pixel, never above the screen's own density
    const scale = Math.min(layout.dpr, Math.max(0.3, p.renderScale))
    const w = Math.max(1, Math.round(layout.width * scale))
    const h = Math.max(1, Math.round(layout.height * scale))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    renderScale = p.renderScale
  }

  function resize(l: Layout, config: ResolvedConfig) {
    layout = l
    sizeCanvas(getWorldParams(config))
  }

  function render(frame: Frame) {
    if (!state || gl!.isContextLost()) return
    const g = gl!
    const { config, pointer, time } = frame
    const p = getWorldParams(config)
    if (p.renderScale !== renderScale) sizeCanvas(p)
    const world = config.world

    // Wind / evolution integrate from frame time (frozen with ?freeze → still image).
    const dtw = Math.max(0, Math.min(0.25, time - lastTime))
    lastTime = time
    const wa = (p.windAngle * Math.PI) / 180
    const wv: [number, number] = [Math.cos(wa) * p.windSpeed, Math.sin(wa) * p.windSpeed]
    // per-window multiplier: the far, wide-angle window would otherwise look still
    const winDrift = (name: WindowName) => Math.max(0, (world.windows[name] as { drift?: number }).drift ?? 1) * world.drift
    if (!wind) {
      const at = (name: WindowName): [number, number] => [-wv[0] * time * winDrift(name), -wv[1] * time * winDrift(name)]
      wind = { main: at('main'), secondary: at('secondary') }
    } else {
      for (const name of WINDOWS) {
        wind[name][0] -= wv[0] * dtw * winDrift(name)
        wind[name][1] -= wv[1] * dtw * winDrift(name)
      }
    }
    // slow change of shape: macro coverage slides, puffs "boil" (scaled by drift too, so drift 0 = still sky)
    const ev = dtw * p.evolve * world.drift
    evolve = [evolve[0] + 0.0011 * ev, evolve[1] + 0.0007 * ev, evolve[2] + 0.004 * ev]

    const W = canvas.width
    const H = canvas.height
    if (p.scene === 'cumulus') {
      cumulus ??= createCumulus(g)
      const win = world.windows.main
      cumulus.render({
        p,
        layout,
        W,
        H,
        shift: [world.offset.x + win.offset.x - pointer.x * world.parallax, world.offset.y + win.offset.y - pointer.y * world.parallax],
        wind: wind.main,
        evolveZ: evolve[2],
        frame: Math.floor(time * 24),
        detail: state.detail,
        vao: state.vao,
        lin: hexToLinear,
      })
      return
    }
    const pxScale = W / layout.width
    const main = layout.cutouts.main
    const fovRad = (Math.max(2, Math.min(120, p.fov)) * Math.PI) / 180
    const focal = main.w / (2 * Math.tan(fovRad / 2))

    const az = (p.sunAzimuth * Math.PI) / 180
    const el = (p.sunElevation * Math.PI) / 180
    const sun = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)]

    g.viewport(0, 0, W, H)
    g.disable(g.SCISSOR_TEST)
    g.clearColor(0, 0, 0, 0)
    g.clear(g.COLOR_BUFFER_BIT)

    const { u } = state
    g.useProgram(state.sky)
    g.bindVertexArray(state.vao)
    g.activeTexture(g.TEXTURE0)
    g.bindTexture(g.TEXTURE_2D, state.map)
    g.uniform1i(u.uMap, 0)
    g.activeTexture(g.TEXTURE1)
    g.bindTexture(g.TEXTURE_3D, state.detail)
    g.uniform1i(u.uDetail, 1)
    g.uniform2f(u.uCanvas, W, H)
    g.uniform1f(u.uPxScale, pxScale)
    g.uniform1f(u.uCx, layout.width / 2)
    g.uniform1f(u.uF, focal)
    g.uniform3f(u.uEvolve, evolve[0], evolve[1], evolve[2])
    g.uniform3f(u.uSunDir, sun[0], sun[1], sun[2])
    g.uniform3fv(u.uZenith, hexToLinear(p.zenith))
    g.uniform3fv(u.uHorizon, hexToLinear(p.horizon))
    g.uniform3fv(u.uLit, hexToLinear(p.cloudLit))
    g.uniform3fv(u.uShade, hexToLinear(p.cloudShade))
    g.uniform3fv(u.uGround, hexToLinear(p.ground))
    g.uniform1f(u.uGradient, (Math.max(1, p.gradient) * Math.PI) / 180)
    g.uniform1f(u.uCoverage, Math.min(1, Math.max(0, p.coverage)))
    g.uniform1f(u.uSoft, Math.max(0.01, p.softness))
    g.uniform1f(u.uDensity, Math.max(0, p.density))
    g.uniform1f(u.uShadow, Math.max(0, p.selfShadow))
    g.uniform1f(u.uErosion, Math.max(0, p.puffiness))
    g.uniform1f(u.uTile, TILE * Math.max(0.05, p.size))
    g.uniform1f(u.uDetailScale, DETAIL_SCALE / Math.max(0.05, p.size))
    g.uniform1f(u.uHaze, p.haze > 0 ? p.haze / 11 : 0)
    g.uniform1f(u.uVeil, Math.max(0, p.veil))
    g.uniform1f(u.uGrain, Math.max(0, p.grain))
    g.uniform1f(u.uFrame, Math.floor(time * 24))
    g.uniform1f(u.uDebug, DEBUG)
    g.uniform1f(u.uThick, Math.max(0, p.cloudHeight))

    // Parallax: the world sits deeper than the paper → moves opposite to the pointer.
    const px = -pointer.x * world.parallax
    const py = -pointer.y * world.parallax

    if (DEBUG) {
      g.uniform2f(u.uWind, wind.main[0], wind.main[1])
      g.uniform1f(u.uDeck, 1)
      g.uniform2f(u.uShift, 0, 0)
      g.drawArrays(g.TRIANGLES, 0, 3)
      return
    }
    g.enable(g.SCISSOR_TEST)
    for (const name of WINDOWS) {
      const rect: Rect = layout.cutouts[name]
      const win = world.windows[name]
      const b = Math.max(0, p.bleed)
      const x0 = Math.max(0, Math.floor((rect.x - b) * pxScale))
      const x1 = Math.min(W, Math.ceil((rect.x + rect.w + b) * pxScale))
      const y0 = Math.max(0, Math.floor((rect.y - b) * pxScale))
      const y1 = Math.min(H, Math.ceil((rect.y + rect.h + b) * pxScale))
      if (x1 <= x0 || y1 <= y0) continue
      g.uniform2f(u.uShift, world.offset.x + win.offset.x + px, world.offset.y + win.offset.y + py)
      g.uniform2f(u.uWind, wind[name][0], wind[name][1])
      g.uniform1f(u.uHy, rect.y + win.horizon * rect.h)
      // Per-window lens: zoom < 1 widens the view around the same viewing direction
      // (the window centre still looks where it would through the shared camera).
      const zoom = Math.max(0.05, win.zoom)
      const rc = rect.x + rect.w / 2
      g.uniform1f(u.uF, focal * zoom)
      g.uniform1f(u.uDeck, 1 / Math.max(0.1, win.cloudScale))
      g.uniform1f(u.uCx, layout.width / 2 + (1 - zoom) * (rc - layout.width / 2))
      // Drawn in horizontal bands of bounded size: one huge draw of the (marched)
      // horizon window can stall some GPUs far beyond its real cost.
      const band = Math.max(8, Math.floor(BAND_PIXELS / (x1 - x0)))
      for (let yb = y0; yb < y1; yb += band) {
        const ye = Math.min(y1, yb + band)
        g.scissor(x0, H - ye, x1 - x0, ye - yb)
        g.drawArrays(g.TRIANGLES, 0, 3)
      }
    }
    g.disable(g.SCISSOR_TEST)
  }

  return {
    resize,
    update: render,
    dispose() {
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      if (state && !gl.isContextLost()) {
        cumulus?.dispose()
        gl.deleteProgram(state.sky)
        gl.deleteTexture(state.map)
        gl.deleteTexture(state.detail)
        gl.deleteVertexArray(state.vao)
      }
      state = null
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      canvas.remove()
    },
  }
}
