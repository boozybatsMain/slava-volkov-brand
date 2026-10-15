import type { Pt } from './quad'

/**
 * The project slab's LIVE pose, for layers that lie on its plane (the project texts: label, title,
 * description, arrows). Same idea as title/raster/pose.ts → titlePose: one solver (the slab layer's),
 * everything else projects through what it publishes.
 *
 * The slab publishes every frame it is live AND in resize(), so the pose is valid while the slab
 * sleeps (before it arrives) and right after a viewport change. The hero updates layers in their
 * declared order: a layer declared after the slab reads the pose of the SAME frame.
 */
export interface SlabPose {
  /** Changes whenever the projection does (turn toward the cursor, float, arrival, resize, pose knobs). */
  key: string
  /**
   * Face units → stage CSS px through the slab's CURRENT 3D pose: (0, 0) is the front face's top-left
   * corner, (1, 1) its bottom-right; values beyond 0…1 are valid and stay on the face's plane
   * (v > 1 = under the slab).
   */
  project(u: number, v: number): Pt
  /**
   * The same through the pose at REST — arrived, no cursor, no float, no swing: for what belongs
   * with the slab but must not move with it (where the texts end, for the floor shadow).
   */
  rest(u: number, v: number): Pt
  /** The front face on screen: TL, TR, BR, BL, stage CSS px. */
  corners: [Pt, Pt, Pt, Pt]
  /** The face's size at scale 1 (before the perspective), CSS px. */
  flat: { w: number; h: number }
  /** 0 — not here yet … 1 — arrived (projects.arrive, by scroll). */
  arrival: number
}

export const slabPose: { current: SlabPose | null } = { current: null }

/**
 * The other way round — what the slab needs to know about the texts lying on its plane: how far
 * down the stage they reach with the slab at rest, CSS px. Published by the layer that lays them
 * out; the slab starts its floor shadow below that line (dots behind small type read as dirt).
 * null — no texts (yet).
 */
export const slabTexts: { current: { bottom: number } | null } = { current: null }
