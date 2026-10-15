/**
 * Slab shaders — the title's «bad render» recipe on a box.
 *
 * Everything lives on the slab's low-resolution pixel lattice (the canvas is that small and is only
 * ever magnified by CSS, `image-rendering: pixelated`): coverage is binary (a pixel is the slab or
 * it is not — the arrival's "transparency" and the shadow are ordered stipples), textures are
 * point-sampled at an explicit mip level, colour goes through a low-depth framebuffer with an
 * ordered dither. Nothing is anti-aliased, filtered or blended.
 *
 * Passes (index.ts): the box → a target; GLITCH_FS over that target (edge crawl, row slips, torn
 * bands) → the title's aberration pass (title/raster/aberration.ts). The shadow is not in here:
 * ./shadow.ts. The hashes, the dither and the glitch pass are shared with the ABOUT world
 * (core/raster-gl.ts).
 */

import { GLITCH_FS, GLITCH_TAG, GLITCH_VS, RASTER_GLSL } from '../../core/raster-gl'

export { GLITCH_FS, GLITCH_TAG, GLITCH_VS }

const COMMON = RASTER_GLSL

/** First line of the box shaders (if they fail to link there is no slab → the flat fallback). */
export const SLAB_TAG = '// slab'

export const SLAB_VS = /* glsl */ `${SLAB_TAG}
attribute float aFace;     // 0 front (the picture), 1 left, 2 right, 3 top, 4 bottom, 5 back

varying vec2 vUv;          // face uv, (0, 0) = its top-left corner; sides: x runs front → back
varying vec3 vAff;         // (uv · w, w): their ratio is the uv interpolated LINEARLY on screen
varying float vFace;

void main() {
  vUv = uv;
  vFace = aFace;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vAff = vec3(uv * gl_Position.w, gl_Position.w);
}
`

