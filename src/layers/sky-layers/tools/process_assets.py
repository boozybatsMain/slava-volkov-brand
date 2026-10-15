#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
process_assets.py — финальные слои неба v2 из сырья Codex.

Вход:   $GEN_DIR/<name>/<name>.png (по умолчанию ./.gen-work; см. generate.sh и README.md)
Выход:  public/assets/sky-layers/{sky-wide,sky-tall,moon,cloudlets,bank-back,bank-front}.webp
        + проход 2: {cloudlets-sparse-a,cloudlets-sparse-b,foreground-a,foreground-b}.webp
Превью: shots/v2-layers-assets/ (композит 1384×914 рядом с reference/sky-hero-v2.png, листы слоёв, цифры)

Запуск из корня проекта:
    python3 src/layers/sky-layers/tools/process_assets.py
    python3 src/layers/sky-layers/tools/process_assets.py --pick bank-front=bank-front-a --pick moon=moon-a
    python3 src/layers/sky-layers/tools/process_assets.py --preview-only   # только превью из готовых webp

Что делает:
  * небо: гладкое поле цветов, подогнанное к небу референса (полином 3-й степени по чистым пикселям неба,
    ниже линии банка — мягкое продолжение), + мелкие детали исходной плашки (облачка, зерно) поверх;
  * облачные слои (RGBA): чистка альфы (островки/дырки), мягкий край с лёгкой эрозией, деконтаминация цвета
    (цвета края и прозрачной зоны продолжаются изнутри — без тёмных/светлых ореолов, в т.ч. в мипмапах),
    грейд по квантилям яркости под облака референса, апскейл ×2 (Upscayl ultrasharp по RGB, альфа — Lanczos);
  * bank-front без «цветной капусты»: guided-сглаживание мелкой фактуры (контуры клубов остаются), мягкий
    крупный локальный контраст, апскейл почти чистым Lanczos (us_mix — доля ultrasharp, у каждого слоя своя);
  * ближний план (foreground-*): дефокус премультиплицированного RGBA, полупрозрачные тонкие места, потолок альфы;
  * луна: первая четверть, светится правая половина, тёмная половина полностью прозрачна; квадратный кроп,
    центр диска = центр картинки, диаметр диска = MOON_DISC_FRAC ширины.
Всё детерминировано (фиксированные seed); результаты Upscayl кэшируются в $GEN_DIR/_cache.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi

ROOT = Path(__file__).resolve().parents[4]
GEN = Path(os.environ.get('GEN_DIR', ROOT / '.gen-work'))
OUT = ROOT / 'public' / 'assets' / 'sky-layers'
SHOTS = ROOT / 'shots' / 'v2-layers-assets'
REF = ROOT / 'reference' / 'sky-hero-v2.png'
UPSCAYL = Path('/Applications/Upscayl.app/Contents/Resources/bin/upscayl-bin')
UPSCAYL_MODELS = Path('/Applications/Upscayl.app/Contents/Resources/models')

# Какой сырой вариант идёт в какой финальный слой (выбрано композитингом, см. README.md).
PICK = {
    'sky-wide': 'sky-wide',
    'sky-tall': 'sky-tall',
    'moon': 'moon-b',
    'cloudlets': 'cloudlets-a',
    'bank-front': 'bank-front-a',
    'bank-back': 'bank-back-v0',
    # проход 2: россыпь мелких облачков (середина неба) и ближние облака перед надписью — оба варианта в финале
    'cloudlets-sparse-a': 'cloudlets-sparse-a',
    'cloudlets-sparse-b': 'cloudlets-sparse-b',
    'foreground-a': 'foreground-a2',  # тонкая рваная полоса; foreground-a (толстая) закрывала VOLKOV почти целиком
    'foreground-b': 'foreground-b',   # две мягкие тучки; foreground-b2 — «хвосты» как дым, тёмные прожилки
}

WEBP_Q = 90            # качество WebP (RGB); альфа без потерь
MAX_BYTES = 700_000    # если файл больше — качество понижается шагами по 3
MOON_SIZE = 512        # сторона moon.webp
MOON_DISC_FRAC = 0.90  # диаметр диска / ширина moon.webp (центр диска = центр картинки)
US_MIX = 0.50          # доля ultrasharp в апскейле RGB (остальное Lanczos) — гасим пересвет деталей

# Раскладка слоёв для композита-превью (доли кадра 1384×914, как на референсе).
PREVIEW_LAYOUT = {
    'bank-back':  dict(width=1.10, x=-0.06, skyline=0.640),   # skyline: где окажется медиана верхнего края
    'bank-front': dict(width=1.06, x=-0.03, peak=0.590),      # peak: где окажется самая высокая точка
    'cloudlets':  dict(width=0.46, x=0.50, centre_y=0.45),
    'moon':       dict(cx=0.851, cy=0.270, disc=0.047),
}
# Проход 2 — где новые слои стоят в превью composite-front (как в рендерере: anchor — точка картинки в долях,
# x / y — куда она встаёт, доли кадра; width — доля ширины кадра). Это пример, не решение композиции.
PREVIEW_FRONT = {
    'cloudlets-sparse-b': dict(width=0.90, x=0.50, y=0.74, anchor=(0.5, 0.88), opacity=0.85),  # за валами
    'foreground-a':       dict(width=1.05, x=0.50, y=0.60, anchor=(0.5, 0.50), opacity=0.95),  # перед всем
}

LUMA = np.array([0.2126, 0.7152, 0.0722])
RGBA_LAYERS = ['bank-front', 'bank-back', 'cloudlets', 'cloudlets-sparse-a', 'cloudlets-sparse-b',
               'foreground-a', 'foreground-b', 'moon']


# ----------------------------------------------------------------------------------------------- utils
def load(name: str) -> np.ndarray:
    p = GEN / name / f'{name}.png'
    if not p.exists():
        sys.exit(f'нет сырья: {p} (см. generate.sh)')
    return np.asarray(Image.open(p).convert('RGBA')).astype(np.float64)


