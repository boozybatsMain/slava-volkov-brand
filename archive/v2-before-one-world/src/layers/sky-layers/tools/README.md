# sky-layers / tools — ассеты слоёного неба v2

Финальные слои для `index.html`. Все десять файлов лежат в `public/assets/sky-layers/` и полностью воспроизводятся скриптами из этой папки. Нужно только сырьё в `$GEN_DIR` (по умолчанию `./.gen-work`, в git не попадает).

| файл | назначение |
|---|---|
| `gen.sh` | одна генерация через Codex CLI (`image_generation`, подписка ChatGPT): `gen.sh <name> <size> <transparent\|opaque> "<prompt>"` → `$GEN_DIR/<name>/<name>.png` |
| `generate.sh` | точные промпты всех вариантов; `generate.sh <name>…` запускает их параллельно; `DRY=1` только печатает промпты |
| `process_assets.py` | сырьё → финальные `*.webp` + превью и цифры в `shots/v2-layers-assets/` (`--shots` — другая папка) |
| `process_veil.py` | слой veil второго экрана: `void-wide/tall`, `veil-wall`, `veil-wisp` из сырья → `public/assets/sky-layers/` (не трогает десять файлов выше); описание, таблица файлов и промпты — `src/layers/projects/tools/README.md` |

```sh
# из корня проекта
GEN_DIR=$PWD/.gen-work src/layers/sky-layers/tools/generate.sh moon-b cloudlets-a   # ≈3 мин, тратит лимит подписки
python3 src/layers/sky-layers/tools/process_assets.py                                  # ≈1.5 мин (Upscayl кэшируется)
python3 src/layers/sky-layers/tools/process_assets.py --pick bank-front=bank-front-b    # другой вариант
python3 src/layers/sky-layers/tools/process_assets.py --only foreground-a --only foreground-b   # только эти слои
python3 src/layers/sky-layers/tools/process_assets.py --out /tmp/x --shots /tmp/x/s --no-upscale   # быстрый пробный прогон
```

Генерации не детерминированы. Если `.gen-work` потерян, повторный `generate.sh` даст другие картинки, и выбор вариантов нужно делать заново.

## Финальные файлы

| файл | размер | KB | кадр (доли картинки, альфа > 0.5) |
|---|---|---|---|
| `sky-wide.webp` | 1536×1024 RGB | 22 | непрозрачная плашка 3:2 |
| `sky-tall.webp` | 1024×1536 RGB | 23 | непрозрачная плашка 2:3 |
| `moon.webp` | 512×512 RGBA | 36 | центр диска = центр картинки, диаметр диска = 0.90 ширины; светится правая половина (x 0.5–0.95), левая полностью прозрачна |
| `cloudlets.webp` | 3072×2048 RGBA | 137 | bbox x 0.054–0.959, y 0.3–0.81; верхний край (min/медиана/max) 0.3 / 0.445 / 0.715 |
| `bank-front.webp` | 3072×2048 RGBA | 95 | bbox x 0.0–1.0, y 0.342–1.0; верхний край (min/медиана/max) 0.342 / 0.552 / 0.646 (проход 2: та же геометрия, другая обработка фактуры) |
| `bank-back.webp` | 3072×2048 RGBA | 85 | bbox x 0.0–1.0, y 0.659–1.0; верхний край (min/медиана/max) 0.659 / 0.725 / 0.752 |
| `cloudlets-sparse-a.webp` | 3072×2048 RGBA | 262 | **россыпь-поле**: 43 отдельных облачка (альфа > 0.1, > 300 px), разбросаны по всему кадру; bbox x 0.031–0.970, y 0.049–0.931; плотность растёт книзу (заполнение по строкам 0.1–0.2: 4 %, 0.4–0.5: 15 %, 0.6–0.7: 27 %, 0.8–0.9: 39 %) |
| `cloudlets-sparse-b.webp` | 3072×2048 RGBA | 277 | **россыпь-полоса**: 27 облачков/кучек, широкая полоса x 0.022–0.979, y 0.312–0.878; верх полосы — редкие мелкие, низ — плотнее и крупнее (заполнение 0.3–0.4: 6 %, 0.5–0.6: 39 %, 0.7–0.8: 74 %); верх кадра 0–0.3 пустой |
| `foreground-a.webp` | 3072×2048 RGBA | 104 | **ближняя рваная полоса** (одна): bbox x 0.069–0.948, y 0.427–0.586, видимая часть (альфа > 3 %) x 0.027–0.974, y 0.417–0.604; центр масс (0.525, 0.504); альфа ≤ 0.94 |
| `foreground-b.webp` | 3072×2048 RGBA | 126 | **две ближние тучки**: большая x 0.066–0.586, y 0.523–0.917 (низ-лево); меньшая x 0.560–0.965, y 0.376–0.592 (справа, выше); общий bbox x 0.076–0.944, y 0.382–0.907; альфа ≤ 0.94 |

