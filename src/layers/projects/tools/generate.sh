#!/bin/zsh
# generate.sh <name> [<name> ...] — запускает gen.sh (Codex image_generation) для перечисленных
# картинок проектов параллельно и ждёт все. Промпты ниже — ровно те, что использованы.
# Сырые PNG: $GEN_DIR/<name>/<name>.png (по умолчанию ./.gen-work). DRY=1 — только напечатать промпты.
# Один вызов ≈ 3 мин и тратит лимит подписки ChatGPT — не гонять без нужды.
#
# Это ЗАГЛУШКИ: «скриншоты из игры», сгенерированные по описаниям проектов (content/*/post.md).
# Настоящие кадры кладутся в public/assets/projects/ и подключаются в sky.config.ts → projects.
here=${0:A:h}

# Общий кадр: картинка показывается на намеренно «плохом» экране низкого разрешения (≈ 400–700 px
# рендера в ширину) и обрезается по высоте до ≈ 2:1 — поэтому крупная читаемая композиция, один
# главный объект, всё важное в средних 75% высоты.
FRAME="This is an in-game screenshot: a direct frame capture from a 3D video game, with a small pixel-art HUD drawn over it in screen space. Bold, simple, readable composition with one clear focal subject; it must still read when shrunk to 500 pixels wide. Keep the main subject and every HUD element inside the central 75 percent of the frame height (the top and bottom strips may be cropped away) and away from the left and right edges."

typeset -A SIZE PRM

# 1 — Take the Elevator (по референсу reference/projects-screen.png: парящие руины над облаками, мальчик со спины)
SIZE[take-the-elevator]=1536x1024
PRM[take-the-elevator]="A stylised 3D puzzle-adventure game. Ancient pale stone ruins overgrown with ivy and moss float as islands high in a bright blue sky above a sea of white clouds: on the left a massive weathered stone archway and wall in the foreground, in the middle distance broken floating towers, bridges and chunks of masonry hanging in the air at impossible angles, some upside down. In the centre, seen from behind in third person, a small boy with messy brown hair, a brown backpack, a pale blue shirt, blue trousers and brown boots stands on a mossy stone ledge, looking out. Far away, on one small floating slab of stone, stands a lone old brass cage elevator with a warm light inside, absurdly out of place. Chunky simple geometry, painterly textures with slightly visible texels, soft warm sunlight, crisp shadows, calm and strange. HUD: three small pixel-art hearts in the top left (two filled red, the third an empty white outline); a small translucent square minimap with thin white maze lines and one white marker at the right side of the frame, a little above the middle. $FRAME"

# 2 — Midnight Apex (genex.games/midnight-apex: ночные гонки под дождём, неон, дрифт)
SIZE[midnight-apex]=1536x1024
PRM[midnight-apex]="A browser 3D street-racing game at night in heavy rain, in the spirit of early-2000s arcade racers. Chase camera low behind a sleek dark sports coupe drifting hard through a wide wet city corner: red tail lights leave streaks, tyre spray and a few sparks fly, the asphalt is a mirror of pink, cyan and violet neon from signs and shop fronts (the signs are abstract glowing shapes and bars, not letters), tall dark buildings recede into wet haze, light poles and raindrop streaks catch the glow. Glossy car paint, strong reflections, slightly simple low-detail geometry of a web game. HUD: big pixel-art speed digits 217 in the bottom right with a small curved rev bar above them; a small minimap with a thin white track outline and a dot in the top right; a tiny lap counter of digits 2/3 in the top left. $FRAME"

# 3 — Snowball (genex.games/snowball: катишь снежный ком, растёшь, подминаешь ёлки и других игроков)
SIZE[snowball]=1536x1024
PRM[snowball]="A cheerful low-poly multiplayer browser game in fresh snow on a bright cold morning. Third-person camera behind and slightly above a huge rough snowball rolling downhill across a white slope, leaving a wide flattened trail behind it; it is just crushing a small low-poly fir tree, snow chunks flying; around it stand many more simple low-poly fir trees and a few grey rocks; two or three much smaller snowballs of other players roll nearby, each with a small coloured arrow marker floating above it (red, yellow, teal); soft blue shadows, pale blue sky, distant low-poly mountains. Flat-shaded faceted geometry, clean simple colours. HUD: a small pixel-art snowball icon with the digits 148 in the top left; three short coloured ranking bars with digits in the top right. $FRAME"

# 4 — Wildlife (саванна, которая сама держит равновесие: у каждого зверя свой мозг)
SIZE[wildlife]=1536x1024
PRM[wildlife]="A low-poly ecosystem simulation game: an African savanna at golden hour seen from a raised three-quarter view. A small blue waterhole in the centre with two low-poly giraffes drinking, a family of three elephants walking in from the right, a few zebras grazing on the left, one cheetah lying in the tall yellow grass in the foreground, flat-topped acacia trees, warm long shadows, dusty orange haze toward the horizon, a low sun. Flat-shaded faceted animals with simple charming shapes, warm ochre, olive and terracotta palette. HUD: a small pixel-art sun-and-moon day dial in the top left; a row of four tiny animal head icons with digits next to them (12, 7, 23, 3) in the top right; one small thought-bubble icon with a water drop above a giraffe. $FRAME"

# 5 — Wildfire (genex.games/world/wildfire: дракон, огонь по-настоящему расходится по лесу)
SIZE[wildfire]=1536x1024
PRM[wildfire]="A low-poly sandbox game at dusk: a dark red dragon with wide wings flies low over a dense low-poly pine forest, seen from behind and above, breathing a long bright stream of fire down onto the trees. Below, a wildfire spreads as a ragged glowing orange front eating through the forest: burning trees with tall flames and flying embers at the front, and behind the front a black charred strip of bare burnt trunks and grey ash with thin smoke rising; the untouched forest ahead is deep green; a purple-blue evening sky with heavy smoke lit orange from below. Flat-shaded faceted geometry, strong contrast between the fire glow and the dark forest. HUD: a small pixel-art flame icon with a short horizontal fuel bar in the bottom left; a small round minimap in the top right showing a green disc with an orange spreading patch. $FRAME"

for n in "$@"; do
  if [[ -z ${PRM[$n]} ]]; then echo "unknown picture: $n"; continue; fi
  if [[ -n $DRY ]]; then print -r -- "$n | ${SIZE[$n]} | ${PRM[$n]}"; continue; fi
  "$here/gen.sh" "$n" "${SIZE[$n]}" "${PRM[$n]}" &
done
wait
