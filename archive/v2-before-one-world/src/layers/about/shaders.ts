import { ABERRATION_GLSL } from '../../core/aberration'
import { GRAIN_GLSL } from '../../core/grain'

/**
 * ABOUT shaders — the sheet in two passes (index.ts), both on the canvas's lattice of cells (one
 * canvas pixel per cell, magnified by CSS with `image-rendering: pixelated`). Nothing is
 * anti-aliased, filtered on screen or blended softly: a cell is a hole, the sheet, a photo or a cross.
 *
 * PASS 1 (SHEET_FS) → an RGBA8 target + an R8 «material» target, only when the picture changes:
 *   1. HOLES — each culled hole maps the cell centre to its glyph (one 3×3 matrix: camera, place,
 *      rotation, the turn in depth with its perspective), quantises it to the letters' texel (locked
 *      to the sheet — on a turned word the texels recede with it — LOD by powers of two), samples
 *      the signed distance there and erodes the edge in blocks (erodes()): big chunks (bites in,
 *      bumps out), small cells along the edge (they crawl while things move), lone crumbs
 *      outside, missing cells inside, a soft wobble. The block sizes are in sheet units, but an
 *      octave never grows past letters.maxPx on screen: the next finer one takes over block by
 *      block, so the edge looks the same at every zoom of the pull-back. Inside a hole: transparent
 *      (the void shows) + the «photocopy» texture, all ramped by zoom from nothing — the first frames
 *      of the pull are exactly the bare void — and shaped by how close up the hole's letters are on
 *      screen (closeness(): the camera's zoom × the hole's letter scale). At the home framing (and the
 *      finale): clean print — a wash, patches.home of the grey blotches (soft-edged, slowly drifting
 *      tone), the grit only as a faint flat mottle of its clusters, rare specks. Close up (the giant
 *      A, a giant fragment): a gritty photocopy — the blotches flat tones with hard stair-stepped
 *      edges, grainy inside, and the grit resolved on its own sheet-locked grid of about one screen
 *      cell (octave hand-over as the zoom falls): fine dark specks dense in clusters, a light paper
 *      grain, black blots, a few vertical toner bars (streaks of specks). Plus tall toner rectangles
 *      (light on the word, darker by the hole's mottle above 1), rare vertical scratches and specks;
 *      everything static, locked to the sheet. A hole's slip pushes a few bands of 2–4 texel rows
 *      sideways.
 *   2. PHOTOS — opaque, over the holes. Rectangle + block disintegration on the torn sides only:
 *      along a torn side the picture is cut into edge blocks of uneven width (0.44…1.56 chunk), each
 *      with its own start (flush, set back or standing out past the side) — no shared baseline, no
 *      skyline; some blocks are bitten to their own depth (a split block bites in two steps), small
 *      cells drop out near the side, debris (never under 2 cells at the home zoom) flies outside
 *      showing the picture beyond the crop, and displaced blocks show a broken macroblock's picture
 *      from half a block away (some of them brighter). Point-sampled at an explicit mip (the tour
 *      photos' pop-in); graded (saturation, contrast, tint, black / white points); quantised to
 *      raster.bits with a Bayer dither — or, for 'halftone', auto-levelled from the picture's own luma
 *      range and dithered to photos.halftone grey levels in dots of 2 × 2 cells; darkened under the
 *      nav dock (photos.dock, stippled boundary); revealed by a Bayer stipple (a cell the stipple
 *      leaves out still counts as the photo in the material target: the stipple is not an edge).
 *   3. CROSSES — a pixel «+» of crosses.size cells, revealed with the photos.
 *   4. The sheet colour everywhere else; the reduced-motion dissolve (a Bayer stipple of all of it).
 * The material target says what each cell is (void 0, hole 0.25, sheet 0.5, photo 0.75, cross 1).
 *
 * PASS 2 (OUT_FS), every grain tick: chromatic aberration on COVERAGE only — a channel takes the cell
 * `d(p)` away (whole cells: a Bayer-dithered rounding, so a shift of 0.4 cells moves 40 % of an
 * edge's cells by one — a thin broken fringe, not nothing and not a solid bar) only where that cell
 * is a different material; inside one material nothing moves, so dither, halftone and stipple never
 * turn into an RGB mesh, and a sliver thinner than the shift (a lone crumb, a notch, a debris cell)
 * and its neighbours keep their colours — then per-cell film grain (the sheet's on everything
 * opaque, letters.grain inside the holes) and the output: premultiplied, or, with the aberration
 * on, the mask and the light of core/channel-split.ts.
 */

