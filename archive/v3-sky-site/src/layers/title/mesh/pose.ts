import * as THREE from 'three'

/**
 * Where the mesh title stands and how it is photographed — the same "lens" as the client's render.
 *
 * Camera: a pinhole at the origin looking down −z, focal length 1; image coordinates u = x / −z,
 * v = −y / −z (v down). The title sits at (shiftX·D, shiftY·D, −D) — off-axis like a shifted lens,
 * so the left / bottom walls of the letters show as in reference/title-main.jpg — turned by
 * yaw / pitch / roll about its pivot (the centre of its bounds).
 *
 * That picture is laid onto the render's own TEXEL space (public/assets/title-raster: the cropped
 * reference, the frame the raster title, its glow and the overlay's anchors live in) by an image-plane
 * similarity `fit` (scale, rotation, offset) found once by scripts/title-mesh/fit.mjs against the
 * render's matte. On screen the texel space goes where the raster title puts it (raster/geometry.ts →
 * titleRestMap), so both titles stand on the same spot and the nav / tagline find their anchors.
 */

const DEG = Math.PI / 180

export interface MeshPose {
  /** turn about the vertical, degrees: + — the right end goes away */
  yaw: number
  /** tilt about the horizontal, degrees: − — the top leans back (the bottom walls show) */
  pitch: number
  /** in-plane tilt of the letters, degrees (+ — counter-clockwise) */
  roll: number
  /** camera distance, cap heights (smaller — stronger perspective) */
  distance: number
  /** the title off the lens axis, fractions of the distance (+x — camera to the left, +y — below) */
  shiftX: number
  shiftY: number
}

/** Image plane → texel space: texel = scale · Rot(rotation) · (u, v) + (x, y). Rotation in degrees, clockwise on screen. */
export interface ImageFit {
  scale: number
  rotation: number
  x: number
  y: number
}

const _q = new THREE.Quaternion()
const _e = new THREE.Euler()
const _v = new THREE.Vector3()
const _m = new THREE.Matrix4()
const ONE = new THREE.Vector3(1, 1, 1)

/** Object → camera at rest (no turn toward the cursor): X_cam = C + R · (X − pivot). */
export function restMatrix(pose: MeshPose, pivot: THREE.Vector3, out: THREE.Matrix4) {
  _q.setFromEuler(_e.set(pose.pitch * DEG, pose.yaw * DEG, pose.roll * DEG, 'YXZ'))
  out.compose(restCentre(pose, _v), _q, ONE)
  return out.multiply(_m.makeTranslation(-pivot.x, -pivot.y, -pivot.z))
}

/** The camera centre of the rest pose (= pose.distance away along the shifted axis), for the turn pivot. */
export function restCentre(pose: MeshPose, out: THREE.Vector3) {
  return out.set(pose.shiftX * pose.distance, pose.shiftY * pose.distance, -pose.distance)
}

/** Composes two image-plane similarities: first `a`, then `b`. */
export function chainFit(a: ImageFit, b: ImageFit): ImageFit {
  const rb = b.rotation * DEG
  const c = Math.cos(rb)
  const s = Math.sin(rb)
  return {
    scale: a.scale * b.scale,
    rotation: a.rotation + b.rotation,
    x: b.scale * (c * a.x - s * a.y) + b.x,
    y: b.scale * (s * a.x + c * a.y) + b.y,
  }
}

/** Applies a similarity to an image point. */
export function applyFit(f: ImageFit, u: number, v: number) {
  const r = f.rotation * DEG
  const c = Math.cos(r)
  const s = Math.sin(r)
  return { x: f.scale * (c * u - s * v) + f.x, y: f.scale * (s * u + c * v) + f.y }
}

/**
 * Projection: pinhole (f = 1) → image-plane similarity `f` (to px of a W×H viewport, y down) → NDC.
 * `jx / jy` — an extra sub-pixel shift, px.
 */
export function setProjection(out: THREE.Matrix4, W: number, H: number, f: ImageFit, near: number, far: number, jx = 0, jy = 0) {
  const r = f.rotation * DEG
  const c = Math.cos(r)
  const s = Math.sin(r)
  const k = f.scale
  const tx = f.x + jx
  const ty = f.y + jy
  out.set(
    (2 * k * c) / W, (2 * k * s) / W, 1 - (2 * tx) / W, 0,
    (-2 * k * s) / H, (2 * k * c) / H, (2 * ty) / H - 1, 0,
    0, 0, -(far + near) / (far - near), (-2 * far * near) / (far - near),
    0, 0, -1, 0,
  )
  return out
}