Для рендерера:
- **Кадр.** Облачные слои вдвое больше v0 (3072×2048, было 1536×1024). Рамка по-прежнему полный кадр 3:2 без обрезки, но облака уже другие, так что положение в кадре смотреть по bbox и верхнему краю из таблицы. Пустой верх весит почти ноль. Если нужна экономия видеопамяти, слой можно обрезать по bbox.
- **Луна:** было 1024², диск ≈ 0.77 ширины; стало 512², диск 0.90 ширины, центр диска — центр картинки.
- **Банки.** Низ `bank-front` и `bank-back` непрозрачен до самого края, слева и справа облака доходят до краёв.
- **Края без ореолов.** RGB под прозрачными и полупрозрачными пикселями заполнен цветом облака (push-pull изнутри). WebP сохранён с `exact`, поэтому straight-alpha, билинейная фильтрация и мипмапы дают край без тёмной или светлой каймы. premultiply не обязателен.
- **Зерно не запечено.** Его даёт рендерер. На референсе high-pass зерна (L − gauss σ3) ≈ 1.6–1.7 уровня из 255 при ширине кадра 1384 px. Зерно монохромное, «пятно» ≈ 1.5–2 px.
- **Проход 2 — новые слои.**
  - `cloudlets-sparse-*` — kind `'clouds'`, рисуются ЗА валами (до `bankBack`), чтобы небо постепенно сгущалось к валу. `-b` — основная середина неба: например x 50, y 74, width 90, anchor (0.5, 0.88) — низ полосы уходит под валы, верх мелкими облачками поднимается до ≈ 0.25 высоты. `-a` — для боков (на референсе мелочь рассыпана слева под «S»): например x 24, y 66, width 55, anchor (0.5, 0.9). Края полей прозрачные, обреза не будет.
  - `foreground-*` — БЛИЖНИЙ план, рисуются ПОВЕРХ надписи. Уже «не в фокусе» (дефокус σ3–3.5 px исходника), тонкие места полупрозрачны, ядро — не больше 0.94, так что надпись просвечивает. Концы полосы `foreground-a` растворяются к краям картинки (edge_fade 10 %) — её можно делать шире экрана или уже, обреза нет. Проверено: `foreground-a` x 50, y 60, width 105, anchor (0.5, 0.5) пересекает «A VOLKOV» посередине высоты букв; `foreground-b` x 55, y 70, width 80, anchor (0.5, 0.5) — меньшая тучка закрывает низ «OLKOV», большая сливается с валом. Зерно лучше давать и им (иначе ближний план «чище» неба).
  - Превью с надписью: `shots/v2-front-assets/final-*-vs-ref.png` (небо — скриншот движка с `?set.` на слоте `cloudletsLeft`, надпись — из того же кадра, ближний план — поверх).
- **Где что на референсе (доли кадра 1384×914).** Луна: центр (0.851, 0.27), диаметр 0.047 ширины. Облачка: x 0.55–0.95, y 0.28–0.55. Банк: занимает нижние ~30 %, в центре-слева поднимается до ~0.60. В превью `bank-front` растянут на ширину 1.06 кадра, его пик стоит на y 0.59. `bank-back` растянут на 1.10, медиана его края на y 0.64.

## Цвет: референс vs композит слоёв

Композит собран в `process_assets.py → composite()`: слои в позициях референса плюс зерно (без слоёв прохода 2; с ними — `composite(front=True)` → `compare-ref-vs-front.png`). Каждая строка — медиана региона или квантиль яркости не-небесных пикселей. Регионы с тайтлом и UI-текстом исключены.

