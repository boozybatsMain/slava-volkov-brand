import { clamp01, lerp, remap, smoother } from '../../core/ease'
import type { Pt } from '../../core/quad'
import { scrollControl } from '../../core/scroll'
import { slabPose } from '../../core/slab-pose'
import { Follower, Spring1 } from '../../core/spring'
import type { Frame, Layout, ResolvedConfig } from '../../core/types'
import type { SkyConfig } from '../../sky.config'

/**
 * SLAB — the pose, solved on the CPU in ONE place.
 *
 * The WebGL slab draws with the matrices from here, the no-WebGL fallback places its quads through
 * the same projection, and the project texts lie on the face through core/slab-pose.ts — so the
 * three can never disagree. No three.js in this file: it also serves the fallback.
 *
 * Space: the stage in CSS px, x right, y DOWN, z toward the viewer (the CSS 3D convention, so the
 * reference fit `rotateY(yaw) rotateX(pitch) rotateZ(roll)` is used as measured). The camera looks
 * at the stage's centre from `perspective × width` away.
 *
 *   unit box (x, y ∈ −½…½, z ∈ −1…0; the picture is the z = 0 face)
 *     → size (w, h, depth) → about the box centre: scale (arrival) → body (the reference pose,
 *       + the arrival's extra pitch) → aim (turn toward the cursor, float, the switch's swing)
 *     → at the face centre's place on the stage (+ parallax, float, the arrival's rise).
 */

export type SlabKnobs = SkyConfig['projects']

/** `config.projects` of the page (version 2), with the mobile overrides already applied. */
export const slabKnobs = (config: ResolvedConfig) => (config as unknown as SkyConfig).projects

/**
 * Size of one render pixel of the slab, CSS px: the slab never gets more than raster.renderWidth
 * render pixels across (the title's rule: the degradation is relative to the object, not to the
 * screen), and never a finer lattice than raster.pixelSize.
 *
 * Then it is rounded to a whole number of DEVICE pixels. The slab is full of regular patterns on
 * its lattice (the stippled shadow and arrival, the ordered dither); magnified by a fractional
 * factor, lattice pixels come out unevenly wide and every such pattern beats into bands.
 */
export function slabPixelSize(faceWidth: number, K: SlabKnobs) {
  const dpr = window.devicePixelRatio || 1
  const css = Math.max(0.25, K.raster.pixelSize, faceWidth / Math.max(50, K.raster.renderWidth))
  return Math.max(1, Math.round(css * dpr)) / dpr
}

/** Column-major 4×4, as CSS matrix3d and three.js store them. */
export type Mat4 = number[]

const DEG = Math.PI / 180

function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Array<number>(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
    }
  }
  return o
}
const translate = (x: number, y: number, z: number): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]
const scale = (x: number, y: number, z: number): Mat4 => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]
// CSS rotateX / rotateY / rotateZ (y down): + pitch = top away, + yaw = right side away, + roll = clockwise
const rotX = (deg: number): Mat4 => {
  const [s, c] = [Math.sin(deg * DEG), Math.cos(deg * DEG)]
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]
}
const rotY = (deg: number): Mat4 => {
  const [s, c] = [Math.sin(deg * DEG), Math.cos(deg * DEG)]
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]
}
const rotZ = (deg: number): Mat4 => {
  const [s, c] = [Math.sin(deg * DEG), Math.cos(deg * DEG)]
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
}

/** Linear up to `knee`, then eases (C¹) to (1 + knee) / 2 at |p| = 1, flat beyond (the title's curve). */
function easeEdge(p: number, knee: number) {
  const k = Math.min(1, Math.max(0.05, knee))
  const a = Math.abs(p)
  if (k >= 1 || a <= k) return p
  const u = Math.min(1, (a - k) / (1 - k))
  return Math.sign(p) * (k + (1 - k) * (u - (u * u) / 2))
}

/** The dynamics of a slab nothing moves: centred pointer, no swing, the float at its middle. */
const REST = { x: 0, y: 0, swing: 0, time: 0 }

/** Identity up to 60 % of `max`, then rolls off smoothly towards `max` (never reaches it). */
function softLimit(a: number, max: number) {
  if (max <= 0) return a
  const k = 0.6 * max
  const s = Math.abs(a)
  if (s <= k) return a
  return Math.sign(a) * (k + (max - k) * Math.tanh((s - k) / (max - k)))
}

