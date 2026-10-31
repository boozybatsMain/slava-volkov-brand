// Нетопырь on the site: what he does by day and by night. All the numbers are in site.config.ts → bat.
//   day (lights on)   hangs under the fixed header and is position: fixed like it, so a fast scroll
//                     can never leave him behind; every few seconds, and at once when the cursor comes
//                     close, he spreads his starry wings.
//   night (lights off) takes off and flies by himself: page coordinates, steering, never snapping with
//                     the scroll; circles the cursor at a distance, glides mostly and flaps in bursts.
// One small WebGL canvas rides along with him; it is drawn only while he is near the screen.
import { site } from '../site.config'
import { Stage } from './stage'
import { CLIPS, base, qF, PERCH_Y } from '../../brand/mascot/netopyr.js'

const C = site.bat
type Mode = 'hang' | 'takeoff' | 'fly' | 'return' | 'land'
const PERCHED: Mode[] = ['hang', 'takeoff', 'land']

// clip indices in brand/mascot/src/clips.js
const FLY = 0
const HANG = 3
const LAND = 4
const TAKEOFF = 5

export class SiteBat {
  private stage: Stage
  private k = 1
  private landOff = { x: 0, y: 0 }
  private mode: Mode
  private tm = 0
  private t = 0
  private spread = 0
  private pos = { x: -9999, y: 0 }
  private vel = { x: 0, y: 0 }
  private relY = 0
  private orb = 0
  private tf = 0
  private flapK = 1
  private pinned: boolean | null = null
  private cx = 0
  private cy = 0
  private plast = -1e9
  private w = 0
  private raf = 0
  private last = 0
  private dark: boolean
  private reduced = matchMedia('(prefers-reduced-motion: reduce)')

