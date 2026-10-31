// Types for netopyr.js (the built module). Written by hand: build.mjs does not touch this file.
import type * as THREE from 'three'

/** A pose: what the clips write and BatView.pose() reads. Positions in world units, y down. */
export interface Pose {
  x: number
  y: number
  z: number
  q: number[]
  o: number
  open: number
  phi: number
  flap: number
  bobY: number
  hyaw: number
  hpitch: number
  [key: string]: unknown
}

export interface Clip {
  name: string
  dur: number
  fn(t: number, b: Pose): void
}

export interface Species {
  headLim: [number, number, number]
  [key: string]: unknown
}

type Uniforms = Record<string, { value: any }>
type Mat = THREE.Material & { userData: { u: Uniforms } }

export class BatView {
  constructor(D: Species, opt?: { env?: THREE.Texture | null; shadow?: boolean; shells?: number; glow?: number })
  g: THREE.Group
  fxg: THREE.Group
  mFur: Mat
  mMem: Mat
  pose(b: Pose): void
  tick(dt: number, px: number, view: number[], away?: unknown): void
  dispose(): void
}

export const NETOPYR: Species
export const CLIPS: Clip[]
export function base(): Pose
export const K: number
export const PERCH_Y: number
export const TIME: { value: number }
export const PXU: { value: number }
export function qF(a: number, b: number, c: number): number[]
export function qH(sw: number): number[]
export function qU(...a: number[]): number[]