def gblur(x: np.ndarray, s: float) -> np.ndarray:
    if x.ndim == 2:
        return ndi.gaussian_filter(x, s)
    return np.stack([ndi.gaussian_filter(x[..., c], s) for c in range(x.shape[2])], 2)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def lum(rgb: np.ndarray) -> np.ndarray:
    return rgb @ LUMA


def resize(x: np.ndarray, w: int, h: int, method=Image.LANCZOS) -> np.ndarray:
    if x.ndim == 2:
        return np.asarray(Image.fromarray(x.astype(np.float32)).resize((w, h), method)).astype(np.float64)
    return np.stack([resize(x[..., c], w, h, method) for c in range(x.shape[2])], 2)


def to_img(rgb: np.ndarray, a: np.ndarray | None = None) -> Image.Image:
    rgb8 = np.clip(rgb + 0.5, 0, 255).astype(np.uint8)
    if a is None:
        return Image.fromarray(rgb8)
    a8 = np.clip(a * 255 + 0.5, 0, 255).astype(np.uint8)
    return Image.fromarray(np.dstack([rgb8, a8]))


def save_webp(img: Image.Image, path: Path) -> tuple[int, int]:
    q = WEBP_Q
    while True:
        buf = io.BytesIO()
        kw = dict(quality=q, method=6)
        if img.mode == 'RGBA':
            kw.update(alpha_quality=100, exact=True)  # exact: не трогать RGB под прозрачностью (деконтаминация)
        img.save(buf, 'WEBP', **kw)
        if len(buf.getvalue()) <= MAX_BYTES or q <= 70:
            break
        q -= 3
    path.write_bytes(buf.getvalue())
    return len(buf.getvalue()), q


# ------------------------------------------------------------------------------------- reference stats
def _ref() -> np.ndarray:
    return np.asarray(Image.open(REF).convert('RGB')).astype(np.float64)


def _ref_exclusions(W: int, H: int) -> np.ndarray:
    """Маска «не смотреть»: тайтл, UI-текст, луна (в пикселях референса 1384×914)."""
    ex = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(ex)
    d.polygon([(50, 165), (1340, 555), (1330, 715), (40, 480)], fill=255)  # SLAVA VOLKOV
    for b in [(55, 45, 130, 80), (905, 40, 1335, 85), (80, 680, 370, 800), (1195, 765, 1300, 865)]:
        d.rectangle(b, fill=255)  # 2026, навигация, GAMES/…, SCROLL ↓
    d.rectangle((1160, 200, 1235, 295), fill=255)  # луна
    return np.asarray(ex) > 0


def _ref_sky_mask(ref: np.ndarray) -> np.ndarray:
    H, W, _ = ref.shape
    R, G, B = ref[..., 0], ref[..., 1], ref[..., 2]
    L = ref.mean(2)
    m = (B - R > 22) & (B > G)
    mu = ndi.uniform_filter(L, 9)
    var = ndi.uniform_filter(L * L, 9) - mu * mu
    return m & (var < 12) & ~_ref_exclusions(W, H)


def _basis(X, Y, deg=3):
    return np.stack([X ** i * Y ** j for i in range(deg + 1) for j in range(deg + 1 - i)], 1)


_SKY_COEF = None


def sky_coef() -> np.ndarray:
    """Полином 3-й степени цвета неба референса по (x, y) ∈ [0,1]²; ниже 0.74 — мягкие якоря (там банк)."""
    global _SKY_COEF
    if _SKY_COEF is None:
        ref = _ref()
        H, W, _ = ref.shape
        ys, xs = np.where(_ref_sky_mask(ref))
        sel = np.random.default_rng(0).choice(len(ys), min(len(ys), 40000), replace=False)
        ys, xs = ys[sel], xs[sel]
        A = _basis(xs / (W - 1), ys / (H - 1))
        ax, ay = np.meshgrid(np.linspace(0, 1, 15), np.linspace(0.74, 1.0, 6))
        ax, ay = ax.ravel(), ay.ravel()
        ac = np.array([[128, 136, 153]]) + np.outer(ay - 0.74, [22, 12, 4])
        _SKY_COEF = np.linalg.lstsq(np.vstack([A, _basis(ax, ay) * 3]), np.vstack([ref[ys, xs], ac * 3]), rcond=None)[0]
    return _SKY_COEF


def sky_field(w: int, h: int, x0=0.0, x1=1.0) -> np.ndarray:
    """Целевое небо (RGB 0..255) размера w×h; x0..x1 — какой горизонтальный участок референса берём."""
    gx, gy = np.meshgrid(np.linspace(x0, x1, w), np.linspace(0, 1, h))
    k, s = 0.64, 0.12  # ниже k полином не продолжаем, а плавно «выдыхаем» (там референс закрыт банком)
    ye = np.where(gy < k, gy, k + s * (1 - np.exp(-(gy - k) / s)))
    return (_basis(gx.ravel(), ye.ravel()) @ sky_coef()).reshape(h, w, 3)


PCTS = [1, 5, 10, 25, 50, 75, 90, 95, 99, 99.7]


def ref_ramp(box, excl=()) -> tuple[np.ndarray, np.ndarray]:
    """Квантили яркости не-небесных пикселей референса в box (доли) и средний цвет на каждом уровне."""
    ref = _ref()
    H, W, _ = ref.shape
    m = np.zeros((H, W), bool)
    m[int(box[1] * H):int(box[3] * H), int(box[0] * W):int(box[2] * W)] = True
    for e in excl:
        m[int(e[1] * H):int(e[3] * H), int(e[0] * W):int(e[2] * W)] = False
    R, G, B = ref[..., 0], ref[..., 1], ref[..., 2]
    m &= ~((B - R > 22) & (B > G)) & ~_ref_exclusions(W, H)
    L = lum(ref)[m]
    C = ref[m]
    qs = np.percentile(L, PCTS)
    cols = np.array([C[np.abs(L - q) < 2.5].mean(0) if (np.abs(L - q) < 2.5).sum() > 5 else C[np.argmin(np.abs(L - q))] for q in qs])
    return qs, cols


