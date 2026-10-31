# projects / tools — картинки второго экрана

Всё, что второй экран `index.html` берёт из файлов: пять картинок проектов (`public/assets/projects/`) и четыре картинки слоя `veil` — белая пустота, стена облаков и клок тумана (`public/assets/sky-layers/`). Все девять файлов полностью воспроизводятся скриптами. Нужно только сырьё в `$GEN_DIR` (по умолчанию `./.gen-work`, в git не попадает).

| файл | назначение |
|---|---|
| `gen.sh` | одна генерация «скриншота из игры» через Codex CLI: `gen.sh <name> <size> "<prompt>"` → `$GEN_DIR/<name>/<name>.png` (своя обёртка: с персонажами и HUD) |
| `generate.sh` | точные промпты пяти картинок проектов; `generate.sh <name>…` запускает их параллельно; `DRY=1` только печатает промпты |
| `generate-void.sh` | точные промпты плашек пустоты (`void-wide`, `void-tall`); генерирует через `../../sky-layers/tools/gen.sh … opaque` |
| `process_projects.py` | сырьё → `public/assets/projects/*.webp` + превью и цифры в `shots/v3-projects/assets/` |
| `../../sky-layers/tools/process_veil.py` | сырьё → `public/assets/sky-layers/{void-wide,void-tall,veil-wall,veil-wisp}.webp` + превью и цифры там же |

```sh
# из корня проекта
GEN_DIR=$PWD/.gen-work src/layers/projects/tools/generate.sh wildfire          # ≈2 мин, тратит лимит подписки
GEN_DIR=$PWD/.gen-work src/layers/projects/tools/generate-void.sh void-wide void-tall
python3 src/layers/projects/tools/process_projects.py                          # 5 картинок, ≈10 с
python3 src/layers/sky-layers/tools/process_veil.py                            # 4 картинки veil, ≈15 с
python3 src/layers/sky-layers/tools/process_veil.py --only veil-wall --out /tmp/x --shots /tmp/x/s   # проба
python3 src/layers/sky-layers/tools/process_veil.py --measure                  # рампа пустоты референса
```

Генерации не детерминированы: если `.gen-work` потерян, повторная генерация даст другие картинки, и числа ниже (HUD, горизонт, гребень) придётся перемерить. Обработка детерминирована: повторный прогон в пустую папку (`--out`) даёт все девять файлов байт-в-байт.

`process_veil.py` берёт помощников (альфа, деконтаминация, грейд) из `process_assets.py`, но его `main()` / `preview()` не вызывает: они переписывают слои первого экрана.

## Финальные файлы

| файл | размер | KB | кадр (доли картинки) |
|---|---|---|---|
| `projects/take-the-elevator.webp` | 1536×864 RGB | 217 | окно сырья y 80…944 (середина) |
| `projects/midnight-apex.webp` | 1536×864 RGB | 227 | окно y 70…934 (сдвиг вверх на 10 px) |
| `projects/snowball.webp` | 1536×864 RGB | 196 | окно y 80…944 |
| `projects/wildlife.webp` | 1536×864 RGB | 222 | окно y 45…909 (сдвиг вверх на 35 px) |
| `projects/wildfire.webp` | 1536×864 RGB | 215 | окно y 65…929 (сдвиг вверх на 15 px) |
| `sky-layers/void-wide.webp` | 1536×1024 RGB | 17 | непрозрачная плашка 3:2; горизонт пола 0.76, пол проявляется к 0.86; радужные блики: дуга внизу по центру (x 0.45–0.56, y 0.88–0.96, насыщенность до 21) и слабая полоса слева (x 0.06–0.25, y 0.83–0.90, до 15) |
| `sky-layers/void-tall.webp` | 1024×1536 RGB | 16 | непрозрачная плашка 2:3; горизонт 0.80, пол к 0.90; блики: слева (x 0–0.14, y 0.86–0.90, до 23) и внизу по центру (x 0.43–0.53, y 0.89–0.96, до 17) |
| `sky-layers/veil-wall.webp` | 1536×1024 RGBA | 36 | **стена**: bbox x 0–1, y 0.092–1; гребень (альфа > 0.5, min / медиана / max) 0.092 / 0.312 / 0.409, видимый край (альфа > 3 %) 0.079 / 0.293 / 0.393; вершина на x 0.334 (с `flipX` — 0.666); с 0.68 альфа 1, тело облака (мягкие складки — зеркальное продолжение сырья) идёт до 0.95, ниже 0.98 — ровный цвет; пустого 26 % |
| `sky-layers/veil-wisp.webp` | 1536×1024 RGBA | 44 | **клок**: одна мягкая полоса, bbox x 0.070–0.930, y 0.386–0.658; видимая часть (альфа > 3 %) x 0.016–0.985, y 0.363–0.679; центр масс (0.50, 0.54); края кадра пустые; пустого 82 % |