export interface SlabSolution {
  /** Stage size and the always-visible height, CSS px. */
  W: number
  H: number
  safeH: number
  /** The face at scale 1 and the slab's depth, CSS px. */
  w: number
  h: number
  d: number
  /** 0 — not here yet … 1 — arrived (projects.arrive by scroll; 1 under reduced motion). */
  arrival: number
  /** Unit box → stage (see the header). */
  model: Mat4
  /**
   * Stage → clip space of a canvas `width` × `height` CSS px whose top-left corner is the stage's
   * (the WebGL canvas is the stage rounded up to whole lattice pixels). y is up in clip space: the
   * flip is inside. Clip w = distance from the camera plane.
   */
  viewProj(width: number, height: number): Mat4
  /** A point of the unit box → stage CSS px. */
  point(x: number, y: number, z: number): Pt
  /** Face units (0, 0 top-left … 1, 1 bottom-right; valid beyond) → stage CSS px. */
  project(u: number, v: number): Pt
  /** The front face on screen: TL, TR, BR, BL. */
  corners: [Pt, Pt, Pt, Pt]
  /** 1 / (clip w) over the face: at its nearest and its farthest corner (screen-affine in between). */
  depth: { near: number; far: number }
  /** The turn on top of the rest pose, degrees: nod (+ = top away), turn (+ = right side away), roll. */
  aim: { x: number; y: number; z: number }
  /** The float's vertical offset right now, −1…1 of its range (the shadow breathes with it). */
  bob: number
  /** Changes whenever the projection does. */
  key: string
}

/**
 * Longest gap between two step() calls that still counts as one stretch of animation, ms. A longer one
 * means the slab was not stepped at all — the layer slept (core/hero.ts → isLive) or the tab was
 * hidden — and whatever its springs were doing before is history. Well above a slow frame or the
 * stall of a screenshot (≤ 0.35 s), well below any sleep a visitor could notice the leftovers of.
 */
const WAKE_GAP = 500

/**
 * The slab's own dynamics (a heavy follower of the pointer, the swing spring of a switch) and the
 * solve itself. step() advances the dynamics once per frame; solve() can be called any time — also
 * from resize(), where there is no Frame: it uses the last dynamics and the live scroll state.
 */
