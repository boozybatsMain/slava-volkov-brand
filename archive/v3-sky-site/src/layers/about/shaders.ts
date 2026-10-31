import { RASTER_GLSL } from '../../core/raster-gl'

/**
 * ABOUT — the shaders of the one world: black concrete letters, photo cards (the projects slab's box),
 * dotted shadows (footprint → gaussian → stepped Bayer dots in the glitch pass's empty pixels; below).
 * three.js ShaderMaterials (GLSL1-style; three compiles them as WebGL2), all on the about lattice:
 * binary coverage (reveals are Bayer stipples, shadows are Bayer dots), point-sampled textures, colour
 * quantised to raster.bits with an ordered dither, display-space colour (no colour management, no tone
 * mapping). Nothing is anti-aliased — do not "improve" it (the shadows' gaussian is a mask, never seen
 * as a gradient: it only decides where the dot steps fall).
 *
 * WORLD: sheet units (core/about-camera.ts) — x right, y DOWN, z toward the camera; the camera looks
 * straight down −z at home and on the tour, along its own `fwd` while it turns on the pull (uCam, uFwd).
 * projectionMatrix = core/about-camera.ts → clipMatrix (sheet → clip; the view is
 * identity), modelMatrix = the object's model (core/about-pose.ts). Each program starts with its own tag
 * line (shader-failure routing in gl.ts).
 */

export const CONCRETE_TAG = '// about-concrete'
export const CARD_TAG = '// about-card'
export const SHADOW_TAG = '// about-shadow'
export const COPY_TAG = '// about-copy'
export const BLUR_TAG = '// about-shadow-blur'

const LUMA = 'vec3(0.2126, 0.7152, 0.0722)'

/**
 * The nav's labels (core/nav-dock.ts: each docked item — its text and its dot — padded by
 * about.cards.dock.pad), render px (x0, y0, x1, y1; y up): dockOut(c) — how far the point c is outside
 * the nearest one, px (< 0 inside), each label taken as a PILL (its ends rounded by half its height:
 * a smudge behind the word, not a box). The concrete and the cards keep a soft halo behind each label
 * (a Bayer ramp across the edge), never one plate for the whole column.
 */
const DOCK_GLSL = /* glsl */ `
uniform vec4 uDockR[4];
uniform float uDockN;
float dockOut(vec2 c) {
  float o = 1e5;
  for (int i = 0; i < 4; i++) {
    if (float(i) >= uDockN) break;
    vec4 r = uDockR[i];
    vec2 h = 0.5 * (r.zw - r.xy);
    float rad = min(h.x, h.y);
    vec2 q = abs(c - 0.5 * (r.xy + r.zw)) - h + rad;
    o = min(o, length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad);
  }
  return o;
}
`

/** The output tail every material shares: stepped haze toward the void, grain, quantise + dither. */
const OUT_GLSL = /* glsl */ `
// the far parts melt into the void in hard steps — a fog table by HEIGHT (z), not a gradient
vec3 hazed(vec3 col, float z, vec4 haze, vec3 voidCol) {
  float k = clamp((haze.y - z) / max(1e-4, haze.y - haze.z), 0.0, 1.0);
  return mix(col, voidCol, haze.x * floor(k * haze.w + 1e-4) / max(1.0, haze.w));
}

// film grain on the lattice (re-rolled on the grain tick) and the framebuffer's colour depth, with
// the ordered dither that hides its steps
vec3 rasterOut(vec3 col, vec2 px, float bay, vec2 levels, vec2 grain) {
  col += (hash12(px + vec2(grain.y * 17.13, grain.y * 31.7)) - 0.5) * 2.0 * grain.x;
  float thr = 0.5 + (bay - 0.5) * levels.y;
  return floor(clamp(col, 0.0, 1.0) * levels.x + thr) / levels.x;
}
`

// ── black concrete ────────────────────────────────────────────────────────────────────────────────

