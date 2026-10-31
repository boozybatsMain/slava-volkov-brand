/**
 * The title's LIVE pose, for layers that lie on its plane (the sky overlay: nav + tagline).
 *
 * The WebGL title publishes itself here once it is up and clears it on dispose. Without it (still
 * loading, static fallback, ?layers= without the title) readers fall back to the rest pose
 * (geometry.ts → titleRestMap). The hero updates layers in their declared order, so a layer declared
 * after the title reads the pose of the SAME frame.
 */
export interface TitlePose {
  /** Changes whenever the projection does (turn toward the cursor, resize, pose knobs). */
  readonly key: string
  /**
   * Texel → screen CSS px through the title's CURRENT 3D pose, exactly as its vertex shader moves
   * the front faces (baked depth + recess); without the lens jitter of the "bad render".
   */
  project(x: number, y: number): { x: number; y: number }
}

export const titlePose: { current: TitlePose | null } = { current: null }