| регион | референс | слои | RMSE |
|---|---|---|---|
| sky top (x .15–.65, y 0–.05) | (56, 83, 113) | (55, 84, 112) | 1.0 |
| sky upper (x .3–.6, y .1–.15) | (62, 93, 125) | (62, 93, 123) | 1.2 |
| sky mid-right (x .65–.8, y .15–.2) | (75, 103, 134) | (79, 106, 137) | 3.4 |
| sky right (x .9–1, y .3–.35) | (112, 132, 158) | (111, 131, 157) | 1.0 |
| bank p10 (x .28–1, y .75–1) | (115, 114, 123) | (123, 120, 129) | 6.7 |
| bank p50 (x .28–1, y .75–1) | (145, 134, 136) | (161, 148, 149) | 14.4 |
| bank p90 (x .28–1, y .75–1) | (210, 175, 154) | (216, 177, 155) | 3.7 |
| cloudlets p50 (x .6–1, y .25–.5) | (166, 156, 158) | (170, 158, 161) | 3.1 |
| cloudlets p95 (x .6–1, y .25–.5) | (216, 185, 166) | (222, 186, 163) | 3.9 |
| moon lit mean (L>170) | (210, 193, 184) | (210, 194, 181) | 1.8 |

Небо в центральной полосе (x 0.40–0.65, y 0…0.40): RMSE **1.1** против 22.3 у сырого v0 (v0 был перенасыщен, B ≈ 150–176 вместо 112–148).

Медиана банка светлее на ~15. Это осознанно. На референсе нижний ярус банка в серой дымке, а сгенерированный банк живее: освещённые макушки есть на всех ярусах. Если притушить его до референса, фактура пропадает и получается плоская серая стена (проверено: `depth_shade` 0.95 давал p50 RMSE 7, но выглядел мёртво).

## Обработка (`process_assets.py`)

- **Небо.**
  - Целевое поле — полином 3-й степени по чистым пикселям неба референса. Тайтл, UI и луна замаскированы. Остаток фита ≈ 2.6–3.5 уровня, это и есть зерно и JPEG.
  - Ниже 0.64 высоты небо скрыто банком, там поле мягко «выдыхается» в лавандово-серый.
  - Из v0-плашки берутся только мелкие детали: исходник минус его собственный гладкий фит 4-й степени. Хрома деталей ×0.45, сила ×0.8.
  - Сверху дизер σ0.6 против бандинга. `sky-tall` берёт участок поля x 0.25–0.95.
- **Облака.**
  - Альфа: пол шума 0.05, удаление островков и дырок, гаусс σ (1.2 / 2.0 / 1.0 px для front / back / cloudlets) и подрезка обода.
  - Цвет: деспекл (медиана 5 px), push-pull деконтаминация.
  - Грейд: квантили яркости переводятся в квантили референса, цвет берётся из рампы референса и частично сохраняет свой оттенок.
  - `bank-front` (проход 2, без «цветной капусты»): после грейда — guided-сглаживание яркости в два прохода (`smooth` r3 eps10, `smooth2` r9 eps6 ×0.6). Мелкие повторяющиеся пупырышки уходят, зубчатый «гребешок» по краю клубов — наполовину, контуры самих клубов (большой перепад яркости) остаются. Локальный контраст ×1.2 на σ30 (было ×1.35 на σ10: он и раздувал пупырышки), блюр 0.7, край альфы σ1.6, апскейл почти чистый Lanczos (`us_mix` 0.1 вместо 0.5). Тело ниже огибающей горизонта тянется к тени референса (104,107,120), освещённые макушки остаются. Варианты (v0…v10) и сравнение 1:1 на ретине — `shots/v2-front-assets/bank/` (`retina-variants.png`, `before-after-retina-1to1.png`, `ref-scale-grid.png`). Сильнее (`smooth2` (9, 9, 1), blur 1.0) на ретине уже выглядит «не в фокусе».
  - `cloudlets-sparse-a/b`: как `cloudlets`, но дальше и в дымке: 12 % к цвету неба, лёгкое guided-сглаживание, блюр 0.9, край σ1.2, `us_mix` 0.2.
  - `foreground-a/b`: грейд под облачка референса, guided-сглаживание. `thin`: непрозрачность тонких мест падает до 0.6 / 0.45 (оценка «толщины» — размытая альфа, σ10 / σ14). Дефокус: гаусс по премультиплицированному RGBA σ3 / σ3.5 px исходника (край мягкий и без каймы), потолок альфы 0.94, у `-a` концы гаснут к краям картинки (10 %). Апскейл — только Lanczos.
  - `bank-back`: дымка 38 % к небу на высоте 0.62, контраст ×0.7, блюр 1.1.
  - Апскейл ×2: RGB делает Upscayl `ultrasharp` в смеси с Lanczos, доля ultrasharp своя у каждого слоя (`us_mix`, по умолчанию `US_MIX` 0.5; bank-front 0.1, россыпь 0.2, ближние 0). Альфа — свой Lanczos плюс гаусс (0.6, у ближних 1.0), Upscayl её не трогает.