REF_BOXES = {
    'bank': ((0.0, 0.62, 1.0, 1.0), [(0.86, 0.82, 0.95, 0.96)]),
    'cloudlets': ((0.6, 0.25, 1.0, 0.5), []),
}


# ------------------------------------------------------------------------------------------- sky plates
def make_sky(src: str, x0: float, x1: float, detail=0.8, chroma=0.45) -> np.ndarray:
    """Плашка неба: поле референса + детали исходника (облачка/зерно), хрома деталей приглушена."""
    p = load(src)[..., :3]
    h, w, _ = p.shape
    low0 = gblur(p, 20)
    cloud = ndi.binary_dilation(np.abs(p - low0).max(2) > 5, iterations=8)
    yy, xx = np.where(~cloud)
    sel = np.random.default_rng(0).choice(len(yy), min(len(yy), 30000), replace=False)
    yy, xx = yy[sel], xx[sel]
    Bp = _basis(xx / (w - 1), yy / (h - 1), 4)
    c = np.linalg.lstsq(Bp, p[yy, xx], rcond=None)[0]
    gx, gy = np.meshgrid(np.linspace(0, 1, w), np.linspace(0, 1, h))
    low = (_basis(gx.ravel(), gy.ravel(), 4) @ c).reshape(h, w, 3)
    det = p - low
    dl = det.mean(2, keepdims=True)
    det = dl + chroma * (det - dl)
    out = sky_field(w, h, x0, x1) + detail * det
    out += np.random.default_rng(1).normal(0, 0.6, out.shape)  # дизер против бандинга в WebP
    return out


# ------------------------------------------------------------------------------------------ RGBA layers
def refine_alpha(a: np.ndarray, sigma: float, floor=0.05, rim=0.08, min_island=60, max_hole=80) -> np.ndarray:
    """Чистая альфа без «вырезанного» края.

    * пол шума: фоновая пыль сырья (альфа < floor) → 0;
    * островки (компоненты, где альфа нигде не доходит до 0.5, или меньше min_island px) → 0;
      дырки-точки внутри облака (< max_hole px) → заполнить;
    * жёсткий ступенчатый край → гаусс σ (мягкие края сырья почти не меняются),
      затем лёгкая подрезка обода (rim) — край не расползается наружу, середина остаётся 1.
    """
    a = np.clip((a - floor) / (1 - floor), 0, 1)
    lab, n = ndi.label(a > 0)
    if n:
        idx = np.arange(1, n + 1)
        area = ndi.sum(np.ones_like(a), lab, idx)
        peak = ndi.maximum(a, lab, idx)
        keep = idx[(area >= min_island) & (peak >= 0.5)]
        a = np.where(np.isin(lab, keep), a, 0)
    b = a > 0.5
    holes, n = ndi.label(~b)
    if n:
        area = ndi.sum(~b, holes, np.arange(1, n + 1))
        small = np.isin(holes, 1 + np.where(area < max_hole)[0])
        a = np.where(small, 1.0, a)
    a = gblur(a, sigma)
    return np.clip((a - rim) / (1 - 2 * rim), 0, 1)


def push_pull(rgb: np.ndarray, w: np.ndarray) -> np.ndarray:
    """Заполнить цвет там, где w=0, гладким продолжением из w=1 (пирамида push-pull, быстро и без швов)."""
    Cs, Ws = [rgb * w[..., None]], [w]
    while min(Ws[-1].shape) > 2:
        C, W = Cs[-1], Ws[-1]
        h, wd = W.shape
        C = np.pad(C, ((0, h % 2), (0, wd % 2), (0, 0)))
        W = np.pad(W, ((0, h % 2), (0, wd % 2)))
        h2, w2 = W.shape[0] // 2, W.shape[1] // 2
        C2 = C.reshape(h2, 2, w2, 2, 3).sum((1, 3))
        W2 = W.reshape(h2, 2, w2, 2).sum((1, 3))
        col = C2 / np.maximum(W2, 1e-8)[..., None]
        Wn = np.minimum(W2, 1.0)
        Cs.append(col * Wn[..., None])
        Ws.append(Wn)
    top = Ws[-1]
    col = Cs[-1] / np.maximum(top, 1e-8)[..., None]
    if not (top > 0).any():
        return rgb.copy()
    col[top <= 0] = (Cs[-1].sum((0, 1)) / top.sum())
    for lvl in range(len(Cs) - 2, -1, -1):
        h, wd = Ws[lvl].shape
        hp, wp = h + h % 2, wd + wd % 2
        up = resize(col, wp, hp, Image.BILINEAR)[:h, :wd]
        col = Cs[lvl] + (1 - Ws[lvl])[..., None] * up
    return col


def decontaminate(rgb: np.ndarray, a_src: np.ndarray, solid=0.9) -> np.ndarray:
    """Цвет края и прозрачной зоны = продолжение цвета изнутри (push-pull от пикселей с альфой ≥ solid)."""
    fill = push_pull(rgb, (a_src >= solid).astype(np.float64))
    keep = smoothstep(0.75, 0.97, a_src)[..., None]
    return fill * (1 - keep) + rgb * keep


def despeckle(rgb: np.ndarray, mask: np.ndarray, thr=16.0, size=5) -> np.ndarray:
    """Убрать одиночные тёмные/светлые точки сырья (апскейл их бы раздул); края медиана сохраняет."""
    med = np.stack([ndi.median_filter(rgb[..., c], size) for c in range(3)], -1)
    bad = (np.abs(lum(rgb) - lum(med)) > thr) & mask
    bad = ndi.binary_dilation(bad, iterations=1) & mask
    out = rgb.copy()
    out[bad] = med[bad]
    return out


