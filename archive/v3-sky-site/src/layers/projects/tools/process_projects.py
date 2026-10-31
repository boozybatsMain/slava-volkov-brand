#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
process_projects.py — картинки проектов для экрана на втором экране из сырья Codex.

Вход:   $GEN_DIR/<name>/<name>.png, 1536×1024 (по умолчанию ./.gen-work; см. generate.sh и README.md)
Выход:  public/assets/projects/<name>.webp — 1536×864 (16:9) RGB, ≤ 250 KB
Превью: shots/v3-projects/assets/ — projects-sheet.png (кадры с рамками грани экрана),
        projects-lowres.png (как картинка читается в «плохом рендере» плиты), report-projects.json

Запуск из корня проекта:
    python3 src/layers/projects/tools/process_projects.py
    python3 src/layers/projects/tools/process_projects.py --only wildlife --out /tmp/x --shots /tmp/x/s

Что делает: только вырезает окно 16:9 из сырья 3:2 и сохраняет WebP. Без резкости, без апскейла, без
грейда: экран сам огрубляет картинку (низкое разрешение, 5 бит на канал). Окно по умолчанию — середина
сырья (0, 80, 1536, 944). Плита показывает не весь кадр, а грань 1.9:1 (sky.config → projects.slab.aspect,
обрезка вокруг focus), поэтому окно сдвигается по вертикали там, где иначе элемент HUD оказался бы
вплотную к краю грани (см. HUD и crop_y). Всё детерминировано.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[4]
GEN = Path(os.environ.get('GEN_DIR', ROOT / '.gen-work'))
OUT = ROOT / 'public' / 'assets' / 'projects'
SHOTS = ROOT / 'shots' / 'v3-projects' / 'assets'

SIZE = (1536, 864)     # финальный кадр 16:9 (ширина сырья — без масштабирования)
CROP_Y = 80            # верх окна по умолчанию: (0, 80, 1536, 944) — середина сырья 1536×1024
WEBP_Q = 86            # стартовое качество WebP
Q_MIN = 70
MAX_BYTES = 250_000    # если файл больше — качество понижается шагами по 3
FACE = 1.9             # пропорции грани экрана на десктопе (projects.slab.aspect)
FACE_MOBILE = 1.45     # …и на телефоне (mobile.projects.slab.aspect): там кадр обрезается по бокам
MARGIN = 0.05          # желаемый отступ HUD от края грани, доля её высоты (на референсе ≈ 0.055)

# Элементы HUD в сырье, px (x0, y0, x1, y1) — замерены по увеличенным кропам. Меняется сырьё — перемерить.
HUD = {
    'take-the-elevator': {'hearts': (189, 167, 345, 211), 'minimap': (1293, 384, 1446, 535)},
    'midnight-apex': {'lap 2/3': (190, 118, 300, 152), 'track': (1220, 113, 1392, 264), 'speed 217': (1196, 784, 1416, 892)},
    'snowball': {'score 148': (138, 151, 314, 226), 'ranking': (1292, 159, 1414, 269)},
    'wildlife': {'day dial': (143, 113, 255, 231), 'counters': (1009, 139, 1408, 187), 'thought bubble': (719, 393, 766, 449)},
    'wildfire': {'fuel bar': (153, 819, 379, 873), 'minimap': (1303, 121, 1470, 289)},
}
NAMES = list(HUD)


def crop_y(name: str) -> int:
    """Верх окна 16:9 в сырье.

    Грань 1.9:1 при focus.y 0.5 показывает строки окна 28…836 из 864. Окно остаётся серединой сырья (80),
    если весь HUD при этом не ближе MARGIN к верху и низу грани; иначе сдвигается на ближайшее подходящее
    место, а если HUD выше, чем грань минус отступы, — встаёт так, чтобы отступы сверху и снизу были равны.
    """
    w, h = SIZE
    face_h = w / FACE
    pad = (h - face_h) / 2
    m = MARGIN * face_h
    top = min(b[1] for b in HUD[name].values())
    bot = max(b[3] for b in HUD[name].values())
    lo, hi = bot + m - pad - face_h, top - m - pad  # допустимый диапазон верха окна
    y0 = min(max(CROP_Y, lo), hi) if lo <= hi else (lo + hi) / 2
    return int(min(max(round(y0), 0), 1024 - h))