- **Луна.**
  - Диск ищется по правому лимбу, терминатор по прямой. Кроп квадратом.
  - Альфа строится аналитически: мягкий лимб и мягкий терминатор, тёмная половина = 0.
  - Моря ×0.38, цвет крем (235,216,201), лёгкое затемнение к терминатору, дымка σ1.6, ореол 10 % у лимба.
  - Днём тёмные участки пропускают небо сильнее (альфа 0.8–1.0 по яркости).
- **WebP:** q90, `method=6`, альфа без потерь, `exact=True`. Если файл больше 700 KB, качество понижается, но сейчас все файлы < 280 KB.
- **Воспроизводимость:** полный прогон в пустую папку (`--out`) даёт все десять файлов байт-в-байт как в `public/assets/sky-layers/` (проверено после прохода 2).

## Генерации и выбор

Первый проход: **7 генераций Codex**, лимит 14. Ещё 6 сырых PNG — первый проход v0, без новых затрат. Второй проход (россыпь и ближний план): **6 генераций**, лимит 10 — промпты и выбор в конце файла.

Обёртка `gen.sh` добавляет к каждому промпту:
- в начало: `Use your built-in image generation tool (not code) to create exactly ONE image, size <size>, highest quality.`;
- для прозрачных: `The background must be fully TRANSPARENT (PNG with alpha channel): only the subject is opaque, soft natural edges, no sky color, no backdrop.`, для непрозрачных: `Full-frame opaque image.`;
- в конец: `No text, no watermark, no people, no birds, no airplanes. Save the resulting PNG … as <name>.png …`.

Промпты ниже — ровно то, что получил генератор (`DRY=1 generate.sh …`):

### `sky-wide` — 1536x1024, opaque → sky-wide.webp (грейд)
_v0, только грейд под поле неба референса_

```text
A clean evening sky plate looking slightly upward: smooth natural gradient from deep dusty steel blue at the top to soft pale dusty blue with a hint of lavender near the bottom edge; only a handful of very small, thin, scattered high cloudlets in the middle band, lit faintly peach; mostly open sky. No big clouds, no moon, no sun disc. Photorealistic, like a real photograph taken with a full-frame camera at golden hour shortly before sunset, low sun behind the viewer to the right; colour palette: dusty steel-blue sky, clouds lit warm peach and apricot on their sunlit tops, cool blue-grey and lavender shaded undersides, soft atmospheric haze.
```

### `sky-tall` — 1024x1536, opaque → sky-tall.webp (грейд)
_v0, только грейд под поле неба референса_

```text
A clean evening sky plate looking slightly upward, portrait orientation: smooth natural gradient from deep dusty steel blue at the top to soft pale dusty blue with a hint of lavender near the bottom edge; only a handful of very small, thin, scattered high cloudlets in the middle, lit faintly peach; mostly open sky. No big clouds, no moon, no sun disc. Photorealistic, like a real photograph taken with a full-frame camera at golden hour shortly before sunset, low sun behind the viewer to the right; colour palette: dusty steel-blue sky, clouds lit warm peach and apricot on their sunlit tops, cool blue-grey and lavender shaded undersides, soft atmospheric haze.
```