export function createSlabSolver() {
  const follow = new Follower()
  /** extra yaw of a project switch, degrees: a push, then a heavy return with no overshoot */
  const swing = new Spring1(0)
  const live = { x: 0, y: 0, swing: 0, time: 0 }
  /** performance.now() of the last step() */
  let stepped = -Infinity

  return {
    /**
     * `heldSwing` — the swing while the switch is pinned for a screenshot (the spring cannot be
     * scrubbed; show.ts gives the same curve as a function of the switch's progress); null = live.
     */
    step(frame: Frame, heldSwing: number | null) {
      const K = slabKnobs(frame.config)
      const now = performance.now()
      // Back after a pause (see WAKE_GAP): the slab must not arrive in the pose it left with and
      // then spend a second relaxing from a pointer position and a swing that are long gone. It
      // starts where the shared pointer is now, with no swing left. (Waking from sleep, nothing of
      // it is on screen yet: the layer is live a little before its arrival begins.)
      if (now - stepped > WAKE_GAP) {
        follow.x = frame.pointer.x
        follow.y = frame.pointer.y
        follow.vx = follow.vy = 0
        swing.set(0)
      }
      stepped = now
      follow.step(frame.pointer, frame.dt, frame.config.motion, K.slab.response.mass)
      live.x = follow.x
      live.y = follow.y
      live.time = frame.time
      const peak = Math.abs(K.switch.swing)
      if (frame.scroll.reduced || !peak) swing.set(0)
      else {
        swing.step(0, frame.dt, 1 / Math.max(0.03, K.switch.swingTime))
        // kick() keeps the swing inside ± switch.swing by construction. This is the same promise
        // kept against everything else — a knob dragged in mid-swing (a longer swingTime turns the
        // speed it already has into a far bigger arc), a spring fed a bad frame: the slab stops at
        // the peak and turns back from there, it never goes over.
        if (!(Math.abs(swing.x) <= peak)) {
          swing.x = swing.x > 0 ? peak : swing.x < 0 ? -peak : 0
          if (!(swing.x * swing.v < 0)) swing.v = 0
        }
      }
      live.swing = frame.scroll.reduced ? 0 : (heldSwing ?? swing.x)
    },

    /**
     * A switch has just started — or was re-targeted, which a held arrow key does about 30 times a
     * second: push the slab along it, never past `switch.swing` degrees.
     *
     * The push is the impulse that takes a RESTING slab to its peak `switch.swingTime` s later,
     * scaled by the headroom left along the push; it replaces a slower push and leaves a faster one
     * alone — pushes never add up. So one press swings exactly as designed, fast clicking keeps the
     * slab leaning near the peak (a heavy sway, a little back between clicks), a held key holds it
     * there, the opposite arrow sways it back through the middle — and the return is the same heavy
     * one every time.
     */
    kick(dir: 1 | -1, K: SlabKnobs) {
      const peak = Math.abs(K.switch.swing)
      if (!peak) return
      const s = dir * Math.sign(K.switch.swing)
      const push = ((peak * Math.E) / Math.max(0.03, K.switch.swingTime)) * clamp01(1 - (s * swing.x) / peak)
      swing.v = s * Math.max(s * swing.v, push)
    },

    /**
     * `atRest` — the pose with the slab arrived and nothing moving it (no cursor, float or swing):
     * what the texts' resting place is measured against (core/slab-pose.ts → SlabPose.rest).
     */
    solve(layout: Layout, config: ResolvedConfig, atRest = false): SlabSolution {
      const K = slabKnobs(config)
      const k = K.slab
      const dyn = atRest ? REST : live
      const scroll = scrollControl.current?.state
      const W = Math.max(1, layout.width)
      const H = Math.max(1, layout.height)
      const safeH = scroll?.safeH || H
      // nothing travels or floats: reduced motion, or the rest pose itself
      const still = !!scroll?.reduced || atRest
      const w = (Math.min(W, k.designAspect * safeH) * k.width) / 100
      const h = w / Math.max(0.1, k.aspect)
      const d = h * Math.max(0, k.thickness)
      const arrival = still ? 1 : smoother(remap(scroll?.pos ?? 0, K.arrive.from, K.arrive.to))
      const size = lerp(K.arrive.scale, 1, arrival)
      const D = Math.max(0.1, k.perspective) * W

      // toward the cursor: linear in the middle of the screen, softer near the edges (the title's
      // curve and knee), never past maxTurn; a cursor below turns the face down, one on the right — right
      const r = k.response
      const knee = config.title.raster.edgeKnee
      const float = still ? 0 : 1
      const phase = (2 * Math.PI * dyn.time) / Math.max(0.5, k.float.period)
      const bob = float * Math.sin(phase)
      const aim = {
        x: -softLimit(easeEdge(dyn.y, knee) * r.tiltX, r.maxTurn),
        y: softLimit(easeEdge(dyn.x, knee) * r.tiltY, r.maxTurn) + dyn.swing,
        z: float * k.float.roll * Math.sin(phase + 1.3),
      }
      const body = mul(rotY(k.yaw), mul(rotX(k.pitch + (1 - arrival) * K.arrive.pitch), rotZ(k.roll)))
      const turn = mul(rotY(aim.y), mul(rotX(aim.x), rotZ(aim.z)))

      // the face centre's place at rest; nearer things answer the pointer more (as the sky's layers)
      const par = config.world.parallax * r.depth
      const ox = k.x * W - dyn.x * par
      const oy = k.y * safeH + ((1 - arrival) * K.arrive.rise * H) / 100 + bob * k.float.y - dyn.y * par
      // the pivot is the box centre: half the depth behind the face centre, through the body's pose
      const cz = (-d / 2) * size
      const px = ox + body[8] * cz
      const py = oy + body[9] * cz
      const pz = body[10] * cz
      const model = mul(
        translate(px, py, pz),
        mul(turn, mul(body, mul(scale(size, size, size), mul(translate(0, 0, d / 2), scale(w, h, d))))),
      )

      // camera at (W/2, H/2, D): screen = centre + (X − centre) · D / (D − Z); clip w = D − Z.
      // For a canvas of another size the same screen point is only renormalised:
      //   clip.x = (2·sx/Wc − 1) · w,  clip.y = (1 − 2·sy/Hc) · w
      const viewProj = (Wc: number, Hc: number): Mat4 => {
        const near = D * 0.2
        const far = D * 5
        const A = -(far + near) / (far - near)
        const B = (-2 * far * near) / (far - near)
        return [(2 * D) / Wc, 0, 0, 0, 0, (-2 * D) / Hc, 0, 0, 1 - W / Wc, H / Hc - 1, A, -1, -D, D, B - A * D, D]
      }

      const point = (x: number, y: number, z: number): Pt => {
        const X = model[0] * x + model[4] * y + model[8] * z + model[12]
        const Y = model[1] * x + model[5] * y + model[9] * z + model[13]
        const Z = model[2] * x + model[6] * y + model[10] * z + model[14]
        const f = D / (D - Z)
        return { x: W / 2 + (X - W / 2) * f, y: H / 2 + (Y - H / 2) * f }
      }
      const project = (u: number, v: number) => point(u - 0.5, v - 0.5, 0)
      const corners: [Pt, Pt, Pt, Pt] = [project(0, 0), project(1, 0), project(1, 1), project(0, 1)]
      // 1 / w at the face corners (w = D − Z): affine across the face on screen, so the corners bound it
      const q = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(
        ([x, y]) => 1 / (D - (model[2] * x + model[6] * y + model[14])),
      )
      const key =
        corners.map((c) => `${c.x.toFixed(2)},${c.y.toFixed(2)}`).join('|') +
        `|${w.toFixed(2)}|${h.toFixed(2)}|${W}|${H}|${arrival.toFixed(4)}`

      return {
        W, H, safeH, w, h, d, arrival, model, viewProj, point, project, corners,
        depth: { near: Math.max(...q), far: Math.min(...q) },
        aim, bob, key,
      }
    },
  }
}

export type SlabSolver = ReturnType<typeof createSlabSolver>

/**
 * Publish a solution as the slab's live pose (core/slab-pose.ts) — both the WebGL slab and the
 * fallback do, every frame and in resize(). `rest` — the same layout solved at rest.
 */
export function publishPose(sol: SlabSolution, rest: SlabSolution) {
  const cur = slabPose.current
  if (cur?.key === sol.key && cur.rest === rest.project) return
  slabPose.current = { key: sol.key, project: sol.project, rest: rest.project, corners: sol.corners, flat: { w: sol.w, h: sol.h }, arrival: sol.arrival }
}