export const SLAB_FS = /* glsl */ `${SLAB_TAG}
precision highp float;

uniform sampler2D uPicA;   // the picture on screen (leaving, during a switch)
uniform sampler2D uPicB;   // the picture arriving
uniform vec4 uCropA;       // picture uv of the face's top-left corner + size of the visible window
uniform vec4 uCropB;
uniform vec2 uHas;         // 1 — that picture's texture is in, 0 — not yet (drawn untextured)
uniform vec2 uLod;         // mip level of A, B (whole steps)
uniform vec2 uZ;           // 1/w at the face's nearest corner; 1 / (nearest − farthest)
uniform float uStipple;    // coverage of the slab, 0…1 (arrival)
uniform float uTextured;   // 0 — the untextured box (arrival), 1 — pictures
uniform vec3 uBlank;       // the untextured face
uniform vec3 uSide;
uniform vec3 uBottom;
uniform vec4 uSeam;        // rgb, width (render px)
uniform vec3 uVeil;        // the void's colour: what the far corner melts into
uniform vec2 uHaze;        // amount, steps
uniform vec4 uSheen;       // amount, centre, half-width, slant
uniform float uSheenSteps;
uniform vec3 uSheenColor;  // the sheen's light (projects.slab.sheenColor)
uniform vec4 uPicGrade;    // the pictures' grade: tint multiplier rgb (already × its amount), saturation
uniform vec2 uPicWhite;    // its white point: knee, white (luminance above the knee compressed to white at most)
uniform vec2 uLevels;      // colour steps per channel: the face, the other faces
uniform float uDither;
uniform float uAffine;     // 0 — perspective-correct texture, 1 — affine (swims)
uniform vec2 uLeak;        // side face: amount, which picture (0 A, 1 B)
uniform vec2 uCells;       // side face: blocks across its depth, along its height

uniform float uMode;       // 0 — one picture, 1 — z-fight, 2 — scan
uniform float uDir;        // +1 — next (sweeps right → left), −1 — previous
uniform float uSweep;
uniform float uZone;
uniform float uZBits;
uniform float uTeeth;
uniform float uRows;
uniform float uTick;       // the switch's own clock: every re-roll happens on it
uniform vec4 uScan;        // pass (0…2), cursor (0…1 along the travel), coarse / fine block (render px)
uniform float uCursor;     // width of the scan cursor, render px
uniform vec3 uCursorColor; // its colour (projects.switch.scan.color)

varying vec2 vUv;
varying vec3 vAff;
varying float vFace;
${COMMON}
// a picture's texel, graded (projects.raster.grade: saturation toward its luminance, then the warm
// tint — luminance-normalised, so it shifts the hue and keeps the brightness; then the white point:
// highlights above the knee compressed, pure white at uPicWhite.y — never whiter than the void)
vec3 pic(sampler2D t, vec4 crop, float has, vec2 uv, float lod) {
  vec2 q = crop.xy + clamp(uv, 0.0, 1.0) * crop.zw;
  vec3 c = textureLod(t, vec2(q.x, 1.0 - q.y), lod).rgb;
  c = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, uPicGrade.w) * uPicGrade.rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  if (l > uPicWhite.x && uPicWhite.y < 1.0) c *= (uPicWhite.x + (l - uPicWhite.x) * (uPicWhite.y - uPicWhite.x) / max(1e-3, 1.0 - uPicWhite.x)) / l;
  return mix(uBlank, c, has);
}

// 'scan', one stage of the re-render: 0 — the old picture, 1 / 2 — the new one as a coarse / fine
// mosaic of SCREEN blocks (a preview renderer's passes), 3 — the new one
vec3 scanStage(float stage, vec2 uv, vec2 dx, vec2 dy) {
  if (stage < 0.5) return pic(uPicA, uCropA, uHas.x, uv, 0.0);
  float n = stage < 1.5 ? uScan.z : stage < 2.5 ? uScan.w : 1.0;
  vec2 o = (floor(gl_FragCoord.xy / n) + 0.5) * n - gl_FragCoord.xy;     // to the centre of its block
  return pic(uPicB, uCropB, uHas.y, uv + dx * o.x + dy * o.y, 0.0);
}

void main() {
  vec2 px = floor(gl_FragCoord.xy);
  // arrival: the slab fills in as an ordered stipple — binary coverage, never a fade
  if (bayer4(px) > uStipple) discard;

  float face = floor(vFace + 0.5);
  vec2 dx = dFdx(vUv);
  vec2 dy = dFdy(vUv);
  float depth = clamp((uZ.x - gl_FragCoord.w) * uZ.y, 0.0, 1.0);          // 0 near … 1 far
  float levels = uLevels.y;
  vec3 col;

  if (face < 0.5) {
    // ── the picture ───────────────────────────────────────────────────────────────────────────
    levels = uLevels.x;
    // in motion the texture is interpolated straight across the screen, per polygon: it swims
    vec2 uv = mix(vUv, vAff.xy / vAff.z, uAffine);
    float w = uDir > 0.0 ? 1.0 - vUv.x : vUv.x;                            // 0 at the leading edge
    if (uTextured < 0.5) {
      col = uBlank;
    } else if (uMode < 0.5) {
      col = pic(uPicA, uCropA, uHas.x, uv, uLod.x);
    } else if (uMode < 1.5) {
      // z-fight: both pictures sit on this one polygon and a coarse depth buffer cannot decide.
      // Depth is cut into uZBits terraces along the slab's LIVE depth (iso-depth lines of the
      // face: they turn with the slab); inside the fight zone each terrace is B for the first q
      // of its width, and q runs from 0 to 1 as the zone sweeps across. The terrace edges are
      // sawn per run of rows and re-rolled on the tick, as two rasterisers disagreeing would be.
      float f = fract(depth * uZBits + 0.35 * hash12(vec2(uTick, 7.7)));
      float q = clamp((uSweep * (1.0 + uZone) - w) / uZone, 0.0, 1.0);
      float row = floor(px.y / uRows);
      float saw = fract(row * 0.25 + hash12(vec2(uTick, 1.3))) - 0.5;      // a 4-step sawtooth…
      float teeth = (0.6 * saw + 0.4 * (hash12(vec2(row, uTick)) - 0.5)) * uTeeth;   // …with a ragged share
      bool b = f < q + teeth * step(0.001, q) * step(q, 0.999);
      col = b ? pic(uPicB, uCropB, uHas.y, uv, uLod.y) : pic(uPicA, uCropA, uHas.x, uv, uLod.x);
    } else {
      // scan: behind the cursor the picture is one stage further than ahead of it
      float gw = max(length(vec2(dx.x, dy.x)), 1e-6);                      // uv.x per render px
      float at = (uScan.y - w) / gw;                                       // px behind the cursor
      float stage = uScan.x + step(0.0, at);
      col = scanStage(stage, uv, dx, dy);
      if (at >= 0.0 && at < 6.0) {
        // fresh pixels right behind the cursor: red and blue have not converged yet
        col.r = scanStage(stage, uv + dx * 2.0, dx, dy).r;
        col.b = scanStage(stage, uv - dx * 2.0, dx, dy).b;
      }
      if (abs(at) < 0.5 * uCursor) col = uCursorColor;
    }

    if (uTextured > 0.5) {
      // sheen: a stepped light band lying across the glass; it slides as the slab turns
      float band = 1.0 - abs(vUv.x + (vUv.y - 0.5) * uSheen.w - uSheen.y) / uSheen.z;
      band = ceil(clamp(band, 0.0, 1.0) * uSheenSteps) / uSheenSteps;
      col = mix(col, uSheenColor, uSheen.x * band);
      // the seam around the picture: a line of whole lattice pixels
      vec2 g = vec2(length(vec2(dx.x, dy.x)), length(vec2(dx.y, dy.y)));
      vec2 e = min(vUv, 1.0 - vUv) / max(g, vec2(1e-6));
      if (min(e.x, e.y) < uSeam.w) col = uSeam.rgb;
    }
  } else if (face < 2.5) {
    // ── side faces: glass with the picture's own edge leaking in, in coarse blocks ────────────────
    col = uSide;
    if (uTextured > 0.5) {
      vec2 cell = floor(vUv * uCells);
      float v = (cell.y + 0.5) / uCells.y;
      float u = face < 1.5 ? 0.02 : 0.98;
      vec3 edge = uLeak.y < 0.5 ? pic(uPicA, uCropA, uHas.x, vec2(u, v), 5.0) : pic(uPicB, uCropB, uHas.y, vec2(u, v), 5.0);
      float lit = step(0.45, hash12(cell + 3.1 + face));                  // some blocks catch it, some stay glass
      col = mix(uSide, edge, uLeak.x * (0.3 + 0.7 * lit));
    }
  } else {
    // ── top, bottom, back: flat, a touch lighter toward the light on the right ───────────────────
    col = uBottom * (0.95 + 0.1 * vUv.x);
    if (uTextured < 0.5) col = mix(col, uBlank, 0.5);
  }

  // the far corner melts into the void in hard steps — a fog table, not a gradient
  col = mix(col, uVeil, uHaze.x * floor(depth * uHaze.y) / max(1.0, uHaze.y));

  // the framebuffer's colour depth, with the ordered dither that hides its steps
  float thr = 0.5 + (bayer4(px) - 0.5) * uDither;
  col = floor(clamp(col, 0.0, 1.0) * levels + thr) / levels;

  gl_FragColor = vec4(col, 1.0);
}
`