### `moon-a` — 1024x1024, transparent → —
_не взят: терминатор рваный, тёмная полоса; на размере ~60–120 px разницы с b нет, b чище_

```text
A photograph of the FIRST-QUARTER HALF MOON in the evening daylight sky: exactly half of the lunar disc is lit, the RIGHT half, and the boundary between lit and unlit parts (the terminator) is a perfectly straight vertical line through the centre of the disc, so the lit part looks like a capital letter D. The LEFT unlit half is completely absent: fully transparent, no grey disc, no earthshine, no outline, nothing. The lit half is warm pale cream with a faint peach tint, soft and slightly hazy as seen through the evening atmosphere, with subtle faint grey maria and soft crater texture getting a little darker toward the straight terminator, low contrast, a gently softened (not razor sharp) curved limb on the right. The disc is centred in the frame; the full disc diameter would be about 70 percent of the frame width. Photorealistic, like a real 35mm film photograph, soft and slightly hazy, low contrast, natural (not over-sharpened, not HDR, not CGI). Only the moon, no clouds, no stars, no sky.
```

### `moon-b` — 1024x1024, transparent → **moon.webp**
_взят: ровная первая четверть, чистый прямой терминатор_

```text
A realistic half moon (first quarter phase) photographed through a telephoto lens in the blue evening sky before sunset: a D-shaped half disc, the RIGHT half illuminated, its flat left side is a straight vertical terminator line exactly through the centre of the disc; the left half of the moon is invisible (in daylight the dark side cannot be seen), so it must be fully transparent. Warm cream-ivory colour with a slight peach cast from the low sun, delicate pale grey maria, a few soft craters near the terminator, slightly hazy and soft, low contrast. The full lunar disc (including the invisible half) is centred and would span about 70 percent of the frame width. Photorealistic, like a real 35mm film photograph, soft and slightly hazy, low contrast, natural (not over-sharpened, not HDR, not CGI). Only the moon, no clouds, no stars, no sky.
```

### `cloudlets-a` — 1536x1024, transparent → **cloudlets.webp**
_взят: облачка разного размера, спокойные, с персиковыми верхушками. Верхнее облачко-«птица» (центр в x 0.34–0.50, y 0.19–0.40) скрипт убирает (`LAYER['cloudlets']['drop']`): оно читалось как силуэт. Осталось 6._

```text
Five to seven small, separate fair-weather cumulus cloudlets floating in open air, widely spaced with plenty of empty space between them, varied sizes: one or two medium puffy ones (each about one fifth of the frame width), the rest small soft puffs and tiny fragments; loosely scattered across the middle band of the frame, nothing touching the frame edges. Soft, calm, slightly hazy, delicate cloud texture as seen from far away, softly diffused edges (not crisp, not cut-out). Tops lit in muted pale peach / apricot-cream, undersides soft blue-grey and lavender-grey. Photorealistic, like a real 35mm film photograph of the sky in the evening shortly before sunset, low warm sun; soft, muted, slightly hazy light; colour palette: sunlit cloud tops in muted pale peach / salmon-cream (pinkish apricot, never yellow, never orange, not saturated), shaded parts in soft blue-grey and mauve-grey, gentle atmospheric haze, low contrast, natural soft photographic detail (not over-sharpened, not HDR, not CGI).
```

### `cloudlets-b` — 1536x1024, transparent → —
_не взят: облачка выстроились в искусственную диагональ_

```text
A sparse handful (about six) of small soft cumulus humilis cloudlets drifting in a loose diagonal line from the upper left to the lower right of the frame, generous empty gaps between them, sizes from tiny wisps to one modest rounded puff about one sixth of the frame width; none of them touches the frame edges. Distant, gentle and hazy, softly diffused fluffy edges, calm and quiet, not dramatic. Tops softly lit muted peach, bases cool blue-grey. Photorealistic, like a real 35mm film photograph of the sky in the evening shortly before sunset, low warm sun; soft, muted, slightly hazy light; colour palette: sunlit cloud tops in muted pale peach / salmon-cream (pinkish apricot, never yellow, never orange, not saturated), shaded parts in soft blue-grey and mauve-grey, gentle atmospheric haze, low contrast, natural soft photographic detail (not over-sharpened, not HDR, not CGI).
```

