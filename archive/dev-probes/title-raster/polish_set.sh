#!/usr/bin/env bash
# Repeatable before/after capture set for the raster title (polish pass).
#   scripts/title-raster/polish_set.sh <label> [port] [extra-query]
# Writes to shots/title-polish/<label>/
set -u
cd "$(dirname "$0")/../.."
L=${1:-cur}
PORT=${2:-5185}
EXTRA=${3:-}
O=shots/title-polish/$L
B="http://localhost:$PORT/?title=raster&freeze=3.5$EXTRA"
mkdir -p "$O"
S=scripts/shot.mjs
node $S --url "$B&pointer=0,0" --out $O/1440_p0,0.png &
node $S --url "$B&pointer=0.9,-0.8" --out $O/1440_p0.9,-0.8.png &
node $S --url "$B&pointer=-0.9,0.8" --out $O/1440_p-0.9,0.8.png &
node $S --url "$B&pointer=0.5,0.3" --out $O/1440_p0.5,0.3.png &
wait
# title-only @1x, for measuring tone against the reference
node $S --url "$B&layers=title&pointer=0,0" --dpr 1 --out $O/t1x_p0,0.png &
node $S --url "$B&layers=title&pointer=0.9,-0.8" --dpr 1 --out $O/t1x_p0.9,-0.8.png &
node $S --url "$B&layers=title&pointer=-0.9,0.8" --dpr 1 --out $O/t1x_p-0.9,0.8.png &
node $S --url "$B&layers=title&pointer=1,0" --dpr 1 --out $O/t1x_p1,0.png &
node $S --url "$B&layers=title&pointer=-1,0" --dpr 1 --out $O/t1x_p-1,0.png &
wait
# motion: real mouse sweeps (no pinned pointer, no freeze → shimmer runs)
M="http://localhost:$PORT/?title=raster$EXTRA"
node $S --url "$M" --mouse "-0.9,0.7;0.9,-0.7" --moveMs 900 --frames 8 --every 70 --cols 4 --out $O/sweep_1440.png &
node $S --url "$M" --mouse "-0.9,0.7;0.9,-0.7" --moveMs 900 --frames 8 --every 70 --cols 4 --clip 300,170,560,320 --out $O/sweep_zoom_SLA.png &
node $S --url "$M" --mouse "0.9,0.7;-0.9,-0.7" --moveMs 900 --frames 8 --every 70 --cols 4 --clip 820,250,560,260 --out $O/sweep_zoom_VOLKOV.png &
wait
node $S --url "$B&pointer=0,0" --w 1920 --h 1080 --out $O/1920_p0,0.png &
node $S --url "$B&pointer=0,0" --w 390 --h 844 --dpr 3 --out $O/390_p0,0.png &
wait
echo done $O
