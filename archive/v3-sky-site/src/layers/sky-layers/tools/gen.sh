#!/bin/zsh
# gen.sh <name> <size> <transparent|opaque> <prompt>  → $G/<name>/<name>.png via Codex image generation
G=${GEN_DIR:-$PWD/.gen-work}
name=$1; size=$2; bg=$3; prompt=$4
mkdir -p $G/$name; cd $G/$name
if [ "$bg" = "transparent" ]; then bgtxt="The background must be fully TRANSPARENT (PNG with alpha channel): only the subject is opaque, soft natural edges, no sky color, no backdrop."; else bgtxt="Full-frame opaque image."; fi
codex exec --skip-git-repo-check --ephemeral --sandbox workspace-write -C "$G/$name" -o "$G/$name/last.txt" \
  "Use your built-in image generation tool (not code) to create exactly ONE image, size $size, highest quality. $prompt $bgtxt No text, no watermark, no people, no birds, no airplanes. Save the resulting PNG into the current directory as $name.png (copy it from wherever the tool stores it). Reply with just the file path and its pixel size and mode." < /dev/null > $G/$name/run.log 2>&1
echo "$name exit $?"
