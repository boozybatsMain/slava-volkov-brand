#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
process.py — фотографии экрана ABOUT из сырья Codex.

Вход:   $GEN_DIR/<name>/<name>.png (по умолчанию ./.gen-work; см. generate.sh и README.md)
Выход:  public/assets/about/<name>.webp — RGB, длинная сторона ≤ 1280 px, ≤ 220 KB
Превью: shots/v4-about/assets/sheet.png — контакт-лист всех обработанных картинок с цифрами

Запуск из корня проекта:
    python3 src/layers/about/tools/process.py
    python3 src/layers/about/tools/process.py --only about-place --out /tmp/x --shots /tmp/x/s

Что делает: (необязательно) вырезает окно из сырья, уменьшает так, чтобы длинная сторона была не больше
1280 px (LANCZOS, без апскейла), и сохраняет WebP `method=6` от q 86 вниз по 3 (не ниже 70), пока файл
больше 220 KB; если не влезает и на q 70 — длинная сторона уменьшается шагами по 64 px (так вышло только
у мелкой листвы about-canopy). Без резкости, без грейда, без зерна: шейдер экрана сам обесцвечивает, квантует и рвёт
картинку. Каждое окно на экране вырезает свой кусок (`crop` в конфиге), поэтому здесь кадр не кадрируется
под окна — только убирается то, что в сырье явно лишнее (CROP). Всё детерминировано.
"""
from __future__ import annotations

import argparse
import io
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[4]
GEN = Path(os.environ.get('GEN_DIR', ROOT / '.gen-work'))
OUT = ROOT / 'public' / 'assets' / 'about'
SHOTS = ROOT / 'shots' / 'v4-about' / 'assets'

LONG = 1280            # длинная сторона финала не больше, px (меньше — не увеличивается)
WEBP_Q = 86            # стартовое качество WebP
Q_MIN = 70             # ниже не опускаться: 86, 83 … 71, 70
MAX_BYTES = 220_000    # если файл больше — качество понижается шагами по 3
LONG_STEP = 64         # если и на Q_MIN файл больше MAX_BYTES — длинная сторона уменьшается шагами по 64 px
LONG_MIN = 768         # …но не меньше (мелкая листва вроде about-canopy иначе не влезает в 220 KB)

# Ожидаемый размер сырья (как заказан в generate.sh). Другой размер — ошибка: значит, сырьё не то.
RAW = {
    'about-clouds-a': (1536, 1024),
    'about-clouds-b': (1536, 1024),
    'about-leaves-a': (1024, 1024),
    'about-leaves-b': (1024, 1536),
    'about-chameleon': (1024, 1024),
    'about-place': (1024, 1536),
    'about-canopy': (1536, 1024),
    'about-cirrus': (1536, 1024),
    'about-succulent': (1024, 1024),
}
NAMES = list(RAW)

# Окно в сырье, px (x0, y0, x1, y1), — только если в сырье есть что убрать. Нет ключа — кадр целиком.
# Меняется сырьё — пересмотреть.
CROP: dict[str, tuple[int, int, int, int]] = {}


def encode_webp(img: Image.Image) -> tuple[bytes, int]:
    """WebP method 6: q 86, 83 … 71, 70 — первое качество, при котором файл ≤ MAX_BYTES (или Q_MIN)."""
    q = WEBP_Q
    while True:
        buf = io.BytesIO()
        img.save(buf, 'WEBP', quality=q, method=6)
        if len(buf.getvalue()) <= MAX_BYTES or q <= Q_MIN:
            return buf.getvalue(), q
        q = max(q - 3, Q_MIN)


def load(name: str) -> Image.Image:
    p = GEN / name / f'{name}.png'
    if not p.exists():
        sys.exit(f'нет сырья: {p} (см. generate.sh)')
    im = Image.open(p).convert('RGB')
    if im.size != RAW[name]:
        sys.exit(f'{p}: ожидалось {RAW[name][0]}×{RAW[name][1]}, а не {im.size}')
    return im.crop(CROP[name]) if name in CROP else im


def fit(im: Image.Image, long: int) -> Image.Image:
    """Длинная сторона ≤ long: LANCZOS, без апскейла и без резкости."""
    w, h = im.size
    k = long / max(w, h)
    return im.resize((round(w * k), round(h * k)), Image.LANCZOS) if k < 1 else im


def make(name: str, path: Path) -> tuple[Image.Image, int, int]:
    """Сырьё → WebP ≤ MAX_BYTES. Сначала понижается качество (до Q_MIN), потом — размер (шагами LONG_STEP)."""
    raw = load(name)
    long = LONG
    while True:
        img = fit(raw, long)
        data, q = encode_webp(img)
        if len(data) <= MAX_BYTES or long - LONG_STEP < LONG_MIN:
            break
        long -= LONG_STEP
    if len(data) > MAX_BYTES:
        print(f'  ! {name}: {len(data)} B > {MAX_BYTES} даже на {img.size} q{q}')
    path.write_bytes(data)
    return img, len(data), q


def stats(im: Image.Image) -> dict:
    """Средняя яркость (Rec. 709 по 8-битным sRGB-значениям, 0…255), её p2 / p50 / p98, средний цвет и
    насыщенность (max − min канала, медиана) — чтобы подбирать grade окон, не открывая картинку."""
    a = np.asarray(im).astype(np.float64)
    y = a @ np.array([0.2126, 0.7152, 0.0722])
    sat = a.max(axis=2) - a.min(axis=2)
    return {
        'luma_mean': round(float(y.mean()), 1),
        'luma_p2_p50_p98': [round(float(v)) for v in np.percentile(y, [2, 50, 98])],
        'mean_rgb': [round(float(v)) for v in a.reshape(-1, 3).mean(axis=0)],
        'sat_p50': round(float(np.median(sat))),
    }


# --------------------------------------------------------------------------------------------- превью
def sheet(rows: list[tuple[str, Image.Image, str]], cols=4, cell=(480, 320), gap=12, label_h=40,
          bg=(16, 16, 16)) -> Image.Image:
    """Контакт-лист: каждая картинка вписана в ячейку целиком, под ней имя и цифры."""
    cw, ch = cell
    n = len(rows)
    r = (n + cols - 1) // cols
    sh = Image.new('RGB', (cols * cw + (cols + 1) * gap, r * (ch + label_h) + (r + 1) * gap), bg)
    d = ImageDraw.Draw(sh)
    font = ImageFont.load_default()
    for i, (name, im, info) in enumerate(rows):
        x = gap + (i % cols) * (cw + gap)
        y = gap + (i // cols) * (ch + label_h + gap)
        k = min(cw / im.size[0], ch / im.size[1])
        t = im.resize((round(im.size[0] * k), round(im.size[1] * k)), Image.LANCZOS)
        sh.paste(t, (x + (cw - t.size[0]) // 2, y + (ch - t.size[1]) // 2))
        d.text((x, y + ch + 4), name, fill=(235, 235, 235), font=font)
        d.text((x, y + ch + 20), info, fill=(150, 150, 150), font=font)
    return sh


# ------------------------------------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', action='append', default=[], help='обработать только эти картинки')
    ap.add_argument('--out', help='писать webp сюда, по умолчанию public/assets/about')
    ap.add_argument('--shots', help='куда класть контакт-лист, по умолчанию shots/v4-about/assets')
    args = ap.parse_args()
    global OUT, SHOTS
    if args.out:
        OUT = Path(args.out).resolve()
    if args.shots:
        SHOTS = Path(args.shots).resolve()
    for n in args.only:
        if n not in RAW:
            sys.exit(f'неизвестная картинка: {n} (есть: {", ".join(NAMES)})')
    OUT.mkdir(parents=True, exist_ok=True)
    for name in args.only or NAMES:
        img, n, q = make(name, OUT / f'{name}.webp')
        s = stats(Image.open(OUT / f'{name}.webp').convert('RGB'))  # цифры — по тому, что получит экран
        crop = f'  окно {CROP[name]}' if name in CROP else ''
        print(f"{name} → {name}.webp {img.size[0]}×{img.size[1]} {img.mode} {n / 1024:.0f} KB (q{q}){crop}"
              f"  яркость {s['luma_mean']} (p2/p50/p98 {s['luma_p2_p50_p98']}), цвет {s['mean_rgb']},"
              f" насыщенность p50 {s['sat_p50']}")
    # контакт-лист — по всем готовым файлам в OUT (в том числе не пересчитанным в этом прогоне)
    rows = []
    for name in NAMES:
        p = OUT / f'{name}.webp'
        if not p.exists():
            continue
        im = Image.open(p).convert('RGB')
        s = stats(im)
        rows.append((name, im, f"{im.size[0]}x{im.size[1]}  {p.stat().st_size / 1024:.0f} KB  luma {s['luma_mean']}"))
    if rows:
        SHOTS.mkdir(parents=True, exist_ok=True)
        sheet(rows).save(SHOTS / 'sheet.png')
        print(f'контакт-лист: {SHOTS / "sheet.png"}')


if __name__ == '__main__':
    main()