def grade(rgb: np.ndarray, mask: np.ndarray, tq: np.ndarray, tc: np.ndarray, keep_hue=0.45) -> np.ndarray:
    """Квантили яркости (по mask) → квантили референса; цвет — рампа референса, частично свой оттенок."""
    L = np.maximum(lum(rgb), 1e-3)
    sq = np.percentile(L[mask], PCTS)
    sq = np.maximum.accumulate(sq + np.arange(len(sq)) * 1e-6)
    # кусочно-линейно с линейной экстраполяцией за крайними квантилями
    Ln = np.interp(L, sq, tq)
    lo_s = (tq[1] - tq[0]) / max(sq[1] - sq[0], 1e-3)
    hi_s = (tq[-1] - tq[-2]) / max(sq[-1] - sq[-2], 1e-3)
    Ln = np.where(L < sq[0], tq[0] + (L - sq[0]) * lo_s, Ln)
    Ln = np.where(L > sq[-1], tq[-1] + (L - sq[-1]) * hi_s, Ln)
    ramp = np.stack([np.interp(Ln, tq, tc[:, c]) for c in range(3)], -1)
    own = rgb * (Ln / L)[..., None]
    return np.clip((1 - keep_hue) * ramp + keep_hue * own, 0, 255)


def guided_smooth(rgb: np.ndarray, radius: int, eps: float, amount=1.0) -> np.ndarray:
    """Сгладить мелкую фактуру клубов, сохранив их контуры (guided filter по яркости, He et al.).

    Там, где яркость в окне radius меняется слабо (дисперсия ≪ eps², eps в уровнях 0..255) — мелкие
    повторяющиеся «пупырышки» ИИ-фактуры, — она сглаживается; там, где перепад большой (освещённая
    макушка клуба против тени), контур остаётся. Цвет не трогаем: меняется только яркость (через
    отношение). amount — доля эффекта (0 — нет, 1 — полностью).
    """
    L = np.maximum(lum(rgb), 1e-3)
    k = 2 * radius + 1
    mu = ndi.uniform_filter(L, k)
    var = ndi.uniform_filter(L * L, k) - mu * mu
    a = var / (var + eps * eps)
    b = mu - a * mu
    q = ndi.uniform_filter(a, k) * L + ndi.uniform_filter(b, k)
    Ln = L + amount * (q - L)
    return np.clip(rgb * (Ln / L)[..., None], 0, 255)


def upscayl2x(rgb: np.ndarray, tag: str, mix: float = US_MIX) -> np.ndarray:
    """RGB ×2 через Upscayl ultrasharp (кэш по хешу входа), смешанный с Lanczos (mix — доля ultrasharp)."""
    h, w, _ = rgb.shape
    lanczos = resize(rgb, 2 * w, 2 * h)
    if mix <= 0:
        return lanczos
    img = to_img(rgb)
    buf = io.BytesIO()
    img.save(buf, 'PNG')
    key = hashlib.sha1(buf.getvalue()).hexdigest()[:16]
    cache = GEN / '_cache'
    cache.mkdir(parents=True, exist_ok=True)
    out = cache / f'{tag}-{key}-x2.png'
    if not out.exists():
        if not UPSCAYL.exists():
            print(f'  ! Upscayl не найден — {tag}: только Lanczos')
            return lanczos
        src = cache / f'{tag}-{key}-in.png'
        src.write_bytes(buf.getvalue())
        r = subprocess.run([str(UPSCAYL), '-i', str(src), '-o', str(out), '-s', '2', '-m', str(UPSCAYL_MODELS),
                            '-n', 'ultrasharp', '-f', 'png'], capture_output=True, text=True)
        if r.returncode or not out.exists():
            print(r.stdout[-500:], r.stderr[-500:])
            sys.exit(f'Upscayl упал на {tag}')
        src.unlink()
    us = np.asarray(Image.open(out).convert('RGB')).astype(np.float64)
    if us.shape[:2] != (2 * h, 2 * w):
        us = resize(us, 2 * w, 2 * h)
    return mix * us + (1 - mix) * lanczos


# параметры слоёв: σ края (px исходника), грейд, дымка
LAYER = {
    # bank-front (проход 2): без «цветной капусты». Было: σ края 1.2, blur 0.4, local_contrast 1.35 (σ10),
    # US_MIX 0.5 — мелкие повторяющиеся пупырышки и зубчатый «гребешок» по краю клубов. Стало: guided-сглаживание
    # в два прохода (мелкая фактура уходит полностью, гребешок — наполовину, контуры клубов остаются), локальный
    # контраст мягче и крупнее (×1.2 на σ30: читаются клубы, а не пупырышки), апскейл почти чистый Lanczos
    # (us_mix 0.1), blur 0.7. Сильнее (smooth2 (9, 9, 1), blur 1.0) — на ретине уже «не в фокусе».
    # Сравнение вариантов: shots/v2-front-assets/bank/ (retina-variants.png, ref-scale-grid.png).
    'bank-front': dict(sigma=1.6, ref='bank', keep_hue=0.25, haze=0.0, blur=0.7, depth_shade=0.80,
                       smooth=(3, 10.0, 1.0), smooth2=(9, 6.0, 0.6), local_contrast=1.2, lc_sigma=30, us_mix=0.1),
    'bank-back':  dict(sigma=2.0, ref='bank', keep_hue=0.40, haze=0.38, blur=1.1, contrast=0.70),
    'cloudlets':  dict(sigma=1.0, ref='cloudlets', keep_hue=0.45, haze=0.0, blur=0.8,
                       drop=[(0.34, 0.19, 0.50, 0.40)]),  # cloudlets-a: облачко-«птица» сверху — выглядит как силуэт, убрано
    # россыпь: далеко и в дымке — мягче и ниже по контрасту, чем cloudlets; апскейл почти без ultrasharp
    'cloudlets-sparse-a': dict(sigma=1.2, ref='cloudlets', keep_hue=0.40, haze=0.12, blur=0.9, us_mix=0.2,
                               smooth=(3, 6.0, 0.6)),
    'cloudlets-sparse-b': dict(sigma=1.2, ref='cloudlets', keep_hue=0.40, haze=0.12, blur=0.9, us_mix=0.2,
                               smooth=(3, 6.0, 0.6)),
    # передний план: близко к камере и не в фокусе — дефокус премультиплицированного RGBA, тонкие места
    # полупрозрачны (thin), ядро тоже чуть просвечивает (alpha_max); ultrasharp не нужен (деталей нет)
    'foreground-a': dict(sigma=1.5, ref='cloudlets', keep_hue=0.45, haze=0.0, blur=0.0, us_mix=0.0,
                         smooth=(4, 8.0, 0.8), thin=(0.6, 10), defocus=3.0, alpha_max=0.94, a_blur=1.0,
                         edge_fade=0.10),  # концы полосы растворяются к краям кадра (для сырья foreground-a,
                                           # толстой полосы до краёв, было thin (0.45, 14), defocus 3.5)
    'foreground-b': dict(sigma=1.5, ref='cloudlets', keep_hue=0.45, haze=0.0, blur=0.0, us_mix=0.0,
                         smooth=(4, 8.0, 0.8), thin=(0.45, 14), defocus=3.5, alpha_max=0.94, a_blur=1.0),
}
HAZE_RGB = np.array([126.0, 137.0, 156.0])   # небо референса на высоте ~0.62 (куда тонет дальний банк)
SHADE_RGB = np.array([104.0, 107.0, 120.0])  # тень нижней части банка на референсе (p5–p10)