### `bank-front-a` — 1536x1024, transparent → **bank-front.webp**
_взят: плотная стена на всю ширину, пик слева от центра; лучше всего держит плотную полосу снизу, как на референсе_

```text
A dense, wide bank of big rounded cumulus clouds (cumulus congestus heaps) seen from a distance, rising from the bottom edge of the frame as one continuous wall that fills the lower half of the frame and touches the left, right and bottom edges with no gaps; its skyline is uneven: the tallest heaps are LEFT of centre and reach up to about 40 percent from the top of the frame, elsewhere the top edge sits at about 55 to 60 percent from the top, with smaller rounded domes along it. Large soft rounded billows, sunlit tops in muted peach / salmon-cream, shaded sides and lower parts in soft blue-grey and mauve-grey, atmospheric haze softening the lower and farther parts. The upper part of the frame is empty. Photorealistic, like a real 35mm film photograph of the sky in the evening shortly before sunset, low warm sun; soft, muted, slightly hazy light; colour palette: sunlit cloud tops in muted pale peach / salmon-cream (pinkish apricot, never yellow, never orange, not saturated), shaded parts in soft blue-grey and mauve-grey, gentle atmospheric haze, low contrast, natural soft photographic detail (not over-sharpened, not HDR, not CGI).
```

### `bank-front-b` — 1536x1024, transparent → —
_не взят: один пик слева, правая часть слишком низкая (на композите справа «дыра»)_

```text
A photographic cloudscape layer: a thick, continuous bank of large fluffy cumulus clouds seen from far away at eye level, filling the bottom 45 percent of a wide frame and touching the left, right and bottom edges with no gaps; gentle uneven skyline of big rounded heaps, the highest heap about one third from the left reaching about 40 percent from the top, a lower broad dome right of centre, smaller puffs between. Soft billowing texture, sunlit upper surfaces muted peach and pale apricot-cream, lower and shaded parts dusty blue-grey with a hint of lavender, slight haze, low contrast. The upper part of the frame is empty. Photorealistic, like a real 35mm film photograph of the sky in the evening shortly before sunset, low warm sun; soft, muted, slightly hazy light; colour palette: sunlit cloud tops in muted pale peach / salmon-cream (pinkish apricot, never yellow, never orange, not saturated), shaded parts in soft blue-grey and mauve-grey, gentle atmospheric haze, low contrast, natural soft photographic detail (not over-sharpened, not HDR, not CGI).
```

### `bank-back-v0` — 1536x1024, transparent → **bank-back.webp**
_взят (v0): после дымки/блюра — фактурный далёкий банк с персиковыми макушками_

```text
A distant, long, low bank of cumulus clouds stretching across the full width of the frame along the bottom third, seen far away: softer, hazier and more blue-grey than near clouds, only the tops catching faint peach light; the bank touches the left, right and bottom edges of the frame so it can be tiled horizontally. Photorealistic, like a real photograph taken with a full-frame camera at golden hour shortly before sunset, low sun behind the viewer to the right; colour palette: dusty steel-blue sky, clouds lit warm peach and apricot on their sunlit tops, cool blue-grey and lavender shaded undersides, soft atmospheric haze.
```

### `bank-back-a` — 1536x1024, transparent → —
_не взят: гладкая плоская лавандовая масса, в композите читается как туман_

```text
A distant, long, low bank of soft cumulus clouds far away near the horizon, stretching across the full width of the frame and touching the left, right and bottom edges; its uneven top edge sits at about half of the frame height, with a few gentle rounded domes rising to about 40 percent from the top. Very soft and hazy, softened by thick atmospheric perspective, low contrast, mostly pale lavender-grey and dusty blue-grey with only a faint pale peach glow on the highest tops; indistinct, diffuse edges. The upper half of the frame is empty. Photorealistic, like a real 35mm film photograph of the sky in the evening shortly before sunset, low warm sun; soft, muted, slightly hazy light; colour palette: sunlit cloud tops in muted pale peach / salmon-cream (pinkish apricot, never yellow, never orange, not saturated), shaded parts in soft blue-grey and mauve-grey, gentle atmospheric haze, low contrast, natural soft photographic detail (not over-sharpened, not HDR, not CGI).
```

