#!/bin/zsh
# generate.sh <name> [<name> ...] — запускает gen.sh (Codex image_generation) для перечисленных
# заготовок параллельно и ждёт все. Промпты ниже — ровно те, что использованы для финальных слоёв
# (см. README.md: какой вариант победил). Сырые PNG: $GEN_DIR/<name>/<name>.png (по умолчанию ./.gen-work).
# DRY=1 — только напечатать промпты. Один вызов ≈ 3 мин и тратит лимит подписки ChatGPT — не гонять без нужды.
here=${0:A:h}

# Общий «свет и плёнка» — подогнан под reference/sky-hero-v2.png (приглушённый персик, сине-серые тени).
STYLE="Photorealistic, like a real 35mm film photograph of the sky in the evening shortly before sunset, low warm sun; soft, muted, slightly hazy light; colour palette: sunlit cloud tops in muted pale peach / salmon-cream (pinkish apricot, never yellow, never orange, not saturated), shaded parts in soft blue-grey and mauve-grey, gentle atmospheric haze, low contrast, natural soft photographic detail (not over-sharpened, not HDR, not CGI)."

# Для луны — без облачной палитры, чтобы модель не дорисовала облака.
MOONSTYLE="Photorealistic, like a real 35mm film photograph, soft and slightly hazy, low contrast, natural (not over-sharpened, not HDR, not CGI). Only the moon, no clouds, no stars, no sky."

typeset -A SIZE BG PRM

# --- луна: первая четверть, светится правая половина, тёмная половина отсутствует ---
SIZE[moon-a]=1024x1024; BG[moon-a]=transparent
PRM[moon-a]="A photograph of the FIRST-QUARTER HALF MOON in the evening daylight sky: exactly half of the lunar disc is lit, the RIGHT half, and the boundary between lit and unlit parts (the terminator) is a perfectly straight vertical line through the centre of the disc, so the lit part looks like a capital letter D. The LEFT unlit half is completely absent: fully transparent, no grey disc, no earthshine, no outline, nothing. The lit half is warm pale cream with a faint peach tint, soft and slightly hazy as seen through the evening atmosphere, with subtle faint grey maria and soft crater texture getting a little darker toward the straight terminator, low contrast, a gently softened (not razor sharp) curved limb on the right. The disc is centred in the frame; the full disc diameter would be about 70 percent of the frame width. $MOONSTYLE"
SIZE[moon-b]=1024x1024; BG[moon-b]=transparent
PRM[moon-b]="A realistic half moon (first quarter phase) photographed through a telephoto lens in the blue evening sky before sunset: a D-shaped half disc, the RIGHT half illuminated, its flat left side is a straight vertical terminator line exactly through the centre of the disc; the left half of the moon is invisible (in daylight the dark side cannot be seen), so it must be fully transparent. Warm cream-ivory colour with a slight peach cast from the low sun, delicate pale grey maria, a few soft craters near the terminator, slightly hazy and soft, low contrast. The full lunar disc (including the invisible half) is centred and would span about 70 percent of the frame width. $MOONSTYLE"

# --- облачка: редкая горстка мелких мягких кучевых, для середины-справа ---
SIZE[cloudlets-a]=1536x1024; BG[cloudlets-a]=transparent
PRM[cloudlets-a]="Five to seven small, separate fair-weather cumulus cloudlets floating in open air, widely spaced with plenty of empty space between them, varied sizes: one or two medium puffy ones (each about one fifth of the frame width), the rest small soft puffs and tiny fragments; loosely scattered across the middle band of the frame, nothing touching the frame edges. Soft, calm, slightly hazy, delicate cloud texture as seen from far away, softly diffused edges (not crisp, not cut-out). Tops lit in muted pale peach / apricot-cream, undersides soft blue-grey and lavender-grey. $STYLE"
SIZE[cloudlets-b]=1536x1024; BG[cloudlets-b]=transparent
PRM[cloudlets-b]="A sparse handful (about six) of small soft cumulus humilis cloudlets drifting in a loose diagonal line from the upper left to the lower right of the frame, generous empty gaps between them, sizes from tiny wisps to one modest rounded puff about one sixth of the frame width; none of them touches the frame edges. Distant, gentle and hazy, softly diffused fluffy edges, calm and quiet, not dramatic. Tops softly lit muted peach, bases cool blue-grey. $STYLE"