Гребень стены по десятым долям ширины (слева направо, без `flipX`): 0.31, 0.24, 0.12, 0.09, 0.15, 0.33, 0.32, 0.28, 0.29, 0.36. У левого края кадра облако начинается с 0.34, у правого — с 0.38.

Для рендерера (`sky.config → veil.layers`):
- **Стена — kind `'bank'` с `solid`.** Вершина гребня стоит у самого верха кадра (0.09), а не на 0.38, как в сырье: `anchor.y 0` и `y` слоя задают почти сам гребень. На экране гребень = `y − подъём + 0.092…0.409 × высота картинки` (при `width 150` на 1440×900 высота картинки — 160 % высоты экрана: вершина на 14.7 % ниже верха картинки, медиана гребня — на 50 %). `feather` до 0.07 гребень не трогает.
- **Низ стены.** С 0.98 высоты и до конца — один цвет и альфа 1: нижнюю строку можно тянуть вниз сколько угодно. (До правки 2026-10-11 ровная заливка начиналась с 0.70, и на телефоне, где стена втрое шире экрана, две трети кадра на pos 0.30–0.36 занимал ровный лист; теперь под последней строкой сырья тело облака продолжается его зеркальным отражением, складки гаснут к 0.95 — `CURTAIN['veil-wall']`: `fade`, `flat_y`, `full_y`.) После WebP это (237, 235, 233), а не ровно `#ecebea` (236, 235, 234): ±1 уровень от перевода в YUV.
- **Бока стены** доходят до краёв кадра: зеркальный повтор (`seam 0`) идёт без шва.
- **Клок — kind `'clouds'`.** Концы полосы растворяются (14 % ширины с каждой стороны), сверху и снизу пусто по трети кадра: `feather` до 0.1 ничего не срезает. Тонкие места полупрозрачны (до 0.5), надпись и подзаголовок сквозь них видны.
- **Края без ореолов.** RGB под прозрачными пикселями — продолжение цвета облака (push-pull), WebP сохранён с `exact`.
- **Пустота.** Яркость и цвет подогнаны к референсу (таблица ниже); ничего темнее 203. Зерно не запечено — его даёт слой. Плавные контуры WebP (до 1 уровня по яркости, до 2.4 по R−B) под зерном `veil.grain` 0.008 не видны; при зерне 0 на ровных местах можно разглядеть мягкие пятна. Нужна ровно 8-битная гладкость — сохранять без потерь (148 KB вместо 17).
- **Горизонт на экране.** Плашка 3:2 обрезается по высоте (cover): 0.76 в файле = ≈ 0.78 на 16:10, ≈ 0.81 на 16:9, ≈ 0.91 на 21:9. Телефон показывает вертикальную плашку целиком: 0.80.

## Картинки проектов: HUD и кадр

Это заглушки — «скриншоты из игры» по описаниям проектов; клиент заменит их настоящими кадрами (16:9, файл с тем же именем или другое `src` в `sky.config → projects.items`).

Плита показывает не весь кадр, а грань `projects.slab.aspect` (1.9:1 на десктопе, обрезка сверху и снизу; 1.45:1 на телефоне, обрезка с боков) вокруг `focus`. Поэтому окно 16:9 вырезается из сырья 3:2 не всегда посередине: `process_projects.py → crop_y` сдвигает его, если иначе HUD оказался бы ближе 5 % высоты грани к её краю (`HUD` — замеренные рамки элементов в сырье).

