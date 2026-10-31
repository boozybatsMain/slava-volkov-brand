// Нетопырь on the site. All the numbers are in site.config.ts → bat.
//
// He flies by himself, day and night, through the empty parts of whatever the visitor is looking at.
// Every element marked data-bat-avoid (titles, text, cards, buttons) is an obstacle; the planner picks
// free points in the viewport and strings them into a route of one of a few kinds (a long glide across,
// a loop around a free spot, a short hop and a hover), then picks another. He does not chase the cursor:
// he only keeps out of its way. Positions are page coordinates, so a scroll never drags him along: when
// his route leaves the screen he plans a new one and flies back into view.
//
// On load he hangs under the header for a moment and then lets go. With prefers-reduced-motion he stays
// on that perch (position: fixed like the header) and only spreads his wings when the cursor comes close.
// One small WebGL canvas rides along with him; it is drawn only while he is near the screen.
import { site } from '../site.config'
import { Stage } from './stage'
import { qF, PERCH_Y } from '../../brand/mascot/netopyr.js'

const C = site.bat
type Mode = 'hang' | 'takeoff' | 'fly'
type Pt = { x: number; y: number }
type Rect = { l: number; t: number; r: number; b: number }
type RouteKind = 'glide' | 'loop' | 'hover'

// clip indices in brand/mascot/src/clips.js
const FLY = 0
const HANG = 3
const TAKEOFF = 5

export class SiteBat {
  private stage: Stage
  private k = 1
  private mode: Mode = 'hang'
  private tm = 0
  private t = 0
  private spread = 0
  private pos: Pt = { x: -9999, y: 0 }
  private vel: Pt = { x: 0, y: 0 }
  private relY = 0
  private tf = 0
  private flapK = 1
  private pinned: boolean | null = null
  private cx = -9999
  private cy = -9999
  private plast = -1e9
  private w = 0
  private raf = 0
  private last = 0
  private reduced = matchMedia('(prefers-reduced-motion: reduce)')
  /** the route: waypoints in page coordinates, the current one first */
  private route: Pt[] = []
  private kind: RouteKind = 'glide'
  private hoverLeft = 0
  private lastKind: RouteKind | null = null
  private planAt = 0

