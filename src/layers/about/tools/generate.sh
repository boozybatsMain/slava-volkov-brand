#!/bin/zsh
# generate.sh [<name> ...] — запускает sky-layers/tools/gen.sh (Codex image_generation, opaque) для фотографий
# экрана ABOUT параллельно и ждёт все. Без аргументов — все девять. Промпты ниже — ровно те, что использованы
# (см. README.md: какая генерация пошла в финал). Сырые PNG: $GEN_DIR/<name>/<name>.png (по умолчанию ./.gen-work).
# DRY=1 — только напечатать промпты. Один вызов ≈ 2–4 мин и тратит лимит подписки ChatGPT — не гонять без нужды.
#
# Обработка сырья → public/assets/about/<name>.webp: process.py (рядом).
# Генерировать нужно ЧИСТЫЕ цветные фотографии во весь кадр: рваные края, грейд, квантование, обесцвечивание
# и зерно даёт шейдер экрана. Поэтому в промптах нет ни рамок, ни виньетки, ни зерна.
here=${0:A:h}
gen=$here/../../sky-layers/tools/gen.sh

# Общий хвост — фотографичность по образцу неба первого экрана (sky-layers/tools/generate.sh → STYLE),
# но дневной свет и прохладная, приглушённая палитра (референс reference/about-screen.webp: обрывки фото на чёрном).
STYLE="Photorealistic, like a real 35mm film photograph: natural daylight, soft, muted, slightly desaturated colours with a faint cool cast, low contrast, natural soft photographic detail (not over-sharpened, not HDR, not CGI), clean, no added film grain. Full-frame, edge to edge, no border, no frame, no vignette, no text."

typeset -A SIZE PRM
NAMES=(about-clouds-a about-clouds-b about-leaves-a about-leaves-b about-chameleon about-place about-canopy about-cirrus about-succulent)

# --- облака-башни крупно на синем небе (как окно с облаками в кадрах 03–04 референса) ---
SIZE[about-clouds-a]=1536x1024
PRM[about-clouds-a]="A close-up of towering cumulus clouds (cumulus congestus) in a clear blue midday sky, seen from below at a slight upward angle: a tight cluster of big cauliflower-like cloud towers fills the centre and the right half of the frame; the tallest tower rises from the bottom edge, slightly right of centre, up to about one fifth from the top; its sunlit domes are bright soft white with fine billowing detail, the shaded sides and undersides soft blue-grey; a few smaller detached puffs float in the upper left third; open blue sky (a slightly faded, cool blue) fills about one third of the frame, mostly toward the upper left; the bottom edge of the frame cuts through the bases of the clouds, which are a little darker grey. No ground, no horizon, no sun disc. $STYLE"

# --- низкий облачный вал над спокойным морем (кадр 05 референса: облака над горизонтом) ---
SIZE[about-clouds-b]=1536x1024
PRM[about-clouds-b]="A long, low bank of heavy cumulus clouds lying over a calm open sea, seen from the shore at eye level: the sea horizon is a perfectly straight, level line at about 72 percent from the top of the frame, running across the full width; below it the calm, slightly rippled grey-blue sea with soft reflections of the clouds fills the bottom quarter; above the horizon the cloud bank rises as one continuous wall of big rounded billows across the full width, its tops reaching about 30 percent from the top on the left and about 40 percent from the top on the right; the tops lit softly from above in white and pale grey, the lower parts and bases darker slate blue-grey with soft rain haze near the horizon; a band of pale, cool blue sky above the bank in the top quarter of the frame. No land, no boats, no sun disc. $STYLE"

# --- крупные листья на просвет, макро (квадратные обрывки с листьями в кадрах 03–05, 08) ---
SIZE[about-leaves-a]=1024x1024
PRM[about-leaves-a]="A macro photograph of a few large, broad leaves backlit by the sun (like fig or catalpa leaves): three or four big overlapping leaves fill the whole frame edge to edge; the largest one crosses diagonally from the lower left corner to the upper right corner, its translucent surface glowing a soft, muted green, with clearly visible branching veins and a fine cell texture; where the leaves overlap they form darker, crisp-edged shadow shapes; a thin stem enters from the bottom edge at about one third from the left. Only small gaps between the leaves, filled with blurred darker green foliage, no sky. Shallow depth of field: the central leaf sharp, the corners of the frame gently out of focus. $STYLE"

# --- высокие вайи папоротника и плющ, вертикаль ---
SIZE[about-leaves-b]=1024x1536
PRM[about-leaves-b]="Portrait orientation. Tall fern fronds and trailing ivy growing in front of a shaded old stone wall: two long fern fronds rise from the bottom edge almost to the top of the frame, curving gently, the main frond slightly left of centre, with finely divided leaflets along its whole length; a second frond leans to the right from the lower third; small heart-shaped ivy leaves climb along the right third of the frame from bottom to top; the background is a dark, softly out-of-focus damp stone wall and deeper foliage; the leaves catch soft diffuse daylight from the upper left, in muted, cool green; the plants fill the frame edge to edge with only small dark gaps between them. $STYLE"