def make_cloud_layer(kind: str, src: str, upscale=True):
    P = LAYER[kind]
    raw = load(src)
    rgb, a0 = raw[..., :3], raw[..., 3] / 255
    for box in P.get('drop', ()):  # убрать облачка, чей центр в box (доли кадра)
        h, w = a0.shape
        lab, n = ndi.label(a0 > 0.02)
        for i, c in enumerate(ndi.center_of_mass(a0 > 0.02, lab, np.arange(1, n + 1))):
            if box[0] * w <= c[1] <= box[2] * w and box[1] * h <= c[0] <= box[3] * h:
                a0 = np.where(lab == i + 1, 0.0, a0)
    a = refine_alpha(a0, P['sigma'])
    rgb = despeckle(rgb, a0 > 0.9)
    rgb = decontaminate(rgb, a0)
    tq, tc = ref_ramp(*REF_BOXES[P['ref']])
    if P.get('contrast'):  # дальний банк: сжать диапазон к середине
        mid = tq[4]
        tq = mid + (tq - mid) * P['contrast']
    if P.get('mids'):  # притемнить середину тонов (p25–p75), края диапазона не трогать
        g = 1 - (1 - P['mids']) * np.array([0, 0, 0.3, 0.8, 1, 0.8, 0.3, 0, 0, 0])
        tq, tc = tq * g, tc * g[:, None]
    if P['haze']:
        tc = tc * (1 - P['haze']) + HAZE_RGB * P['haze']
        tq = lum(tc)
    rgb = grade(rgb, a0 > 0.9, tq, tc, P['keep_hue'])
    if P.get('smooth'):  # убрать «цветную капусту» (мелкие повторяющиеся пупырышки), контуры клубов оставить
        rgb = guided_smooth(rgb, *P['smooth'])
    if P.get('smooth2'):  # второй, более крупный проход (radius больше): гасит зубчатый «гребешок» по краям клубов
        rgb = guided_smooth(rgb, *P['smooth2'])
    if P.get('local_contrast'):  # глубже тени между клубами, ярче их макушки (как на референсе)
        L = np.maximum(lum(rgb), 1)
        Lb = gblur(L, P.get('lc_sigma', 10))
        rgb = np.clip(rgb * ((Lb + (L - Lb) * P['local_contrast']) / L)[..., None], 0, 255)
    if P.get('depth_shade'):  # тело банка ниже освещённых верхушек — в тени (серее, темнее), как на референсе
        h = a.shape[0]
        top = np.argmax(a > 0.5, axis=0).astype(float)
        top[~(a > 0.5).any(0)] = h
        top = ndi.gaussian_filter1d(ndi.minimum_filter1d(top, 41), 25)  # огибающая горизонта банка
        depth = (np.arange(h)[:, None] - top[None, :]) / h
        t = smoothstep(0.02, 0.22, depth) * P['depth_shade']
        t = (t * (1 - 0.85 * smoothstep(140, 195, lum(rgb))))[..., None]  # освещённые верхушки нижних ярусов не гасим
        L = lum(rgb)
        detail = (L / np.maximum(gblur(L, 8), 1)) ** 1.3  # локальный рельеф клубов сохраняем
        rgb = rgb * (1 - t) + (SHADE_RGB * detail[..., None]) * t  # тянем к тени референса
    if P['blur']:
        rgb = gblur(rgb, P['blur'])
    if P.get('thin'):  # полупрозрачность: тонкие места (мало «толщины» вокруг) пропускают небо и надпись
        lo, s = P['thin']  # lo — непрозрачность самых тонких мест, s — радиус оценки толщины, px исходника
        thick = smoothstep(0.15, 0.85, gblur(a, s))
        a = a * (lo + (1 - lo) * thick)
    if P.get('defocus'):  # «не в фокусе» (малая ГРИП): размытие премультиплицированного RGBA, край мягкий
        s = P['defocus']
        ab = gblur(a, s)
        rgbp = gblur(rgb * a[..., None], s)
        solid = ab > 0.02
        rgb = np.where(solid[..., None], rgbp / np.maximum(ab, 1e-6)[..., None], rgb)
        rgb = decontaminate(np.clip(rgb, 0, 255), np.where(solid, 1.0, 0.0), solid=0.5)
        a = ab
    if P.get('alpha_max'):  # потолок непрозрачности: даже ядро облака слегка просвечивает
        a = a * P['alpha_max']
    if P.get('edge_fade'):  # полоса до краёв кадра: концы растворяются на этой доле ширины (обреза не видно)
        w = a.shape[1]
        x = (np.arange(w) + 0.5) / w
        a = a * (smoothstep(0, P['edge_fade'], x) * smoothstep(0, P['edge_fade'], 1 - x))[None, :]
    if upscale:
        h, w = a.shape
        rgb = upscayl2x(rgb, kind, P.get('us_mix', US_MIX))
        a = np.clip(resize(a, 2 * w, 2 * h), 0, 1)
        a = gblur(a, P.get('a_blur', 0.6))
    a[a < 1 / 255] = 0
    return rgb, a


