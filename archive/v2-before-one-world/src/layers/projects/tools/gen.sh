#!/bin/zsh
# gen.sh <name> <size> <prompt>  → $G/<name>/<name>.png via Codex image generation (подписка ChatGPT).
# Картинки проектов для экрана на втором экране: «скриншоты из игры» — с персонажами и HUD,
# поэтому своя обёртка (у sky-layers/tools/gen.sh в хвосте жёстко «no people»).
G=${GEN_DIR:-$PWD/.gen-work}
name=$1; size=$2; prompt=$3
mkdir -p $G/$name; cd $G/$name
codex exec --skip-git-repo-check --ephemeral --sandbox workspace-write -C "$G/$name" -o "$G/$name/last.txt" \
  "Use your built-in image generation tool (not code) to create exactly ONE image, size $size, highest quality. $prompt Full-frame opaque image, no borders, no letterboxing, no window chrome, no watermark, no logo, no caption, no readable words anywhere (HUD = icons and digits only). Save the resulting PNG into the current directory as $name.png (copy it from wherever the tool stores it). Reply with just the file path and its pixel size and mode." < /dev/null > $G/$name/run.log 2>&1
echo "$name exit $?"
