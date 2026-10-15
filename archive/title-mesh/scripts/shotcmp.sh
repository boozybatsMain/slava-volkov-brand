#!/bin/sh
# usage: scripts/title-mesh/shotcmp.sh <name> [extra query, e.g. "&mesh.material.horizon=12"]
cd "$(dirname "$0")/../.."
node scripts/shot.mjs --url "http://localhost:${PORT:-5184}/?title=mesh&layers=title&pointer=0,0&freeze=2$2" --out "shots/title-mesh/$1_title.png" --w 1440 --h 900 --dpr 2 | grep -v vite
python3 scripts/title-mesh/compare.py "shots/title-mesh/$1_title.png" "shots/title-mesh/cmp_$1.png" >/dev/null && echo "shots/title-mesh/cmp_$1.png"