# ------------------------------------------------------------------------------------------------ moon
def make_moon(src: str):
    raw = load(src)
    rgb, a0 = raw[..., :3], raw[..., 3] / 255
    H, W = a0.shape
    b = a0 > 0.5
    ys, xs = np.where(b)
    term_x = np.percentile(xs, 0.5)  # прямой терминатор
    # центр/радиус: окружность по правому лимбу (крайние справа пиксели каждой строки)
    rows = np.unique(ys)
    rx = np.array([xs[ys == r].max() for r in rows], float)
    keep = rx > term_x + 0.25 * (rx.max() - term_x)
    yy, xx = rows[keep].astype(float), rx[keep]
    A = np.c_[2 * xx, 2 * yy, np.ones_like(xx)]
    cx, cy, c = np.linalg.lstsq(A, xx ** 2 + yy ** 2, rcond=None)[0]
    R = np.sqrt(c + cx ** 2 + cy ** 2)
    cx = 0.5 * (cx + term_x)  # у первой четверти терминатор проходит через центр диска
    print(f'  луна {src}: центр ({cx:.0f},{cy:.0f}) R={R:.0f} терминатор x={term_x:.0f}')
    rgb = decontaminate(rgb, a0)
    # кроп: квадрат вокруг диска, диаметр = MOON_DISC_FRAC стороны
    side = 2 * R / MOON_DISC_FRAC
    box = (cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2)
    S = MOON_SIZE * 2  # работаем ×2, потом вниз
    img = to_img(rgb).transform((S, S), Image.EXTENT, box, Image.BICUBIC)
    rgb = np.asarray(img).astype(np.float64)
    g = (np.arange(S) + 0.5) / S
    X, Y = np.meshgrid(g, g)
    r = np.hypot(X - 0.5, Y - 0.5) / (MOON_DISC_FRAC / 2)  # 1 = лимб
    dx = (X - 0.5) / (MOON_DISC_FRAC / 2)                   # 0 = терминатор, 1 = правый край
    disc = 1 - smoothstep(0.975, 1.02, r)                   # мягкий лимб (дымка)
    term = smoothstep(-0.03, 0.12, dx)                      # мягкий терминатор
    # грейд: тёплый крем референса, моря приглушены
    L = np.maximum(lum(rgb), 1)
    lit = (disc > 0.9) & (term > 0.9)
    q50 = np.percentile(L[lit], 50)
    Ln = q50 + 0.38 * (L - q50)                      # моря едва видны
    Ln = Ln * (200.0 / q50)                          # средняя яркость → 200 (референс ~196 по диску)
    shade = 0.90 + 0.10 * smoothstep(0.0, 0.40, dx)  # у терминатора чуть темнее
    Ln = Ln * shade
    cream = np.array([235.0, 216.0, 201.0]) / lum(np.array([235.0, 216.0, 201.0]))
    rgb = np.clip(cream * Ln[..., None] * 0.85 + rgb * (Ln / L)[..., None] * 0.15, 0, 255)
    rgb = gblur(rgb, 1.6)  # дымка
    # днём луна «полупрозрачна»: тёмные участки пропускают небо сильнее
    t = np.clip((Ln - 150) / 80, 0, 1)
    a = disc * term * (0.80 + 0.20 * t)
    glow = 0.10 * np.exp(-np.maximum(r - 1, 0) / 0.05) * (r > 0.98) * smoothstep(0.0, 0.4, dx)  # дымка у лимба
    a = np.maximum(a, glow)
    a = gblur(a, 1.2)
    img = to_img(rgb, a).resize((MOON_SIZE, MOON_SIZE), Image.LANCZOS)
    arr = np.asarray(img).astype(np.float64)
    rgb, a = arr[..., :3], arr[..., 3] / 255
    rgb = decontaminate(rgb, a, solid=0.6)
    a[a < 1 / 255] = 0
    return rgb, a


# --------------------------------------------------------------------------------------------- preview
def _over(dst: np.ndarray, rgb: np.ndarray, a: np.ndarray, x: int, y: int):
    h, w = a.shape
    H, W, _ = dst.shape
    x0, y0, x1, y1 = max(x, 0), max(y, 0), min(x + w, W), min(y + h, H)
    if x1 <= x0 or y1 <= y0:
        return
    sa = a[y0 - y:y1 - y, x0 - x:x1 - x, None]
    dst[y0:y1, x0:x1] = rgb[y0 - y:y1 - y, x0 - x:x1 - x] * sa + dst[y0:y1, x0:x1] * (1 - sa)


def _read(name: str):
    arr = np.asarray(Image.open(OUT / f'{name}.webp').convert('RGBA')).astype(np.float64)
    return arr[..., :3], arr[..., 3] / 255


def _place(frame: np.ndarray, name: str, L: dict):
    rgb, a = _read(name)
    W = frame.shape[1]
    w = round(L['width'] * W)
    h = round(a.shape[0] * w / a.shape[1])
    rgb, a = resize(rgb, w, h), np.clip(resize(a, w, h), 0, 1) * L.get('opacity', 1)
    _over(frame, rgb, a, round(L['x'] * W - L['anchor'][0] * w), round(L['y'] * frame.shape[0] - L['anchor'][1] * h))