| картинка | HUD, доли финального кадра (u0, v0 – u1, v1) | до края грани 1.9:1, px (верх / низ) | уже какой грани HUD не входит |
|---|---|---|---|
| `take-the-elevator` | сердца 0.123, 0.101 – 0.225, 0.152; миникарта 0.842, 0.352 – 0.941, 0.527 | 59 / 381 | 1.55 |
| `midnight-apex` | круг 2/3 0.124, 0.056 – 0.195, 0.095; трасса 0.794, 0.050 – 0.906, 0.225; скорость 217 0.779, 0.826 – 0.922, 0.951 | 15 / 14 | 1.52 |
| `snowball` | счёт 148 0.090, 0.082 – 0.204, 0.169; рейтинг 0.841, 0.091 – 0.921, 0.219 | 43 / 647 | 1.58 |
| `wildlife` | день/ночь 0.093, 0.079 – 0.166, 0.215; счётчики 0.657, 0.109 – 0.917, 0.164; мысль жирафа 0.468, 0.403 – 0.499, 0.468 | 40 / 432 | 1.56 |
| `wildfire` | топливо 0.100, 0.873 – 0.247, 0.935; миникарта 0.848, 0.065 – 0.957, 0.259 | 28 / 28 | 1.62 |

- `midnight-apex`: HUD занимает 96 % высоты грани 1.9:1 — отступы по 15 px (2 %), больше из этого сырья не получить. Окно по умолчанию оставляло сверху 5 px.
- `wildlife`: в окне по умолчанию циферблат стоял в 5 px от верха грани; `wildfire`: миникарта в 13 px.
- **Телефон.** Грань 1.45:1 при `focus.x 0.5` показывает столбцы 0.092…0.908 кадра: у каждой из пяти картинок крайний элемент HUD режется или касается края (миникарта `take-the-elevator` — на треть, `wildfire` — наполовину). HUD целиком с отступами входит только в грань не уже 1.52…1.62 (последний столбец).
- Превью: `projects-sheet.png` (жёлтое — HUD, голубое — грань 1.9:1, пурпурное — 1.45:1), `projects-lowres.png` (грубая прикидка «плохого рендера»: 540 px, 5 бит).

## Цвет пустоты: референс и плашка

Средняя яркость по сетке 5×5 кадра 16:9 (плашка обрезана как на экране; у референса — `reference/projects-screen.png` без экрана, текстов и тени):

| y \ x | 0–0.2 | 0.2–0.4 | 0.4–0.6 | 0.6–0.8 | 0.8–1 |
|---|---|---|---|---|---|
| 0–0.2 | 213 → **211** | 215 → **221** | 226 → **222** | 233 → **235** | 240 → **246** |
| 0.2–0.4 | 221 → **218** | — | — | 234 → **238** | 241 → **246** |
| 0.4–0.6 | 227 → **223** | — | — | — | 245 → **240** |
| 0.6–0.8 | 225 → **227** | — | 235 → **232** | 237 → **242** | 241 → **235** |
| 0.8–1 (пол) | 199 → **221** | (тень) → **223** | 200 → **226** | 217 → **238** | 232 → **237** |

Рампа плашек: верх (y 0–0.2) `#e2e1e4` 225, середина (0.4–0.6) `#eceaea` 234 / `#eae8e8` 232 (tall), пол (0.85–1) `#e1dfe2` 224 / `#e5e1e5` 226; слева холоднее (верх-лево (210, 210, 217)), справа теплее и светлее всего (248, 246, 242). Яркость min / p1 / p50 / p99 / max: 203 / 206 / 230 / 248 / 251. Средний цвет `#e7e5e7` (у `veil.color` `#ecebea`). Насыщенность (max − min канала): небо p50 4, p95 8 — как у референса; блики на полу до 21–23 (у референса 21–28).

Пол светлее референса намеренно: там он затемнён тенью экрана, а тень теперь рисует слой `slab`.

## Обработка

- **Картинки проектов** (`process_projects.py`): только окно 16:9 и WebP `method=6` от q 86 вниз по 3, пока файл больше 250 KB (вышло q 80–86). Без резкости, апскейла и грейда.
- **Пустота** (`process_veil.py → make_void`):
  - горизонт пола переставляется на нужную высоту (0.70 → 0.76, вертикальная 0.75 → 0.80): небо растягивается, пол сжимается; излом приходится на полосу дымки;
  - небо размывается до больших мягких пятен (σ 24) и получает обратно 35 % средней фактуры (σ 7); пол размыт слабо (σ 2.5) и проявляется из дымки постепенно (от 0.01 выше горизонта до 0.10 ниже);
  - грейд: квантили яркости → квантили пустоты референса (без тени экрана; низ поднят до 205) гладкой кривой PCHIP — у кусочно-линейной кривой на таком градиенте видны изломы; цвет — рампа референса, своего оттенка 30 % в небе и 65 % на полу (блики);
  - WebP q 92, без запечённого дизера.
