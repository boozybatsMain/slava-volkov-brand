import type { PointerState, ResolvedConfig } from './types'

/**
 * A layer's own inertia: a spring that chases the shared pointer target (frame.pointer.targetX/Y)
 * with a MASS. mass 1 reproduces the shared feel (motion.stiffness / motion.damping) exactly;
 * heavier things turn later and slower (×√mass time), lighter ones snap quicker. Damping scales
 * with √mass, so the damping ratio — and therefore the amount of overshoot — never changes.
 */
export class Follower {
  x = 0
  y = 0
  vx = 0
  vy = 0
  private started = false

  step(p: PointerState, dt: number, motion: ResolvedConfig['motion'], mass: number) {
    if (!this.started) {
      this.x = p.x
      this.y = p.y
      this.started = true
    }
    const m = Math.max(0.05, mass)
    const k = motion.stiffness
    const c = motion.damping * Math.sqrt(m)
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)))
    const h = dt / steps
    for (let i = 0; i < steps; i++) {
      this.vx += ((k * (p.targetX - this.x) - c * this.vx) / m) * h
      this.vy += ((k * (p.targetY - this.y) - c * this.vy) / m) * h
      this.x += this.vx * h
      this.y += this.vy * h
    }
    return this
  }
}

/**
 * A 1-D spring with no mass knob: a value chasing a target at natural frequency `omega` (1/s) with
 * damping ratio `zeta` (1 = critically damped: the fastest approach with no overshoot; below 1 it
 * swings past and comes back). Semi-implicit Euler, sub-stepped like Follower, so a slow frame
 * cannot blow it up. `v` is public: an impulse (a kick) is just `spring.v += …`.
 */
export class Spring1 {
  v = 0

  constructor(public x = 0) {}

  step(target: number, dt: number, omega: number, zeta = 1) {
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)))
    const h = dt / steps
    for (let i = 0; i < steps; i++) {
      this.v += (omega * omega * (target - this.x) - 2 * zeta * omega * this.v) * h
      this.x += this.v * h
    }
    return this.x
  }

  /** Jump to `x` and stop there. */
  set(x: number) {
    this.x = x
    this.v = 0
  }
}