def composite(W=1384, H=914, grain=True, front=False) -> np.ndarray:
    """Превью слоёв в кадре референса. front=True — плюс слои прохода 2 (PREVIEW_FRONT): россыпь за валами,
    ближние облака поверх (надписи в этом превью нет — она в рендерере, см. shots/v2-front-assets/)."""
    sky, _ = _read('sky-wide')
    sh, sw = sky.shape[:2]
    s = max(W / sw, H / sh)
    sky = resize(sky, round(sw * s), round(sh * s))
    oy = (sky.shape[0] - H) // 2
    ox = (sky.shape[1] - W) // 2
    frame = sky[oy:oy + H, ox:ox + W].copy()
    # луна
    m = PREVIEW_LAYOUT['moon']
    rgb, a = _read('moon')
    side = round(m['disc'] * W / MOON_DISC_FRAC)
    rgb, a = resize(rgb, side, side), np.clip(resize(a, side, side), 0, 1)
    _over(frame, rgb, a, round(m['cx'] * W - side / 2), round(m['cy'] * H - side / 2))
    # облачка
    c = PREVIEW_LAYOUT['cloudlets']
    rgb, a = _read('cloudlets')
    w = round(c['width'] * W)
    h = round(a.shape[0] * w / a.shape[1])
    rgb, a = resize(rgb, w, h), np.clip(resize(a, w, h), 0, 1)
    rows = np.where(a.max(1) > 0.5)[0]
    _over(frame, rgb, a, round(c['x'] * W), round(c['centre_y'] * H - (rows.min() + rows.max()) / 2))
    if front:
        _place(frame, 'cloudlets-sparse-b', PREVIEW_FRONT['cloudlets-sparse-b'])
    # банки
    for name in ('bank-back', 'bank-front'):
        L = PREVIEW_LAYOUT[name]
        rgb, a = _read(name)
        w = round(L['width'] * W)
        h = round(a.shape[0] * w / a.shape[1])
        rgb, a = resize(rgb, w, h), np.clip(resize(a, w, h), 0, 1)
        top = np.argmax(a > 0.5, axis=0)
        x = round(L['x'] * W)
        vis = top[max(0, -x):max(0, -x) + W]
        if 'peak' in L:
            y = round(L['peak'] * H - vis.min())
        else:
            y = round(L['skyline'] * H - np.median(vis))
        y = max(y, H - h)  # низ слоя не выше низа кадра
        _over(frame, rgb, a, x, y)
    if front:
        _place(frame, 'foreground-a', PREVIEW_FRONT['foreground-a'])
    if grain:  # плёночное зерно референса (high-pass σ3 ≈ 1.6–1.7) — в рантайме его даёт рендерер
        n = gblur(np.random.default_rng(7).normal(0, 1, (H, W, 1)), 1.0)
        frame += n / n.std() * 1.85 + gblur(np.random.default_rng(8).normal(0, 1, frame.shape), 0.8) * 0.6
    return np.clip(frame, 0, 255)


def region_stats(img: np.ndarray) -> dict:
    H, W, _ = img.shape
    ex = _ref_exclusions(W, H)

    def med(x0, y0, x1, y1):
        sl = (slice(int(y0 * H), int(y1 * H)), slice(int(x0 * W), int(x1 * W)))
        p = img[sl][~ex[sl]]
        return np.median(p, 0).round().astype(int).tolist()

    out = {
        'sky top (x .15–.65, y 0–.05)': med(0.15, 0.0, 0.65, 0.05),
        'sky upper (x .3–.6, y .1–.15)': med(0.3, 0.10, 0.6, 0.15),
        'sky mid-right (x .65–.8, y .15–.2)': med(0.65, 0.15, 0.80, 0.20),
        'sky right (x .9–1, y .3–.35)': med(0.90, 0.30, 1.0, 0.35),
    }
    Lr = lum(img)
    box = (slice(int(0.75 * H), H), slice(int(0.28 * W), W))
    m = ~ex[box]
    Lb, Cb = Lr[box][m], img[box][m]
    for p in (10, 50, 90):
        q = np.percentile(Lb, p)
        out[f'bank p{p} (x .28–1, y .75–1)'] = Cb[np.abs(Lb - q) < 2.5].mean(0).round().astype(int).tolist()
    box = (slice(int(0.25 * H), int(0.5 * H)), slice(int(0.6 * W), W))
    R, G, B = img[..., 0][box], img[..., 1][box], img[..., 2][box]
    m = ~((B - R > 22) & (B > G)) & ~ex[box]
    if m.sum() > 50:
        Lc, Cc = Lr[box][m], img[box][m]
        for p in (50, 95):
            q = np.percentile(Lc, p)
            out[f'cloudlets p{p} (x .6–1, y .25–.5)'] = Cc[np.abs(Lc - q) < 2.5].mean(0).round().astype(int).tolist()
    mo = img[int(0.20 * H):int(0.33 * H), int(0.82 * W):int(0.89 * W)]
    Lm = lum(mo)
    out['moon lit mean (L>170)'] = mo[Lm > 170].mean(0).round().astype(int).tolist() if (Lm > 170).any() else None
    return out