export const CONCRETE_VS = /* glsl */ `${CONCRETE_TAG}
attribute vec2 aPart;      // band id (mesh.ts → PART), depth fraction
uniform float uScale;      // the word's width: sheet units per word unit
varying vec3 vN;           // normal, sheet axes
varying vec3 vW;           // the point, sheet units
varying vec3 vO;           // the point in the word's own frame × uScale (the texture travels with the letters)
varying vec3 vON;          // the normal in the word's own frame
varying vec3 vAZ;          // the word's own z axis (toward its face), sheet axes
varying float vPart;
varying float vFrac;       // depth fraction: 0 at the face … 1 at the back

void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vAZ = normalize(mat3(modelMatrix) * vec3(0.0, 0.0, 1.0));
  vO = position * uScale;
  vON = normal;
  vPart = aPart.x;
  vFrac = aPart.y;
  gl_Position = projectionMatrix * w;
}
`

export const CONCRETE_FS = /* glsl */ `${CONCRETE_TAG}
precision highp float;
uniform vec3 uCam;         // the camera (its eye), sheet units
uniform vec3 uFwd;         // its view direction (core/about-camera.ts → fwd)
uniform float uFpx;        // focal length, render px
uniform float uStipple;    // coverage (reveal), 0…1
// colours: dark (key light away) → lit (facing it), per band
uniform vec3 uFace0, uFace1, uStep0, uStep1, uBevel0, uBevel1, uWall0, uWall1;
uniform vec3 uSeam, uBack;
uniform vec3 uKey;         // toward the key light
uniform float uBands;      // Lambert bands
uniform vec3 uLamp;        // the glint's lamp, sheet units (core/about-camera.ts → cameraLamp: hung off the camera)
uniform vec4 uGlint;       // amount, cos(size), steps, —
uniform vec3 uGlintColor;
uniform vec4 uTex;         // texel (render px), mottle size, mottle amount, —
uniform vec3 uAgg;         // aggregate: size, density, amount
uniform vec3 uStone;       // the light pebbles' colour
uniform vec4 uHaze;        // amount, near z, far z, steps
uniform float uHazeZ;      // the word's own height (its haze is one step for the whole word)
uniform vec3 uVoid;
uniform vec2 uLevels;      // levels, dither
uniform vec2 uGrain;       // amount, tick
uniform vec4 uBand;        // the thin bands in depth fractions: the step's width, the groove's width, the step's middle, the groove's middle
uniform vec2 uBandOn;      // per word (gl.ts — by its bevel's size on screen, with hysteresis): the step / the groove drawn as a line (1) or as their neighbour (0)
uniform vec3 uDockK;       // how far toward uDockInk, edge band (render px), on
uniform vec3 uDockInk;

varying vec3 vN;
varying vec3 vW;
varying vec3 vO;
varying vec3 vON;
varying vec3 vAZ;
varying float vPart;
varying float vFrac;
${RASTER_GLSL}
${OUT_GLSL}
${DOCK_GLSL}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  vec2 px = floor(gl_FragCoord.xy);
  float bay = bayer4(px);
  // screen derivatives first (before any discard): the depth fraction (how wide a thin band is on
  // screen) and the object point (how stretched the texture is)
  float dFrac = length(vec2(dFdx(vFrac), dFdy(vFrac)));
  vec3 dOx = dFdx(vO);
  vec3 dOy = dFdy(vO);
  if (bay > uStipple) discard;
  float part = floor(vPart + 0.5);
  vec3 N = normalize(vN);

  // ── the thin bands: the step between the chamfers (seen almost edge-on from the front) and the seam
  // groove on the walls are mostly under a pixel wide on screen — rasterised as they are, they come out
  // as broken dashes (a «stitch» that flickers as the camera moves). Per WORD (uBandOn — gl.ts, by the
  // bevel's size on screen, with hysteresis; never per pixel): a word near enough draws each as a LINE
  // at least a pixel wide — every pixel whose centre lies within half a pixel of the band (its own and
  // its neighbours', measured by the depth fraction's screen gradient) takes the band's colour: the
  // hero's crisp double line on the bevel, the seam round the walls; a word too small for that draws
  // them as their neighbour (the step as the inner chamfer — normal and glint included —, the groove
  // as the wall). ──
  if (part > 0.5 && part < 5.5) {
    bool isStep = part < 3.5;
    float own = isStep ? 2.0 : 5.0;
    bool inBand = abs(part - own) < 0.5;
    vec3 Z = normalize(vAZ);
    if ((isStep ? uBandOn.x : uBandOn.y) > 0.5) {
      float half_ = 0.5 * (isStep ? uBand.x : uBand.y);
      if (abs(vFrac - (isStep ? uBand.z : uBand.w)) - half_ < 0.5 * dFrac) {
        // the step's own pixels shaded like its neighbours (the face's z added: 45°), one even line
        if (isStep && inBand) N = normalize(N + Z);
        part = own;
      }
    } else if (inBand) {
      if (isStep) {
        N = normalize(N + Z);        // the step faces out sideways; the chamfer is that + the face's z, at 45°
        part = 3.0;
      } else {
        N = normalize(N - dot(N, Z) * Z + 1e-5 * Z);
        part = 4.0;
      }
    }
  }

  // ── the concrete: object space, a power-of-two texel ≈ uTex.x render px here (Bayer between levels:
  // the texels travel with the letters and never boil; a level switch is an ordered cross-fade) ──
  vec3 on = abs(vON);
  bool flat_ = on.z > 0.5;
  bool alongY = on.x > on.y;
  vec2 uv = flat_ ? vO.xy : (alongY ? vO.yz : vO.xz);
  // how much the texture is stretched on screen here: the footprint of a pixel along each texture axis
  // (perspective on a wall seen from close by — the tunnel of the A's counter — stretches it along the
  // depth many times); round pebbles drawn there would be streaks, so they fade out with it (from a
  // stretch of 1.2, gone at 1.8 — the grazing floor of the tunnel on a wide screen), and so does the
  // mottle's finest octave
  vec2 ux = flat_ ? dOx.xy : (alongY ? dOx.yz : dOx.xz);
  vec2 uy = flat_ ? dOy.xy : (alongY ? dOy.yz : dOy.xz);
  float ga = length(vec2(ux.x, uy.x));
  float gb = length(vec2(ux.y, uy.y));
  float aniso = max(ga, gb) / max(1e-9, min(ga, gb));
  float round_ = clamp((1.8 - aniso) / 0.6, 0.0, 1.0);
  float dist = max(1e-5, dot(vW - uCam, uFwd));
  float lx = log2(uTex.x * dist / uFpx) + 18.0;          // in steps of 2^-18 sheet units
  float T = exp2(floor(lx) + step(bay, fract(lx)) - 18.0);
  vec2 q = (floor(uv / T) + 0.5) * T;
  // mottle: three octaves; an octave fades out as it nears the texel's size (sampled once per texel it
  // would only be noise — no speckle), so the finer ones show only close up
  float S = uTex.y;
  float m = 0.0;
  for (int o = 0; o < 3; o++) {
    float k = clamp(S / T * 0.5 - 0.5, 0.0, 1.0) * (o == 2 ? round_ : 1.0);
    m += (vnoise(q / S + float(o) * 17.0) - 0.5) * k * (o == 0 ? 0.55 : o == 1 ? 0.3 : 0.15);
    S *= o == 0 ? 0.37 : 0.32;
  }
  float alb = 1.0 + m * 2.0 * uTex.z;
  float peb = 0.0;   // + a light pebble, − a dark pore (their share of the colour)
  // sparse aggregate and pores: pebbles in some cells of uAgg.x, and of a 3.5× finer grid (those only
  // close up); at least one texel each — as they shrink to a texel they fade out (no speckle)
  float A = uAgg.x;
  for (int o = 0; o < 2; o++) {
    vec2 ac = floor(q / A);
    float h = hash12(ac + 3.7 + float(o) * 11.0);
    if (h < uAgg.y) {
      vec2 c = (ac + 0.25 + 0.5 * vec2(hash12(ac + 9.1), hash12(ac + 4.3))) * A;
      float r = max(A * (0.2 + 0.15 * hash12(ac + 1.9)), 0.5 * T);
      float fade = clamp(2.0 - T / A, 0.0, 1.0) * round_;
      if (length(q - c) < r) peb = (h < uAgg.y * 0.6 ? 1.0 : -0.7) * uAgg.z * fade;
    }
    A /= 3.5;
  }

  // ── light: absolute, from the upper left, Lambert in hard bands ──
  float ndl = max(dot(N, uKey), 0.0);
  float b = floor(ndl * uBands + 0.5) / uBands;
  vec3 col;
  bool catches = false;
  if (part < 0.5) col = mix(uFace0, uFace1, b);                         // face
  else if (part < 1.5) { col = mix(uBevel0, uBevel1, b); catches = true; } // outer chamfer
  else if (part < 2.5) col = mix(uStep0, uStep1, b);                    // flat step
  else if (part < 3.5) { col = mix(uBevel0, uBevel1, b * 0.85); catches = true; } // inner chamfer
  else if (part < 4.5) { col = mix(uWall0, uWall1, b); catches = true; }  // walls
  else if (part < 5.5) col = uSeam;                                     // the seam groove
  else col = uBack;                                                     // the back
  col *= alb;
  // pebbles stand out of the dark as stone (a mix, not a scale: they show on the darkest walls too)
  col = peb > 0.0 ? mix(col, uStone * (0.6 + 0.4 * b), peb) : col * (1.0 + peb);

  // ── the lamp: a small hard warm glint on the bevels and walls, blended (not added) ──
  if (catches) {
    // a point lamp (it moves with the camera): its reflection is a small spot that slides along a
    // facet as the letters turn, not the whole facet at once
    vec3 V = normalize(uCam - vW);
    vec3 Lp = normalize(uLamp - vW);
    float nh = dot(N, normalize(Lp + V));
    float g = clamp((nh - uGlint.y) / max(1e-4, 1.0 - uGlint.y), 0.0, 1.0);
    g = ceil(g * uGlint.z) / uGlint.z;
    col = mix(col, uGlintColor, g * uGlint.x);
  }

  col = hazed(col, uHazeZ, uHaze, uVoid);
  // behind the nav's labels the concrete is no lighter than uDockInk — only where it IS lighter (lit
  // bevels, glints, lit faces; the dark walls and faces stay bit for bit as they are): the labels'
  // difference blend then comes out light and legible over it (over a mid grey it would vanish); a
  // halo per label whose edge is a Bayer ramp uDockK.y px wide — never a plate under the whole column
  if (uDockK.z > 0.5 && dot(col, ${LUMA}) > dot(uDockInk, ${LUMA}) + 0.04) {
    float o = dockOut(px + 0.5);
    if (bay < clamp(0.5 - o / max(1.0, uDockK.y), 0.0, 1.0)) col = mix(col, min(col, uDockInk), uDockK.x);
  }
  // mid-reveal (a Bayer stipple): alpha ≈ 0.95 — covered, but the glitch pass's crawl leaves it alone
  // (core/raster-gl.ts: its holes would be eaten into a random maze)
  gl_FragColor = vec4(rasterOut(col, px, bay, uLevels, uGrain), uStipple < 1.0 ? 0.95 : 1.0);
}
`

