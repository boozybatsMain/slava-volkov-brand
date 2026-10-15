/**
 * Flat DOM onto a plane in perspective: screen quads and the CSS matrix3d that bends an element's
 * rectangle onto one. Shared by everything that lays real DOM on a 3D surface — the sky overlay
 * (nav + tagline on the title's plane) and the project texts on the slab.
 */

export interface Pt {
  x: number
  y: number
}

/**
 * CSS matrix3d taking the element's local rectangle (a0, b0)–(a1, b1) onto the screen quad
 * q0…q3 (images of its corners (a0,b0), (a1,b0), (a1,b1), (a0,b1)): unit square → quad (Heckbert),
 * composed with rectangle → unit square. matrix3d is column-major.
 */
export function rectToQuad(a0: number, b0: number, a1: number, b1: number, q0: Pt, q1: Pt, q2: Pt, q3: Pt) {
  const dx1 = q1.x - q2.x
  const dx2 = q3.x - q2.x
  const dx3 = q0.x - q1.x + q2.x - q3.x
  const dy1 = q1.y - q2.y
  const dy2 = q3.y - q2.y
  const dy3 = q0.y - q1.y + q2.y - q3.y
  const det = dx1 * dy2 - dx2 * dy1
  const g = det ? (dx3 * dy2 - dx2 * dy3) / det : 0
  const k = det ? (dx1 * dy3 - dx3 * dy1) / det : 0
  // x = (A·s + B·t + q0.x) / (g·s + k·t + 1), y = (D·s + E·t + q0.y) / (…), s / t ∈ 0…1
  const A = q1.x - q0.x + g * q1.x
  const B = q3.x - q0.x + k * q3.x
  const D = q1.y - q0.y + g * q1.y
  const E = q3.y - q0.y + k * q3.y
  const da = a1 - a0 || 1
  const db = b1 - b0 || 1
  const m = [
    A / da, D / da, 0, g / da,
    B / db, E / db, 0, k / db,
    0, 0, 1, 0,
    q0.x - (A * a0) / da - (B * b0) / db, q0.y - (D * a0) / da - (E * b0) / db, 0, 1 - (g * a0) / da - (k * b0) / db,
  ]
  return `matrix3d(${m.map((n) => +n.toPrecision(9)).join(',')})`
}
