#!/usr/bin/env bash
# 1:1 device-pixel motion frames (dpr 2) of two edge regions during a real mouse sweep.
#   scripts/title-raster/motion_zoom.sh <label> [extra-query]
cd "$(dirname "$0")/../.."
O=shots/title-polish/$1; mkdir -p $O
M="http://localhost:${PORT:-5185}/?title=raster$2"
node scripts/shot.mjs --url "$M" --mouse "-0.9,0.7;0.9,-0.7" --moveMs 1000 --frames 12 --every 60 --cols 4 --clip 375,290,200,130 --out $O/mz_S.png >/dev/null &
node scripts/shot.mjs --url "$M" --mouse "0.9,-0.7;-0.9,0.7" --moveMs 1000 --frames 12 --every 60 --cols 4 --clip 1060,330,200,130 --out $O/mz_VOL.png >/dev/null &
wait