// ── photo cards (the projects slab's box) ───────────────────────────────────────────────────────────

export const CARD_VS = /* glsl */ `${CARD_TAG}
attribute float aFace;     // 0 front (the picture), 1 left, 2 right, 3 top, 4 bottom, 5 back
varying vec2 vUv;          // face uv, (0, 0) = its top-left corner; sides: x runs front → back
varying vec3 vAff;         // (uv · w, w): their ratio is the uv interpolated LINEARLY on screen
varying float vFace;
varying float vZ;          // height, sheet units

void main() {
  vUv = uv;
  vFace = aFace;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vZ = w.z;
  gl_Position = projectionMatrix * w;
  vAff = vec3(uv * gl_Position.w, gl_Position.w);
}
`

export const CARD_FS = /* glsl */ `${CARD_TAG}
precision highp float;
uniform sampler2D uPic;
uniform vec3 uTexSize;     // picture px (w, h), its top mip level
uniform float uLod;        // the pop-in's mip level (whole)
uniform float uStipple;    // coverage (reveal), 0…1
uniform vec3 uBlank;       // a face without its picture
uniform float uHas;
uniform vec3 uSide;
uniform vec3 uEdge;        // top, bottom, back
uniform vec4 uSeam;        // rgb, width (render px)
uniform vec4 uSheen;       // amount, centre, half-width, slant
uniform float uSheenSteps;
uniform vec3 uSheenColor;
uniform vec4 uGrade;       // saturation, contrast, black, white
uniform vec3 uTint;        // tint multiplier (luminance-normalised, × its amount)
uniform vec4 uHalftone;    // on, levels, luma lo, luma hi
uniform float uAffine;     // 0 — perspective-correct texture, 1 — affine (swims)
uniform float uLeak;       // side faces: the picture's edge colour leaking in
uniform vec2 uCells;       // side faces: blocks across the depth, along the height
uniform vec3 uDock2;       // wash, edge band (render px), on
uniform vec4 uHaze;
uniform vec3 uVoid;
uniform vec2 uLevels;
uniform vec2 uGrain;

varying vec2 vUv;
varying vec3 vAff;
varying float vFace;
varying float vZ;
${RASTER_GLSL}
${OUT_GLSL}
${DOCK_GLSL}
// the picture's texel at an explicit mip level, graded: saturation, contrast, the warm tint, black /
// white points (a card is never whiter than the void); the halftone style: ordered dots of 2 × 2 px
vec3 pic(vec2 uv, float lod, vec2 px) {
  vec3 c = textureLod(uPic, vec2(uv.x, 1.0 - uv.y), lod).rgb;
  if (uHalftone.x > 0.5) {
    float l = clamp((dot(c, ${LUMA}) - uHalftone.z) / max(0.05, uHalftone.w - uHalftone.z), 0.0, 1.0);
    l = clamp((l - 0.5) * uGrade.y + 0.5, 0.0, 1.0);
    float lev = max(1.0, uHalftone.y - 1.0);
    c = vec3(floor(l * lev + bayer4(floor(px / 2.0))) / lev);
  } else {
    c = mix(vec3(dot(c, ${LUMA})), c, uGrade.x);
    c = clamp((c - 0.5) * uGrade.y + 0.5, 0.0, 1.0);
  }
  c = clamp(c * uTint, 0.0, 1.0);
  return mix(vec3(uGrade.z), vec3(uGrade.w), c);
}

void main() {
  vec2 px = floor(gl_FragCoord.xy);
  float bay = bayer4(px);
  if (bay > uStipple) discard;
  float face = floor(vFace + 0.5);
  vec3 col;

  if (face < 0.5) {
    // ── the picture: point-sampled, its mip level from the on-screen size (or the pop-in's) ──────────
    // (the footprint: the geometric mean of the two screen axes — the larger one alone made a tilted
    // card one or two levels coarser than the lattice, a camouflage mosaic on small screens)
    vec2 dx = dFdx(vUv);
    vec2 dy = dFdy(vUv);
    float foot = sqrt(length(dx * uTexSize.xy) * length(dy * uTexSize.xy));
    float lod = clamp(max(floor(log2(max(foot, 1e-6)) + 0.5), uLod), 0.0, uTexSize.z);
    // in motion the texture is interpolated straight across the screen, per polygon: it swims
    vec2 uv = mix(vUv, vAff.xy / vAff.z, uAffine);
    col = uHas > 0.5 ? pic(clamp(uv, 0.0, 1.0), lod, px) : uBlank;
    if (uHas > 0.5) {
      // sheen: a stepped light band lying across the face
      float band = 1.0 - abs(vUv.x + (vUv.y - 0.5) * uSheen.w - uSheen.y) / uSheen.z;
      band = ceil(clamp(band, 0.0, 1.0) * uSheenSteps) / uSheenSteps;
      col = mix(col, uSheenColor, uSheen.x * band);
    }
    // the seam around the picture: a line of whole lattice pixels
    vec2 g = vec2(length(vec2(dx.x, dy.x)), length(vec2(dx.y, dy.y)));
    vec2 e = min(vUv, 1.0 - vUv) / max(g, vec2(1e-6));
    if (min(e.x, e.y) < uSeam.w) col = uSeam.rgb;
  } else if (face < 2.5) {
    // ── side faces: the warm edge with the picture's own edge leaking in, in coarse blocks ─────────
    col = uSide;
    if (uHas > 0.5) {
      vec2 cell = floor(vUv * uCells);
      float v = (cell.y + 0.5) / uCells.y;
      float u = face < 1.5 ? 0.02 : 0.98;
      vec3 edge = pic(vec2(u, v), min(5.0, uTexSize.z), px);
      float lit = step(0.45, hash12(cell + 3.1 + face));
      col = mix(uSide, edge, uLeak * (0.3 + 0.7 * lit));
    }
  } else {
    // ── top, bottom, back: flat, a touch lighter toward the light on the left ────────────────────────
    col = uEdge * (1.05 - 0.1 * vUv.x);
    if (face > 3.5 && face < 4.5) col *= 0.9;
  }

  // behind the nav's labels the card is washed toward the void (their difference blend stays legible
  // over a mid-grey picture): a halo per label, its edge a Bayer ramp uDock2.y px wide — never a strip
  // cut through the picture under the whole column
  if (uDock2.z > 0.5) {
    float o = dockOut(px + 0.5);
    if (bay < clamp(0.5 - o / max(1.0, uDock2.y), 0.0, 1.0)) col = mix(col, uVoid, uDock2.x);
  }

  col = hazed(col, vZ, uHaze, uVoid);
  // mid-reveal: covered, never crawled (as the concrete)
  gl_FragColor = vec4(rasterOut(col, px, bay, uLevels, uGrain), uStipple < 1.0 ? 0.95 : 1.0);
}
`

