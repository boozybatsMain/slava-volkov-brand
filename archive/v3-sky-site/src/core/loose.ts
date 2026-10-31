/**
 * Reading knobs from a config whose exact type the reader does not own: core must not depend on one
 * page's config, and a layer must survive any config — an old one, a hand-edited one, the tuner.
 * Every read names its fallback.
 */

export type Loose = Record<string, unknown>

export const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
export const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d)
export const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
/** A plain object (not an array), or an empty one. */
export const obj = (v: unknown): Loose => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Loose) : {})