def save_webp(img: Image.Image, path: Path) -> tuple[int, int]:
    q = WEBP_Q
    while True:
        buf = io.BytesIO()
        img.save(buf, 'WEBP', quality=q, method=6)
        if len(buf.getvalue()) <= MAX_BYTES or q <= Q_MIN:
            break
        q -= 3
    path.write_bytes(buf.getvalue())
    return len(buf.getvalue()), q


def make(name: str) -> tuple[Image.Image, int]:
    p = GEN / name / f'{name}.png'
    if not p.exists():
        sys.exit(f'нет сырья: {p} (см. generate.sh)')
    im = Image.open(p).convert('RGB')
    if im.size != (1536, 1024):
        sys.exit(f'{p}: ожидалось 1536×1024, а не {im.size}')
    y0 = crop_y(name)
    return im.crop((0, y0, SIZE[0], y0 + SIZE[1])), y0


# --------------------------------------------------------------------------------------------- цифры
def hud_report(name: str, y0: int) -> dict:
    """HUD в долях финального кадра (u, v) и запасы до края грани: десктоп 1.9:1 и телефон 1.45:1."""
    w, h = SIZE
    face_h = w / FACE
    pad = (h - face_h) / 2
    mob_w = h * FACE_MOBILE
    side = (w - mob_w) / 2  # столько срезается с каждого бока на телефоне при focus.x 0.5
    out = {'crop': [0, y0, w, y0 + h], 'shifted_px': y0 - CROP_Y, 'elements': {}}
    xs0, xs1 = [], []
    for k, (x0, ya, x1, yb) in HUD[name].items():
        a, b = ya - y0, yb - y0
        out['elements'][k] = {
            'uv': [round(x0 / w, 3), round(a / h, 3), round(x1 / w, 3), round(b / h, 3)],
            'face_1.9_margin_px': [round(a - pad), round(pad + face_h - b)],            # сверху, снизу
            'face_1.45_margin_px': [round(x0 - side), round(w - side - x1)],            # слева, справа
        }
        xs0.append(x0)
        xs1.append(x1)
    tops = [e['face_1.9_margin_px'][0] for e in out['elements'].values()]
    bots = [e['face_1.9_margin_px'][1] for e in out['elements'].values()]
    out['face_1.9_margin_px'] = [min(tops), min(bots)]
    out['face_1.9_margin_frac'] = [round(min(tops) / face_h, 3), round(min(bots) / face_h, 3)]
    # самая узкая грань, в которую весь HUD входит с отступом MARGIN с боков (кадр по центру HUD)
    out['min_aspect_all_hud'] = round((max(xs1) - min(xs0) + 2 * MARGIN * h) / h, 2)
    # где центр HUD по горизонтали: доля кадра и то же как «выравнивание» 0…1 (0 — кадр прижат влево) —
    # для focus.x на телефоне, смотря как его понимает слой
    out['hud_centre_u'] = round((min(xs0) + max(xs1)) / 2 / w, 3)
    out['focus_x_centred_hud'] = round(((min(xs0) + max(xs1)) / 2 - mob_w / 2) / (w - mob_w), 2)
    return out


# --------------------------------------------------------------------------------------------- превью
BAYER = np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]) / 16 - 0.5


