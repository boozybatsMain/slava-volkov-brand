#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
process_veil.py — слой veil («спуск в облако» и белая пустота второго экрана) из сырья Codex.

Вход:   $GEN_DIR/<name>/<name>.png (по умолчанию ./.gen-work)
          void-wide, void-tall        — src/layers/projects/tools/generate-void.sh (2 генерации)
          bank-front-b, foreground-a  — сырьё первого экрана (generate.sh), новых генераций нет
Выход:  public/assets/sky-layers/{void-wide,void-tall,veil-wall,veil-wisp}.webp
Превью: shots/v3-projects/assets/ (плашки, кроп ×3 против бандинга, стена и клок поверх первого экрана
        и поверх ровного цвета veil, цифры — report-veil.json)

Запуск из корня проекта:
    python3 src/layers/sky-layers/tools/process_veil.py
    python3 src/layers/sky-layers/tools/process_veil.py --only veil-wall --only veil-wisp
    python3 src/layers/sky-layers/tools/process_veil.py --out /tmp/x --shots /tmp/x/s   # пробный прогон
    python3 src/layers/sky-layers/tools/process_veil.py --preview-only                    # только превью

Что делает:
  * пустота (void-*): горизонт пола переставляется на нужную высоту, ИИ-фактура размывается, яркость
    по квантилям приводится к пустоте референса (reference/projects-screen.png, без тени экрана) гладкой
    кривой; цвет — рампа референса, частично свой оттенок (радужные блики на полу остаются);
  * стена (veil-wall): вал bank-front-b → почти белый, не в фокусе; сдвинут вверх кадра (гребень у верха);
    под последней строкой сырья тело облака продолжается его же зеркальным отражением — мягкие складки
    идут почти до низа кадра и плавно уходят в ровный цвет veil.color; самые нижние 2 % кадра — ровно этот
    цвет с альфой 1 (рендерер тянет нижнюю строку вниз: слой kind 'bank' с solid);
  * клок (veil-wisp): полоса foreground-a → почти белая, не в фокусе, тонкие места полупрозрачны, концы
    растворяются — ничего не касается краёв кадра.