Сравнивались, но не используются: `bank-front-v0` (жёлто-белый, «хрустящий», пик справа), `cloudlets-v0` (слишком много облачков, оранжевые), `moon-v0` (не та фаза: растущая, ~65 %, с серой тёмной стороной).

## Проход 2: россыпь облачков и ближний план (6 генераций)

Запрос: «облака на самом ближнем плане могут перекрывать надпись» + ревью «мало облаков в середине неба: чистое небо и сразу стена». Варианты выбирались композитом 1384×914 рядом с референсом (`shots/v2-front-assets/`).

### `cloudlets-sparse-a` — 1536x1024, transparent → **cloudlets-sparse-a.webp**
_взят: ровное поле из ~45 облачков по всему кадру, книзу гуще. Целиком на всю ширину читается как «горошек» — лучше на боках / частично (превью: слева под «S», width 55)_

```text
A loose scattered field of MANY (about thirty to forty) small, fragmented fair-weather cumulus cloudlets (cumulus humilis and ragged cumulus fractus) seen from far away, spread irregularly over the whole frame: tiny specks and thin wisps, small soft puffs and a few little ragged clusters, the biggest cloudlet only about one tenth of the frame width; NO large clouds, no cloud bank, no solid mass. Irregular, natural spacing with open gaps between them (no rows, no grid, no diagonal line, no pattern); slightly more numerous and a little bigger toward the bottom of the frame, sparser and tinier toward the top; nothing touches the frame edges. Soft, hazy, slightly diffused edges, thin parts partly translucent, as seen through evening haze. Tops lit by the low sun in muted pale peach / apricot-cream, undersides soft blue-grey and lavender-grey. Photorealistic, like a real 35mm film photograph of the sky in the evening shortly before sunset, low warm sun; soft, muted, slightly hazy light; colour palette: sunlit cloud tops in muted pale peach / salmon-cream (pinkish apricot, never yellow, never orange, not saturated), shaded parts in soft blue-grey and mauve-grey, gentle atmospheric haze, low contrast, natural soft photographic detail (not over-sharpened, not HDR, not CGI).
```

### `cloudlets-sparse-b` — 1536x1024, transparent → **cloudlets-sparse-b.webp**
_взят (основной): полоса, книзу гуще и крупнее — небо постепенно сгущается к валу, как на референсе_

```text
A wide, loose, patchy band of broken fair-weather cumulus: about thirty to forty small separate cloudlets and fragments scattered across the full width of the frame through its middle and lower half, like the scattered small clouds that float above a distant cloud bank; patchy and irregular, small soft puffs, little broken clusters of two or three puffs, ragged wisps and tiny specks, with open gaps of empty air between them; the band gets denser, hazier and slightly bigger toward its lower edge and thins out into tiny scattered specks toward its upper edge; no large clouds, nothing touching the frame edges, the top quarter of the frame is empty. Soft hazy diffused edges, delicate, partly translucent thin parts, far away. Tops lit in muted pale peach / salmon-cream, undersides soft blue-grey and mauve-grey. Photorealistic, like a real 35mm film photograph of the sky in the evening shortly before sunset, low warm sun; soft, muted, slightly hazy light; colour palette: sunlit cloud tops in muted pale peach / salmon-cream (pinkish apricot, never yellow, never orange, not saturated), shaded parts in soft blue-grey and mauve-grey, gentle atmospheric haze, low contrast, natural soft photographic detail (not over-sharpened, not HDR, not CGI).
```

### `foreground-a` — 1536x1024, transparent → —
_не взят как основной: толстая полоса во всю ширину закрывала VOLKOV почти целиком (туман). Сырьё лежит: `--pick foreground-a=foreground-a` (тогда лучше thin (0.45, 14), defocus 3.5)_