/** Rows of the instance data texture (RGBA32F, 8 texels per row). */
export const ROW_HOLES = 0
export const ROW_PHOTOS = 12
export const ROW_CROSSES = 26
export const DATA_ROWS = 50
export const DATA_WIDTH = 8

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
// one triangle over the whole canvas
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`

const HASH = /* glsl */ `
// pcg3d (the grain's hash): stable integer noise on every GPU
uint pcgx(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v.x;
}
// 0…1 per integer cell (offset keeps negative block indices positive) and seed
float h3(ivec2 c, int s) { return float(pcgx(uvec3(uvec2(c + 65536), uint(s + 4096)))) * (1.0 / 4294967296.0); }

// soft value noise, −1…1
float vnoise(vec2 x, int s) {
  vec2 i = floor(x);
  vec2 f = x - i;
  f = f * f * (3.0 - 2.0 * f);
  ivec2 k = ivec2(i);
  float a = h3(k, s), b = h3(k + ivec2(1, 0), s), c = h3(k + ivec2(0, 1), s), d = h3(k + ivec2(1, 1), s);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y) * 2.0 - 1.0;
}

// 4×4 ordered (Bayer) threshold of a cell, 1/32 … 31/32
float bayer4(ivec2 p) {
  const float m[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
  ivec2 i = p & 3;
  return (m[i.x + i.y * 4] + 0.5) / 16.0;
}
`

export const SHEET_TAG = '// about sheet'

export const SHEET_FS = /* glsl */ `#version 300 es
${SHEET_TAG}
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;

uniform sampler2D uAtlas;         // signed distance of the letters, glyph px (+ inside), LINEAR
uniform sampler2DArray uPhotos;   // per window: its crop + margin, mipmapped, NEAREST
uniform sampler2D uData;          // per-instance rows (index.ts → pack)
uniform ivec4 uCount;             // holes, photos, crosses
uniform vec4 uView;               // canvas w, h (cells); cell (CSS px); camera scale (px per sheet unit)
uniform vec4 uSheet;              // sheet colour, dissolve 0…1
uniform vec4 uL1;                 // band, chunk, chunkAmount, cell (sheet units / shares)
uniform vec4 uL2;                 // cellAmount, wobble, maxPx, crawl tick
uniform vec4 uWash;               // wash colour, alpha (× the zoom ramp)
uniform vec4 uTex;                // patches: size, amount (× ramp; × patches.home…1 by closeness), cover; specks (× ramp)
uniform vec4 uScr;                // scratches: amount (× ramp), length (texels); ramp; -
uniform vec4 uKeep;               // entry point (CSS px), radius without specks (CSS px)
uniform vec4 uE1;                 // photo edges: chunk, small, band, missing (× photo width)
uniform vec4 uE2;                 // debris, reach (× width), shift, halftone levels
uniform vec4 uE3;                 // smallest edge block (sheet units: 2 cells at the home zoom), -, -, -
uniform vec4 uDock;               // the nav dock: x0, y0, x1, y1 (CSS px, stage)
uniform vec4 uDock2;              // photo brightness under it, pad (CSS px), stipple feather (CSS px), on
uniform vec4 uG1;                 // grade: saturation, contrast, black, white
uniform vec4 uG2;                 // tint colour (luma-normalised), amount
uniform vec2 uQ;                  // colour levels (2^bits − 1), dither
uniform vec4 uCross;              // cross colour, arm (cells)
uniform float uCalm;              // the edge's damage at this zoom: letters.home at the home framing … 1 close up
uniform vec4 uGrit;               // ln zoom, ln letters.texture.full, patches.home, letters.grit (× ramp)
uniform vec2 uFine;               // the letters' texel at LOD 0 and one cell at the home zoom (sheet units)
uniform vec2 uLod;                // a LOD switch dissolving in: the old texel ÷ the new one, share of cells already on the new

layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oMat;

${HASH}

vec4 D(int row, int i) { return texelFetch(uData, ivec2(i, row), 0); }

const float MAT_HOLE = 0.25;
const float MAT_SHEET = 0.5;
const float MAT_PHOTO = 0.75;
const float MAT_CROSS = 1.0;

/** black over a premultiplied colour */
vec4 darken(vec4 c, float a) { return vec4(c.rgb * (1.0 - a), c.a + a * (1.0 - c.a)); }

/**
 * Is the glyph-local sheet point ql (a texel centre) part of the hole? d — the signed distance there
 * (sheet units, + inside the letter); tx — the texel (sheet units).
 */
bool erodes(vec2 ql, float d, float rough, int seed, float tx) {
  float s = uView.w;
  float maxPx = uL2.z;
  float chunk = uL1.y;
  // how many halvings the chunk octave needs to stay under maxPx on screen; the finer octave takes
  // over block by block as that grows (a dithered hand-over: detail fades in, nothing pops)
  float lam = max(0.0, log2(chunk * s / maxPx));
  float k = floor(lam);
  float sz = chunk * exp2(-k);
  if (h3(ivec2(floor(ql / (sz * 0.5))), seed + 3) < lam - k) sz *= 0.5;
  float g = sz / chunk;
  // everything shrinks with the octave (the same edge on screen); the band never reaches deeper
  // than 0.8 maxPx on screen (the camera's first frame is inside the stroke by 2 maxPx)
  float band = min(uL1.x * rough * g, 0.8 * maxPx / s);
  float cs = max(uL1.w * g, tx);
  float dd = d + uL2.y * rough * g * vnoise(ql / (chunk * 2.5 * g), seed + 5);
  if (dd > band + 2.0 * cs) return true;
  if (dd < -3.0 * cs - band) return false;
  // big chunks: whole blocks bitten out of the letter (or, rarer, bulging out of it)
  ivec2 cb = ivec2(floor(ql / sz));
  float e = dd;
  float hc = h3(cb, seed + 7);
  float amt = uL1.z * rough * uCalm;
  float cam = uL2.x * rough * uCalm;
  if (hc < amt) e -= band * (0.5 + 0.5 * h3(cb, seed + 9));
  else if (hc > 1.0 - amt * 0.35) e += band * (0.3 + 0.4 * h3(cb, seed + 9));
  // notches: a cell on the edge flips to the other side — they crawl while the camera or the pointer moves
  ivec2 cc = ivec2(floor(ql / cs));
  int cr = seed + 11 + int(uL2.w) * 7;
  if (abs(e) < cs && h3(cc, cr) < cam) e = -e;
  // lone white crumbs just outside (sparser further out), a few missing cells just inside
  if (e < 0.0 && e > -3.0 * cs && h3(cc, seed + 13) < cam * 0.12 * (1.0 + e / (3.0 * cs))) return true;
  if (e > 0.0 && e < 0.5 * band && h3(cc, seed + 14) < cam * 0.08) return false;
  return e > 0.0;
}

/**
 * How close up this hole's letters are on screen, 0…1: 0 at the home framing (ABOUT at zoom 1, the
 * finale) … 1 once its letters are letters.texture.full × ABOUT's home size. A giant fragment (tex — its
 * letters ÷ ABOUT's) is a close-up of print even at zoom 1. The CPU's calm uses the same curve.
 */
float closeness(float tex) {
  return smoothstep(0.0, 1.0, clamp((uGrit.x + log(tex)) / max(uGrit.y, 0.01), 0.0, 1.0));
}

/**
 * Inside a hole: the void, «photocopied» (premultiplied over it). ql — the texel-quantised point, tq —
 * the letters' texel (sheet units), gq — the exact point, fine — a finer cell locked to the sheet (a
 * fixed share of the letters' texel, so it never changes with the zoom inside one LOD level: specks,
 * grit and scratches do not boil while the camera moves), tex — the hole's letters ÷ ABOUT's: the
 * blotches, grit clusters and toner rectangles belong to the letter and grow with it, and so does
 * the blotches' own texel; cl — how close up it is (closeness()). At the home framing: clean print —
 * patches.home of the blotches, faint and soft-edged, rare specks. Close up: a gritty photocopy —
 * the blotches flat tones with hard stair-stepped edges, grainy inside, plus the grit (fine dark
 * specks in clusters, a few vertical toner bars). Everything is static, locked to the sheet.
 */
vec4 interior(vec2 ql, float tq, vec2 gq, float fine, float d, float mottle, float tex, float cl, int seed, vec2 p) {
  vec4 c = vec4(uWash.rgb * uWash.a, uWash.a);
  if (uScr.z <= 0.0) return c;
  float ps = uTex.x * tex;
  float kb = max(1.0, floor(tex + 0.5));
  float bt = tq * kb;
  vec2 qb = (floor(ql / bt) + 0.5) * bt;
  ivec2 f = ivec2(floor(gq / fine));
  float grit = h3(f, seed + 25);
  // the blotches: patches.home of them at the home framing … all of them close up
  float amt = uTex.y * (uGrit.z + (1.0 - uGrit.z) * cl);
  // grey blotches: noise at the patch size (~cover of the area); inside, one tone drifting slowly
  // (half a patch per swing) — never cell by cell. The edge: a short soft ramp at the home framing,
  // a hard step close up (a flat tone cut along the texels, never a blurred upscale)
  float n = (vnoise(qb / ps, seed + 21) * 0.65 + vnoise(qb / (ps * 0.3), seed + 20) * 0.35) * 0.5 + 0.5;
  float t0 = 0.6 - (uTex.z - 0.25) * 0.5;
  float bl = smoothstep(t0, t0 + mix(0.1 / kb, 0.004, cl), n);
  // close up a blotch is less a flat tone and more a cluster of grit (below): toner, not paint
  float pa = amt * mottle * bl * (0.75 + 0.25 * vnoise(qb / (ps * 0.5), seed + 27)) * (1.0 - 0.6 * cl);
  // a few tall rectangles of toner (the photocopier's own marks), each ONE tone: light grey on the
  // word (mottle 1), darker (0.45…0.7) the higher the hole's mottle above 1 — and more of them
  // (× mottle²)
  ivec2 pb = ivec2(floor(ql / (ps * vec2(1.0, 2.6))));
  bool toner = h3(pb, seed + 22) < uTex.z * 0.1 * mottle * mottle;
  if (toner) {
    float tn = 0.45 + 0.25 * h3(pb, seed + 23);
    pa = max(pa, mix(amt * tn * (1.0 + 1.2 * cl), tn * uScr.z, clamp(mottle - 1.0, 0.0, 1.0)));
  }
  // and a faint, slow unevenness everywhere (capped low)
  pa = max(pa, amt * 0.08 * (0.5 + 0.5 * vnoise(qb / (ps * 0.6), seed + 26)));
  // close up the toner is grainy: each fine cell ±45 % of its tone
  pa *= 1.0 + (h3(f, seed + 45) - 0.5) * 0.9 * cl;
  c = darken(c, clamp(pa, 0.0, 0.85));
  // the grit (letters.grit × the zoom ramp × closeness: none at the home framing, none in the first
  // frames of the pull). Its own grid, locked to the sheet, about one screen cell: as the camera
  // pulls back the grid doubles octave by octave, handed over cell by cell (a 2 × 2 group joins
  // into one as the zoom falls), every level with its own hash — nothing pops, nothing boils.
  float gr = uGrit.w * cl;
  float gz = smoothstep(0.35, 0.8, vnoise(gq / (ps * 0.35), seed + 40) * 0.5 + 0.5);
  // seen from afar the grit is not resolved: it averages into a faint, flat, slow mottle of its
  // clusters (the clean print's faint mottle at the home framing; gone as the grit resolves)
  c = darken(c, uGrit.w * (1.0 - cl) * (0.07 + 0.12 * max(gz * 0.9, (toner ? 1.0 : bl) * mottle * 0.85)));
  if (gr > 0.0) {
    float lam = max(0.0, log2(uFine.x * uView.w / uView.z));
    float lk = floor(lam);
    float gs = uFine.x * exp2(-lk);
    int lv = int(lk);
    if (h3(ivec2(floor(gq / gs)), seed + 50 + lv * 17) < lam - lk) {
      gs *= 0.5;
      lv += 1;
    }
    ivec2 fg = ivec2(floor(gq / gs));
    int gsd = seed + 51 + lv * 17;
    // where it gathers: two scales of noise, letter-relative (clusters, and finer clumps in them)
    float gz2 = vnoise(gq / (ps * 0.08), seed + 46) * 0.5 + 0.5;
    // a few vertical toner bars: streaks of grit about a patch tall, ~3 grit cells wide
    float blen = max(4.0, ps * 0.9 / gs);
    int bc = fg.x / 3;
    float bo = floor(h3(ivec2(bc, 1), seed + 47) * blen);
    int bs = int(floor((float(fg.y) + bo) / blen));
    float bar = (h3(ivec2(bc, bs), seed + 48) < 0.04 && h3(ivec2(fg.x, bs), seed + 49) < 0.7) ? 0.8 : 0.0;
    float k = max(gz * (0.4 + 1.2 * gz2 * gz2), (toner ? 1.0 : bl) * mottle * (0.5 + 0.7 * gz2));
    // the paper's own grain: a light tone in every cell, clumped (a hash and a noise of ~2.5 cells),
    // stronger in the clusters
    float wv = vnoise(gq / (gs * 2.5), gsd + 3) * 0.5 + 0.5;
    float tone = gr * 0.4 * clamp(0.6 * h3(fg, gsd) + 0.7 * wv - 0.35, 0.0, 1.0) * (0.45 + 0.55 * min(k, 1.0));
    // dark specks, dense in the clusters, rare between them, a streak of them down a toner bar
    if (h3(fg, gsd + 1) < gr * max(0.01 + 0.085 * k * k, bar)) tone = 0.2 + 0.5 * h3(fg, gsd + 2);
    // and now and then a black blot of a few grit cells (a 3 × 3 group, its corners nibbled)
    if (h3(fg / 3, gsd + 4) < gr * 0.03 * k && h3(fg, gsd + 5) < 0.75) tone = 0.85;
    c = darken(c, tone);
  }
  // thin vertical scratches (one fine cell wide, scratches.length cells of the home zoom long, one
  // tone each)
  float len = max(2.0, uScr.y * uFine.y / fine);
  float off = floor(h3(ivec2(f.x, 0), seed + 31) * len);
  int segment = int(floor((float(f.y) + off) / len));
  if (h3(ivec2(f.x, segment), seed + 32) < 0.006) c = darken(c, uScr.x * (0.6 + 0.4 * h3(ivec2(f.x, segment), seed + 33)));
  // black specks (one or two fine cells), denser near the edge, never around the entry point
  float near = 1.0 + 1.5 * (1.0 - smoothstep(0.0, 0.012, d));
  if (distance(p, uKeep.xy) > uKeep.z && (grit < uTex.w * near || h3(f / 2, seed + 34) < uTex.w * 0.2 * near)) c = darken(c, 0.9);
  return c;
}

void hole(int i, vec2 p, ivec2 cell, inout vec4 col, inout float mat) {
  int r = ${ROW_HOLES} + i;
  vec4 bb = D(r, 6);
  if (p.x < bb.x || p.y < bb.y || p.x > bb.z || p.y > bb.w) return;
  vec3 ph = vec3(p, 1.0);
  vec3 m2 = D(r, 2).xyz;
  vec2 g = vec2(dot(D(r, 0).xyz, ph), dot(D(r, 1).xyz, ph)) / dot(m2, ph);
  vec4 rect = D(r, 3);
  vec4 pr = D(r, 4);      // sheet units per glyph px, texel (glyph px), rough, mottle
  vec4 px = D(r, 5);      // slip, seed, texture scale
  float tx = pr.y;
  // a LOD switch dissolves in (raster.lod.fade): the cells not yet on the new level keep the old texel
  if (bayer4(cell) >= uLod.y) tx *= uLod.x;
  int seed = int(px.y);
  // row slip (the finale's torn rows): the texel rows go in blocks of 5; a slipping block pushes a band
  // of 2–4 adjacent rows inside it sideways by 1…4 texels — a few torn bands, not hair. slip — the
  // share of rows that move (a block slips with slip × 5 / 3: its band is 3 rows on average)
  if (px.x > 0.0) {
    int row = int(floor(g.y / tx));
    int blk = int(floor(float(row) / 5.0));
    float r0 = float(row - blk * 5);
    float hb = 2.0 + floor(h3(ivec2(blk, 5), seed) * 3.0);
    float s0 = floor(h3(ivec2(blk, 6), seed) * (6.0 - hb));
    if (h3(ivec2(blk, 7), seed) < px.x * 5.0 / 3.0 && r0 >= s0 && r0 < s0 + hb) {
      float sh = 1.0 + floor(h3(ivec2(blk, 11), seed) * 4.0);
      g.x += (h3(ivec2(blk, 13), seed) < 0.5 ? -sh : sh) * tx;
    }
  }
  vec2 ti = floor(g / tx);
  vec2 q = (ti + 0.5) * tx;
  if (q.x < 0.0 || q.y < 0.0 || q.x > rect.z || q.y > rect.w) return;
  float d = textureLod(uAtlas, (rect.xy + q) / vec2(textureSize(uAtlas, 0)), 0.0).r * pr.x;
  vec2 ql = q * pr.x;
  if (!erodes(ql, d, pr.z, seed, tx * pr.x)) return;
  // the fine cell, locked to the sheet: half the letters' texel at LOD 0 (one cell at the home zoom),
  // a quarter of it on the coarser levels (≈ 1.7…4 CSS px close up) — fine grit, never boiling
  float tq = tx * pr.x;
  float fine = tq * (tq >= uFine.x * 0.99 ? 0.5 : 0.25);
  col = interior(ql, tq, g * pr.x, fine, d, pr.w, px.z, closeness(px.z), seed, p);
  mat = MAT_HOLE;
}

const vec3 LUMA3 = vec3(0.2126, 0.7152, 0.0722);

/** distance (sheet units, + inside) from the photo's torn sides to point q; 1e9 — no torn side */
float tornDist(vec2 q, vec2 WH, int torn) {
  float t = 1e9;
  if ((torn & 1) != 0) t = min(t, q.x);
  if ((torn & 2) != 0) t = min(t, WH.x - q.x);
  if ((torn & 4) != 0) t = min(t, q.y);
  if ((torn & 8) != 0) t = min(t, WH.y - q.y);
  return t;
}

/**
 * The block grid of a torn edge (blocks of «size», photo units): stripes parallel to the nearest torn
 * side (columns for l / r — «across» — rows for t / b), each stripe shifted along that side by a
 * hash, so the blocks of neighbouring stripes never line up. Returns the block; «mid» — its centre.
 */
ivec2 tornGrid(vec2 lp, float size, bool across, int seed, out vec2 mid) {
  if (across) {
    float ix = floor(lp.x / size);
    float o = h3(ivec2(int(ix), 0), seed) * size;
    float iy = floor((lp.y + o) / size);
    mid = vec2(ix + 0.5, iy + 0.5) * size - vec2(0.0, o);
    return ivec2(int(ix), int(iy));
  }
  float iy = floor(lp.y / size);
  float o = h3(ivec2(0, int(iy)), seed) * size;
  float ix = floor((lp.x + o) / size);
  mid = vec2(ix + 0.5, iy + 0.5) * size - vec2(o, 0.0);
  return ivec2(int(ix), int(iy));
}

/** The edge blocks' boundary k along a torn side: k chunks, jittered by ±0.28 chunk. */
float edgeCut(float k, float chunk, int seed) { return (k + 0.56 * (h3(ivec2(int(k), 0), seed) - 0.5)) * chunk; }

/**
 * The edge block at u (the coordinate along a torn side): every boundary jittered, so the blocks are
 * 0.44 … 1.56 chunk wide — neighbours merge and split, bites never come in one width. Returns its
 * index, start and end (along the side).
 */
vec3 edgeBlock(float u, float chunk, int seed) {
  float k = floor(u / chunk);
  float b0 = edgeCut(k, chunk, seed);
  float b1 = edgeCut(k + 1.0, chunk, seed);
  if (u < b0) return vec3(k - 1.0, edgeCut(k - 1.0, chunk, seed), b0);
  if (u >= b1) return vec3(k + 1.0, b1, edgeCut(k + 2.0, chunk, seed));
  return vec3(k, b0, b1);
}

void photo(int j, vec2 p, ivec2 cell, inout vec4 col, inout float mat) {
  int r = ${ROW_PHOTOS} + j;
  vec4 bb = D(r, 6);
  if (p.x < bb.x || p.y < bb.y || p.x > bb.z || p.y > bb.w) return;
  vec3 ph = vec3(p, 1.0);
  vec2 lp = vec2(dot(D(r, 0).xyz, ph), dot(D(r, 1).xyz, ph)) / dot(D(r, 2).xyz, ph);
  vec4 a = D(r, 3);       // W, H, layer, lod
  vec4 b = D(r, 4);       // torn bits, amount, halftone, saturation
  vec4 c = D(r, 5);       // reveal, seed, margin, reach
  vec2 WH = a.xy;
  int torn = int(b.x);
  float am = b.y;
  float reach = c.w;
  // straight sides cut clean; past a torn side debris may fly out to the reach
  vec2 lo = vec2((torn & 1) != 0 ? -reach : 0.0, (torn & 4) != 0 ? -reach : 0.0);
  vec2 hi = WH + vec2((torn & 2) != 0 ? reach : 0.0, (torn & 8) != 0 ? reach : 0.0);
  if (lp.x < lo.x || lp.y < lo.y || lp.x > hi.x || lp.y > hi.y) return;
  bool inside = lp.x >= 0.0 && lp.y >= 0.0 && lp.x <= WH.x && lp.y <= WH.y;
  bool on = inside;
  vec2 off = vec2(0.0);
  float lift = 0.0;
  int seed = int(c.y);
  if (torn != 0) {
    float W = WH.x;
    float chunk = uE1.x * W;
    // small blocks never under 2 cells at the home zoom: debris, not dust
    float small = max(uE1.y * W, uE3.x);
    float band = uE1.z * W * am;
    // which torn side is nearest: the edge blocks run along it, bites go in against it
    float dl = (torn & 1) != 0 ? lp.x : 1e9;
    float dr = (torn & 2) != 0 ? WH.x - lp.x : 1e9;
    float dt = (torn & 4) != 0 ? lp.y : 1e9;
    float db = (torn & 8) != 0 ? WH.y - lp.y : 1e9;
    bool across = min(dl, dr) < min(dt, db);
    int side = across ? (dl < dr ? 0 : 1) : (dt < db ? 2 : 3);
    float u = across ? lp.y : lp.x;
    float t = tornDist(lp, WH, torn);
    vec3 eb = edgeBlock(u, chunk, seed + 17 + side * 5);
    ivec2 kb = ivec2(int(eb.x), side);
    // the block's own start: half of them flush with the side, the rest set back into the picture or
    // standing out past it (−0.24 … 0.36 chunk) — the edge has no shared baseline
    float rs = h3(kb, seed + 41) < 0.5 ? 0.0 : (h3(kb, seed + 42) - 0.4) * 0.6 * chunk;
    vec2 sm;
    vec2 cm;
    ivec2 sb = tornGrid(lp, small, across, seed + 18, sm);
    ivec2 cb = tornGrid(lp, chunk, across, seed + 17, cm);
    float ts = tornDist(sm, WH, torn);
    float tc = tornDist(cm, WH, torn);
    if (t >= rs) {
      on = true;
      // a bitten block loses everything nearer the side than its bite: every bite its own depth (0.3 …
      // 1 band); half of the bitten blocks are split in two, the second part bitten shallower — the
      // bite's floor steps, never a row of teeth
      if (h3(kb, seed) < uE1.w * am * 0.75) {
        float bd = band * mix(0.3, 1.0, h3(kb, seed + 7));
        if (h3(kb, seed + 43) < 0.5 && u > mix(eb.y, eb.z, mix(0.3, 0.7, h3(kb, seed + 44)))) bd *= mix(0.3, 1.0, h3(kb, seed + 45));
        if (t < bd) on = false;
      }
      // small cells drop out near the side
      float ks = 1.0 - clamp(ts / max(band * 0.6, 1e-6), 0.0, 1.0);
      if (on && ts < band * 0.6 * mix(0.4, 1.0, h3(sb, seed + 9)) && h3(sb, seed + 1) < uE1.w * am * 0.8 * ks) on = false;
      // displaced blocks: a broken macroblock — its picture from half a block away, mostly sideways;
      // about one in seven of them brighter (+0.25)
      if (on && tc < band * 1.6 && h3(cb, seed + 2) < uE2.z) {
        float ox = h3(cb, seed + 3) < 0.5 ? -0.5 : 0.5;
        float oy = h3(cb, seed + 4) < 0.35 ? (h3(cb, seed + 8) < 0.5 ? -0.5 : 0.5) : 0.0;
        off = vec2(ox, oy) * chunk;
        if (h3(cb, seed + 19) < 0.15) lift = 0.25;
      }
    } else {
      on = false;
      float k = 1.0 + max(ts, -reach) / max(reach, 1e-6);
      // the loose debris crawls while things move (raster.crawlFps), like the letters' notches
      if (h3(sb, seed + 5 + int(uL2.w) * 7) < uE2.x * am * k * k) on = true;
      else if (h3(cb, seed + 6) < uE2.x * am * 0.25 * (1.0 + max(tc, -reach) / max(reach, 1e-6))) on = true;
    }
  }
  if (!on) return;
  // left out by the reveal stipple: still the photo's material (pass 2 must not see an edge here)
  if (bayer4(cell) >= c.x) {
    mat = MAT_PHOTO;
    return;
  }
  float m = c.z;
  vec2 uv = (lp + off) / WH;
  vec2 mg = vec2(m, m * WH.x / WH.y);
  vec2 st = (uv + mg) / (1.0 + 2.0 * mg);
  vec3 rgb = textureLod(uPhotos, vec3(st, a.z), a.w).rgb;
  float th = bayer4(cell);
  if (b.z > 0.5) {
    // halftone: the picture's own luma range (photos.ts → lo / hi) stretched to black … white — a pale
    // wall keeps its blacks — then the grade's contrast, and an ordered dither to a few grey levels in
    // dots of 2 × 2 cells (a print screen, not static), between the grade's black and white points
    vec4 lv = D(r, 7);
    float l = (dot(rgb, LUMA3) - lv.x) / max(lv.y - lv.x, 0.05);
    l = clamp((l - 0.5) * uG1.y + 0.5 + lift, 0.0, 1.0);
    float n = max(2.0, uE2.w) - 1.0;
    rgb = vec3(uG1.z + (uG1.w - uG1.z) * floor(l * n + bayer4(cell / 2)) / n);
  } else {
    // the grade: saturation, contrast, a cool tint, then black and white points
    float sat = b.w < 0.0 ? uG1.x : b.w;
    rgb = mix(vec3(dot(rgb, LUMA3)), rgb, sat);
    rgb = (rgb - 0.5) * uG1.y + 0.5 + lift;
    rgb = mix(rgb, dot(rgb, LUMA3) * uG2.rgb, uG2.a);
    rgb = uG1.z + (uG1.w - uG1.z) * clamp(rgb, 0.0, 1.0);
    // the framebuffer's colour depth, with the ordered dither that hides its steps (as the slab)
    rgb = floor(clamp(rgb, 0.0, 1.0) * uQ.x + 0.5 + (th - 0.5) * uQ.y) / uQ.x;
  }
  // under the nav dock (+ pad) the photo goes dark (photos.dock), the boundary a Bayer stipple over
  // ±feather: the nav's inverted labels never sit on mid-grey (the holes are left alone)
  if (uDock2.w > 0.5) {
    vec2 o2 = max(max(uDock.xy - p, p - uDock.zw), 0.0);
    float k = clamp((uDock2.y + uDock2.z - max(o2.x, o2.y)) / (2.0 * uDock2.z), 0.0, 1.0);
    if (th < k) rgb *= uDock2.x;
  }
  col = vec4(rgb, 1.0);
  mat = MAT_PHOTO;
}

void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  // cells from the stage's top-left (y down) and the cell centre in CSS px
  ivec2 cell = ivec2(fc.x, int(uView.y) - 1 - fc.y);
  vec2 p = (vec2(cell) + 0.5) * uView.z;
  vec4 col = vec4(uSheet.rgb, 1.0);
  float mat = MAT_SHEET;
  for (int i = 0; i < uCount.x; i++) hole(i, p, cell, col, mat);
  for (int j = 0; j < uCount.y; j++) photo(j, p, cell, col, mat);
  for (int k = 0; k < uCount.z; k++) {
    vec4 cr = D(${ROW_CROSSES} + k, 0);
    ivec2 dl = cell - ivec2(cr.xy);
    int arm = int(uCross.w);
    if (((dl.y == 0 && abs(dl.x) <= arm) || (dl.x == 0 && abs(dl.y) <= arm)) && bayer4(cell) < cr.z) {
      col = col * (1.0 - cr.w) + vec4(uCross.rgb, 1.0) * cr.w;
      mat = MAT_CROSS;
    }
  }
  // reduced motion: the whole sheet dissolves in as a stipple
  if (bayer4(cell) >= uSheet.a) {
    col = vec4(0.0);
    mat = 0.0;
  }
  oColor = col;
  oMat = vec4(mat, 0.0, 0.0, 1.0);
}
`

export const OUT_TAG = '// about out'

export const OUT_FS = /* glsl */ `#version 300 es
${OUT_TAG}
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uCol;     // pass 1: premultiplied colour
uniform sampler2D uMat;     // pass 1: material
uniform vec4 uView;         // canvas w, h (cells); cell (CSS px); aberration on
uniform vec4 uAb0;
uniform vec4 uAb1;
uniform vec4 uGrain;        // the sheet's grain: amount, size (≤ 1: per cell), blend
uniform uint uSeed;
uniform float uHoleGrain;   // letters.grain
uniform float uMask;        // 1 — the mask pass of the channel split