# --- передний банк: плотная стена больших кучевых снизу ---
SIZE[bank-front-a]=1536x1024; BG[bank-front-a]=transparent
PRM[bank-front-a]="A dense, wide bank of big rounded cumulus clouds (cumulus congestus heaps) seen from a distance, rising from the bottom edge of the frame as one continuous wall that fills the lower half of the frame and touches the left, right and bottom edges with no gaps; its skyline is uneven: the tallest heaps are LEFT of centre and reach up to about 40 percent from the top of the frame, elsewhere the top edge sits at about 55 to 60 percent from the top, with smaller rounded domes along it. Large soft rounded billows, sunlit tops in muted peach / salmon-cream, shaded sides and lower parts in soft blue-grey and mauve-grey, atmospheric haze softening the lower and farther parts. The upper part of the frame is empty. $STYLE"
SIZE[bank-front-b]=1536x1024; BG[bank-front-b]=transparent
PRM[bank-front-b]="A photographic cloudscape layer: a thick, continuous bank of large fluffy cumulus clouds seen from far away at eye level, filling the bottom 45 percent of a wide frame and touching the left, right and bottom edges with no gaps; gentle uneven skyline of big rounded heaps, the highest heap about one third from the left reaching about 40 percent from the top, a lower broad dome right of centre, smaller puffs between. Soft billowing texture, sunlit upper surfaces muted peach and pale apricot-cream, lower and shaded parts dusty blue-grey with a hint of lavender, slight haze, low contrast. The upper part of the frame is empty. $STYLE"

# --- дальний банк: мягкий, в дымке, позади переднего ---
SIZE[bank-back-a]=1536x1024; BG[bank-back-a]=transparent
PRM[bank-back-a]="A distant, long, low bank of soft cumulus clouds far away near the horizon, stretching across the full width of the frame and touching the left, right and bottom edges; its uneven top edge sits at about half of the frame height, with a few gentle rounded domes rising to about 40 percent from the top. Very soft and hazy, softened by thick atmospheric perspective, low contrast, mostly pale lavender-grey and dusty blue-grey with only a faint pale peach glow on the highest tops; indistinct, diffuse edges. The upper half of the frame is empty. $STYLE"

# --- облачка-россыпь (проход 2): МНОГО мелких рваных кучевых — заполняют середину неба, чтобы небо
#     постепенно «сгущалось» к валу, как на референсе (ревью: «мало облаков в середине, чистое небо и сразу стена») ---
SIZE[cloudlets-sparse-a]=1536x1024; BG[cloudlets-sparse-a]=transparent
PRM[cloudlets-sparse-a]="A loose scattered field of MANY (about thirty to forty) small, fragmented fair-weather cumulus cloudlets (cumulus humilis and ragged cumulus fractus) seen from far away, spread irregularly over the whole frame: tiny specks and thin wisps, small soft puffs and a few little ragged clusters, the biggest cloudlet only about one tenth of the frame width; NO large clouds, no cloud bank, no solid mass. Irregular, natural spacing with open gaps between them (no rows, no grid, no diagonal line, no pattern); slightly more numerous and a little bigger toward the bottom of the frame, sparser and tinier toward the top; nothing touches the frame edges. Soft, hazy, slightly diffused edges, thin parts partly translucent, as seen through evening haze. Tops lit by the low sun in muted pale peach / apricot-cream, undersides soft blue-grey and lavender-grey. $STYLE"
SIZE[cloudlets-sparse-b]=1536x1024; BG[cloudlets-sparse-b]=transparent
PRM[cloudlets-sparse-b]="A wide, loose, patchy band of broken fair-weather cumulus: about thirty to forty small separate cloudlets and fragments scattered across the full width of the frame through its middle and lower half, like the scattered small clouds that float above a distant cloud bank; patchy and irregular, small soft puffs, little broken clusters of two or three puffs, ragged wisps and tiny specks, with open gaps of empty air between them; the band gets denser, hazier and slightly bigger toward its lower edge and thins out into tiny scattered specks toward its upper edge; no large clouds, nothing touching the frame edges, the top quarter of the frame is empty. Soft hazy diffused edges, delicate, partly translucent thin parts, far away. Tops lit in muted pale peach / salmon-cream, undersides soft blue-grey and mauve-grey. $STYLE"

