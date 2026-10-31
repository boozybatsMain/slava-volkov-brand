#!/bin/zsh
# generate-void.sh <name> [<name> ...] — запускает sky-layers/tools/gen.sh (Codex image_generation, opaque)
# для плашек «белой пустоты» второго экрана параллельно и ждёт все. Промпты ниже — ровно те, что использованы
# (см. README.md: какой вариант пошёл в финал). Сырые PNG: $GEN_DIR/<name>/<name>.png (по умолчанию ./.gen-work).
# DRY=1 — только напечатать промпты. Один вызов ≈ 2 мин и тратит лимит подписки ChatGPT — не гонять без нужды.
#
# Обработка сырья → public/assets/sky-layers/void-{wide,tall}.webp: sky-layers/tools/process_veil.py.
# Стена и клок тумана (veil-wall / veil-wisp) генераций не требуют: они делаются из сырья первого экрана.
here=${0:A:h}
gen=$here/../../sky-layers/tools/gen.sh

# Общая «пустота» — по reference/projects-screen.png: высокий ключ, почти без контраста, слева холоднее,
# справа теплее; в нижней пятой — намёк на глянцевый пол с радужными бликами. Без предметов и без теней:
# тень экрана рисует сам слой slab.
VOID="An endless bright white void, like standing inside a thin luminous cloud: almost uniform soft white, with large, blurry, very low-contrast patches of pearl-grey and faint lavender mist drifting through it; a little cooler and greyer toward the upper left, warmer and brightest toward the right, as if lit softly from the right. No distinct cloud shapes, only haze."
FLOOR="a hint of a vast, smooth, glossy pale floor (like wet polished pale stone under thin mist) that reflects the white haze in soft blurred streaks and dissolves into the mist with no hard line; on the floor two or three very faint, blurred prismatic lens flares (pastel rainbow streaks, barely saturated), one near the lower left, one near the bottom centre."
TAIL="No objects, no sun disc, no shadows, no dark corners, no vignette, nothing darker than light grey anywhere. High-key photograph, extremely low contrast, soft and slightly hazy (not HDR, not CGI)."

typeset -A SIZE PRM

# --- горизонтальная плашка 3:2: пол — нижняя пятая, горизонт едва виден на ≈ 78 % высоты ---
SIZE[void-wide]=1536x1024
PRM[void-wide]="$VOID In the lower fifth of the frame, $FLOOR The horizon is barely visible, at about 78 percent from the top. $TAIL"

# --- вертикальная плашка 2:3 (телефон): та же пустота, пол ниже — горизонт на ≈ 82 % высоты ---
SIZE[void-tall]=1024x1536
PRM[void-tall]="Portrait orientation. $VOID In the lowest sixth of the frame, $FLOOR The horizon is barely visible, at about 82 percent from the top. $TAIL"

for n in "$@"; do
  if [[ -z ${PRM[$n]} ]]; then echo "unknown plate: $n"; continue; fi
  if [[ -n $DRY ]]; then print -r -- "$n | ${SIZE[$n]} | opaque | ${PRM[$n]}"; continue; fi
  "$gen" "$n" "${SIZE[$n]}" opaque "${PRM[$n]}" &
done
wait