- **Стена и клок** (`curtain`): чистая альфа (`refine_alpha`), деспекл, деконтаминация; грейд к рампе облачков первого экрана, подтянутой к белому (тени на 0.48, света на 0.86; у клока тени на 0.60); guided-сглаживание; локальный контраст ×1.3 (клок ×1.2) на σ 25.
  - Стена: сдвиг вверх (вершина на 0.09), тело светлеет к `veil.color` от гребня до 0.68, дефокус σ 7 по премультиплицированному RGBA, ниже 0.70 — ровный цвет. Яркость p2 / p50 / p98: 209 (207, 209, 220) / 228 (237, 226, 224) / 243 (254, 240, 227).
  - Клок: тонкие места до 0.5 (оценка толщины σ 18), дырки и клочки мельче 900 px² убраны, концы растворяются, дефокус σ 7. Яркость 207 / 226 / 244.
  - WebP q 90, альфа без потерь, `exact`. Без апскейла.

## Генерации и выбор

**7 генераций Codex** из 12: пять картинок проектов и две плашки пустоты. Стена и клок сделаны из сырья первого экрана (`bank-front-b`, `foreground-a` — оба там в финал не пошли), новых генераций нет. Повторов не было.

Обёртки: у картинок проектов — `gen.sh` из этой папки (промпты — в `generate.sh`, `DRY=1 generate.sh <name>`); у пустоты — `sky-layers/tools/gen.sh … opaque` (в начало `Use your built-in image generation tool (not code) to create exactly ONE image, size <size>, highest quality.`, в конец `Full-frame opaque image. No text, no watermark, no people, no birds, no airplanes. Save the resulting PNG …`).

Промпты пустоты — ровно то, что получил генератор (`DRY=1 generate-void.sh void-wide void-tall`):

### `void-wide` — 1536x1024, opaque → **void-wide.webp**
_взят с первой попытки: высокий ключ, слева холоднее, справа теплее, глянцевый пол с двумя радужными бликами; горизонт вышел на 0.70 — переставлен на 0.76_

```text
An endless bright white void, like standing inside a thin luminous cloud: almost uniform soft white, with large, blurry, very low-contrast patches of pearl-grey and faint lavender mist drifting through it; a little cooler and greyer toward the upper left, warmer and brightest toward the right, as if lit softly from the right. No distinct cloud shapes, only haze. In the lower fifth of the frame, a hint of a vast, smooth, glossy pale floor (like wet polished pale stone under thin mist) that reflects the white haze in soft blurred streaks and dissolves into the mist with no hard line; on the floor two or three very faint, blurred prismatic lens flares (pastel rainbow streaks, barely saturated), one near the lower left, one near the bottom centre. The horizon is barely visible, at about 78 percent from the top. No objects, no sun disc, no shadows, no dark corners, no vignette, nothing darker than light grey anywhere. High-key photograph, extremely low contrast, soft and slightly hazy (not HDR, not CGI).
```

### `void-tall` — 1024x1536, opaque → **void-tall.webp**
_взят с первой попытки; горизонт вышел на 0.75 — переставлен на 0.80_

```text
Portrait orientation. An endless bright white void, like standing inside a thin luminous cloud: almost uniform soft white, with large, blurry, very low-contrast patches of pearl-grey and faint lavender mist drifting through it; a little cooler and greyer toward the upper left, warmer and brightest toward the right, as if lit softly from the right. No distinct cloud shapes, only haze. In the lowest sixth of the frame, a hint of a vast, smooth, glossy pale floor (like wet polished pale stone under thin mist) that reflects the white haze in soft blurred streaks and dissolves into the mist with no hard line; on the floor two or three very faint, blurred prismatic lens flares (pastel rainbow streaks, barely saturated), one near the lower left, one near the bottom centre. The horizon is barely visible, at about 82 percent from the top. No objects, no sun disc, no shadows, no dark corners, no vignette, nothing darker than light grey anywhere. High-key photograph, extremely low contrast, soft and slightly hazy (not HDR, not CGI).
```

Сырьё стены и клока: промпты `bank-front-b` и `foreground-a` — в `../../sky-layers/tools/generate.sh` и README той папки.