def lowres(im: Image.Image, width=540, bits=5, dither=0.6) -> Image.Image:
    """Грубая прикидка «плохого рендера» плиты: грань 1.9:1, ширина рендера, 5 бит с дизером Байера."""
    w, h = im.size
    fh = round(w / FACE)
    im = im.crop((0, (h - fh) // 2, w, (h - fh) // 2 + fh)).resize((width, round(width / FACE)), Image.BOX)
    a = np.asarray(im).astype(np.float64) / 255
    n = (1 << bits) - 1
    yy, xx = np.mgrid[0:a.shape[0], 0:a.shape[1]]
    a = np.round(a * n + BAYER[yy % 4, xx % 4][..., None] * dither) / n
    return Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8)).resize((width * 2, round(width / FACE) * 2), Image.NEAREST)


def _sheet(tiles: list[Image.Image], cols: int, gap=8, bg=(24, 24, 24)) -> Image.Image:
    tw, th = max(t.size[0] for t in tiles), max(t.size[1] for t in tiles)
    rows = (len(tiles) + cols - 1) // cols
    sh = Image.new('RGB', (cols * tw + (cols - 1) * gap, rows * th + (rows - 1) * gap), bg)
    for i, t in enumerate(tiles):
        sh.paste(t, ((i % cols) * (tw + gap), (i // cols) * (th + gap)))
    return sh


def preview(report: dict):
    SHOTS.mkdir(parents=True, exist_ok=True)
    w, h = SIZE
    frames, low = [], []
    for name in NAMES:
        p = OUT / f'{name}.webp'
        if not p.exists():
            continue
        im = Image.open(p).convert('RGB')
        low.append(lowres(im))
        d = ImageDraw.Draw(im)
        fh = w / FACE
        d.rectangle((1, (h - fh) / 2, w - 2, (h + fh) / 2), outline=(0, 255, 255), width=2)        # грань 1.9:1
        mw = h * FACE_MOBILE
        d.rectangle(((w - mw) / 2, 1, (w + mw) / 2, h - 2), outline=(255, 0, 255), width=2)        # грань 1.45:1
        y0 = report[name]['hud']['crop'][1]
        for x0, ya, x1, yb in HUD[name].values():
            d.rectangle((x0 - 3, ya - y0 - 3, x1 + 3, yb - y0 + 3), outline=(255, 255, 0), width=1)  # HUD
        frames.append(im.resize((w // 2, h // 2), Image.LANCZOS))
    if frames:
        _sheet(frames, 2).save(SHOTS / 'projects-sheet.png')
        _sheet(low, 2).save(SHOTS / 'projects-lowres.png')
    (SHOTS / 'report-projects.json').write_text(json.dumps(report, indent=1, ensure_ascii=False))


# ------------------------------------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', action='append', default=[], help='обработать только эти картинки')
    ap.add_argument('--out', help='писать webp сюда, по умолчанию public/assets/projects')
    ap.add_argument('--shots', help='куда класть превью, по умолчанию shots/v3-projects/assets')
    args = ap.parse_args()
    global OUT, SHOTS
    if args.out:
        OUT = Path(args.out).resolve()
    if args.shots:
        SHOTS = Path(args.shots).resolve()
    OUT.mkdir(parents=True, exist_ok=True)
    report = {}
    for name in args.only or NAMES:
        img, y0 = make(name)
        n, q = save_webp(img, OUT / f'{name}.webp')
        hud = hud_report(name, y0)
        report[name] = {'size': list(img.size), 'mode': img.mode, 'bytes': n, 'quality': q, 'hud': hud}
        note = '' if y0 == CROP_Y else f"  окно сдвинуто {'вверх' if y0 < CROP_Y else 'вниз'} на {abs(y0 - CROP_Y)} px"
        print(f'{name} → {name}.webp {img.size} {img.mode} {n / 1024:.0f} KB (q{q})  окно y {y0}…{y0 + SIZE[1]}{note}')
        print(f"    HUD до края грани 1.9:1 (сверху, снизу): {hud['face_1.9_margin_px']} px;"
              f" весь HUD с отступом входит в грань не уже {hud['min_aspect_all_hud']}:1")
    preview(report)


if __name__ == '__main__':
    main()