Помощники (альфа, деконтаминация, грейд, сглаживание) — из process_assets.py; его main() / preview()
здесь НЕ вызываются: они переписывают слои первого экрана. Всё детерминировано.
"""
from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi
from scipy.interpolate import PchipInterpolator

sys.dont_write_bytecode = True  # иначе импорт process_assets оставит __pycache__ в src/
sys.path.insert(0, str(Path(__file__).resolve().parent))
import process_assets as pa  # noqa: E402

ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / 'public' / 'assets' / 'sky-layers'
SHOTS = ROOT / 'shots' / 'v3-projects' / 'assets'
REF = ROOT / 'reference' / 'projects-screen.png'
HERO = ROOT / 'shots' / 'v3-projects' / 'baseline' / 'v2-1440.png'  # первый экран, 1440×900@2

# #ecebea — был sky.config → veil.color («внутри облака»); с 2026-10-12 пустота тёплая (#e6ddd0), а
# стена в файле осталась с этим низом. Менять вместе с WALL_BODY в src/layers/sky-layers/index.ts
# (ровное тело под стеной у фолбэка без WebGL).
VEIL_RGB = np.array([236.0, 235.0, 234.0])

# Какой сырой вариант идёт в какой файл.
PICK = {
    'void-wide': 'void-wide',
    'void-tall': 'void-tall',
    'veil-wall': 'bank-front-b',  # bank-front первого экрана сделан из bank-front-a — силуэт другой
    'veil-wisp': 'foreground-a',  # толстая полоса: на первом экране была «туманом», здесь это и нужно
}

# ---------------------------------------------------------------------------------------------- пустота
# Яркость пустоты референса на квантилях pa.PCTS (1 … 99.7 %) и цвет на каждом уровне. Замер:
# measure_void_ramp() — reference/projects-screen.png без экрана, текстов, навигации и БЕЗ тени экрана
# (тень рисует слой slab). Два отличия от замера:
#   * низ рампы поднят с 191 до 205: на референсе темнее всего пол рядом с тенью, а в плашке не должно
#     быть ничего темнее светло-серого;
#   * тёмный конец чуть теплее (B−R +1…+2 вместо +4…+5): на референсе такие яркости есть только в
#     холодном левом верхнем углу, а в плашке — ещё и в левой середине, где референс тёплый.
VOID_TQ = np.array([205.0, 210.0, 213.0, 221.0, 230.5, 238.5, 244.3, 245.6, 248.0, 249.5])
VOID_TC = np.array([(207, 205, 207), (212, 210, 213), (215, 213, 216), (224, 221, 222), (232, 230, 231),
                    (240, 238, 237), (247, 244, 241), (248, 245, 242), (250, 247, 244), (251, 249, 245)], float)

VOID = {
    # horizon: (где горизонт пола в сырье, куда его поставить) — доли высоты. Плашка 3:2 на экране 16:9
    #   обрезается сверху и снизу (cover), поэтому 0.76 в файле = 0.81 на 16:9 и 0.78 на 16:10 — как на
    #   референсе (0.78–0.85); у вертикальной плашки телефон показывает всю высоту.
    # blur: размытие ИИ-фактуры, px (небо, пол). Небо — до бесформенной дымки: при 7 оно ещё читается как
    #   «пасмурное небо с облаками», при 24 остаются только большие мягкие пятна, как на референсе, при 40
    #   пустота уже совсем ровная. Пол мягче: остаются полосы отражений и блики.
    # detail: (доля, размытие px) — сколько средней фактуры сырья вернуть в небо. 0 — только большие пятна
    #   (локальный контраст σ40 — 1.2 уровня; у референса 1.7), 1 — «пасмурное небо»; 0.35 — дымка живая,
    #   а плавные изолинии яркости рвутся фактурой (на совсем гладком поле WebP рисует их контурами).
    # haze: (выше, ниже горизонта) — на этой доле высоты пол проявляется из дымки, линии горизонта нет.
    # keep_hue: доля своего оттенка (небо, пол): на полу больше — там радужные блики.
    # q: качество WebP. Плашка гладкая, и дело не в размере, а в контурах: у WebP с потерями (YUV 4:2:0,
    #   урезанный диапазон) на таком поле низкочастотная ошибка — до 1 уровня по яркости и до 2.4 по R−B,
    #   и выше q 92 она не падает (замер: q 96 и q 100 — те же числа, 26 и 31 KB). Под зерном слоя veil
    #   (≈ 1.1 уровня на CSS-пиксель) контуров не видно. Ровно 8 бит дал бы только lossless — 148 KB вместо 17.
    'void-wide': dict(horizon=(0.700, 0.76), blur=(24.0, 2.5), detail=(0.35, 7.0), haze=(0.01, 0.10), keep_hue=(0.30, 0.65), q=92),
    'void-tall': dict(horizon=(0.748, 0.80), blur=(24.0, 2.5), detail=(0.35, 7.0), haze=(0.01, 0.10), keep_hue=(0.30, 0.65), q=92),
}
VOID_MAX_BYTES = 40_000

# ----------------------------------------------------------------------------------------- стена и клок
CURTAIN = {
    # lift: (тени, света) — насколько рампа облачков первого экрана (reference/sky-hero-v2.png) подтянута к
    #   белому: 0 — как облачка неба, 1 — чистый белый. Света тянутся сильнее теней: макушки почти белые
    #   (≈ 243, тёплые), складки — светлый жемчужно-сиреневый (≈ 209). Одинаковый подъём 0.6 давал облако
    #   всего в 18 уровней яркости: объём держался только на цвете (персик против сирени).
    # keep_hue: доля своего оттенка сырья (0.3 с ровным подъёмом — макушки заметно персиковые, 0.2 — почти
    #   без цвета; 0.25 — «тёплый белый» с едва заметным персиком);
    # contrast: (сила, радиус px) — локальный контраст клубов: после дефокуса без него стена — ровное
    #   белое пятно, а не облако (1 — выкл; 1.3 — клубы читаются; больше — возвращается «цветная капуста»);
    # defocus: размытие премультиплицированного RGBA, px («не в фокусе», край мягкий и без каймы).
    'veil-wall': dict(lift=(0.48, 0.86), keep_hue=0.25, contrast=(1.3, 25), defocus=7.0,
                      crest=0.09,       # куда встаёт вершина гребня (доля высоты): выше её съест feather слоя
                      # тело светлеет к ровному veil.color: от гребня (+ отступ) до flat_y; степень. Чем она
                      # больше, тем дольше складки держат контраст и тем быстрее гаснут у самого flat_y
                      # (1.4 — уже с середины тело почти ровное; 2.2 — складки читаются до ≈ 0.8 высоты;
                      # 3 и больше — у flat_y заметна «ступенька» фактуры)
                      fade=(0.02, 2.2),
                      # с этой высоты кадра — ровный цвет (ниже WALL_FLAT_FROM — точно он). Было 0.68: всё, что
                      # ниже, было ровной заливкой, и на телефоне (стена там втрое шире экрана) с pos 0.30
                      # по 0.36 две трети кадра занимал ровный лист. Теперь тело идёт до 0.95
                      flat_y=0.95,
                      full_y=(0.58, 0.68)),  # на этом отрезке высоты альфа тела добирается до 1 (силуэт гребня выше)
    # thin: (непрозрачность самых тонких мест, радиус оценки толщины px); hole / island — дырки и клочки
    #   мельче этого (px²) убираются: после дефокуса они читались как «сыр»;
    # edge_fade: концы полосы растворяются на этой доле ширины с каждой стороны.
    # Тени клока подняты сильнее, чем у стены (0.60 против 0.48), и контраст мягче: у полосы тёмный
    #   низ (≈ 192 при 0.48), и в белой пустоте (слой mist) он читался как серая грязь; так — ≈ 207.
    'veil-wisp': dict(lift=(0.60, 0.86), keep_hue=0.25, contrast=(1.2, 25), defocus=7.0, thin=(0.5, 18),
                      hole=900, island=900, edge_fade=0.14),
}
CURTAIN_MAX_BYTES = 80_000
WALL_FLAT_FROM = 0.98  # ниже этой доли высоты veil-wall — ровно VEIL_RGB, альфа 1

# Раскладка превью — как слой veil ставит картинки (sky.config → veil.layers, числа спецификации):
# x / y — куда встаёт точка anchor, % ширины / высоты экрана; width — % от min(ширина, 1.8 × высота).
DESIGN_ASPECT = 1.8
PREVIEW = {
    'veil-wall': dict(kind='bank', x=50, y=108, width=150, anchor=(0.5, 0.0), flip=True, feather=0.06),
    'veil-wisp': dict(kind='clouds', x=30, y=118, width=90, anchor=(0.5, 0.0), flip=False, feather=0.08,
                      opacity=0.9),
}


# ----------------------------------------------------------------------------------------------- utils
def save_webp(img: Image.Image, path: Path, q: int, max_bytes: int, q_min=70) -> tuple[int, int]:
    """Как pa.save_webp, но со своим стартовым качеством и лимитом (альфа без потерь, exact)."""
    while True:
        buf = io.BytesIO()
        kw = dict(quality=q, method=6)
        if img.mode == 'RGBA':
            kw.update(alpha_quality=100, exact=True)
        img.save(buf, 'WEBP', **kw)
        if len(buf.getvalue()) <= max_bytes or q <= q_min:
            break
        q -= 3
    path.write_bytes(buf.getvalue())
    return len(buf.getvalue()), q


def _read(name: str):
    arr = np.asarray(Image.open(OUT / f'{name}.webp').convert('RGBA')).astype(np.float64)
    return arr[..., :3], arr[..., 3] / 255


# ---------------------------------------------------------------------------------------------- пустота
def measure_void_ramp():
    """Квантили яркости пустоты референса (то, из чего получены VOID_TQ / VOID_TC). Печатает и возвращает."""
    from PIL import ImageDraw
    ref = np.asarray(Image.open(REF).convert('RGB')).astype(np.float64)
    H, W, _ = ref.shape  # 1672×941
    ex = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(ex)
    d.polygon([(325, 60), (1320, 320), (1370, 740), (325, 600)], fill=255)  # экран с гранями
    d.polygon([(70, 95), (350, 140), (345, 185), (65, 140)], fill=255)       # 01 / SELECTED PROJECTS
    d.polygon([(315, 610), (720, 640), (700, 790), (315, 840)], fill=255)    # заголовок, описание, ссылка
    d.rectangle((1500, 30, 1660, 380), fill=255)                             # навигация
    d.polygon([(0.10 * W, 0.80 * H), (0.78 * W, 0.86 * H), (0.80 * W, 0.90 * H), (0.62 * W, H), (0.10 * W, H)],
              fill=255)                                                      # тень экрана на полу
    m = np.asarray(ex) == 0
    L = pa.lum(ref)[m]
    C = ref[m]
    tq = np.percentile(L, pa.PCTS)
    tc = np.array([C[np.abs(L - q) < 1.5].mean(0) for q in tq])
    print('  пустота референса: tq', tq.round(1).tolist())
    print('                     tc', tc.round().astype(int).tolist())
    return tq, tc


def move_horizon(p: np.ndarray, src: float, dst: float) -> np.ndarray:
    """Переставить горизонт пола с доли src на долю dst высоты: небо растягивается, пол сжимается.

    Кусочно-линейно по строкам; излом приходится на сам горизонт (полоса дымки) и не виден.
    """
    h = p.shape[0]
    yo = (np.arange(h) + 0.5) / h
    ys = np.where(yo < dst, yo * src / dst, src + (yo - dst) * (1 - src) / (1 - dst))
    f = ys * h - 0.5
    i0 = np.clip(np.floor(f).astype(int), 0, h - 2)
    t = np.clip(f - i0, 0, 1)[:, None, None]
    return p[i0] * (1 - t) + p[i0 + 1] * t


def grade_smooth(rgb: np.ndarray, tq: np.ndarray, tc: np.ndarray, keep_hue) -> np.ndarray:
    """pa.grade для очень гладкой картинки: кривая тонов — монотонный кубический сплайн (PCHIP).

    У кусочно-линейной кривой pa.grade наклон меняется скачком в каждом квантиле; на облаках этого не
    видно, а на гладком градиенте пустоты излом яркости читается как контур («полоса Маха»).
    keep_hue — число или поле (h×w): доля своего оттенка.
    """
    L = np.maximum(pa.lum(rgb), 1e-3)
    sq = np.percentile(L, pa.PCTS)
    sq = np.maximum.accumulate(sq + np.arange(len(sq)) * 1e-4)
    f = PchipInterpolator(sq, tq)
    d = f.derivative()
    Lc = np.clip(L, sq[0], sq[-1])
    Ln = f(Lc) + np.minimum(L - Lc, 0) * float(d(sq[0])) + np.maximum(L - Lc, 0) * float(d(sq[-1]))
    Lr = np.clip(Ln, tq[0], tq[-1])
    Ln = Lr + (Ln - Lr) * 0.25  # за краями рампы (по 1 % пикселей) — пологое «колено», а не срез
    Ln = np.clip(Ln, tq[0] - 2, tq[-1] + 1)
    ramp = np.stack([PchipInterpolator(tq, tc[:, c])(Lr) for c in range(3)], -1) + (Ln - Lr)[..., None]
    own = rgb * (Ln / L)[..., None]
    k = np.asarray(keep_hue, float)
    k = k[..., None] if k.ndim == 2 else k
    return np.clip((1 - k) * ramp + k * own, 0, 255)


def make_void(kind: str, src: str) -> np.ndarray:
    P = VOID[kind]
    p = pa.load(src)[..., :3]
    h, w, _ = p.shape
    hs, hd = P['horizon']
    p = move_horizon(p, hs, hd)
    # пол — ниже горизонта; дальний пол тонет в дымке (размыт как небо), ближний проявляется постепенно
    floor = pa.smoothstep(hd - P['haze'][0], hd + P['haze'][1], (np.arange(h) + 0.5) / h)[:, None]
    bs, bf = P['blur']
    sky = pa.gblur(p, bs)
    if P.get('detail'):  # доля средней фактуры неба (размытие detail[1] px) поверх бесформенной дымки
        k, s = P['detail']
        sky = sky + k * (pa.gblur(p, s) - sky)
    p = sky * (1 - floor[..., None]) + pa.gblur(p, bf) * floor[..., None]
    ks, kf = P['keep_hue']
    out = grade_smooth(p, VOID_TQ, VOID_TC, (ks + (kf - ks) * floor) * np.ones((h, w)))
    return out


# ----------------------------------------------------------------------------------------- стена и клок
def curtain(src: str, P: dict):
    """Общая часть стены и клока: чистая альфа, цвет без ореолов, грейд к «почти белому»."""
    raw = pa.load(src)
    rgb, a0 = raw[..., :3], raw[..., 3] / 255
    a = pa.refine_alpha(a0, 1.6, min_island=P.get('island', 60), max_hole=P.get('hole', 80))
    rgb = pa.decontaminate(pa.despeckle(rgb, a0 > 0.9), a0)
    tq, tc = pa.ref_ramp(*pa.REF_BOXES['cloudlets'])
    lo, hi = P['lift']  # те же оттенки (персик на свету, сиреневая тень), подтянутые к белому
    lift = lo + (hi - lo) * (tq - tq[0]) / (tq[-1] - tq[0])
    tc = tc + (255 - tc) * lift[:, None]
    tq = pa.lum(tc)
    rgb = pa.grade(rgb, a0 > 0.9, tq, tc, P['keep_hue'])
    rgb = pa.guided_smooth(rgb, 4, 8.0, 0.8)
    k, sig = P.get('contrast', (1, 0))
    if k != 1:  # глубже складки между клубами, светлее их макушки (как local_contrast у bank-front)
        L = np.maximum(pa.lum(rgb), 1)
        Lb = pa.gblur(L, sig)
        rgb = np.clip(rgb * ((Lb + (L - Lb) * k) / L)[..., None], 0, 255)
    return rgb, a


def defocus(rgb: np.ndarray, a: np.ndarray, s: float):
    """«Не в фокусе»: гаусс по премультиплицированному RGBA (край мягкий, без тёмной и светлой каймы);
    цвет под прозрачным продолжается изнутри (push-pull), как в process_assets."""
    ab = pa.gblur(a, s)
    rgbp = pa.gblur(rgb * a[..., None], s)
    solid = ab > 0.02
    rgb = np.where(solid[..., None], rgbp / np.maximum(ab, 1e-6)[..., None], rgb)
    rgb = pa.decontaminate(np.clip(rgb, 0, 255), np.where(solid, 1.0, 0.0), solid=0.5)
    return rgb, ab


def make_wall(src: str):
    P = CURTAIN['veil-wall']
    rgb, a = curtain(src, P)
    h, w = a.shape
    # 1. сдвиг вверх: вершина гребня → P['crest']; освободившийся низ — тело облака (альфа 1): нижние
    #    строки сырья, отражённые зеркально. Шва нет (отражение непрерывно), а в отличие от повтора
    #    последней строки нет и вертикальных полос; дефокус и затухание ниже делают из него мягкие
    #    складки, в которых зеркало не узнаётся
    top = np.argmax(a > 0.5, axis=0).astype(float)
    top[~(a > 0.5).any(0)] = h
    shift = int(round(top.min() - P['crest'] * h))
    if shift > 0:
        rgb = np.concatenate([rgb[shift:], rgb[::-1][1:shift + 1]])
        a = np.concatenate([a[shift:], np.ones((shift, w))])
        top = top - shift
    # 2. тело светлеет и теряет фактуру с глубиной: 0 у гребня → 1 на flat_y (так под высокой «башней»
    #    клубы видны дольше, а ровный цвет везде начинается на одной высоте — без «шатра» под вершиной)
    env = ndi.gaussian_filter1d(ndi.minimum_filter1d(top, 61, mode='reflect'), 40, mode='reflect') / h
    y = (np.arange(h) + 0.5)[:, None] / h
    t = np.clip((y - env[None, :] - P['fade'][0]) / np.maximum(P['flat_y'] - env[None, :] - P['fade'][0], 1e-3), 0, 1)
    t = pa.smoothstep(0, 1, t) ** P['fade'][1]
    rgb = rgb * (1 - t[..., None]) + VEIL_RGB * t[..., None]
    a = np.maximum(a, pa.smoothstep(*P['full_y'], y) * np.ones((1, w)))
    # 3. не в фокусе; затем низ — ровно цвет veil с альфой 1 (рендерер тянет нижнюю строку вниз)
    rgb, a = defocus(rgb, a, P['defocus'])
    k = pa.smoothstep(P['flat_y'], WALL_FLAT_FROM, y)
    rgb = rgb * (1 - k[..., None]) + VEIL_RGB * k[..., None]
    a = a * (1 - k) + k
    a[a < 1 / 255] = 0
    return rgb, a


def make_wisp(src: str):
    P = CURTAIN['veil-wisp']
    rgb, a = curtain(src, P)
    h, w = a.shape
    lo, s = P['thin']  # тонкие места (мало «толщины» вокруг) полупрозрачны
    a = a * (lo + (1 - lo) * pa.smoothstep(0.15, 0.85, pa.gblur(a, s)))
    x = (np.arange(w) + 0.5) / w  # полоса в сырье доходит до краёв кадра: концы растворяются
    a = a * (pa.smoothstep(0, P['edge_fade'], x) * pa.smoothstep(0, P['edge_fade'], 1 - x))[None, :]
    rgb, a = defocus(rgb, a, P['defocus'])
    a[a < 1 / 255] = 0
    return rgb, a


# --------------------------------------------------------------------------------------------- цифры
def geometry(a: np.ndarray) -> dict:
    """bbox по альфе > 0.5 и по видимой части (> 3 %), линия гребня (верхний край по столбцам) — доли кадра."""
    h, w = a.shape
    b = a > 0.5
    ys, xs = np.where(b)
    vy, vx = np.where(a > 8 / 255)
    top = np.argmax(b, axis=0)[b.any(0)] / h
    return {
        'bbox_frac': [round(float(v), 3) for v in (xs.min() / w, ys.min() / h, (xs.max() + 1) / w, (ys.max() + 1) / h)],
        'bbox_visible_frac': [round(float(v), 3) for v in (vx.min() / w, vy.min() / h, (vx.max() + 1) / w, (vy.max() + 1) / h)],
        'coverage_a50': round(float(b.mean()), 3),
        'empty_share': round(float((a == 0).mean()), 3),
        'alpha_max': round(float(a.max()), 3),
        'crest_min_med_max': [round(float(top.min()), 3), round(float(np.median(top)), 3), round(float(top.max()), 3)],
        'edges_alpha_max': {'left': round(float(a[:, 0].max()), 3), 'right': round(float(a[:, -1].max()), 3),
                            'top': round(float(a[0].max()), 3), 'bottom_min': round(float(a[-1].min()), 3)},
    }


def void_stats(rgb: np.ndarray) -> dict:
    """Яркость плашки: сетка 5×5 (как таблица референса), рампа верх / середина / пол, крайние значения."""
    h, w, _ = rgb.shape
    L = pa.lum(rgb)
    grid = [[int(round(L[int(y * h / 5):int((y + 1) * h / 5), int(x * w / 5):int((x + 1) * w / 5)].mean()))
             for x in range(5)] for y in range(5)]
    band = lambda y0, y1: rgb[int(y0 * h):int(y1 * h)].reshape(-1, 3).mean(0)  # noqa: E731
    hexs = lambda c: '#%02x%02x%02x' % tuple(int(round(v)) for v in c)          # noqa: E731
    bands = {'top (y 0–0.2)': band(0, 0.2), 'middle (y 0.4–0.6)': band(0.4, 0.6), 'floor (y 0.85–1)': band(0.85, 1)}
    return {
        'luma_grid_5x5': grid,
        'ramp': {k: {'rgb': hexs(v), 'luma': round(float(pa.lum(v)), 1)} for k, v in bands.items()},
        'luma_min_p1_p50_p99_max': [round(float(v), 1) for v in (L.min(), *np.percentile(L, [1, 50, 99]), L.max())],
        'chroma_p50_p95_max': [round(float(v), 1) for v in np.percentile(rgb.max(2) - rgb.min(2), [50, 95, 100])],
        'mean_rgb': hexs(rgb.reshape(-1, 3).mean(0)),
    }


# --------------------------------------------------------------------------------------------- превью
def place(frame: np.ndarray, rgb: np.ndarray, a: np.ndarray, L: dict, rise=0.0):
    """Поставить слой в кадр так, как это делает рендерер sky-layers (rise — подъём, % высоты).

    'bank': вбок повторяется зеркально, сверху прозрачен (feather — доля высоты картинки), ниже картинки
    тянется её нижняя строка (solid). 'clouds': одна картинка, края гаснут на feather × меньшую сторону.
    """
    H, W, _ = frame.shape
    w = int(round(min(W, DESIGN_ASPECT * H) * L['width'] / 100))
    h = int(round(w * a.shape[0] / a.shape[1]))
    rgb, a = pa.resize(rgb, w, h), np.clip(pa.resize(a, w, h), 0, 1) * L.get('opacity', 1)
    if L.get('flip'):
        rgb, a = rgb[:, ::-1], a[:, ::-1]
    x0 = int(round(L['x'] / 100 * W - L['anchor'][0] * w))
    y0 = int(round((L['y'] - rise) / 100 * H - L['anchor'][1] * h))
    f = L.get('feather', 0)
    if L['kind'] == 'bank':
        if f > 0:
            a = a * pa.smoothstep(0, f, (np.arange(h) + 0.5) / h)[:, None]
        u = (np.arange(W) - x0) % (2 * w)
        u = np.where(u >= w, 2 * w - 1 - u, u)
        v = np.arange(H) - y0
        ok = v >= 0
        v = np.clip(v, 0, h - 1)
        sa = (a[v][:, u] * ok[:, None])[..., None]
        frame[:] = rgb[v][:, u] * sa + frame * (1 - sa)
    else:
        if f > 0:
            e = np.minimum.outer(np.minimum(np.arange(h), h - 1 - np.arange(h)), np.minimum(np.arange(w), w - 1 - np.arange(w)))
            a = a * pa.smoothstep(0, f * min(w, h), e + 0.5)
        pa._over(frame, rgb, a, x0, y0)


def _sheet(tiles: list[Image.Image], cols: int, gap=8, bg=(24, 24, 24)) -> Image.Image:
    tw, th = max(t.size[0] for t in tiles), max(t.size[1] for t in tiles)
    rows = (len(tiles) + cols - 1) // cols
    sh = Image.new('RGB', (cols * tw + (cols - 1) * gap, rows * th + (rows - 1) * gap), bg)
    for i, t in enumerate(tiles):
        sh.paste(t, ((i % cols) * (tw + gap), (i // cols) * (th + gap)))
    return sh


def preview():
    SHOTS.mkdir(parents=True, exist_ok=True)
    report = {'pick': PICK, 'files': {}}
    for p in sorted(OUT.glob('v*.webp')):
        if p.stem in PICK:
            im = Image.open(p)
            report['files'][p.name] = {'size': list(im.size), 'mode': im.mode, 'bytes': p.stat().st_size}
    # --- плашки пустоты: целиком, кроп ×3 (и он же с растянутым контрастом — бандинг и блоки WebP), рядом с референсом
    for n in ('void-wide', 'void-tall'):
        if not (OUT / f'{n}.webp').exists():
            continue
        rgb, _ = _read(n)
        h, w, _ = rgb.shape
        report[n] = void_stats(rgb)
        Image.open(OUT / f'{n}.webp').convert('RGB').save(SHOTS / f'{n}.png')
        tiles = []
        for cx, cy in ((0.22, 0.2), (0.78, 0.3), (0.3, 0.86)):  # холодный верх-лево, светлое право, пол с бликом
            cw, ch = 256, 170
            x0, y0 = int(np.clip(cx * w - cw / 2, 0, w - cw)), int(np.clip(cy * h - ch / 2, 0, h - ch))
            c = rgb[y0:y0 + ch, x0:x0 + cw]
            for stretch in (1, 6):  # ×6 вокруг средней яркости кропа: ступени в 1 уровень становятся видны
                v = np.clip((c - c.mean()) * stretch + (c.mean() if stretch == 1 else 128), 0, 255)
                tiles.append(pa.to_img(v).resize((cw * 3, ch * 3), Image.NEAREST))
        _sheet(tiles, 2).save(SHOTS / f'{n}-x3.png')
    if (OUT / 'void-wide.webp').exists() and REF.exists():
        ref = np.asarray(Image.open(REF).convert('RGB')).astype(np.float64)
        H, W, _ = ref.shape
        rgb, _ = _read('void-wide')
        s = max(W / rgb.shape[1], H / rgb.shape[0])
        big = pa.resize(rgb, round(rgb.shape[1] * s), round(rgb.shape[0] * s))
        oy, ox = (big.shape[0] - H) // 2, (big.shape[1] - W) // 2
        side = np.full((H, 2 * W + 12, 3), 24.0)
        side[:, :W] = ref
        side[:, W + 12:] = big[oy:oy + H, ox:ox + W]
        pa.to_img(side).resize(((2 * W + 12) * 2 // 3, H * 2 // 3), Image.LANCZOS).save(SHOTS / 'void-wide-vs-ref.png')
    # --- стена и клок: поверх первого экрана и поверх ровного veil.color, в раскладке рендерера
    hero = None
    if HERO.exists():
        hero = np.asarray(Image.open(HERO).convert('RGB').resize((1440, 900), Image.LANCZOS)).astype(np.float64)
    flat = np.broadcast_to(VEIL_RGB, (900, 1440, 3)).copy()
    for n, rises in (('veil-wall', (40, 62, 84, 110)), ('veil-wisp', (50, 75, 100, 125))):
        if not (OUT / f'{n}.webp').exists():
            continue
        rgb, a = _read(n)
        report[n] = geometry(a)
        for tag, bg in (('hero', hero), ('flat', flat)):
            if bg is None:
                continue
            tiles = []
            for r in rises:
                f = bg.copy()
                place(f, rgb, a, PREVIEW[n], rise=r)
                tiles.append(pa.to_img(f))
            _sheet(tiles, 2).save(SHOTS / f'{n}-over-{tag}.png')
            tiles[1 if n == 'veil-wall' else 2].save(SHOTS / f'{n}-over-{tag}-1440.png')
        # сама картинка: шахматка, тёмный и светлый ровный фон — ореолы на краях видны сразу
        h, w = a.shape
        yy, xx = np.mgrid[0:h, 0:w]
        bgs = [np.where(((yy // 32 + xx // 32) % 2)[..., None] == 0, 190.0, 140.0) * np.ones(3),
               np.broadcast_to(np.array([56.0, 83.0, 113.0]), (h, w, 3)), np.broadcast_to(VEIL_RGB, (h, w, 3)),
               np.broadcast_to(np.array([255.0, 255.0, 255.0]), (h, w, 3))]
        _sheet([pa.to_img(rgb * a[..., None] + b * (1 - a[..., None])).resize((w // 2, h // 2), Image.LANCZOS) for b in bgs],
               2).save(SHOTS / f'{n}-sheet.png')
    (SHOTS / 'report-veil.json').write_text(json.dumps(report, indent=1, ensure_ascii=False))
    for k, v in report['files'].items():
        print(f"  {k:<16} {v['size']} {v['mode']}  {v['bytes'] / 1024:.1f} KB")
    for n in ('veil-wall', 'veil-wisp'):
        if n in report:
            g = report[n]
            print(f"  {n}: bbox {g['bbox_frac']}  видимая {g['bbox_visible_frac']}  гребень min/med/max {g['crest_min_med_max']}"
                  f"  пусто {g['empty_share']}  края {g['edges_alpha_max']}")
    for n in ('void-wide', 'void-tall'):
        if n in report:
            s = report[n]
            print(f"  {n}: {s['ramp']}  яркость min/p1/p50/p99/max {s['luma_min_p1_p50_p99_max']}  средний {s['mean_rgb']}")


# ------------------------------------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pick', action='append', default=[], help='файл=сырьё, напр. veil-wall=bank-front-a')
    ap.add_argument('--only', action='append', default=[], help='обработать только эти файлы')
    ap.add_argument('--preview-only', action='store_true')
    ap.add_argument('--measure', action='store_true', help='только напечатать рампу пустоты референса')
    ap.add_argument('--out', help='писать webp сюда, по умолчанию public/assets/sky-layers')
    ap.add_argument('--shots', help='куда класть превью, по умолчанию shots/v3-projects/assets')
    args = ap.parse_args()
    global OUT, SHOTS
    if args.measure:
        measure_void_ramp()
        return
    if args.out:
        OUT = Path(args.out).resolve()
    if args.shots:
        SHOTS = Path(args.shots).resolve()
    for p in args.pick:
        k, v = p.split('=')
        PICK[k] = v
    OUT.mkdir(parents=True, exist_ok=True)
    if not args.preview_only:
        for name in args.only or list(PICK):
            src = PICK[name]
            print(f'{name} ← {src}')
            if name in VOID:
                img, q0, limit = pa.to_img(make_void(name, src)), VOID[name]['q'], VOID_MAX_BYTES
            else:
                img = pa.to_img(*(make_wall(src) if name == 'veil-wall' else make_wisp(src)))
                q0, limit = pa.WEBP_Q, CURTAIN_MAX_BYTES
            n, q = save_webp(img, OUT / f'{name}.webp', q0, limit)
            print(f'  → {name}.webp {img.size} {img.mode} {n / 1024:.1f} KB (q{q})')
    preview()


if __name__ == '__main__':
    main()