// ── dotted shadows ────────────────────────────────────────────────────────────────────────────────────
//
// Like the projects slab's: a pool of dots whose density falls off in whole steps toward its rim, the
// same family on every screen. Three steps (gl.ts):
//   1. FOOTPRINT — every caster (a word's whole mesh, a card's picture face) flattened along its own
//      parallel light (aimed from the lamp — a point at the camera, up-left of the frame's
//      centre — at its middle: core.ts → shadowLamp, lightFrom; every shadow on screen falls the same
//      way, down-right) onto its shadow plane and drawn into a mask target, no depth, MAX blending: r — the weight: the
//      shape (a word: 1 inside its silhouette; a card: a pool over its face grown by its penumbra — a
//      superellipse, a rounded rectangle for a card low over the sheet, toward an ellipse for a high
//      one —, 1 − r² from the middle to the rim, like the slab's) × the height fade (1 at the plane,
//      less the higher the casting point: a high card's shadow is fainter AND smaller once cut at
//      shadow.edge), g — the weight × the caster's presence (its reveal stipple × how much of it is in
//      the frame: a shadow never shows more of itself than its caster; after the blur g / r gives it
//      back);
//   2. BLUR — a gaussian on the lattice, H then V (shadow.blur, sheet units → render px): the edge of
//      every footprint becomes a soft slope;
//   3. SHADE — in the empty pixels of the frame (core/raster-gl.ts → glitchFS: only on the void, never
//      on a letter or a card; the dots slip with their rows and never crawl): the slope above
//      shadow.edge is cut into shadow.steps steps of density, each an ordered (Bayer 4×4) dot pattern.
// Binary coverage: a lattice pixel is a dot or nothing — never a semi-transparent pixel.

