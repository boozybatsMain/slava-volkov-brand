import type { PointerState, ResolvedConfig } from './types'

/**
 * Pointer with inertia: a damped spring follows the cursor, so every layer
 * receives the same heavy, slightly lagging motion instead of raw mouse jitter.
 */
export class Pointer {
  readonly state: PointerState = {
    x: 0, y: 0, vx: 0, vy: 0, energy: 0, rawX: 0, rawY: 0, targetX: 0, targetY: 0, active: false,
  }

  private targetX = 0
  private targetY = 0
  private lastMove = -Infinity
  private fixed: { x: number; y: number } | null = null

  constructor(private readonly el: HTMLElement) {
    const fixed = new URLSearchParams(location.search).get('pointer')
    if (fixed) {
      const [x, y] = fixed.split(',').map(Number)
      this.fixed = { x: x || 0, y: y || 0 }
    }
    window.addEventListener('pointermove', this.onMove, { passive: true })
    document.documentElement.addEventListener('pointerleave', this.onLeave)
    window.addEventListener('blur', this.onLeave)
  }

  private onMove = (e: PointerEvent) => {
    const r = this.el.getBoundingClientRect()
    this.targetX = ((e.clientX - r.left) / r.width) * 2 - 1
    this.targetY = ((e.clientY - r.top) / r.height) * 2 - 1
    this.state.active = true
    this.lastMove = performance.now()
  }

  private onLeave = () => {
    this.state.active = false
    this.targetX = 0
    this.targetY = 0
  }

  step(dt: number, time: number, cfg: ResolvedConfig) {
    const m = cfg.motion
    const s = this.state
    let tx = this.fixed ? this.fixed.x : this.targetX
    let ty = this.fixed ? this.fixed.y : this.targetY
    s.rawX = tx
    s.rawY = ty

    // Idle "float": slow, tiny wander that fades in after the mouse stops.
    const still = this.fixed ? 1 : Math.min(1, Math.max(0, (performance.now() - this.lastMove - 1500) / 2500))
    if (m.idle > 0 && still > 0) {
      const a = m.idle * 0.22 * still
      tx += a * (Math.sin(time * 0.31) * 0.7 + Math.sin(time * 0.17 + 1.3) * 0.3)
      ty += a * (Math.sin(time * 0.23 + 0.7) * 0.6 + Math.sin(time * 0.11 + 2.1) * 0.4)
    }

    tx *= m.intensity
    ty *= m.intensity
    s.targetX = tx
    s.targetY = ty

    // Semi-implicit Euler, sub-stepped for stability at low frame rates.
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)))
    const h = dt / steps
    for (let i = 0; i < steps; i++) {
      s.vx += (m.stiffness * (tx - s.x) - m.damping * s.vx) * h
      s.vy += (m.stiffness * (ty - s.y) - m.damping * s.vy) * h
      s.x += s.vx * h
      s.y += s.vy * h
    }

    const speed = Math.hypot(s.vx, s.vy)
    const target = Math.min(1, speed * 0.9)
    // Rise fast, decay slower — glitches linger a moment after the motion stops.
    const k = target > s.energy ? 1 - Math.exp(-dt * 12) : 1 - Math.exp(-dt * 3)
    s.energy += (target - s.energy) * k
  }

  dispose() {
    window.removeEventListener('pointermove', this.onMove)
    document.documentElement.removeEventListener('pointerleave', this.onLeave)
    window.removeEventListener('blur', this.onLeave)
  }
}
