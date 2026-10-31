/**
 * CLOUD EDGES — where the cloud is inside a picture of the veil, column by column.
 *
 * The nav changes its ink as the white comes behind each of its pieces (index.ts → look()), and the
 * white is the veil's clouds rising from below: the wisp that goes first, then the wall. Their edges
 * are anything but level — the wall has a tower, a notch and a shoulder: a fifth of the screen's
 * height between two words of the same nav — so one "crest" number for a whole cloud turns a word
 * dark long before, or after, the cloud is behind it. The pictures themselves know better: the alpha
 * of each is read once, at a tiny size, into a profile of its upper and lower edge.
 *
 * Read from the same URL the veil draws (the HTTP cache answers: no second download), and only when
 * somebody first asks — the nav does when it leaves the hero's strip. Until a picture is read, or
 * if it cannot be, silhouetteOf() answers null and the caller keeps its fallback.
 */

/** Columns of a profile. The veil's clouds are out of focus: nothing in them is narrower than a hundredth of the picture. */
const COLS = 96

export interface Silhouette {
  /**
   * Per column, left → right: where the cloud begins and where it ends below the picture's top, in
   * shares of the picture's WIDTH. A column without cloud has top > bottom.
   */
  top: Float32Array
  bottom: Float32Array
  /** the picture's height / width */
  ratio: number
}

const read = new Map<string, Silhouette | null>()
const asked = new Set<string>()

/**
 * The silhouette of the picture at `url`: its pixels at least `solid` opaque (0…1) are cloud.
 * null until it is read (the first call starts the read) and for good if it cannot be.
 */
export function silhouetteOf(url: string, solid: number): Silhouette | null {
  const level = Math.min(255, Math.max(1, Math.round(solid * 255)))
  const key = `${level}|${url}`
  if (!asked.has(key)) {
    asked.add(key)
    void load(url, level)
      .catch(() => null)
      .then((s) => read.set(key, s))
  }
  return read.get(key) ?? null
}

async function load(url: string, level: number): Promise<Silhouette | null> {
  const res = await fetch(url)
  if (!res.ok) return null
  const bmp = await createImageBitmap(await res.blob())
  const ratio = bmp.height / Math.max(1, bmp.width)
  const rows = Math.max(2, Math.round(COLS * ratio))
  const canvas = document.createElement('canvas')
  canvas.width = COLS
  canvas.height = rows
  const g = canvas.getContext('2d', { willReadFrequently: true })
  if (!g) return null
  g.drawImage(bmp, 0, 0, COLS, rows)
  bmp.close()
  const px = g.getImageData(0, 0, COLS, rows).data
  const alpha = (x: number, y: number) => px[(y * COLS + x) * 4 + 3]
  // where the alpha crosses `level` between two neighbouring rows (a row's alpha is that of its
  // middle): the profile has no steps
  const cross = (x: number, clear: number, cloud: number) => {
    const a0 = alpha(x, clear)
    const a1 = alpha(x, cloud)
    return clear + 0.5 + ((cloud - clear) * (level - a0)) / Math.max(1, a1 - a0)
  }
  const top = new Float32Array(COLS)
  const bottom = new Float32Array(COLS)
  for (let x = 0; x < COLS; x++) {
    let y0 = 0
    while (y0 < rows && alpha(x, y0) < level) y0++
    if (y0 === rows) {
      // no cloud in this column
      top[x] = ratio
      bottom[x] = 0
      continue
    }
    let y1 = rows - 1
    while (alpha(x, y1) < level) y1--
    top[x] = ((y0 > 0 ? cross(x, y0 - 1, y0) : 0) / rows) * ratio
    bottom[x] = ((y1 < rows - 1 ? cross(x, y1 + 1, y1) : rows) / rows) * ratio
  }
  return { top, bottom, ratio }
}

/**
 * The cloud at the share `s` of the picture's width (0 — its left side, 1 — its right): where it
 * begins and ends below the picture's top, in shares of the picture's width → out[0], out[1].
 * `flipX` — the picture is drawn mirrored. `tiled` — beyond its sides the picture goes on mirrored
 * (a bank); otherwise there is nothing there (out[0] > out[1]).
 */
export function cloudAt(sil: Silhouette, s: number, flipX: boolean, tiled: boolean, out: [number, number]) {
  let t = s
  if (tiled) {
    // the mirrored copies on either side: … 1 → 0 | 0 → 1 | 1 → 0 …
    t = Math.abs(s) % 2
    if (t > 1) t = 2 - t
  } else if (s < 0 || s > 1) {
    out[0] = sil.ratio
    out[1] = 0
    return
  }
  if (flipX) t = 1 - t
  const f = t * (COLS - 1)
  const i = Math.min(COLS - 2, Math.floor(f))
  const k = f - i
  out[0] = sil.top[i] + (sil.top[i + 1] - sil.top[i]) * k
  out[1] = sil.bottom[i] + (sil.bottom[i + 1] - sil.bottom[i]) * k
}