out vec4 o;

${GRAIN_GLSL}
${ABERRATION_GLSL}

// 4×4 ordered (Bayer) threshold of a cell, 1/32 … 31/32
float bayer4(ivec2 p) {
  const float m[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
  ivec2 i = p & 3;
  return (m[i.x + i.y * 4] + 0.5) / 16.0;
}

float matAt(ivec2 c, ivec2 top) { return texelFetch(uMat, clamp(c, ivec2(0), top), 0).r; }

void main() {
  ivec2 ic = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(uCol, ic, 0);
  float m = texelFetch(uMat, ic, 0).r;
  vec2 R = vec2(c.r, c.a);
  vec2 G = vec2(c.g, c.a);
  vec2 B = vec2(c.b, c.a);
  if (uView.w > 0.5) {
    // the lens moves red by d and blue by −d (CSS px, y down): in whole cells, and only across a
    // change of material — coverage moves, the colour inside one material never does
    vec2 p = (vec2(float(ic.x), uView.y - 1.0 - float(ic.y)) + 0.5) * uView.z;
    vec2 d = aberrationShift(p, uAb0, uAb1) / uView.z;
    // whole cells, the rounding dithered (Bayer): 0.4 cells → 40 % of an edge's cells move by one
    ivec2 dc = ivec2(floor(d + bayer4(ic)));
    dc.y = -dc.y;
    if (dc != ivec2(0)) {
      ivec2 top = ivec2(uView.xy) - 1;
      bool er = abs(matAt(ic - dc, top) - m) > 0.1;
      bool eb = abs(matAt(ic + dc, top) - m) > 0.1;
      // a sliver thinner than the shift (this cell differs from both sides) keeps its colours, and so
      // does the cell next to one (the cell beyond it is this cell's own material again): a lone
      // crumb, notch or debris cell never breaks into red / green / blue dots
      if (er && eb) er = eb = false;
      if (er && abs(matAt(ic - 2 * dc, top) - m) < 0.1) er = false;
      if (eb && abs(matAt(ic + 2 * dc, top) - m) < 0.1) eb = false;
      if (er) {
        vec4 cr = texelFetch(uCol, clamp(ic - dc, ivec2(0), top), 0);
        R = vec2(cr.r, cr.a);
      }
      if (eb) {
        vec4 cb = texelFetch(uCol, clamp(ic + dc, ivec2(0), top), 0);
        B = vec2(cb.b, cb.a);
      }
    }
  }
  vec3 a = vec3(R.y, G.y, B.y);
  if (uMask > 0.5) {
    o = vec4(1.0 - a, 1.0);
    return;
  }
  float alpha = max(a.r, max(a.g, a.b));
  // nothing here → fully transparent: the void below stays untouched (no grain, no dither)
  if (alpha < 1.0 / 1024.0) {
    o = vec4(0.0);
    return;
  }
  vec3 s = vec3(R.x, G.x, B.x) / max(a, vec3(1e-6));
  // per-cell grain: the sheet's, or the letters' own inside the holes
  float amount = (m > 0.125 && m < 0.375) ? uHoleGrain : uGrain.x;
  float n = rnd(uvec2(ic), uSeed);
  float L = dot(s, LUMA);
  s += (n - 0.5) * 2.0 * amount * mix(1.0, 4.0 * L * (1.0 - L), uGrain.z) + dither(vec2(ic));
  o = vec4(clamp(s, 0.0, 1.0) * a, alpha);
}
`
