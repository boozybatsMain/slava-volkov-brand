import * as THREE from 'three'
import type { MeshTitleParams } from './params'

/**
 * Camera model: a fixed pinhole at the origin looking down −z (focal length 1).
 * The title sits at (shiftX·D, shiftY·D, −D) — off-axis, like a shifted lens, so
 * we see the left / bottom sides of every letter as in reference/title-main.jpg.
 * The resulting picture is then placed on screen by an image-plane similarity
 * (scale s, rotation rot, translation tx/ty in CSS px) baked into the projection.
 */

const DEG = Math.PI / 180

export interface PoseInput {
  /** extra base tilt (deg) from hero.config title.tilt */
  tiltX: number
  tiltY: number
  /** hero.config title.perspective */
  perspective: number
}

export interface Placement {
  s: number
  rot: number
  tx: number
  ty: number
  D: number
  center: THREE.Vector3
  base: THREE.Quaternion
}

export function poseOf(p: MeshTitleParams, inp: PoseInput) {
  const D = p.pose.distance / Math.max(0.05, inp.perspective)
  const center = new THREE.Vector3(p.pose.shiftX * D, p.pose.shiftY * D, -D)
  const base = new THREE.Quaternion().setFromEuler(
    new THREE.Euler((p.pose.pitch + inp.tiltX) * DEG, (p.pose.yaw + inp.tiltY) * DEG, p.pose.roll * DEG, 'YXZ'),
  )
  return { D, center, base }
}

export interface Extents {
  umin: number
  umax: number
  vmin: number
  vmax: number
  /** S: left edge and vertical middle */
  sLeft: number
  sMid: number
}

const tmpV = new THREE.Vector3()

/** Projects silhouette samples with object→camera matrix M; returns image-space extents (y down). */
export function measure(M: THREE.Matrix4, hull: Float32Array, hullS: Float32Array): Extents {
  const ex: Extents = { umin: Infinity, umax: -Infinity, vmin: Infinity, vmax: -Infinity, sLeft: Infinity, sMid: 0 }
  for (let i = 0; i < hull.length; i += 3) {
    tmpV.set(hull[i], hull[i + 1], hull[i + 2]).applyMatrix4(M)
    const w = Math.max(1e-4, -tmpV.z)
    const u = tmpV.x / w
    const v = -tmpV.y / w
    if (u < ex.umin) ex.umin = u
    if (u > ex.umax) ex.umax = u
    if (v < ex.vmin) ex.vmin = v
    if (v > ex.vmax) ex.vmax = v
  }
  let s0 = Infinity
  let s1 = -Infinity
  for (let i = 0; i < hullS.length; i += 3) {
    tmpV.set(hullS[i], hullS[i + 1], hullS[i + 2]).applyMatrix4(M)
    const w = Math.max(1e-4, -tmpV.z)
    const u = tmpV.x / w
    const v = -tmpV.y / w
    if (u < ex.sLeft) ex.sLeft = u
    if (v < s0) s0 = v
    if (v > s1) s1 = v
  }
  ex.sMid = (s0 + s1) / 2
  return ex
}

/** Similarity that puts the image point (au, av) at screen (x, y), with `width` = span of [umin, umax]. */
export function placeBy(ex: Extents, au: number, av: number, x: number, y: number, width: number, rotDeg: number) {
  const s = width / Math.max(1e-6, ex.umax - ex.umin)
  const rot = rotDeg * DEG
  const c = Math.cos(rot)
  const sn = Math.sin(rot)
  return { s, rot, tx: x - s * (c * au - sn * av), ty: y - s * (sn * au + c * av) }
}

/** Projection matrix: pinhole (f = 1) → image-plane similarity → NDC of a W×H CSS-px viewport. */
export function setProjection(
  out: THREE.Matrix4,
  W: number,
  H: number,
  s: number,
  rot: number,
  tx: number,
  ty: number,
  far: number,
) {
  const c = Math.cos(rot)
  const sn = Math.sin(rot)
  const near = 0.05
  out.set(
    (2 * s * c) / W, (2 * s * sn) / W, 1 - (2 * tx) / W, 0,
    (-2 * s * sn) / H, (2 * s * c) / H, (2 * ty) / H - 1, 0,
    0, 0, -(far + near) / (far - near), (-2 * far * near) / (far - near),
    0, 0, -1, 0,
  )
  return out
}