def preview():
    SHOTS.mkdir(parents=True, exist_ok=True)
    ref = _ref()
    comp = composite()
    H, W, _ = ref.shape
    gap = 12
    side = np.full((H, 2 * W + gap, 3), 24.0)
    side[:, :W] = ref
    side[:, W + gap:] = comp
    to_img(side).save(SHOTS / 'compare-ref-vs-layers.png')
    to_img(comp).save(SHOTS / 'composite-1384x914.png')
    if all((OUT / f'{n}.webp').exists() for n in PREVIEW_FRONT):
        front = composite(front=True)
        side[:, W + gap:] = front
        to_img(side).save(SHOTS / 'compare-ref-vs-front.png')
        side[:, W + gap:] = comp
    # крупно: луна и край банка
    crops = [((1120, 180, 1280, 320), 3), ((420, 520, 780, 760), 2)]
    tiles = []
    for (x0, y0, x1, y1), k in crops:
        for src in (ref, comp):
            t = to_img(src[y0:y1, x0:x1]).resize(((x1 - x0) * k, (y1 - y0) * k), Image.NEAREST)
            tiles.append(t)
    tw = max(t.size[0] for t in tiles) * 2 + gap
    th = sum(max(tiles[i].size[1], tiles[i + 1].size[1]) for i in (0, 2)) + gap
    sheet = Image.new('RGB', (tw, th), (24, 24, 24))
    y = 0
    for i in (0, 2):
        sheet.paste(tiles[i], (0, y))
        sheet.paste(tiles[i + 1], (tiles[i].size[0] + gap, y))
        y += max(tiles[i].size[1], tiles[i + 1].size[1]) + gap
    sheet.save(SHOTS / 'zoom-ref-vs-layers.png')
    # лист слоёв: шахматка и небо
    names = [n for n in RGBA_LAYERS if (OUT / f'{n}.webp').exists()]
    cells = []
    for n in names:
        rgb, a = _read(n)
        h, w = a.shape
        tw_ = 640
        th_ = round(h * tw_ / w)
        rgb, a = resize(rgb, tw_, th_), np.clip(resize(a, tw_, th_), 0, 1)
        yy, xx = np.mgrid[0:th_, 0:tw_]
        chk = np.where(((yy // 16 + xx // 16) % 2)[..., None] == 0, 200.0, 150.0) * np.ones(3)
        sky = sky_field(tw_, th_)
        cells.append(np.hstack([rgb * a[..., None] + chk * (1 - a[..., None]), np.full((th_, 8, 3), 24.0),
                                rgb * a[..., None] + sky * (1 - a[..., None])]))
    wmax = max(c.shape[1] for c in cells)
    sheet = np.vstack([np.pad(c, ((0, 8), (0, wmax - c.shape[1]), (0, 0)), constant_values=24) for c in cells])
    to_img(sheet).save(SHOTS / 'layers-sheet.png')
    # плашки неба: wide и tall рядом с референсом
    wide = np.asarray(Image.open(OUT / 'sky-wide.webp').convert('RGB')).astype(np.float64)
    tall = np.asarray(Image.open(OUT / 'sky-tall.webp').convert('RGB')).astype(np.float64)
    hh = 600
    parts = [resize(ref, round(W * hh / H), hh), resize(wide, round(wide.shape[1] * hh / wide.shape[0]), hh),
             resize(tall, round(tall.shape[1] * hh / tall.shape[0]), hh)]
    plates = np.hstack(sum([[p_, np.full((hh, gap, 3), 24.0)] for p_ in parts], [])[:-1])
    to_img(plates).save(SHOTS / 'sky-plates.png')
    # цифры
    rs, cs = region_stats(ref), region_stats(comp)
    lines = []
    for k in rs:
        r, c = rs[k], cs[k]
        d = None if (r is None or c is None) else float(np.sqrt(np.mean((np.array(r) - np.array(c)) ** 2)))
        lines.append({'region': k, 'reference': r, 'layers': c, 'rmse': None if d is None else round(d, 1)})
    sizes = {p.name: p.stat().st_size for p in sorted(OUT.glob('*.webp'))}
    dims = {p.name: list(Image.open(p).size) + [Image.open(p).mode] for p in sorted(OUT.glob('*.webp'))}
    geom = {}
    for n in [n for n in RGBA_LAYERS if (OUT / f'{n}.webp').exists()]:
        a8 = np.asarray(Image.open(OUT / f'{n}.webp'))[..., 3]
        a = a8 > 127
        h, w = a.shape
        ys, xs = np.where(a)
        top = np.argmax(a, axis=0)[a.any(0)] / h
        vy, vx = np.where(a8 > 8)  # видимая часть (альфа > 3 %) — у полупрозрачных слоёв шире, чем bbox по 0.5
        geom[n] = {'bbox_frac': [round(xs.min() / w, 3), round(ys.min() / h, 3), round((xs.max() + 1) / w, 3), round((ys.max() + 1) / h, 3)],
                   'bbox_visible_frac': [round(vx.min() / w, 3), round(vy.min() / h, 3), round((vx.max() + 1) / w, 3), round((vy.max() + 1) / h, 3)],
                   'coverage_a50': round(float(a.mean()), 3),
                   'skyline_min_med_max': [round(float(top.min()), 3), round(float(np.median(top)), 3), round(float(top.max()), 3)]}
    report = {'colour_match': lines, 'sizes_bytes': sizes, 'dims': dims, 'pick': PICK, 'geometry': geom,
              'moon': {'disc_centre': [0.5, 0.5], 'disc_diameter_frac': MOON_DISC_FRAC, 'lit': 'right half (x 0.5–0.95)'}}
    (SHOTS / 'report.json').write_text(json.dumps(report, indent=1, ensure_ascii=False))
    for l in lines:
        print(f"  {l['region']:<36} ref {l['reference']}  layers {l['layers']}  rmse {l['rmse']}")
    for n, s in sizes.items():
        print(f'  {n:<16} {dims[n]}  {s / 1024:.0f} KB')


# ------------------------------------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pick', action='append', default=[], help='слой=сырьё, напр. bank-front=bank-front-a')
    ap.add_argument('--only', action='append', default=[], help='обработать только эти слои')
    ap.add_argument('--no-upscale', action='store_true')
    ap.add_argument('--preview-only', action='store_true')
    ap.add_argument('--out', help='писать webp сюда (для сравнения вариантов), по умолчанию public/assets/sky-layers')
    ap.add_argument('--shots', help='куда класть превью, по умолчанию shots/v2-layers-assets')
    args = ap.parse_args()
    global OUT, SHOTS
    if args.out:
        OUT = Path(args.out).resolve()
    if args.shots:
        SHOTS = Path(args.shots).resolve()
    for p in args.pick:
        k, v = p.split('=')
        PICK[k] = v
    OUT.mkdir(parents=True, exist_ok=True)
    if not args.preview_only:
        todo = args.only or list(PICK)
        for layer in todo:
            src = PICK[layer]
            print(f'{layer} ← {src}')
            if layer == 'sky-wide':
                img = to_img(make_sky(src, 0.0, 1.0))
            elif layer == 'sky-tall':
                img = to_img(make_sky(src, 0.25, 0.95))
            elif layer == 'moon':
                img = to_img(*make_moon(src))
            else:
                img = to_img(*make_cloud_layer(layer, src, upscale=not args.no_upscale))
            n, q = save_webp(img, OUT / f'{layer}.webp')
            print(f'  → {layer}.webp {img.size} {img.mode} {n / 1024:.0f} KB (q{q})')
    preview()


if __name__ == '__main__':
    main()
