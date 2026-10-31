import * as THREE from 'three'

/**
 * The «bad render» pieces shared by the three.js lattice layers — the projects slab (layers/slab) and
 * the ABOUT world (layers/about): the same hashes and ordered dither, the same glitch pass over the
 * rendered frame, the same point-sampled picture textures, the same display-space colours. One copy,
 * so the two screens cannot drift apart.
 *
 * Everything lives on a low-resolution pixel lattice (the canvas is that small and only ever
 * magnified by CSS, `image-rendering: pixelated`): coverage is binary, textures are point-sampled,
 * colour goes through a low-depth framebuffer with an ordered dither. Nothing is anti-aliased.
 */

/** GLSL: hash12 (a lattice pixel → 0…1) and bayer4 (the 4×4 ordered threshold, 1/32 … 31/32). */
export const RASTER_GLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// 4×4 ordered (Bayer) threshold of a lattice pixel, 1/32 … 31/32
float bayer4(vec2 p) {
  const float m[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
  ivec2 i = ivec2(mod(p, 4.0));
  return (m[i.x + i.y * 4] + 0.5) / 16.0;
}
`

/** The same 4×4 Bayer matrix for 2D canvases (row-major, rows from the TOP), values 0…15. */
export const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

/** Fullscreen quad (a PlaneGeometry(2, 2) drawn with any camera). */
const SCREEN_VS = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

/**
 * The glitch pass over the rendered frame — the title's edge instability (title/raster/shaders.ts:
 * crawl on `e`, row slips on `eMove²`, both re-rolled on the shimmer tick), for objects that have no
 * matte: it works on the pixels themselves.
 *   crawl — an object pixel (alpha 1) with an empty 4-neighbour is dropped (inward only: the outline is
 *           eaten, nothing is ever sprinkled outside it); pixels with 0.5 < alpha < 0.98 count as
 *           covered but never crawl themselves: DOTS (0.5…0.9) and objects in the middle of their
 *           Bayer reveal (≈ 0.95 — every stipple pixel has empty neighbours by design: eaten, the
 *           regular grid would turn into a random maze, a «disintegrating» object). The screen's edge
 *           is NOT an outline: past it counts as the edge pixel itself (a letter cut by the frame
 *           keeps a straight cut, no flickering dashed frame); the ABOUT world's dotted shadows are
 *           drawn by its variant of this pass into the empty pixels (glitchFS below);
 *   row slips — rare short runs of 1–3 rows shift sideways by a few pixels (at the screen's edge they
 *           pull in the edge pixel, not emptiness);
 *   tears — forced: a few bands of rows within uSpan slip at once (a switch, a texture load).
 * Output alpha is strictly 0 or 1. There is no whole-object jitter (the client rejected a jumping title).
 * Starts with GLITCH_TAG: if it fails to compile the layer goes on without it.
 */
export const GLITCH_TAG = '// raster-glitch'

export const GLITCH_VS = /* glsl */ `${GLITCH_TAG}${SCREEN_VS}`

/**
 * The glitch pass with something of the layer's own drawn into the pixels it leaves EMPTY (after the
 * slips and the crawl): `head` — its uniforms and functions (RASTER_GLSL and `vec4 src(vec2 p)` — the
 * frame's pixel, 0 outside — are already in), `empty` — a GLSL statement run where nothing covers the
 * pixel, with `vec2 p` (the source pixel, the row slips applied), `vec2 px` (this pixel) and `vec4 c`
 * (set it to vec4(rgb, 1.0) to cover the pixel). The ABOUT world draws its dotted shadows there
 * (layers/about/shaders.ts → SHADE_HEAD): the dots land only on the void, slip with their rows and
 * never crawl. Without both — GLITCH_FS, the slab's.
 */
export function glitchFS(head = '', empty = ''): string {
  return GLITCH_SRC.replace('/*HEAD*/', head).replace('/*EMPTY*/', empty)
}

const GLITCH_SRC = /* glsl */ `${GLITCH_TAG}
precision highp float;
uniform sampler2D uSrc;    // the frame (nearest): alpha 1 — an object, 0.9…0.98 — an object mid-reveal, 0.5…0.9 — a dot, 0 — nothing
uniform vec2 uRes;
uniform float uTick;
uniform vec2 uE;           // e (crawl), eMove (row slips) — the title's formulas
uniform float uCrawl;
uniform vec3 uRow;         // probability, largest shift (px), run length (px)
uniform vec3 uTear;        // bands, largest shift (px), seed
uniform vec2 uSpan;        // the rows the objects cover on screen: lowest, highest (render px, y up)
${RASTER_GLSL}
vec4 src(vec2 p) {
  if (p.x < 0.0 || p.y < 0.0 || p.x >= uRes.x || p.y >= uRes.y) return vec4(0.0);
  return texelFetch(uSrc, ivec2(p), 0);
}
// the frame's pixel, clamped to the frame: past the screen's edge is the edge pixel itself (the frame
// cuts an object; its cut is not an outline to crawl, a slip at the edge pulls in the edge, not nothing)
vec4 srcC(vec2 p) {
  return texelFetch(uSrc, ivec2(clamp(p, vec2(0.0), uRes - 1.0)), 0);
}
/*HEAD*/

void main() {
  vec2 px = floor(gl_FragCoord.xy);
  vec2 p = px;

  // forced tears: bands of 2–8 rows somewhere over the objects, each slipping its own way
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    if (fi >= uTear.x) break;
    float y0 = floor(mix(uSpan.x, uSpan.y, hash12(vec2(fi * 7.3 + 1.0, uTear.z))));
    float rows = 2.0 + floor(hash12(vec2(fi * 3.1 + 5.0, uTear.z)) * 7.0);
    if (px.y >= y0 && px.y < y0 + rows) {
      float shift = max(1.0, ceil(hash12(vec2(fi + 9.0, uTear.z + 2.0)) * uTear.y));
      p.x += hash12(vec2(fi + 4.0, uTear.z)) < 0.5 ? -shift : shift;
    }
  }

  // rare row slips: a short run of 1–3 rows shifts by a few pixels
  float bandH = 1.0 + floor(hash12(vec2(uTick, 3.7)) * 3.0);
  float band = floor(px.y / bandH);
  float run = uRow.z * (1.0 + 2.0 * hash12(vec2(band, uTick + 4.1)));
  float seg = floor((px.x + hash12(vec2(band, uTick + 5.3)) * 97.0) / run);
  if (hash12(vec2(band * 1.618 + seg * 31.7, uTick + 0.5)) < uRow.x * uE.y * uE.y) {
    float dir = hash12(vec2(band + seg, uTick + 1.7)) < 0.5 ? -1.0 : 1.0;
    p.x += dir * max(1.0, ceil(hash12(vec2(band, seg + uTick + 2.9)) * uRow.y));
  }

  vec4 c = srcC(p);
  // edge crawl, inward only (whole objects; dots and objects mid-reveal never crawl)
  if (c.a > 0.98 && hash12(px * 0.37 + vec2(uTick * 7.13, uTick * 3.1)) < uCrawl * min(uE.x, 1.0)) {
    float m = min(min(srcC(p + vec2(1.0, 0.0)).a, srcC(p - vec2(1.0, 0.0)).a), min(srcC(p + vec2(0.0, 1.0)).a, srcC(p - vec2(0.0, 1.0)).a));
    if (m < 0.5) c.a = 0.0;
  }
  if (c.a <= 0.5) {
    c = vec4(0.0);
    /*EMPTY*/
  }
  gl_FragColor = c.a > 0.5 ? vec4(c.rgb, 1.0) : vec4(0.0);
}
`

/** The slab's glitch pass (nothing of its own in the empty pixels). */
export const GLITCH_FS = glitchFS()

const _color = new THREE.Color()

/** '#rrggbb' → raw display-space 0…1 (these layers work in display space, like an old renderer). */
export function hexToVec3(hex: string, out: THREE.Vector3) {
  _color.setStyle(hex, THREE.NoColorSpace)
  return out.set(_color.r, _color.g, _color.b)
}

/**
 * A picture canvas as a lattice texture: display-space (NoColorSpace), point-sampled (Nearest /
 * NearestMipmapNearest — the mip level is chosen explicitly in the shaders), clamped, mips generated
 * from the already-reduced canvas. CanvasTexture flips y: shaders sample (u, 1 − v).
 */
export function latticeTexture(canvas: HTMLCanvasElement) {
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.NoColorSpace
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestMipmapNearestFilter
  tex.generateMipmaps = true
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  tex.anisotropy = 1
  return tex
}