  constructor(private canvas: HTMLCanvasElement, private halo: HTMLElement | null, private head: HTMLElement) {
    this.stage = new Stage(canvas, { look: C.look, shells: C.shells, glow: C.glow, maxPixelRatio: C.maxPixelRatio })
    this.stage.setSize(C.canvas.w, C.canvas.h)
    this.fit()
    addEventListener('pointermove', this.onMove, { passive: true })
    addEventListener('resize', this.onResize)
    document.addEventListener('visibilitychange', this.onVisibility)
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)
  }

  private onMove = (e: PointerEvent) => {
    this.cx = e.clientX
    this.cy = e.clientY
    this.plast = performance.now()
  }
  private onResize = () => {
    this.fit()
    this.route = []
  }
  private onVisibility = () => {
    // rAF does not run in a hidden tab; on return start the clock afresh so he does not jump
    if (!document.hidden) this.last = performance.now()
  }

  private fit() {
    this.w = document.documentElement.clientWidth
    const span = this.w < C.mobileBelow ? C.spanMobile : C.span
    // 249: the bat's wingspan in world units with the wings open
    this.stage.setDist((249 * C.canvas.h) / (span * 2 * Math.tan((14 * Math.PI) / 180)))
    this.k = this.stage.px()
  }

  private setMode(m: Mode) {
    this.mode = m
    this.tm = 0
  }

  private frame = (now: number) => {
    const dt = Math.min(0.05, (now - this.last) / 1000)
    this.last = now
    if (!document.hidden) this.step(dt)
    this.raf = requestAnimationFrame(this.frame)
  }

  // ---------- the planner ----------

  /** The flyable box and the obstacles, in viewport coordinates. */
  private space() {
    const vw = this.w
    const vh = window.innerHeight
    const top = this.head.getBoundingClientRect().bottom + C.edgeTop
    const box: Rect = { l: C.edgeX, t: top, r: vw - C.edgeX, b: vh - C.edgeBottom }
    const pad = C.avoidPad
    const obs: Rect[] = []
    for (const el of document.querySelectorAll<HTMLElement>('[data-bat-avoid]')) {
      const r = el.getBoundingClientRect()
      if (r.bottom < -pad || r.top > vh + pad || r.width === 0) continue
      obs.push({ l: r.left - pad, t: r.top - pad, r: r.right + pad, b: r.bottom + pad })
    }
    return { box, obs }
  }

  /** How far a viewport point is from the nearest obstacle (0 inside one), capped. */
  private clearance(p: Pt, obs: Rect[]) {
    let c = 400
    for (const o of obs) {
      const dx = Math.max(o.l - p.x, 0, p.x - o.r)
      const dy = Math.max(o.t - p.y, 0, p.y - o.b)
      c = Math.min(c, Math.hypot(dx, dy))
      if (c === 0) break
    }
    return c
  }

  private pathFree(a: Pt, b: Pt, obs: Rect[]) {
    for (let i = 1; i <= 10; i++) {
      const u = i / 10
      if (this.clearance({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }, obs) === 0) return false
    }
    return true
  }

  private cursorNear(p: Pt) {
    const live = performance.now() - this.plast < C.pointerAlive
    return live && Math.hypot(p.x - this.cx, p.y - this.cy) < C.cursorClear
  }

  /** The best free point for a leg from `from`, preferring a leg length around `want` px. */
  private pick(from: Pt, want: number, box: Rect, obs: Rect[]): Pt | null {
    let best: Pt | null = null
    let bestS = -Infinity
    for (let i = 0; i < 48; i++) {
      const p = { x: box.l + Math.random() * (box.r - box.l), y: box.t + Math.random() * (box.b - box.t) }
      const c = this.clearance(p, obs)
      if (c === 0 || this.cursorNear(p)) continue
      const d = Math.hypot(p.x - from.x, p.y - from.y)
      let s = Math.min(c, 160) - Math.abs(d - want) * 0.35
      if (!this.pathFree(from, p, obs)) s -= 400
      if (s > bestS) {
        bestS = s
        best = p
      }
    }
    return best
  }

  /** A new route from where he is now (viewport coordinates in, page coordinates out). */
  private plan() {
    const { box, obs } = this.space()
    const vtop = window.scrollY
    const here = { x: this.pos.x, y: this.pos.y - vtop }
    if (box.r - box.l < 40 || box.b - box.t < 40) {
      // a tiny window: just stay in its middle
      this.route = [{ x: this.w / 2, y: vtop + window.innerHeight / 2 }]
      this.kind = 'hover'
      return
    }
    // no two routes of the same kind in a row
    const kinds: RouteKind[] = (['glide', 'glide', 'loop', 'hover'] as RouteKind[]).filter((k) => k !== this.lastKind)
    const kind = kinds[Math.floor(Math.random() * kinds.length)]
    const span = Math.min(box.r - box.l, 900)
    const pts: Pt[] = []
    if (kind === 'glide') {
      // a long glide across the free space, with one bend
      let a = this.pick(here, span * 0.45, box, obs)
      if (a) pts.push(a)
      const b = a && this.pick(a, span * 0.5, box, obs)
      if (b) pts.push(b)
    } else if (kind === 'loop') {
      // a loop around a free spot: four points on an ellipse, skipping the ones that hit something
      const c = this.pick(here, span * 0.3, box, obs)
      if (c) {
        const R = Math.min(C.loopRadius, (box.r - box.l) / 3)
        const a0 = Math.atan2(here.y - c.y, here.x - c.x)
        const dir = Math.random() < 0.5 ? 1 : -1
        for (let i = 1; i <= 5; i++) {
          const a = a0 + dir * i * ((Math.PI * 2) / 5)
          const p = { x: c.x + Math.cos(a) * R, y: c.y + Math.sin(a) * R * 0.6 }
          if (p.x > box.l && p.x < box.r && p.y > box.t && p.y < box.b && this.clearance(p, obs) > 0) pts.push(p)
        }
      }
    } else {
      // a short hop, then a pause in the air
      const p = this.pick(here, span * 0.25, box, obs)
      if (p) pts.push(p)
    }
    if (!pts.length) {
      const p = this.pick(here, span * 0.4, box, obs)
      if (p) pts.push(p)
    }
    this.kind = kind
    this.lastKind = kind
    this.hoverLeft = kind === 'hover' ? C.hoverFor[0] + Math.random() * (C.hoverFor[1] - C.hoverFor[0]) : 0
    this.route = pts.map((p) => ({ x: p.x, y: p.y + vtop }))
    this.planAt = this.t
  }

  // ---------- one frame ----------

  private step(dt: number) {
    const st = this.stage
    const k = this.k
    this.t += dt
    this.tm += dt
    const t = this.t
    const w = this.w
    const vtop = window.scrollY
    const vh = window.innerHeight
    const pb = st.pose()
    const live = performance.now() - this.plast < C.pointerAlive
    const mx = this.cx
    const my = this.cy + vtop
    const mobile = w < C.mobileBelow
    // the perch under the fixed header (only at the start, or for reduced motion)
    const ax = w * (mobile ? C.perchXMobile : C.perchX)
    const ay = vtop + this.head.getBoundingClientRect().bottom - C.perchInset + PERCH_Y / k

    if (this.mode === 'hang' && !this.reduced.matches && this.tm > C.letGoAfter) this.setMode('takeoff')
    if (this.mode === 'hang' || this.mode === 'takeoff') {
      if (this.mode === 'hang') {
        st.clip(HANG, this.tm, pb)
        // the starry wings open when the cursor comes close
        const want = live && Math.hypot(mx - ax, my - ay - 30) < C.hoverRadius ? 1 : 0
        this.spread += (want - this.spread) * Math.min(1, dt * (want ? 5 : 3.5))
        const s = this.spread * this.spread * (3 - 2 * this.spread)
        if (s > 0.001) {
          pb.o = s
          pb.open = s
          pb.phi = pb.phi * (1 - s) + 0.04 * Math.sin(t * 2.2) * s
        }
        if (live) st.look(pb, ((mx - ax) / w) * 2, (-(my - ay) / vh) * 2, 0.5)
      } else st.clip(TAKEOFF, Math.min(this.tm, 2.39), pb)
      st.place(pb, ax * k, -ay * k, 0)
      const nx = pb.x / k
      const ny = pb.y / k
      // velocity relative to the screen, so a scroll does not fling him when he lets go
      const d = Math.max(dt, 1e-3)
      this.vel.x = (nx - this.pos.x) / d
      this.vel.y = (ny - vtop - this.relY) / d
      const vm = Math.hypot(this.vel.x, this.vel.y)
      if (vm > 600) {
        this.vel.x *= 600 / vm
        this.vel.y *= 600 / vm
      }
      this.relY = ny - vtop
      this.pos.x = nx
      this.pos.y = ny
      if (this.mode === 'takeoff' && this.tm > 1.25) {
        this.setMode('fly')
        this.route = []
      }
    } else {
      // the route: replan when it runs out, when its next point has left the screen, or now and then
      const next = this.route[0]
      const off = next && (next.y < vtop + 80 || next.y > vtop + vh - 40)
      if (!next || off || t - this.planAt > C.replanAfter) this.plan()
      let target = this.route[0] ?? { x: this.pos.x, y: this.pos.y }
      const dist = Math.hypot(target.x - this.pos.x, target.y - this.pos.y)
      if (dist < C.arrive) {
        if (this.route.length > 1) this.route.shift()
        else if (this.kind === 'hover' && this.hoverLeft > 0) this.hoverLeft -= dt
        else this.route = []
        target = this.route[0] ?? target
      }
      // steering, not snapping
      const dx = target.x - this.pos.x
      const dy = target.y - this.pos.y
      const dl = Math.hypot(dx, dy) || 1
      const sp = Math.min(C.maxSpeed, dl * 1.8)
      let dvx = (dx / dl) * sp
      let dvy = (dy / dl) * sp
      // he keeps out of the cursor's way, but never follows it
      if (live) {
        const ex = this.pos.x - mx
        const ey = this.pos.y - my
        const ed = Math.hypot(ex, ey) || 1
        if (ed < C.keepAway) {
          dvx += (ex / ed) * (C.keepAway - ed) * 4
          dvy += (ey / ed) * (C.keepAway - ed) * 4
          if (ed < C.keepAway * 0.6) this.route = [] // a new route away from it
        }
      }
      const acc = Math.min(1, dt * C.steer)
      this.vel.x += (dvx - this.vel.x) * acc
      this.vel.y += (dvy - this.vel.y) * acc
      this.pos.x += this.vel.x * dt
      this.pos.y += this.vel.y * dt
      this.relY = this.pos.y - vtop
      // he glides most of the time and flaps in bursts: when climbing, when slow (a hover) and now and then
      const spd = Math.hypot(this.vel.x, this.vel.y)
      const wantF = spd < C.flapBelowSpeed || this.vel.y < -C.flapClimb || t % C.flapCycle < C.flapCycleOn ? 1 : 0
      this.flapK += (wantF - this.flapK) * Math.min(1, dt * 3)
      this.tf += dt * C.flapRate * (0.15 + 0.85 * this.flapK)
      st.clip(FLY, this.tf, pb)
      const g = 1 - this.flapK
      if (g > 0.001) {
        pb.phi = pb.phi * (1 - g) + (0.1 + 0.05 * Math.sin(t * 1.6)) * g
        pb.o = pb.o * (1 - g) + g
        pb.bobY *= 1 - g
      }
      const cl = (v: number, a: number) => Math.max(-a, Math.min(a, v))
      pb.q = qF(Math.PI / 2 - cl(this.vel.x * 0.0035, 0.9), 0.2 + cl(this.vel.y * 0.0006, 0.35), cl(-this.vel.x * 0.0012, 0.5))
      pb.x = 0
      pb.y = 0
      pb.z = 0
      st.place(pb, this.pos.x * k, -this.pos.y * k, 0)
    }
    st.follow(pb.x, -pb.y)

    // on the perch he is pinned to the screen like the header itself (position: fixed); in flight, to the page
    const pin = this.mode !== 'fly'
    if (pin !== this.pinned) {
      this.pinned = pin
      const p = pin ? 'fixed' : 'absolute'
      this.canvas.style.position = p
      if (this.halo) this.halo.style.position = p
    }
    const oy = pin ? -vtop : 0
    const hw = C.canvas.w / 2
    const hh = C.canvas.h / 2
    this.canvas.style.transform = `translate3d(${(this.pos.x - hw).toFixed(1)}px,${(this.pos.y + oy - hh).toFixed(1)}px,0)`
    if (this.halo) this.halo.style.transform = `translate3d(${(this.pos.x - 280).toFixed(1)}px,${(this.pos.y + oy - 280).toFixed(1)}px,0)`
    // only drawn while he is near the screen
    st.onScreen = this.pos.y > vtop - 300 && this.pos.y < vtop + vh + 300
    st.render(dt, pb)
  }

  dispose = () => {
    cancelAnimationFrame(this.raf)
    removeEventListener('pointermove', this.onMove)
    removeEventListener('resize', this.onResize)
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.stage.dispose()
  }
}