# --- морда хамелеона, экстремальное макро (странное, живое — «weird ideas») ---
SIZE[about-chameleon]=1024x1024
PRM[about-chameleon]="An extreme macro close-up of a chameleon's FACE in side profile, facing left, filling the whole frame: its turret eye — a large domed, conical eyelid covered in tiny bead-like scales, with a small pin-hole opening in the middle showing a glossy dark pupil with a tiny highlight — sits just above the centre of the frame and takes about one third of the frame width; the bony casque ridge above the eye runs out of the top edge; the long mouth line with its scaly lips crosses the lower third of the frame from the left edge toward the lower right; the cheek and jaw continue out of the bottom and right edges, so there is no background except a small blurred, muted green-grey area in the lower left corner in front of the snout. Fine granular bead-like scales everywhere, slightly larger flat scales along the lips and along the ridge above the eye; skin in muted sage green with olive and pale grey-turquoise patches. Shallow depth of field: the eye and the scales around it sharp, the far edges of the frame softly out of focus; soft, diffuse daylight. A real animal, natural, not stylised. $STYLE"

# --- странное пустое место: выбеленная стена, тёмное окошко, лестница в никуда (кадр 04, справа) ---
SIZE[about-place]=1024x1536
PRM[about-place]="Portrait orientation. A strange, empty place: a large sun-bleached white plaster wall of an old, simple building fills almost the whole frame; its surface is rough, uneven and weathered, with hairline cracks, a few patches of fallen plaster showing grey stone beneath and faint water stains; one small square window — a deep black opening with no glass and no frame — sits at about one third from the top, slightly right of centre, about one eighth of the frame width wide; a lone, narrow concrete stair without a railing rises diagonally along the wall from the lower left corner, about eight steps, and ends abruptly in mid-air well below and to the left of the window, leading nowhere; the stair casts a hard diagonal shadow on the wall. Harsh midday sun from high above and to the upper right: short hard shadows, the plaster almost white; a narrow strip of pale, bleached blue sky along the top edge above the flat roofline (about one tenth of the frame height); a strip of dusty pale ground along the bottom edge. Nobody there; silent and eerie. $STYLE"

# --- крона дерева снизу на бледном небе ---
SIZE[about-canopy]=1536x1024
PRM[about-canopy]="Looking straight up into the canopy of a tall deciduous tree from directly beneath it: a dense layer of leaves and thin branches fills the frame edge to edge, the leaves silhouetted dark grey-green against a pale, bright, almost uniform overcast sky that shows through in many small irregular gaps (about one third of the frame in total), with the larger gaps toward the centre; a few thicker dark branches radiate from the lower left corner toward the centre of the frame; individual leaf shapes are readable at the edges of the gaps. Soft, flat light, no sun disc, no trunk visible except the branches. $STYLE"

# --- перистые облака: светлые штрихи на бледном небе (окно cirrus в t2; вторым заходом, генерация 8 из 9) ---
SIZE[about-cirrus]=1536x1024
PRM[about-cirrus]="Abstract high cirrus clouds (mare's tails) in a pale blue sky, looking straight up: long, thin, wispy white streaks of ice cloud sweep diagonally across the whole frame from the lower left toward the upper right, like soft dry brush strokes, several of them ending in hooked, feathery, curling tails; the streaks are densest across the middle band of the frame and thinner toward the top and bottom edges, with pale sky showing between them everywhere; the streaks are bright soft white with a fine fibrous, combed texture; the sky is a light, faded, cool pale blue, slightly lighter toward the bottom of the frame. Light and airy, high key, no dark or heavy clouds. No ground, no horizon, no sun disc, no contrails. $STYLE"

# --- бледная эхеверия сверху, макро (домашний обрывок shard и окно succ в t4; генерация 9 из 9) ---
SIZE[about-succulent]=1024x1024
PRM[about-succulent]="A macro photograph of a single pale echeveria succulent rosette seen from directly above, filling the whole frame edge to edge: thick, fleshy, spoon-shaped leaves in a tight, regular spiral around a small bud of young leaves exactly in the centre of the frame; the outer leaves run off all four edges of the frame; the leaves are a pale, powdery blue-grey with a soft chalky bloom, almost silvery white along their edges and tips, each leaf gently shaded where it tucks under the next one, with small soft shadows between the leaves; only small gaps between the outer leaves, in the corners, showing a pale light grey background. Soft, diffuse overcast light from above, no hard shadows. Light and graphic, high key, the spiral shape clearly readable even when the image is small. $STYLE"

(( $# )) || set -- $NAMES
for n in "$@"; do
  if [[ -z ${PRM[$n]} ]]; then echo "unknown image: $n"; continue; fi
  if [[ -n $DRY ]]; then print -r -- "$n | ${SIZE[$n]} | opaque | ${PRM[$n]}"; continue; fi
  "$gen" "$n" "${SIZE[$n]}" opaque "${PRM[$n]}" &
done
wait