```text
One long soft wisp band of cloud very close to the camera, drifting horizontally across the whole width of the frame through its middle, slightly out of focus (shallow depth of field, like a telephoto shot focused on something farther away), so all its edges are soft and blurred: a stretched, uneven streamer of cloud with a few thicker soft puffy knots and thin, translucent, veil-like stretches between them, frayed wispy ends, its height varying from very thin to about one fifth of the frame height; the band reaches the left and right frame edges; above and below it the frame is empty (more than two thirds of the frame is empty). The thick parts are lit softly in muted pale peach / apricot-cream on top, shaded soft blue-grey and lavender-grey below; the thin veils are pale and semi-transparent. Photorealistic, like a real 35mm film photograph of the sky in the evening shortly before sunset, low warm sun; soft, muted, slightly hazy light; colour palette: sunlit cloud tops in muted pale peach / salmon-cream (pinkish apricot, never yellow, never orange, not saturated), shaded parts in soft blue-grey and mauve-grey, gentle atmospheric haze, low contrast, natural soft photographic detail (not over-sharpened, not HDR, not CGI).
```

### `foreground-a2` — 1536x1024, transparent → **foreground-a.webp**
_взят: тонкая рваная полоса с 2–3 плотными узлами — пересекает буквы, но надпись читается_

```text
A few long, thin, torn wisps of cloud (cumulus fractus streamers) very close to the camera, stretched horizontally across the frame through its middle as one loose, broken band with gaps in it, slightly out of focus (shallow depth of field, focused far behind them) so they look soft and blurred; mostly thin and translucent like veils of mist, with only two or three small denser soft knots; frayed, tapering ends; the band is thin, about one eighth of the frame height at its thickest; the frame above and below the band is empty (more than three quarters of the frame is empty). Denser knots lit softly in muted pale peach on top, shaded soft blue-grey and lavender-grey below; the thin veils pale and semi-transparent. Photorealistic, like a real 35mm film photograph of the sky in the evening shortly before sunset, low warm sun; soft, muted, slightly hazy light; colour palette: sunlit cloud tops in muted pale peach / salmon-cream (pinkish apricot, never yellow, never orange, not saturated), shaded parts in soft blue-grey and mauve-grey, gentle atmospheric haze, low contrast, natural soft photographic detail (not over-sharpened, not HDR, not CGI).
```

### `foreground-b` — 1536x1024, transparent → **foreground-b.webp**
_взят: две мягкие тучки естественной формы_

```text
Two or three separate soft cumulus puffs floating very close to the camera, slightly out of focus (shallow depth of field, focused far behind them), so their edges are soft and blurred, with thin translucent wispy fringes; irregular natural shapes, not round cartoon clouds: one medium puff in the lower left part of the frame (about one third of the frame width), one smaller flatter puff right of centre a bit higher, optionally one small wisp near the right; widely spaced, with large empty areas between and around them (more than two thirds of the frame is empty); nothing touches the frame edges. Sunlit tops in muted pale peach / apricot-cream, shaded sides and bases soft blue-grey and lavender-grey, gentle haze. Photorealistic, like a real 35mm film photograph of the sky in the evening shortly before sunset, low warm sun; soft, muted, slightly hazy light; colour palette: sunlit cloud tops in muted pale peach / salmon-cream (pinkish apricot, never yellow, never orange, not saturated), shaded parts in soft blue-grey and mauve-grey, gentle atmospheric haze, low contrast, natural soft photographic detail (not over-sharpened, not HDR, not CGI).
```

### `foreground-b2` — 1536x1024, transparent → —
_не взят: «хвосты» тучек как дым / щупальца, тёмные прожилки_

```text
Three small, separate, ragged cumulus fractus puffs floating very close to the camera, slightly out of focus (shallow depth of field, focused far behind them): soft blurred edges and thin translucent wispy tails trailing to one side; irregular torn shapes, not round cartoon clouds; each about one fifth to one quarter of the frame width; loosely spaced across the middle of the frame at slightly different heights, with large empty gaps between them; nothing touches the frame edges; more than three quarters of the frame is empty. Sunlit tops in muted pale peach / apricot-cream, shaded sides and bases soft blue-grey and lavender-grey. Photorealistic, like a real 35mm film photograph of the sky in the evening shortly before sunset, low warm sun; soft, muted, slightly hazy light; colour palette: sunlit cloud tops in muted pale peach / salmon-cream (pinkish apricot, never yellow, never orange, not saturated), shaded parts in soft blue-grey and mauve-grey, gentle atmospheric haze, low contrast, natural soft photographic detail (not over-sharpened, not HDR, not CGI).
```
