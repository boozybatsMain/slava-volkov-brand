import * as THREE from 'three'

/*
 * All colours are handled as display (sRGB) values straight through — no colour
 * management, no tone mapping — like an old software renderer writing RGB555.
 */

export const hexToVec3 = (hex: string, out = new THREE.Vector3()) => {
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16)
  return out.set(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

const NOISE = /* glsl */ `
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
  }
  float noise2(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x),
               mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
  }
  float noise3(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    float a = mix(mix(hash13(i), hash13(i + vec3(1,0,0)), u.x), mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), u.x), u.y);
    float b = mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), u.x), mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), u.x), u.y);
    return mix(a, b, u.z);
  }
`

// ─────────────────────────────────────────────────────────────────────────────
//  Letter material: matte pseudo-chrome faces + grey metal sides
// ─────────────────────────────────────────────────────────────────────────────

const TITLE_VERT = /* glsl */ `
  attribute vec2 aPart;
  attribute vec2 aLocal;
  uniform float uBulge;
  varying vec3 vN;
  varying vec3 vPos;
  varying vec3 vObj;
  varying vec2 vPart;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vPos = mv.xyz;
    // front cap + chamfers are "pillowed": normals lean outward with the glyph-local position,
    // so every letter sweeps sky → horizon → floor top to bottom, like old smoothed chrome text
    float pid = floor(aPart.x + 0.5);
    float bend = (1.0 - step(3.5, pid)) * min(1.0, abs(pid - 2.0)); // face, chamfer 1, chamfer 2
    vec3 n = normal + bend * uBulge * vec3(aLocal.x * 0.35, aLocal.y, 0.0);
    vN = normalMatrix * n;
    vObj = position;
    vPart = aPart;
    gl_Position = projectionMatrix * mv;
  }
`

const TITLE_FRAG = /* glsl */ `
  uniform vec3 uFace;
  uniform vec3 uSide;
  uniform vec3 uSky;
  uniform vec3 uGlint;
  uniform vec3 uGround;
  uniform float uReflect;
  uniform float uSideReflect;
  uniform float uMatte;
  uniform float uBlotch;
  uniform float uWarp;
  uniform float uSpec;
  uniform vec2 uEnvShift;
  uniform float uHorizon;
  uniform float uContrast;
  uniform float uBevelLight;
  uniform float uDebug;
  uniform float uLamp;
  uniform mat3 uEnvRot;
  varying vec3 vN;
  varying vec3 vPos;
  varying vec3 vObj;
  varying vec2 vPart;
  ${NOISE}

  // Procedural "studio" environment in view space (x right, y up, z to viewer):
  // blotchy blue-white sky above, a soft white band + dark line at the horizon,
  // dull streaky grey floor below. Faces of the title reflect az ≈ 70–110°, el ≈ 5–20°.
  vec3 env(vec3 r) {
    float el = asin(clamp(r.y, -1.0, 1.0)) + uEnvShift.y;
    float az = atan(r.x, r.z) + uEnvShift.x;
    float hw = mix(0.01, 0.07, uMatte);                                  // horizon softness
    float hz = el - uHorizon - 0.05 * sin(az * 3.1 + 0.6) - 0.025 * sin(az * 7.3 + 2.0);

    float n = noise2(vec2(az * 2.2, el * 3.4) + 4.1) * 0.6 + noise2(vec2(az * 5.3, el * 8.1) + 1.7) * 0.4;
    float nb = noise2(vec2(az * 3.1, el * 4.3) + 21.0);
    // neutral silver-grey sky, with localised saturated blue patches and white glints
    vec3 sky = mix(vec3(0.66, 0.665, 0.68), uSky, smoothstep(0.1, 0.32, hz) * (0.55 + 0.45 * smoothstep(0.3, 0.6, nb)));
    sky = mix(sky, uSky, smoothstep(0.6, 0.8, nb) * 0.7 * uBlotch);
    sky = mix(sky, uGlint, smoothstep(0.55, 0.78, n) * uBlotch);
    sky = mix(sky, vec3(0.42, 0.43, 0.47), smoothstep(0.38, 0.16, n) * 0.6 * uBlotch);
    // bright softbox streak just above the horizon
    sky = mix(sky, uGlint, 0.35 * exp(-pow((hz - 0.11) / (0.02 + hw), 2.0)));

    float g = noise2(vec2(az * 6.0, el * 2.0) + 9.0);                     // vertical-ish streaks
    vec3 gnd = mix(uGround * 1.6, uGround * 0.75, smoothstep(0.0, -0.4, hz));
    gnd *= 0.7 + 0.6 * g;
    // dark "horizon line" right under the bright band
    gnd *= 1.0 - 0.4 * exp(-pow((hz + 0.03) / (0.02 + hw), 2.0));

    vec3 c = mix(gnd, sky, smoothstep(-hw, hw, hz));
    // two cheap studio lamps baked into the env — blue-white hot spots that land on SLAVA
    // at rest and slide across the letters as the title turns
    vec2 d1 = vec2((az - 1.42) * 1.0, (el - uHorizon - 0.30) * 1.4);
    vec2 d2 = vec2((az - 1.62) * 1.6, (el - uHorizon - 0.12) * 2.2);
    c = mix(c, vec3(0.55, 0.66, 1.0) * 1.15, uLamp * 0.8 * exp(-dot(d1, d1) / 0.055));
    c = mix(c, vec3(0.97, 0.98, 1.0) * 1.15, uLamp * 0.6 * exp(-dot(d2, d2) / 0.008));
    // a few soft dark bars (studio stands) → dark streaks across the faces
    float bars = smoothstep(0.62, 0.9, noise2(vec2(az * 3.4 + 2.0, el * 0.6)));
    c *= 1.0 - bars * 0.45 * uBlotch;
    return c;
  }

  void main() {
    float part = floor(vPart.x + 0.5);
    float isFace = 1.0 - step(0.5, part);
    // chamfers (1, 3) are chrome; the flat step (2) between them faces sideways like a wall
    float isCh1 = 1.0 - abs(sign(part - 1.0));
    float isCh2 = 1.0 - abs(sign(part - 3.0));
    float isStep = 1.0 - abs(sign(part - 2.0));
    float isSide = step(3.5, part);
    float isSeam = step(4.5, part);

    vec3 N = normalize(vN);
    // uneven "foil": low-frequency wobble of the normal in object space
    vec3 w = vec3(noise3(vObj * 1.9), noise3(vObj * 1.9 + 11.3), noise3(vObj * 1.9 + 27.1)) - 0.5;
    N = normalize(N + w * uWarp * mix(0.9, 0.45, isSide + isStep));

    vec3 V = normalize(-vPos);
    vec3 R = reflect(-V, N);
    vec3 e = env(uEnvRot * R);
    // matte: squash contrast and saturation
    float lum = dot(e, vec3(0.3, 0.55, 0.15));
    e = mix(e, vec3(lum), uMatte * 0.25);
    e = mix(e, vec3(0.70), uMatte * 0.3);

    // two cheap lamps → odd blue-white hits
    vec3 L1 = normalize(vec3(-0.45, 0.75, 0.55));
    vec3 L2 = normalize(vec3(0.85, 0.25, 0.45));
    float s1 = pow(max(dot(N, normalize(L1 + V)), 0.0), 26.0);
    float s2 = pow(max(dot(N, normalize(L2 + V)), 0.0), 70.0);
    vec3 spec = (s1 * 0.55 * vec3(0.86, 0.9, 1.0) + s2 * 0.55 * uGlint) * uSpec;

    float lam = max(dot(N, L1), 0.0);
    float ndv = clamp(dot(N, V), 0.0, 1.0);
    vec3 face = mix(uFace * (0.7 + 0.35 * lam), e, uReflect);
    // chamfer rings: hard contrasty chrome + a grazing rim → crisp bright / dark outlines
    // chamfer rings: old logo-tool bevel lighting (key light from the upper left → bright top/left
    // edges, dark bottom/right edges) mixed with contrasty chrome + a grazing rim
    vec3 eb = (e - 0.5) * 1.6 + 0.55;
    float bl = dot(N, normalize(vec3(-0.55, 0.75, 0.35)));
    vec3 bevelLit = mix(vec3(0.5, 0.5, 0.52), vec3(1.0, 1.0, 1.02), smoothstep(-0.2, 0.6, bl));
    // outer chamfer = the thin bright line around the face; inner chamfer = darker chrome band
    vec3 chamfer1 = mix(eb, bevelLit, uBevelLight) + vec3(0.95, 0.96, 1.0) * pow(1.0 - ndv, 3.0) * 0.35;
    vec3 chamfer2 = mix(eb, bevelLit * 0.75, uBevelLight * 0.5) * 0.72;
    // sides: grey metal, lit from the upper left, darker toward the back, brushed streaks
    float streak = noise3(vObj * vec3(9.0, 9.0, 1.2) + 5.0);
    // sides are lit from the front-right and slightly below (as in the reference: left-facing
    // walls in shade, undersides catching the bounce from the floor)
    float sideKey = max(dot(N, normalize(vec3(0.5, -0.3, 0.8))), 0.0);
    float sideLit = 0.55 + 0.75 * sideKey;
    vec3 side = uSide * sideLit * (1.1 - 0.35 * vPart.y) * (0.82 + 0.36 * streak);
    side += (e - 0.4) * uSideReflect;
    side *= mix(1.0, 0.45, isSeam);
    vec3 stepCol = side * 0.6 + spec * 0.2;

    vec3 col = face * isFace + chamfer1 * isCh1 + chamfer2 * isCh2 + stepCol * isStep + side * isSide;
    col += spec * (isFace + isCh1 + 0.6 * isCh2 + 0.45 * isSide);
    // levels: a bit more contrast around mid-grey, soft shoulder so whites don't all clip
    col = (col - 0.5) * uContrast + 0.5;
    col = mix(col, 0.8 + 0.2 * (1.0 - exp(-(col - 0.8) * 3.0)), step(0.8, col));
    if (uDebug > 1.5) {
      // reflection direction: r = az/π·0.5+0.5, g = el/(π/2)·0.5+0.5 (before env shift)
      float az0 = atan(R.x, R.z);
      float el0 = asin(clamp(R.y, -1.0, 1.0));
      gl_FragColor = vec4(az0 / 3.14159 * 0.5 + 0.5, el0 / 1.5708 * 0.5 + 0.5, part / 5.0, 1.0);
      return;
    }
    if (uDebug > 0.5) {
      // false colours per profile band: face, chamfer 1, step, chamfer 2, side, seam
      vec3 pc[6] = vec3[6](vec3(0.9), vec3(1.0, 0.2, 0.2), vec3(0.2, 1.0, 0.2), vec3(0.2, 0.4, 1.0), vec3(0.45), vec3(1.0, 1.0, 0.0));
      col = pc[int(part)] * (0.6 + 0.4 * max(dot(N, normalize(vec3(-0.4, 0.6, 0.7))), 0.0));
    }
    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`

export function createTitleMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: TITLE_VERT,
    fragmentShader: TITLE_FRAG,
    uniforms: {
      uFace: { value: new THREE.Vector3() },
      uSide: { value: new THREE.Vector3() },
      uSky: { value: new THREE.Vector3() },
      uGlint: { value: new THREE.Vector3() },
      uGround: { value: new THREE.Vector3() },
      uReflect: { value: 0.85 },
      uSideReflect: { value: 0.3 },
      uMatte: { value: 0.3 },
      uBlotch: { value: 1 },
      uWarp: { value: 0.4 },
      uSpec: { value: 1 },
      uEnvShift: { value: new THREE.Vector2() },
      uHorizon: { value: 0.15 },
      uBulge: { value: 0.5 },
      uContrast: { value: 1.1 },
      uBevelLight: { value: 0.6 },
      uDebug: { value: 0 },
      uLamp: { value: 1 },
      uEnvRot: { value: new THREE.Matrix3() },
    },
    side: THREE.FrontSide,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
//  Final pass: bad key-out fringe, unstable edges, RGB555 + Bayer dither
// ─────────────────────────────────────────────────────────────────────────────

const POST_VERT = /* glsl */ `
  void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`

const POST_FRAG = /* glsl */ `
  uniform sampler2D tColor;
  uniform vec2 uRes;
  uniform float uTick;
  uniform float uE;        // energy × shimmer
  uniform float uFringe;
  uniform float uLevels;
  uniform float uDither;
  uniform float uGlitch;
  uniform float uFlicker;
  ${NOISE}

  float bayer4(ivec2 p) {
    int x = p.x & 3, y = p.y & 3;
    int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
    return (float(m[y * 4 + x]) + 0.5) / 16.0;
  }

  vec4 at(ivec2 q) {
    return texelFetch(tColor, clamp(q, ivec2(0), ivec2(uRes) - 1), 0);
  }

  void main() {
    ivec2 P = ivec2(gl_FragCoord.xy);
    float e = uE;

    // occasional 1-px row / column slips while moving (old renderer tearing, not "glitch art")
    ivec2 off = ivec2(0);
    float band = floor(float(P.y) / 2.0);
    if (hash12(vec2(band, uTick)) < 0.03 * e * uGlitch)
      off.x = hash12(vec2(band + 17.0, uTick)) < 0.5 ? -1 : 1;
    float cband = floor(float(P.x) / 3.0);
    if (hash12(vec2(cband + 91.0, uTick * 1.3)) < 0.01 * e * uGlitch)
      off.y = hash12(vec2(cband, uTick + 5.0)) < 0.5 ? -1 : 1;
    ivec2 Q = P + off;

    vec4 c = at(Q);
    float a = step(0.5, c.a);
    vec4 cl = at(Q + ivec2(-1, 0)), cr = at(Q + ivec2(1, 0));
    vec4 cu = at(Q + ivec2(0, 1)), cd = at(Q + ivec2(0, -1));
    float nmax = max(max(cl.a, cr.a), max(cu.a, cd.a));
    float nmin = min(min(cl.a, cr.a), min(cu.a, cd.a));
    bool edgeIn = a > 0.5 && nmin < 0.5;
    bool edgeOut = a < 0.5 && nmax > 0.5;

    // alpha-threshold jitter: edge pixels pop in and out
    float hf = hash12(vec2(Q) + vec2(uTick * 1.37, uTick * 0.71));
    if (edgeIn && hf < uFlicker * e * 0.45) { a = 0.0; edgeIn = false; edgeOut = true; }
    else if (edgeOut && hf < uFlicker * e * 0.3) {
      c = cl.a > 0.5 ? cl : cr.a > 0.5 ? cr : cu.a > 0.5 ? cu : cd;
      a = 1.0; edgeOut = false; edgeIn = true;
    }

    vec3 rgb = c.rgb;
    float outA = a;
    float hs = hash12(vec2(Q) * 0.731 + 3.0);
    if (edgeIn) {
      // half-keyed edge pixels: blended with the white background they were rendered on
      rgb = mix(rgb, vec3(0.96, 0.965, 0.975), uFringe * (0.18 + 0.4 * hs));
    } else if (edgeOut) {
      // stray whitish halo pixels the key didn't remove
      float keep = step(0.35, hs);
      rgb = vec3(0.95, 0.955, 0.965);
      outA = uFringe * keep * (0.2 + 0.35 * hs);
    }

    // RGB555-ish quantisation with ordered dither
    float d = mix(0.5, bayer4(P), uDither);
    rgb = floor(rgb * uLevels + d) / uLevels;

    gl_FragColor = vec4(rgb * outA, outA);
  }
`

export function createPostMaterial(tex: THREE.Texture) {
  return new THREE.ShaderMaterial({
    vertexShader: POST_VERT,
    fragmentShader: POST_FRAG,
    uniforms: {
      tColor: { value: tex },
      uRes: { value: new THREE.Vector2(1, 1) },
      uTick: { value: 0 },
      uE: { value: 0 },
      uFringe: { value: 0.5 },
      uLevels: { value: 31 },
      uDither: { value: 1 },
      uGlitch: { value: 1 },
      uFlicker: { value: 0.5 },
    },
    depthTest: false,
    depthWrite: false,
    transparent: false,
  })
}
