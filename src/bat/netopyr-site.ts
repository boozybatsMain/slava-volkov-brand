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
  //
  // The free space is a grid over the visible part of the page (cells of C.cell px, in page coordinates).
  // A cell is free when it is inside the screen margins and outside every [data-bat-avoid] box grown by
  // avoidX / avoidY, so narrow strips (the 72 px between the game cards, the margins) stay open. Each cell
  // also knows how far it is from the nearest wall. A route is a cheapest path over the free cells
  // (Dijkstra, with walls made expensive so he keeps to the middle of a corridor), straightened where the
  // line of sight allows, to a target chosen in the part of the screen he has visited least.

  private grid: { y0: number; cols: number; rows: number; free: Uint8Array; clr: Float32Array } | null = null
  private zoneT = new Float32Array(C.zones[0] * C.zones[1])

  private build() {
    const cs = C.cell
    const vw = this.w
    const vh = window.innerHeight
    const vtop = window.scrollY
    const cols = Math.ceil(vw / cs)
    const rows = Math.ceil(vh / cs)
    const free = new Uint8Array(cols * rows)
    const top = this.head.getBoundingClientRect().bottom + C.edgeTop
    for (let j = 0; j < rows; j++) {
      const y = (j + 0.5) * cs
      if (y < top || y > vh - C.edgeBottom) continue
      for (let i = 0; i < cols; i++) {
        const x = (i + 0.5) * cs
        if (x >= C.edgeX && x <= vw - C.edgeX) free[j * cols + i] = 1
      }
    }
    for (const el of document.querySelectorAll<HTMLElement>('[data-bat-avoid]')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.bottom < -C.avoidY || r.top > vh + C.avoidY) continue
      // every cell whose centre falls in the grown box
      const i0 = Math.max(0, Math.ceil((r.left - C.avoidX) / cs - 0.5))
      const i1 = Math.min(cols - 1, Math.floor((r.right + C.avoidX) / cs - 0.5))
      const j0 = Math.max(0, Math.ceil((r.top - C.avoidY) / cs - 0.5))
      const j1 = Math.min(rows - 1, Math.floor((r.bottom + C.avoidY) / cs - 0.5))
      for (let j = j0; j <= j1; j++) free.fill(0, j * cols + i0, j * cols + i1 + 1)
    }
    // distance to the nearest blocked cell (two-pass chamfer), in px
    const n = cols * rows
    const d = new Float32Array(n)
    for (let q = 0; q < n; q++) d[q] = free[q] ? 1e6 : 0
    const D = Math.SQRT2
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const q = j * cols + i
        if (!d[q]) continue
        let v = d[q]
        if (i > 0) v = Math.min(v, d[q - 1] + 1)
        if (j > 0) {
          v = Math.min(v, d[q - cols] + 1)
          if (i > 0) v = Math.min(v, d[q - cols - 1] + D)
          if (i < cols - 1) v = Math.min(v, d[q - cols + 1] + D)
        }
        d[q] = v
      }
    for (let j = rows - 1; j >= 0; j--)
      for (let i = cols - 1; i >= 0; i--) {
        const q = j * cols + i
        if (!d[q]) continue
        let v = d[q]
        if (i < cols - 1) v = Math.min(v, d[q + 1] + 1)
        if (j < rows - 1) {
          v = Math.min(v, d[q + cols] + 1)
          if (i < cols - 1) v = Math.min(v, d[q + cols + 1] + D)
          if (i > 0) v = Math.min(v, d[q + cols - 1] + D)
        }
        d[q] = v
      }
    const clr = new Float32Array(n)
    for (let q = 0; q < n; q++) clr[q] = Math.min(d[q], 60) * cs - cs / 2
    this.grid = { y0: vtop, cols, rows, free, clr }
    return this.grid
  }

  /** How much room there is around a page point (px), for slowing down in narrow places. */
  private room(p: Pt) {
    const g = this.grid
    if (!g) return 999
    const i = Math.floor(p.x / C.cell)
    const j = Math.floor((p.y - g.y0) / C.cell)
    if (i < 0 || j < 0 || i >= g.cols || j >= g.rows) return 999
    return Math.max(0, g.clr[j * g.cols + i])
  }

  private cursorNear(p: Pt) {
    const live = performance.now() - this.plast < C.pointerAlive
    return live && Math.hypot(p.x - this.cx, p.y - this.cy) < C.cursorClear
  }

  private zoneOf(x: number, y: number) {
    const [zc, zr] = C.zones
    const i = Math.min(zc - 1, Math.max(0, Math.floor((x / this.w) * zc)))
    const j = Math.min(zr - 1, Math.max(0, Math.floor((y / window.innerHeight) * zr)))
    return j * zc + i
  }

  /** A new route from where he is now, through the free cells of the screen (page coordinates out). */
  private plan() {
    const g = this.build()
    const { cols, rows, free, clr } = g
    const cs = C.cell
    const vtop = g.y0
    const n = cols * rows
    const cell = (q: number): Pt => ({ x: ((q % cols) + 0.5) * cs, y: (Math.floor(q / cols) + 0.5) * cs })
    const here = { x: this.pos.x, y: this.pos.y - vtop }
    this.planAt = this.t
    // the start: his own cell, or the nearest free one (a scroll may have put him over the text)
    let start = -1
    let bd = Infinity
    for (let q = 0; q < n; q++) {
      if (!free[q]) continue
      const c = cell(q)
      const dd = (c.x - here.x) ** 2 + (c.y - here.y) ** 2
      if (dd < bd) {
        bd = dd
        start = q
      }
    }
    if (start < 0) {
      // no free room on this screen at all: wait in the middle
      this.route = [{ x: this.w / 2, y: vtop + window.innerHeight / 2 }]
      this.kind = 'hover'
      this.hoverLeft = 1
      return
    }
    // Dijkstra over the free cells; a step costs more near a wall, so he keeps to the middle of a corridor
    const cost = new Float32Array(n).fill(Infinity)
    const from = new Int32Array(n).fill(-1)
    const heap: number[] = [start]
    cost[start] = 0
    const push = (q: number) => {
      heap.push(q)
      let k = heap.length - 1
      while (k > 0) {
        const p = (k - 1) >> 1
        if (cost[heap[p]] <= cost[heap[k]]) break
        ;[heap[p], heap[k]] = [heap[k], heap[p]]
        k = p
      }
    }
    const pop = () => {
      const top = heap[0]
      const last = heap.pop()!
      if (heap.length) {
        heap[0] = last
        let k = 0
        for (;;) {
          const l = 2 * k + 1
          const r = l + 1
          let m = k
          if (l < heap.length && cost[heap[l]] < cost[heap[m]]) m = l
          if (r < heap.length && cost[heap[r]] < cost[heap[m]]) m = r
          if (m === k) break
          ;[heap[m], heap[k]] = [heap[k], heap[m]]
          k = m
        }
      }
      return top
    }
    const done = new Uint8Array(n)
    const reach: number[] = []
    while (heap.length) {
      const q = pop()
      if (done[q]) continue
      done[q] = 1
      reach.push(q)
      const i = q % cols
      const j = (q - i) / cols
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue
          const ni = i + di
          const nj = j + dj
          if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue
          const nq = nj * cols + ni
          if (!free[nq] || done[nq]) continue
          // no cutting a corner past a blocked cell
          if (di && dj && (!free[j * cols + ni] || !free[nj * cols + i])) continue
          const c = cost[q] + (di && dj ? Math.SQRT2 : 1) * (1 + 24 / Math.max(clr[nq], 8))
          if (c < cost[nq]) {
            cost[nq] = c
            from[nq] = q
            push(nq)
          }
        }
    }
    // the target: somewhere he has not been lately, far enough, away from the cursor; narrow strips get a bonus
    // time spent in each zone, measured against how much free room the zone has, so a zone that is
    // mostly text with a thin margin does not keep calling him back
    const share = new Float32Array(this.zoneT.length)
    for (const q of reach) {
      const c = cell(q)
      share[this.zoneOf(c.x, c.y)] += 1 / reach.length
    }
    const need = this.zoneT.map((z, k) => z / Math.max(share[k], 0.02))
    let maxZ = 1e-3
    for (const z of need) maxZ = Math.max(maxZ, z)
    const diag = Math.hypot(this.w, window.innerHeight)
    let target = -1
    let bestS = -Infinity
    for (let k = 0; k < 90 && reach.length > 1; k++) {
      const q = reach[1 + Math.floor(Math.random() * (reach.length - 1))]
      const c = cell(q)
      const dEu = Math.hypot(c.x - here.x, c.y - here.y)
      let s = 2 * (1 - need[this.zoneOf(c.x, c.y)] / maxZ) + 0.6 * Math.min(1, dEu / (0.6 * diag)) + 0.7 * Math.random()
      if (dEu < C.minLeg) s -= 3
      if (clr[q] < 40) s += 0.15
      if (this.cursorNear(c)) s -= 5
      if (s > bestS) {
        bestS = s
        target = q
      }
    }
    if (target < 0) {
      this.route = [{ x: here.x, y: here.y + vtop }]
      this.kind = 'hover'
      this.hoverLeft = C.hoverFor[0]
      return
    }
    // the path back from the target, then straightened: from each corner, jump to the farthest cell in sight
    const path: number[] = []
    for (let q = target; q >= 0; q = from[q]) path.push(q)
    path.reverse()
    const sight = (a: Pt, b: Pt) => {
      const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (cs / 2))
      for (let k = 1; k < steps; k++) {
        const x = a.x + ((b.x - a.x) * k) / steps
        const y = a.y + ((b.y - a.y) * k) / steps
        const i = Math.floor(x / cs)
        const j = Math.floor(y / cs)
        if (i < 0 || j < 0 || i >= cols || j >= rows || !free[j * cols + i]) return false
      }
      return true
    }
    const pts: Pt[] = []
    let a = 0
    while (a < path.length - 1) {
      let b = path.length - 1
      while (b > a + 1 && !sight(cell(path[a]), cell(path[b]))) b--
      pts.push(cell(path[b]))
      a = b
    }
    // now and then a loop where there is room, or a pause in the air
    let kind: RouteKind = 'glide'
    const end = cell(target)
    const r = Math.min(C.loopRadius, clr[target] * 0.9)
    if (Math.random() < C.loopChance && r > 70) {
      const dir = Math.random() < 0.5 ? 1 : -1
      const a0 = Math.atan2(here.y - end.y, here.x - end.x)
      let prev = end
      for (let k = 1; k <= 6; k++) {
        const ang = a0 + dir * k * ((Math.PI * 2) / 6)
        const p = { x: end.x + Math.cos(ang) * r, y: end.y + Math.sin(ang) * r * 0.6 }
        if (!sight(prev, p)) break
        pts.push(p)
        prev = p
      }
      kind = 'loop'
    } else if (Math.random() < C.hoverChance) kind = 'hover'
    this.kind = kind
    this.hoverLeft = kind === 'hover' ? C.hoverFor[0] + Math.random() * (C.hoverFor[1] - C.hoverFor[0]) : 0
    this.route = pts.map((p) => ({ x: p.x, y: p.y + vtop }))
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
      const off = next && (next.y < vtop + this.head.getBoundingClientRect().bottom || next.y > vtop + vh)
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
      // slower in a narrow place and when arriving at the last point
      const sp = Math.min(C.maxSpeed, C.narrowBase + C.narrowPerPx * this.room(this.pos), this.route.length > 1 ? Infinity : dl * 1.8 + 40)
      let dvx = (dx / dl) * sp
      let dvy = (dy / dl) * sp
      // a soft wall at the screen edges, so a fast turn never carries him off the side
      if (this.pos.x < C.edgeX) dvx += (C.edgeX - this.pos.x) * 8
      if (this.pos.x > w - C.edgeX) dvx -= (this.pos.x - w + C.edgeX) * 8
      if (this.pos.y > vtop + vh - C.edgeBottom) dvy -= (this.pos.y - vtop - vh + C.edgeBottom) * 8
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
      // remember which part of the screen he has been in, so the next target is somewhere else
      const fade = Math.exp(-dt / C.zoneMemory)
      for (let z = 0; z < this.zoneT.length; z++) this.zoneT[z] *= fade
      this.zoneT[this.zoneOf(this.pos.x, this.relY)] += dt
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