# --- передний план (проход 2): БЛИЖНИЕ облака, плывут ПЕРЕД надписью — мягкие, не в фокусе,
#     много прозрачного, чтобы закрывать надпись только частично ---
SIZE[foreground-a]=1536x1024; BG[foreground-a]=transparent
PRM[foreground-a]="One long soft wisp band of cloud very close to the camera, drifting horizontally across the whole width of the frame through its middle, slightly out of focus (shallow depth of field, like a telephoto shot focused on something farther away), so all its edges are soft and blurred: a stretched, uneven streamer of cloud with a few thicker soft puffy knots and thin, translucent, veil-like stretches between them, frayed wispy ends, its height varying from very thin to about one fifth of the frame height; the band reaches the left and right frame edges; above and below it the frame is empty (more than two thirds of the frame is empty). The thick parts are lit softly in muted pale peach / apricot-cream on top, shaded soft blue-grey and lavender-grey below; the thin veils are pale and semi-transparent. $STYLE"
SIZE[foreground-b]=1536x1024; BG[foreground-b]=transparent
PRM[foreground-b]="Two or three separate soft cumulus puffs floating very close to the camera, slightly out of focus (shallow depth of field, focused far behind them), so their edges are soft and blurred, with thin translucent wispy fringes; irregular natural shapes, not round cartoon clouds: one medium puff in the lower left part of the frame (about one third of the frame width), one smaller flatter puff right of centre a bit higher, optionally one small wisp near the right; widely spaced, with large empty areas between and around them (more than two thirds of the frame is empty); nothing touches the frame edges. Sunlit tops in muted pale peach / apricot-cream, shaded sides and bases soft blue-grey and lavender-grey, gentle haze. $STYLE"

# второй заход по переднему плану (тоньше и прозрачнее, чтобы надпись читалась сквозь облака)
SIZE[foreground-a2]=1536x1024; BG[foreground-a2]=transparent
PRM[foreground-a2]="A few long, thin, torn wisps of cloud (cumulus fractus streamers) very close to the camera, stretched horizontally across the frame through its middle as one loose, broken band with gaps in it, slightly out of focus (shallow depth of field, focused far behind them) so they look soft and blurred; mostly thin and translucent like veils of mist, with only two or three small denser soft knots; frayed, tapering ends; the band is thin, about one eighth of the frame height at its thickest; the frame above and below the band is empty (more than three quarters of the frame is empty). Denser knots lit softly in muted pale peach on top, shaded soft blue-grey and lavender-grey below; the thin veils pale and semi-transparent. $STYLE"
SIZE[foreground-b2]=1536x1024; BG[foreground-b2]=transparent
PRM[foreground-b2]="Three small, separate, ragged cumulus fractus puffs floating very close to the camera, slightly out of focus (shallow depth of field, focused far behind them): soft blurred edges and thin translucent wispy tails trailing to one side; irregular torn shapes, not round cartoon clouds; each about one fifth to one quarter of the frame width; loosely spaced across the middle of the frame at slightly different heights, with large empty gaps between them; nothing touches the frame edges; more than three quarters of the frame is empty. Sunlit tops in muted pale peach / apricot-cream, shaded sides and bases soft blue-grey and lavender-grey. $STYLE"

# --- v0 (первый проход): эти три сырья тоже пошли в финал — sky-wide/sky-tall (грейд), bank-back-v0 ---
V0STYLE="Photorealistic, like a real photograph taken with a full-frame camera at golden hour shortly before sunset, low sun behind the viewer to the right; colour palette: dusty steel-blue sky, clouds lit warm peach and apricot on their sunlit tops, cool blue-grey and lavender shaded undersides, soft atmospheric haze."
SIZE[sky-wide]=1536x1024; BG[sky-wide]=opaque
PRM[sky-wide]="A clean evening sky plate looking slightly upward: smooth natural gradient from deep dusty steel blue at the top to soft pale dusty blue with a hint of lavender near the bottom edge; only a handful of very small, thin, scattered high cloudlets in the middle band, lit faintly peach; mostly open sky. No big clouds, no moon, no sun disc. $V0STYLE"
SIZE[sky-tall]=1024x1536; BG[sky-tall]=opaque
PRM[sky-tall]="A clean evening sky plate looking slightly upward, portrait orientation: smooth natural gradient from deep dusty steel blue at the top to soft pale dusty blue with a hint of lavender near the bottom edge; only a handful of very small, thin, scattered high cloudlets in the middle, lit faintly peach; mostly open sky. No big clouds, no moon, no sun disc. $V0STYLE"
SIZE[bank-back-v0]=1536x1024; BG[bank-back-v0]=transparent
PRM[bank-back-v0]="A distant, long, low bank of cumulus clouds stretching across the full width of the frame along the bottom third, seen far away: softer, hazier and more blue-grey than near clouds, only the tops catching faint peach light; the bank touches the left, right and bottom edges of the frame so it can be tiled horizontally. $V0STYLE"

for n in "$@"; do
  if [[ -z ${PRM[$n]} ]]; then echo "unknown asset: $n"; continue; fi
  if [[ -n $DRY ]]; then print -r -- "$n | ${SIZE[$n]} | ${BG[$n]} | ${PRM[$n]}"; continue; fi
  "$here/gen.sh" "$n" "${SIZE[$n]}" "${BG[$n]}" "${PRM[$n]}" &
done
wait
