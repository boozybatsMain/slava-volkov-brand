#!/usr/bin/env python3
"""
TEMPORARY sky plates for version 2 (index.html), cut from reference/sky-hero.png.

    python3 src/layers/photo-sky/tools/make_placeholders.py [--debug]

The real plates (the reference sky re-generated clean, ≥ 3000 px wide) will replace these
files 1:1 — public/assets/sky/sky-wide.jpg and sky-tall.jpg. Until then:

  1. the UI text of the mockup (name, nav, tagline) is removed with a membrane fill;
  2. the chrome title is removed with a shift-map fill: the hole is split into vertical strips,
     each strip borrows a patch of the same sky from elsewhere in the frame (offset chosen by
     how well its surroundings match + how well it joins the neighbouring strips, Viterbi over
     the strips), then the whole patchwork is Poisson-blended into the photo;
  3. sky-wide.jpg = the whole frame; sky-tall.jpg = a portrait crop of its cloudier right side.

The title silhouette is the title asset (public/assets/title-raster/maps.png, R = matte) put
on the reference by a homography fitted to it (see the README). Nothing here is shipped.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi
from scipy.sparse import coo_matrix
from scipy.sparse.linalg import splu

ROOT = Path(__file__).resolve().parents[4]
SRC = ROOT / "reference" / "sky-hero.png"
MATTE = ROOT / "public" / "assets" / "title-raster" / "maps.png"
OUT = ROOT / "public" / "assets" / "sky"
DEBUG = "--debug" in sys.argv
DBG = ROOT / "shots" / "v2-photo" / "placeholder-debug"

# asset texel → reference px (fitted: silhouette IoU vs a colour/texture classifier of the reference)
H_TITLE = np.array([
    [1.425992827739984, -0.11950385793554397, 193.79329548700053],
    [0.19763530791960743, 1.3158401539336313, 82.42740462055869],
    [5.936697954041226e-05, -7.2372579968273985e-06, 1.0],
])
TITLE_GROW = 15         # px around the fitted silhouette (fit error + JPEG halo + fringe)
TEXT_BOXES = [(40, 35, 330, 90), (1260, 35, 1945, 90), (40, 735, 380, 862)]  # x0, y0, x1, y1
STRIP = 72              # strip width, px
FEATHER = 28            # half-width of the band where the seam between two strips is searched, px
RING = 32               # context ring used to score a candidate offset, px
TALL_X = 1320           # left edge of the portrait crop
TALL_W = 680            # portrait crop width (full height 906 → 0.75 aspect)


def title_mask(shape):
    matte = np.asarray(Image.open(MATTE)).astype(float)[..., 0] / 255
    a = ndi.gaussian_filter((matte > 0.42).astype(float), 1.0)
    h, w = shape
    Hi = np.linalg.inv(H_TITLE)
    yy, xx = np.mgrid[0:h, 0:w].astype(float)
    d = Hi[2, 0] * xx + Hi[2, 1] * yy + Hi[2, 2]
    u = (Hi[0, 0] * xx + Hi[0, 1] * yy + Hi[0, 2]) / d
    v = (Hi[1, 0] * xx + Hi[1, 1] * yy + Hi[1, 2]) / d
    m = ndi.map_coordinates(a, [v, u], order=1, cval=0) > 0.5
    m = ndi.binary_closing(m, iterations=14)  # narrow sky gaps between letters join the hole
    return ndi.binary_dilation(ndi.binary_fill_holes(m), iterations=TITLE_GROW)


def chrome_leftovers(img, t):
    """Chrome the fitted silhouette misses (dark / grey slivers along its edge): a dark rim left
    on the hole boundary would be smeared across the whole fill by the Poisson solve."""
    lum = img @ [0.299, 0.587, 0.114]
    sat = img.max(-1) - img.min(-1)
    near = ndi.binary_dilation(t, iterations=26) & ~t
    grey = ((lum < 112) & (sat < 34)) | (sat < 12)
    hit = ndi.binary_opening(near & grey, iterations=1)
    lab, n = ndi.label(hit)
    touching = np.unique(lab[ndi.binary_dilation(t, iterations=2) & hit])
    keep = np.isin(lab, touching[touching > 0])
    return ndi.binary_dilation(keep, iterations=5)


def text_mask(img):
    lum = img @ [0.299, 0.587, 0.114]
    bgl = ndi.median_filter(lum, size=25)
    sat = img.max(-1) - img.min(-1)
    m = np.zeros(lum.shape, bool)
    for x0, y0, x1, y1 in TEXT_BOXES:
        box = np.s_[y0:y1, x0:x1]
        m[box] = (lum[box] - bgl[box] > 10) & (sat[box] < 60)
    m = ndi.binary_closing(m, iterations=2)
    return ndi.binary_dilation(m, iterations=4)


def shift_fill(img, hole, forbid):
    """Strip-wise patch borrowing; returns the patchwork G (valid on dilate(hole))."""
    h, w = hole.shape
    need = ndi.binary_dilation(hole, iterations=2)  # G must exist one ring outside the hole (Poisson guidance)
    cols = np.nonzero(need.any(0))[0]
    x_lo, x_hi = cols.min(), cols.max() + 1
    starts = list(range(x_lo, x_hi, STRIP))
    blocked = ndi.binary_dilation(forbid, iterations=3)
    # candidates are scored on a blurred copy: matching the local colour/brightness pattern, not
    # pixel noise (raw SSD prefers flat blue patches inside cloud fields → washed-out fill)
    soft = ndi.gaussian_filter(img, (5, 5, 0))
    dxs = np.arange(-960, 961, 16)
    dys = np.arange(-424, 425, 8)
    strips = []
    for x0 in starts:
        xa, xb = max(0, x0 - FEATHER), min(w, x0 + STRIP + FEATHER)
        band = np.zeros_like(hole)
        band[:, xa:xb] = True
        region = need & band
        ring = ndi.binary_dilation(region, iterations=RING) & ~blocked & band
        ry, rx = np.nonzero(region)
        gy, gx = np.nonzero(ring)
        cy, cx = ry[::3], rx[::3]  # validity check on a subsample (blocked is grown by 3 px)
        gy, gx = gy[::2], gx[::2]
        if len(ry) == 0:
            strips.append(None)
            continue
        target = soft[gy, gx]
        cands = []
        for dy in dys:
            for dx in dxs:
                if abs(dx) < 40 and abs(dy) < 40:
                    continue
                if ry.min() + dy < 0 or rx.min() + dx < 0 or ry.max() + dy >= h or rx.max() + dx >= w:
                    continue
                sy, sx = cy + dy, cx + dx
                if blocked[sy, sx].any():
                    continue
                ty, tx = gy + dy, gx + dx
                ok = (ty >= 0) & (tx >= 0) & (ty < h) & (tx < w)
                ok[ok] &= ~blocked[ty[ok], tx[ok]]
                if ok.mean() < 0.8:
                    continue
                err = ((soft[ty[ok], tx[ok]] - target[ok]) ** 2).sum(-1).mean()
                # same altitude = same kind of sky (blue on top, dense small clouds low)
                err += 0.6 * dy ** 2 / 100
                cands.append((err, dy, dx))
        cands.sort()
        strips.append(dict(x0=x0, xa=xa, xb=xb, region=region, cands=cands[:40]))

    # Viterbi over strips: unary = context error, pairwise = disagreement in the shared feather
    live = [s for s in strips if s and s['cands']]
    prev_cost = np.array([c[0] for c in live[0]['cands']])
    back = []
    for a, b in zip(live, live[1:]):
        ov = a['region'] & b['region']
        oy, ox = np.nonzero(ov)
        pair = np.zeros((len(a['cands']), len(b['cands'])))
        if len(oy):
            pa = np.stack([img[oy + c[1], ox + c[2]] for c in a['cands']])
            pb = np.stack([img[oy + c[1], ox + c[2]] for c in b['cands']])
            for i in range(len(a['cands'])):
                pair[i] = ((pb - pa[i]) ** 2).sum(-1).mean(-1)
        tot = prev_cost[:, None] + 1.5 * pair
        back.append(tot.argmin(0))
        prev_cost = tot.min(0) + np.array([c[0] for c in b['cands']])
    choice = [int(prev_cost.argmin())]
    for bk in reversed(back):
        choice.append(int(bk[choice[-1]]))
    choice.reverse()

    # Owner map: every hole pixel takes ONE strip's patch (no cross-fade ghosting). Between two
    # strips the border is a min-error vertical cut through their shared feather (image quilting).
    offs = [s['cands'][ci][1:] for s, ci in zip(live, choice)]
    owner = -np.ones(hole.shape, int)
    xs = np.arange(w)
    for k, s in enumerate(live):
        core = s['region'] & (xs >= s['x0'])[None, :] & (xs < s['x0'] + STRIP)[None, :]
        owner[core] = k
        if DEBUG:
            print(f"strip x={s['x0']:4d}  offset dx={offs[k][1]:+4d} dy={offs[k][0]:+4d}")
    for k in range(len(live) - 1):
        a, b = live[k], live[k + 1]
        xa, xb = b['x0'] - FEATHER, b['x0'] + FEATHER
        ov = a['region'][:, xa:xb] & b['region'][:, xa:xb]
        rows = np.nonzero(ov.any(1))[0]
        if not len(rows):
            continue
        (dya, dxa), (dyb, dxb) = offs[k], offs[k + 1]
        yy, xx = np.mgrid[rows[0]:rows[-1] + 1, xa:xb]
        okm = ov[rows[0]:rows[-1] + 1]
        ea = img[np.clip(yy + dya, 0, h - 1), np.clip(xx + dxa, 0, w - 1)]
        eb = img[np.clip(yy + dyb, 0, h - 1), np.clip(xx + dxb, 0, w - 1)]
        err = np.where(okm, ((ea - eb) ** 2).sum(-1), 0.0)
        # DP: cheapest top-to-bottom path, one column step per row at most
        cum = err.copy()
        for r in range(1, len(cum)):
            prev = cum[r - 1]
            best = np.minimum(prev, np.minimum(np.r_[np.inf, prev[:-1]], np.r_[prev[1:], np.inf]))
            cum[r] += best
        cut = np.zeros(len(cum), int)
        cut[-1] = int(cum[-1].argmin())
        for r in range(len(cum) - 2, -1, -1):
            c = cut[r + 1]
            lo, hi = max(0, c - 1), min(cum.shape[1], c + 2)
            cut[r] = lo + int(cum[r, lo:hi].argmin())
        left = (np.arange(xb - xa)[None, :] < cut[:, None]) & okm
        sub = owner[rows[0]:rows[-1] + 1, xa:xb]
        sub[left] = k
        sub[~left & okm] = k + 1
    # leftovers (hole pixels outside every strip core and seam): nearest owner
    miss = need & (owner < 0)
    if miss.any():
        _, (iy, ix) = ndi.distance_transform_edt(owner < 0, return_indices=True)
        owner[miss] = owner[iy[miss], ix[miss]]
    G = img.copy()
    for k, (dy, dx) in enumerate(offs):
        ry, rx = np.nonzero(owner == k)
        G[ry, rx] = img[np.clip(ry + dy, 0, h - 1), np.clip(rx + dx, 0, w - 1)]
    return G, owner


def poisson(img, G, owner, hole_guided, hole_plain):
    """Solve Δf = div(∇G) on hole_guided, Δf = 0 on hole_plain, f = img outside.
    Gradients across a seam between two patches (owner differs) are dropped → the seam heals."""
    omega = hole_guided | hole_plain
    h, w = omega.shape
    idx = -np.ones(omega.shape, int)
    ys, xs = np.nonzero(omega)
    n = len(ys)
    idx[ys, xs] = np.arange(n)
    rows, cols, vals = [np.arange(n)], [np.arange(n)], [np.full(n, 4.0)]
    b = np.zeros((n, 3))
    guided = hole_guided[ys, xs]
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        qy, qx = np.clip(ys + dy, 0, h - 1), np.clip(xs + dx, 0, w - 1)
        inside = omega[qy, qx]
        rows.append(np.nonzero(inside)[0])
        cols.append(idx[qy[inside], qx[inside]])
        vals.append(np.full(inside.sum(), -1.0))
        b[~inside] += img[qy[~inside], qx[~inside]]
        same = guided & (owner[ys, xs] == owner[qy, qx])
        b[same] += G[ys[same], xs[same]] - G[qy[same], qx[same]]
    A = coo_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(n, n)).tocsc()
    lu = splu(A)
    out = img.copy()
    for c in range(3):
        out[ys, xs, c] = lu.solve(b[:, c])
    return out


def main():
    img = np.asarray(Image.open(SRC).convert('RGB')).astype(float)
    t = title_mask(img.shape[:2])
    t = ndi.binary_fill_holes(t | chrome_leftovers(img, t))
    x = text_mask(img) & ~t
    G, owner = shift_fill(img, t, t | x)
    out = np.clip(poisson(img, G, owner, t, x), 0, 255).astype(np.uint8)
    OUT.mkdir(parents=True, exist_ok=True)
    wide = Image.fromarray(out)
    wide.save(OUT / 'sky-wide.jpg', quality=90, optimize=True, progressive=True)
    wide.crop((TALL_X, 0, TALL_X + TALL_W, out.shape[0])).save(
        OUT / 'sky-tall.jpg', quality=90, optimize=True, progressive=True)
    if DEBUG:
        DBG.mkdir(parents=True, exist_ok=True)
        dbg = img.copy()
        dbg[t] = dbg[t] * 0.5 + np.array([255, 0, 0]) * 0.5
        dbg[x] = dbg[x] * 0.5 + np.array([0, 255, 0]) * 0.5
        Image.fromarray(dbg.astype(np.uint8)).save(DBG / 'masks.png')
        Image.fromarray(np.clip(G, 0, 255).astype(np.uint8)).save(DBG / 'patchwork.png')
    # flat colours for the page before the photo arrives (sky.color in sky.config.ts)
    top = out[: out.shape[0] // 3].reshape(-1, 3).mean(0)
    bot = out[-out.shape[0] // 3:].reshape(-1, 3).mean(0)
    hexc = lambda c: '#' + ''.join(f'{int(round(v)):02x}' for v in c)
    print('wide', wide.size, 'tall', (TALL_W, out.shape[0]), 'top', hexc(top), 'bottom', hexc(bot),
          'mean', hexc(out.reshape(-1, 3).mean(0)))


if __name__ == '__main__':
    main()
