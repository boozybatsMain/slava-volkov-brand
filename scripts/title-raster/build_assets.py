#!/usr/bin/env python3
"""
Offline preprocessing for the raster 3D title (candidate "raster").

    python3 scripts/title-raster/build_assets.py [--debug]

Input : reference/title-main.jpg  (the client's own render — used AS the asset, so every
        intended defect survives: JPEG mush, stepped bevels, matte pseudo-chrome, odd highlights)
Output: public/assets/title-raster/
          color.png    RGB  — the reference pixels, cropped. Nothing is denoised, sharpened,
                              upscaled or smoothed.
          maps.png     RGB  — R: matte  (soft "inside-ness"; the shader cuts it with a HARD
                                         threshold, so the cut is stair-stepped and can crawl)
                              G: relief (1 = front faces, → 0 towards the back edge of the
                                         extrusions; blurred, used for vertex displacement)
                              B: face   (front-face depth: 0 off-face, ~0.1 on the bevel rim,
                                         1 = ≥ FACE_DEEP px inside the face → where the
                                         reflection may slide without dragging bevels along)
          normals.png  RGB  — R,G: pseudo normal xy (0.5 = flat), B: hot mask (where the
                                   render already has blue-white highlights)
          meta.json         — crop size, anchor (left edge of "S" at its vertical middle),
                              visual bbox, vanishing point of the baked perspective.

The key is deliberately crude ("badly cut out"): background = near-white pixels connected to the
image border (flood fill) + enclosed pockets marked by HOLE_SEEDS. Chrome highlights are
near-white too, but they are enclosed by darker bevels so the flood never reaches them. The A/O/D
counters show grey extrusion walls in this render, so the only enclosed see-through pocket is the
end of the S's upper counter (closed off by the L). The JPEG halo around the silhouette stays in
the foreground, which gives the faint light fringe of a white-keyed cut-out.
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "reference" / "title-main.jpg"
OUT = ROOT / "public" / "assets" / "title-raster"
DEBUG = "--debug" in sys.argv
DBG = ROOT / "shots" / "title-raster" / "maps"

# ── knobs ────────────────────────────────────────────────────────────────────
BG_WHITE = 244      # min(R,G,B) at/above which a border-connected pixel is background
BG_SAT = 16         # max(R,G,B)-min(R,G,B) tolerated for background
MARGIN = 28         # transparent margin around the title (room for displacement / row glitches)
SPECK_KEEP = 3.0    # isolated foreground specks are kept only within this distance (px) of the body
MATTE_SIGMA = 0.85  # softness of the matte ramp (the shader thresholds it → still a hard cut)
FACE_WINDOW = 20    # adaptive threshold window (px) for front faces vs extrusion walls
FACE_DEEP = 14.0    # px inside a face at which the face channel saturates
# Enclosed background pockets the border flood cannot reach (source px). Every other enclosed
# near-white blob in this render is a chrome highlight (checked one by one with --debug).
HOLE_SEEDS = [
    (283, 138),  # S upper counter: its open end is closed off by the L's wall
]


def gauss_masked(x, m, s):
    num = ndi.gaussian_filter(x * m, s)
    den = ndi.gaussian_filter(m, s) + 1e-6
    return num / den


def main():
    img = np.asarray(Image.open(SRC).convert("RGB")).astype(np.float32)
    H, W, _ = img.shape
    R, G, B = img[..., 0], img[..., 1], img[..., 2]
    mn = img.min(2)
    sat = img.max(2) - mn
    lum = 0.299 * R + 0.587 * G + 0.114 * B
    blue = B - (R + G) / 2

    # ── 1. key: background = near-white connected to the border ───────────────
    cand = (mn >= BG_WHITE) & (sat <= BG_SAT)
    lab, _ = ndi.label(cand)
    border_ids = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    border_ids = border_ids[border_ids > 0]
    bg = np.isin(lab, border_ids)
    for sx, sy in HOLE_SEEDS:
        if lab[sy, sx] > 0:
            bg |= lab == lab[sy, sx]
    fg = ~bg

    # Foreground specks: big components are the title body ("SLAVA" and "VOLKOV" are two).
    flab, fn = ndi.label(fg)
    sizes = ndi.sum(fg, flab, range(1, fn + 1))
    body = np.isin(flab, np.nonzero(sizes >= 500)[0] + 1)
    dist_body = ndi.distance_transform_edt(~body)
    fg = body | (fg & (dist_body <= SPECK_KEEP))  # keep sloppy specks hugging the edge only

    # ── 2. matte ramp (the shader cuts it with a hard threshold ~0.4–0.5) ─────
    matte = ndi.gaussian_filter(fg.astype(np.float32), MATTE_SIGMA)
    # Pixels that are clearly inside never drop out, however the threshold jitters.
    inside = ndi.binary_erosion(fg, iterations=2)
    matte = np.where(inside, 1.0, matte)

    # ── 3. front faces vs extrusion walls (adaptive local brightness) ─────────
    fgf = fg.astype(np.float32)
    L_small = gauss_masked(lum, fgf, 1.5)
    L_big = gauss_masked(lum, fgf, FACE_WINDOW)
    face = (L_small + 2.0 * np.maximum(blue, 0) > L_big * 0.98) & fg
    face = ndi.binary_opening(face, iterations=2)
    face = ndi.binary_closing(face, iterations=2)
    face = ndi.binary_fill_holes(face)
    flab2, fn2 = ndi.label(face)
    fs = ndi.sum(face, flab2, range(1, fn2 + 1))
    face = np.isin(flab2, np.nonzero(fs >= 150)[0] + 1)
    face_soft = ndi.gaussian_filter(face.astype(np.float32), 1.2) * fgf

    # ── 4. relief: faces in front, walls fall back towards the silhouette ─────
    d_face = ndi.distance_transform_edt(~face)
    d_bg = ndi.distance_transform_edt(fg)
    t = np.clip(d_face / (d_face + d_bg + 1e-6), 0, 1)
    relief = np.where(face, 1.0, 1.0 - t)
    relief = gauss_masked(np.where(fg, relief, 0.0), fgf, 2.0)
    # Extend into the background with the nearest foreground value: no artificial cliff at the
    # silhouette (a face edge on the contour stays in front; only wall back-edges sit behind).
    _, (iy, ix) = ndi.distance_transform_edt(~fg, return_indices=True)
    relief = np.where(fg, relief, relief[iy, ix])
    relief = ndi.gaussian_filter(relief, 1.5)

    # ── 5. pseudo normals: relief gradient (walls) + face-edge bevels ─────────
    hb = ndi.gaussian_filter(relief, 2.0)
    gy, gx = np.gradient(hb)
    fb = ndi.gaussian_filter(face.astype(np.float32), 2.2)
    by, bx = np.gradient(fb)
    nx = -(gx * 6.0) + (bx * 7.0) * face_soft   # bevels lean outwards from the face
    ny = -(gy * 6.0) + (by * 7.0) * face_soft   # image space: +y = down
    nz = np.ones_like(nx)
    nl = np.sqrt(nx * nx + ny * ny + nz * nz)
    nx, ny = nx / nl, ny / nl

    hot = np.clip((lum - 175) / 70, 0, 1) * np.clip(0.4 + blue / 30, 0, 1) * fgf
    hot = np.maximum(hot, np.clip((mn - 225) / 25, 0, 1) * fgf)

    # ── 6. anchor: left edge of the "S" at its vertical middle ────────────────
    xs = np.nonzero(fg.any(0))[0]
    ys = np.nonzero(fg.any(1))[0]
    bx0, bx1, by0, by1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    s_cols = fg[:, bx0:bx0 + 190]               # the S occupies the first ~200 px (L starts after)
    s_rows = np.nonzero(s_cols.any(1))[0]
    s_mid = (s_rows.min() + s_rows.max()) / 2.0
    band = fg[int(s_mid) - 2:int(s_mid) + 3]     # ±2 rows around the middle
    s_left = float(min(np.nonzero(r)[0].min() for r in band))

    # ── 7. baked perspective: fit letter-top / letter-bottom lines → vanishing point
    tops, bots = [], []
    for x in range(bx0 + 40, bx1 - 20, 6):
        c = np.nonzero(fg[:, x])[0]
        if len(c):
            tops.append((x, c.min()))
            bots.append((x, c.max()))
    tops = np.array(tops, np.float64)
    bots = np.array(bots, np.float64)

    def envelope(pts, upper):
        # robust line through the outer envelope (letter tops / bottoms), ignoring V/A notches
        k = 0
        sel = pts
        for _ in range(4):
            k, b = np.polyfit(sel[:, 0], sel[:, 1], 1)
            res = pts[:, 1] - (k * pts[:, 0] + b)
            keep = res < 4 if upper else res > -4
            sel = pts[keep]
        return np.polyfit(sel[:, 0], sel[:, 1], 1)

    kt, bt = envelope(tops, True)
    kb, bb = envelope(bots, False)
    vx = (bb - bt) / (kt - kb)
    vy = kt * vx + bt

    # ── 8. crop + write ───────────────────────────────────────────────────────
    x0, y0 = max(0, bx0 - MARGIN), max(0, by0 - MARGIN)
    x1, y1 = min(W, bx1 + 1 + MARGIN), min(H, by1 + 1 + MARGIN)
    pad = [(max(0, MARGIN - bx0), max(0, bx1 + 1 + MARGIN - W))]
    padT, padB = max(0, MARGIN - by0), max(0, by1 + 1 + MARGIN - H)

    def crop(a, fill):
        c = a[y0:y1, x0:x1]
        padw = ((padT, padB), pad[0]) + (((0, 0),) if c.ndim == 3 else ())
        return np.pad(c, padw, constant_values=fill)

    to8 = lambda a: np.clip(np.round(a * 255), 0, 255).astype(np.uint8)
    OUT.mkdir(parents=True, exist_ok=True)

    color = crop(img, 254).astype(np.uint8)
    Image.fromarray(color).save(OUT / "color.png", optimize=True)
    face_in = np.clip(ndi.distance_transform_edt(face) / FACE_DEEP, 0, 1)
    maps = np.stack([crop(matte, 0), crop(relief, 0), crop(face_in, 0)], -1)
    Image.fromarray(to8(maps)).save(OUT / "maps.png", optimize=True)
    nrm = np.stack([crop(nx * 0.5 + 0.5, 0.5), crop(ny * 0.5 + 0.5, 0.5), crop(hot, 0)], -1)
    Image.fromarray(to8(nrm)).save(OUT / "normals.png", optimize=True)

    ox, oy = x0 - pad[0][0], y0 - padT  # texel (0,0) in source coords
    th, tw = color.shape[:2]
    meta = {
        "source": "reference/title-main.jpg",
        "size": [tw, th],
        "anchor": [s_left - ox, s_mid - oy],
        "bbox": [bx0 - ox, by0 - oy, bx1 + 1 - ox, by1 + 1 - oy],
        "vanish": [float(vx - ox), float(vy - oy)],
        "lines": {"top": [float(kt), float(bt + kt * ox - oy)], "bottom": [float(kb), float(bb + kb * ox - oy)]},
    }
    (OUT / "meta.json").write_text(json.dumps(meta, indent=2))
    print(json.dumps(meta, indent=2))

    if DEBUG:
        DBG.mkdir(parents=True, exist_ok=True)
        vis = img.copy()
        vis[bg] = [255, 110, 200]
        Image.fromarray(vis.astype(np.uint8)).save(DBG / "key.png")
        ov = img.copy()
        ov[~fg] = 255
        ov[face] = ov[face] * 0.55 + np.array([255, 40, 40]) * 0.45
        Image.fromarray(ov.astype(np.uint8)).save(DBG / "face.png")
        Image.fromarray(to8(relief)).save(DBG / "relief.png")
        Image.fromarray(to8(np.stack([nx * .5 + .5, ny * .5 + .5, np.sqrt(np.clip(1 - nx**2 - ny**2, 0, 1))], -1))).save(DBG / "normals_vis.png")
        Image.fromarray(to8(hot)).save(DBG / "hot.png")


if __name__ == "__main__":
    main()
