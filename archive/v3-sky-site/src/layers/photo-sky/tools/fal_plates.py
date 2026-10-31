#!/usr/bin/env python3
"""
Final sky plates for version 2 (index.html), made with fal.ai from reference/sky-hero.png.

    FAL_KEY=… python3 src/layers/photo-sky/tools/fal_plates.py fill    [--seed N] [--n 2] [--prompt …] [--tag …]
    FAL_KEY=… python3 src/layers/photo-sky/tools/fal_plates.py edit    --prompt … [--tag …] [--n 1]
    python3 src/layers/photo-sky/tools/fal_plates.py despeck <in.png> <out-name>   (no network)
    python3 src/layers/photo-sky/tools/fal_plates.py merge <detail.png> <colour.png> <out-name>  (no network)
    python3 src/layers/photo-sky/tools/fal_plates.py heal <in.png> <out-name> x,y,r [x,y,r …]    (no network)
    FAL_KEY=… python3 src/layers/photo-sky/tools/fal_plates.py upscale <endpoint> <json-args> <in.png> <out-name>

The key is read from the environment only and never written anywhere.
Work files go to $FAL_WORK (default: ./.fal-work, git-ignored); nothing here is shipped.

  fill     — FLUX.1 Fill [pro] repaints the chrome title and the mockup's UI text (mask from
             make_placeholders.py: the fitted title silhouette + chrome leftovers + text), then the
             result is composited back so every pixel outside the (feathered) mask stays original.
  upscale  — runs one fal upscaler on a local PNG and saves the result (used to compare models).
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_placeholders import SRC, chrome_leftovers, text_mask, title_mask  # noqa: E402

WORK = Path(os.environ.get('FAL_WORK', Path.cwd() / '.fal-work'))
QUEUE = 'https://queue.fal.run'

SKY_PROMPT = (
    'golden hour sky photograph, soft scattered cumulus and altocumulus clouds lit warm peach and '
    'apricot by a low sun, cool blue-violet grey shaded undersides, dusty steel-blue sky, '
    'natural photo, high detail, no text, no letters, no objects'
)


def key() -> str:
    k = os.environ.get('FAL_KEY', '').strip()
    if not k:
        sys.exit('FAL_KEY is not set')
    return k


def http(method: str, url: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        'Authorization': f'Key {key()}',
        'Content-Type': 'application/json',
    })
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def run(endpoint: str, args: dict, poll: float = 2.0, timeout: float = 900) -> dict:
    """Submit to the fal queue and wait for the result."""
    sub = http('POST', f'{QUEUE}/{endpoint}', args)
    status_url, response_url = sub['status_url'], sub['response_url']
    t0 = time.time()
    while True:
        st = http('GET', status_url)
        if st.get('status') == 'COMPLETED':
            break
        if time.time() - t0 > timeout:
            sys.exit(f'{endpoint}: timed out ({st.get("status")})')
        time.sleep(poll)
    res = http('GET', response_url)
    print(f'{endpoint}: done in {time.time() - t0:.0f}s', file=sys.stderr)
    return res


def data_uri(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()


def fetch(url: str) -> Image.Image:
    if url.startswith('data:'):
        return Image.open(io.BytesIO(base64.b64decode(url.split(',', 1)[1]))).convert('RGB')
    with urllib.request.urlopen(url, timeout=300) as r:
        return Image.open(io.BytesIO(r.read())).convert('RGB')


def images_of(res: dict) -> list[str]:
    if 'images' in res:
        return [i['url'] for i in res['images']]
    if 'image' in res:
        return [res['image']['url']]
    sys.exit(f'no image in response: {list(res)}')


def fill(seed: int | None, n: int, prompt: str = SKY_PROMPT, tag: str = 'fill'):
    WORK.mkdir(parents=True, exist_ok=True)
    src = Image.open(SRC).convert('RGB')
    img = np.asarray(src).astype(float)
    hole = holes(img)
    # the model gets a slightly larger hole (room to blend); the composite keeps a soft seam inside it
    model_mask = ndi.binary_dilation(hole, iterations=10)
    Image.fromarray((model_mask * 255).astype(np.uint8)).save(WORK / 'mask.png')
    args = {
        'image_url': data_uri(src),
        'mask_url': data_uri(Image.fromarray((model_mask * 255).astype(np.uint8)).convert('RGB')),
        'prompt': prompt,
        'num_images': n,
        'output_format': 'png',
        'safety_tolerance': '2',
    }
    if seed is not None:
        args['seed'] = seed
    res = run('fal-ai/flux-pro/v1/fill', args)
    for i, url in enumerate(images_of(res)):
        composite(img, hole, fetch(url), f'{tag}-{i}')


def holes(img: np.ndarray) -> np.ndarray:
    t = title_mask(img.shape[:2])
    t = ndi.binary_fill_holes(t | chrome_leftovers(img, t))
    return t | text_mask(img)


def composite(img: np.ndarray, hole: np.ndarray, gen: Image.Image, name: str):
    """Original pixels outside the (feathered) hole, generated ones inside."""
    gen = gen.resize((img.shape[1], img.shape[0]), Image.LANCZOS)
    gen.save(WORK / f'{name}-raw.png')
    alpha = ndi.gaussian_filter(ndi.binary_dilation(hole, iterations=5).astype(float), 3)[..., None]
    comp = img * (1 - alpha) + np.asarray(gen).astype(float) * alpha
    Image.fromarray(np.clip(comp, 0, 255).astype(np.uint8)).save(WORK / f'{name}.png')
    print(WORK / f'{name}.png')


def edit(prompt: str, tag: str, n: int):
    """Instruction edit (Gemini image, 'nano-banana') of the whole reference; composited inside the hole only."""
    WORK.mkdir(parents=True, exist_ok=True)
    src = Image.open(SRC).convert('RGB')
    img = np.asarray(src).astype(float)
    hole = holes(img)
    res = run('fal-ai/nano-banana/edit', {
        'image_urls': [data_uri(src)],
        'prompt': prompt,
        'num_images': n,
        'output_format': 'png',
    })
    for i, url in enumerate(images_of(res)):
        composite(img, hole, fetch(url), f'{tag}-{i}')


def despeck(src_path: str, out_name: str, band: int = 150, thresh: float = 14.0):
    """Removes small dark specks (a stray 'bird' the fill likes to invent) from the clear sky at
    the top: pixels much darker than the local median, filled by harmonic (Laplace) diffusion —
    the sky there is a smooth gradient, so the fill is invisible."""
    img = np.asarray(Image.open(src_path).convert('RGB')).astype(float)
    lum = img @ [0.299, 0.587, 0.114]
    dark = (ndi.median_filter(lum, size=31) - lum) > thresh
    dark[band:] = False
    lab, n = ndi.label(dark)
    sizes = ndi.sum(dark, lab, range(1, n + 1))
    keep = np.isin(lab, [i + 1 for i, sz in enumerate(sizes) if sz < 900])
    hole = ndi.binary_dilation(keep, iterations=4)
    out = img.copy()
    out[hole] = ndi.median_filter(img, size=(41, 41, 1))[hole]
    for _ in range(400):  # Jacobi iterations of the Laplace equation inside the hole
        avg = (np.roll(out, 1, 0) + np.roll(out, -1, 0) + np.roll(out, 1, 1) + np.roll(out, -1, 1)) / 4
        out[hole] = avg[hole]
    Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(WORK / out_name)
    print(WORK / out_name, f'{int(hole.sum())} px filled in {len(sizes)} blobs checked')


def merge(detail_path: str, colour_path: str, out_name: str):
    """Luma from the generative upscale (the new cloud detail), chroma from a precise one: the
    generative model sometimes paints iridescent/rainbow blotches into clouds — those live in
    the colour channels and disappear, while the detail (luminance) stays."""
    d = Image.open(detail_path).convert('YCbCr')
    c_rgb = Image.open(colour_path).convert('RGB').resize(d.size, Image.LANCZOS)
    c = c_rgb.convert('YCbCr')
    y = d.split()[0]
    _, cb, cr = c.split()
    merged = np.asarray(Image.merge('YCbCr', (y, cb, cr)).convert('RGB')).astype(float)
    # where the generative pass drifted in colour it also invented shapes (a bright swirl under
    # the rainbow): take the precise upscale there entirely, with a soft edge
    dd = np.asarray(d).astype(float)
    cc = np.asarray(c).astype(float)
    drift = ndi.gaussian_filter(np.abs(dd[..., 1] - cc[..., 1]) + np.abs(dd[..., 2] - cc[..., 2]), 4)
    bad = ndi.binary_dilation(drift > 20, iterations=14)  # typical model-to-model drift is 6–9
    a = ndi.gaussian_filter(bad.astype(float), 8)[..., None]
    out = merged * (1 - a) + np.asarray(c_rgb).astype(float) * a
    # 'stars': at high factors the generative pass sprinkles tiny bright/dark points (even a crescent
    # moon) over clear sky. Where the precise upscale is smooth, any small sharp blob the generative
    # one adds is invented — put the precise pixels back there.
    yd, yc = dd[..., 0], cc[..., 0]
    smooth = ndi.uniform_filter((yc - ndi.uniform_filter(yc, 9)) ** 2, 15) < 4.0
    crgb = np.asarray(c_rgb).astype(float)
    blue_sky = ndi.binary_erosion(ndi.uniform_filter(crgb[..., 2] - crgb[..., 0], 9) > 12, iterations=3)
    spike = np.abs(ndi.gaussian_filter(yd - yc, 1.0)) > 10
    lab, n = ndi.label(spike & smooth & blue_sky)  # only clear blue sky: cloud texture is real detail
    sizes = ndi.sum(np.ones_like(yd), lab, range(1, n + 1))
    stars = np.isin(lab, [i + 1 for i, sz in enumerate(sizes) if sz < 600])
    sa = ndi.gaussian_filter(ndi.binary_dilation(stars, iterations=4).astype(float), 1.5)[..., None]
    out = out * (1 - sa) + np.asarray(c_rgb).astype(float) * sa
    Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(WORK / out_name)
    lab, n = ndi.label(bad)
    print(WORK / out_name, d.size, f'{n} drift patches, {bad.mean() * 100:.2f}% of the frame; '
          f'{int(ndi.label(stars)[1])} stars removed')


def heal(src_path: str, out_name: str, spots: list[tuple[int, int, int]]):
    """Hand-picked retouch: discs (x, y, r) filled by harmonic diffusion from their rim, with the
    surrounding fine texture re-added so the patch is not a flat blur."""
    img = np.asarray(Image.open(src_path).convert('RGB')).astype(float)
    out = img.copy()
    yy, xx = np.mgrid[0:img.shape[0], 0:img.shape[1]]
    for x, y, r in spots:
        y0, y1, x0, x1 = max(0, y - 2 * r), y + 2 * r, max(0, x - 2 * r), x + 2 * r
        hole = (xx[y0:y1, x0:x1] - x) ** 2 + (yy[y0:y1, x0:x1] - y) ** 2 <= r * r
        tile = out[y0:y1, x0:x1]
        grain = tile - ndi.gaussian_filter(tile, (1.5, 1.5, 0))  # fine grain only
        fill = tile.copy()
        fill[hole] = ndi.median_filter(tile, size=(r, r, 1))[hole]
        for _ in range(60 + 4 * r):
            avg = (np.roll(fill, 1, 0) + np.roll(fill, -1, 0) + np.roll(fill, 1, 1) + np.roll(fill, -1, 1)) / 4
            fill[hole] = avg[hole]
        # grain of the same strength as just around the hole (a flat fill would read as a blur spot)
        ring = ndi.binary_dilation(hole, iterations=max(3, r // 3)) & ~hole
        sigma = grain[ring].std() if ring.any() else 0.0
        rng = np.random.default_rng(x * 7919 + y)
        noise = ndi.gaussian_filter(rng.standard_normal(hole.shape), 0.7)
        noise *= sigma / (noise.std() + 1e-6)
        a = ndi.gaussian_filter(hole.astype(float), r / 6)[..., None]
        tile[:] = tile * (1 - a) + (fill + noise[..., None]) * a
    Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(WORK / out_name)
    print(WORK / out_name, f'{len(spots)} spots healed')


def upscale(endpoint: str, args_json: str, src_path: str, out_name: str):
    WORK.mkdir(parents=True, exist_ok=True)
    args = json.loads(args_json)
    args['image_url'] = data_uri(Image.open(src_path).convert('RGB'))
    res = run(endpoint, args)
    out = fetch(images_of(res)[0])
    out.save(WORK / out_name)
    print(WORK / out_name, out.size)


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'fill':
        a = sys.argv[2:]
        seed = int(a[a.index('--seed') + 1]) if '--seed' in a else None
        n = int(a[a.index('--n') + 1]) if '--n' in a else 2
        prompt = a[a.index('--prompt') + 1] if '--prompt' in a else SKY_PROMPT
        tag = a[a.index('--tag') + 1] if '--tag' in a else 'fill'
        fill(seed, n, prompt, tag)
    elif cmd == 'edit':
        a = sys.argv[2:]
        edit(a[a.index('--prompt') + 1], a[a.index('--tag') + 1] if '--tag' in a else 'edit',
             int(a[a.index('--n') + 1]) if '--n' in a else 1)
    elif cmd == 'merge' and len(sys.argv) == 5:
        merge(*sys.argv[2:5])
    elif cmd == 'heal' and len(sys.argv) >= 5:
        heal(sys.argv[2], sys.argv[3], [tuple(int(v) for v in a.split(',')) for a in sys.argv[4:]])
    elif cmd == 'despeck' and len(sys.argv) == 4:
        despeck(sys.argv[2], sys.argv[3])
    elif cmd == 'upscale' and len(sys.argv) == 6:
        upscale(*sys.argv[2:6])
    else:
        sys.exit(__doc__)
