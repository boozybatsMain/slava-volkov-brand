#!/usr/bin/env bash
# Shimmer at a FIXED pose (?pointer pinned, energy forced by ?rtenergy) → consecutive frames differ
# only by edge instability.   scripts/title-raster/shimmer_set.sh <label> [extra-query]
cd "$(dirname "$0")/../.."
O=shots/title-polish/$1; mkdir -p $O
U="http://localhost:${PORT:-5185}/?title=raster&pointer=0.3,-0.2&rtenergy=0.8$2"
node scripts/shot.mjs --url "$U" --mouse "0.3,-0.2;0.3,-0.2" --moveMs 50 --frames 12 --every 75 --cols 4 --clip 380,280,300,150 --out $O/sh_SL.png >/dev/null &
node scripts/shot.mjs --url "$U" --mouse "0.3,-0.2;0.3,-0.2" --moveMs 50 --frames 12 --every 75 --cols 4 --clip 1050,330,300,150 --out $O/sh_VOL.png >/dev/null &
U0="http://localhost:${PORT:-5185}/?title=raster&pointer=0.3,-0.2&rtenergy=0$2"
node scripts/shot.mjs --url "$U0" --mouse "0.3,-0.2;0.3,-0.2" --moveMs 50 --frames 12 --every 75 --cols 4 --clip 380,280,300,150 --out $O/sh_SL_rest.png >/dev/null &
wait