export const SHADOW_VS = /* glsl */ `${SHADOW_TAG}
uniform vec3 uLight;       // toward the light: this caster's own (core.ts → lightFrom)
uniform vec4 uPlane;       // the plane the shadow falls on: n · p = d (core.ts → Plane)
uniform vec2 uGrow;        // a card's face grown by its penumbra (× its size); words: 1
varying float vH;          // the casting point's height above that plane
varying vec2 vUv;          // a card's face uv over the grown face (words: none)

void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position.xy * uGrow, position.z, 1.0);
  float h = max(0.0, dot(w.xyz, uPlane.xyz) - uPlane.w);
  vec3 s = w.xyz - (h / max(0.05, dot(uLight, uPlane.xyz))) * uLight;
  vH = h;
  vec4 c = projectionMatrix * vec4(s, 1.0);
  // a mask, drawn alone: no depth (and never clipped by the objects' far plane)
  c.z = 0.0;
  gl_Position = c;
}
`

export const SHADOW_FS = /* glsl */ `${SHADOW_TAG}
precision highp float;
uniform float uFade;       // weight lost per sheet unit of height
uniform float uPresence;   // the caster's reveal × its share in the frame, 0…1
uniform vec2 uCard;        // a card: its pool's superellipse exponent (2 — an ellipse … 8 — almost the rectangle); y — on
varying float vH;
varying vec2 vUv;
void main() {
  float f = 1.0;
  if (uCard.y > 0.5) {
    vec2 u = abs(vUv - 0.5) * 2.0;
    float n = uCard.x;
    float r = pow(pow(u.x, n) + pow(u.y, n), 1.0 / n);
    f = clamp(1.0 - r * r, 0.0, 1.0);
  }
  f *= clamp(1.0 - uFade * vH, 0.0, 1.0);
  gl_FragColor = vec4(f, f * uPresence, 0.0, 1.0);
}
`