  constructor(private canvas: HTMLCanvasElement, private halo: HTMLElement | null, private head: HTMLElement, dark: boolean) {
    this.stage = new Stage(canvas, { look: C.look, shells: C.shells, glow: C.glow, maxPixelRatio: C.maxPixelRatio })
    this.stage.setSize(C.canvas.w, C.canvas.h)
    this.dark = dark
    this.mode = dark && !this.reduced.matches ? 'takeoff' : 'hang'
    this.fit()
    addEventListener('pointermove', this.onMove, { passive: true })
    addEventListener('resize', this.onResize)
    document.addEventListener('visibilitychange', this.onVisibility)
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)
  }

  setDark(dark: boolean) {
    if (dark === this.dark) return
    this.dark = dark
    if (dark) {
      if (this.reduced.matches) return // with reduced motion he stays on his perch
      if (this.mode === 'hang') this.setMode('takeoff')
      else if (this.mode === 'return' || this.mode === 'land') this.setMode('fly')
    } else if (this.mode === 'fly' || this.mode === 'takeoff') this.setMode('return')
  }

  private onMove = (e: PointerEvent) => {
    this.cx = e.clientX
    this.cy = e.clientY
    this.plast = performance.now()
  }
  private onResize = () => this.fit()
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
    const tmp = base()
    CLIPS[LAND].fn(0, tmp)
    this.landOff = { x: tmp.x / this.k, y: tmp.y / this.k }
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

  private step(dt: number) {
    const st = this.stage
    const k = this.k
    this.t += dt
    this.tm += dt
    const t = this.t
    const w = this.w
    const mobile = w < C.mobileBelow
    const vtop = window.scrollY
    const vh = window.innerHeight
    const pb = st.pose()
    const m = this.mode
    const live = performance.now() - this.plast < C.pointerAlive
    // the cursor in page coordinates
    const mx = this.cx
    const my = this.cy + vtop
    // he hangs from the fixed header, so his perch moves with the screen
    const ax = w * (mobile ? C.perchXMobile : C.perchX)
    const ay = vtop + this.head.getBoundingClientRect().bottom - C.perchInset + PERCH_Y / k

    if (m === 'hang' || m === 'takeoff' || m === 'land') {
      if (m === 'hang') st.clip(HANG, this.tm, pb)
      else if (m === 'takeoff') st.clip(TAKEOFF, Math.min(this.tm, 2.39), pb)
      else st.clip(LAND, Math.min(this.tm, 2.99), pb)
      if (m === 'hang') {
        // now and then (and whenever the cursor comes close) he opens the starry wings
        const u = this.tm % C.spreadEvery
        let want = !this.reduced.matches && u > C.spreadFrom && u < C.spreadTo ? 1 : 0
        if (live && Math.hypot(mx - ax, my - ay - 30) < C.hoverRadius) want = 1
        this.spread += (want - this.spread) * Math.min(1, dt * (want ? 5 : 3.5))
        const s = this.spread * this.spread * (3 - 2 * this.spread)
        if (s > 0.001) {
          pb.o = s
          pb.open = s
          pb.phi = pb.phi * (1 - s) + 0.04 * Math.sin(t * 2.2) * s
        }
        if (live) st.look(pb, ((mx - ax) / w) * 2, (-(my - ay) / vh) * 2, 0.5)
      }
      st.place(pb, ax * k, -ay * k, 0)
      const nx = pb.x / k
      const ny = pb.y / k
      // velocity relative to the screen, so a fast scroll does not fling him when he takes off
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
      if (m === 'takeoff' && this.tm > 1.25) this.setMode('fly')
      if (m === 'land' && this.tm > 2.99) {
        this.setMode('hang')
        this.spread = 0
      }
    } else {
      let tx: number
      let ty: number
      const keep = mobile ? C.keepAwayMobile : C.keepAway
      if (m === 'fly') {
        if (live) {
          // he circles the cursor at a polite distance instead of sitting on it
          this.orb += dt * C.orbitSpeed
          const R = mobile ? C.orbitMobile : C.orbit
          tx = mx + Math.cos(this.orb) * R
          ty = my + Math.sin(this.orb) * R * 0.55
          tx = Math.max(C.edgeX, Math.min(w - C.edgeX, tx))
          ty = Math.max(vtop + C.edgeTop, Math.min(vtop + vh - C.edgeBottom, ty))
        } else {
          tx = w * 0.6 + Math.sin(t * 0.42) * w * 0.28
          ty = vtop + vh * (0.48 + Math.sin(t * 0.83) * 0.18)
        }
      } else {
        tx = ax + this.landOff.x
        ty = ay + this.landOff.y
        if (Math.hypot(tx - this.pos.x, ty - this.pos.y) < 16 || this.tm > 4) this.setMode('land')
      }
      // steering, not snapping: when the page scrolls away he flies after the screen by himself
      const dx = tx - this.pos.x
      const dy = ty - this.pos.y
      const dl = Math.hypot(dx, dy) || 1
      const sp = Math.min(C.maxSpeed, dl * (m === 'fly' && live ? 2.2 : 2.6))
      let dvx = (dx / dl) * sp
      let dvy = (dy / dl) * sp
      const acc = Math.min(1, dt * C.steer)
      if (m === 'fly' && live) {
        const ex = this.pos.x - mx
        const ey = this.pos.y - my
        const ed = Math.hypot(ex, ey) || 1
        if (ed < keep) {
          dvx += (ex / ed) * (keep - ed) * 5
          dvy += (ey / ed) * (keep - ed) * 5
        }
      }
      this.vel.x += (dvx - this.vel.x) * acc
      this.vel.y += (dvy - this.vel.y) * acc
      this.pos.x += this.vel.x * dt
      this.pos.y += this.vel.y * dt
      if (m === 'fly' && live) {
        // the hard limit: never closer than keep to the cursor
        const fx = this.pos.x - mx
        const fy = this.pos.y - my
        const fd = Math.hypot(fx, fy) || 1
        if (fd < keep) {
          const u = Math.min(1, dt * 8) * (keep - fd)
          this.pos.x += (fx / fd) * u
          this.pos.y += (fy / fd) * u
          const vr = (this.vel.x * fx + this.vel.y * fy) / fd
          if (vr < 0) {
            this.vel.x -= (fx / fd) * vr
            this.vel.y -= (fy / fd) * vr
          }
        }
      }
      // fewer wing beats: he glides most of the time and flaps in bursts, when climbing or when nearly still
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
      this.relY = this.pos.y - vtop
    }
    st.follow(pb.x, -pb.y)

    // on the perch he is pinned to the screen like the header itself (position: fixed)
    const pin = PERCHED.includes(this.mode)
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