export const BLUR_VS = /* glsl */ `${BLUR_TAG}
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

/** One direction of the gaussian (the mask's r and g), clamped at the canvas's edges. */
export const BLUR_FS = /* glsl */ `${BLUR_TAG}
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uRes;
uniform vec2 uDir;         // (1, 0) or (0, 1)
uniform float uSigma;      // render px
void main() {
  vec2 px = floor(gl_FragCoord.xy);
  float r = min(16.0, ceil(2.0 * uSigma));
  float k = -0.5 / max(1e-4, uSigma * uSigma);
  vec2 acc = vec2(0.0);
  float ws = 0.0;
  for (int i = -16; i <= 16; i++) {
    float fi = float(i);
    if (abs(fi) > r) continue;
    float wt = exp(k * fi * fi);
    acc += wt * texelFetch(uSrc, ivec2(clamp(px + uDir * fi, vec2(0.0), uRes - 1.0)), 0).rg;
    ws += wt;
  }
  gl_FragColor = vec4(acc / ws, 0.0, 1.0);
}
`

/**
 * The dots, for the glitch pass's empty pixels (core/raster-gl.ts → glitchFS(SHADE_HEAD, SHADE_EMPTY))
 * and the plain copy: shade(p) — the dot colour (alpha 1) or nothing. Needs uRes.
 */
export const SHADE_HEAD = /* glsl */ `
uniform sampler2D uShadow; // the blurred footprint (r — weight, g — weight × presence)
uniform vec4 uShade;       // density at the core, steps, edge (the weight where the dots begin), on
uniform vec3 uShadowColor;
vec4 shade(vec2 p) {
  if (uShade.w < 0.5) return vec4(0.0);
  vec2 s = texelFetch(uShadow, ivec2(clamp(p, vec2(0.0), uRes - 1.0)), 0).rg;
  if (s.x <= uShade.z) return vec4(0.0);
  float shape = (s.x - uShade.z) / max(1e-3, 1.0 - uShade.z);
  float d = uShade.x * ceil(shape * uShade.y - 1e-3) / uShade.y * clamp(s.y / s.x, 0.0, 1.0);
  float bay = bayer4(p);
  return bay < d ? vec4(uShadowColor, 1.0) : vec4(0.0);
}
`
export const SHADE_EMPTY = 'c = shade(p);'


// ── a plain copy of the frame (when the glitch pass failed to compile), the dots included ─────────────

export const COPY_VS = /* glsl */ `${COPY_TAG}
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

export const COPY_FS = /* glsl */ `${COPY_TAG}
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uRes;
${RASTER_GLSL}
${SHADE_HEAD}
void main() {
  vec2 px = floor(gl_FragCoord.xy);
  vec4 c = texelFetch(uSrc, ivec2(px), 0);
  gl_FragColor = c.a > 0.5 ? vec4(c.rgb, 1.0) : shade(px);
}
`
