#!/usr/bin/env node
/**
 * Bakes the outlines of the title letters (Russo One, OFL) into a small JSON
 * consumed by src/layers/title/mesh at runtime — no font parsing in the browser.
 *
 *   node scripts/title-mesh/bake-glyphs.mjs
 *
 * Output: src/layers/title/mesh/glyphs.json
 *   { unitsPerEm, capHeight, space, glyphs: { S: { adv, cmds: [[op, ...xy]] } }, kern: { "AV": -70 } }
 *
 * The S is lightly re-drawn to match reference/title-main.jpg: Russo's S has a slanted
 * "flag" bottom-left terminal and a short top bar; the reference S has a square
 * bottom-left terminal and a top bar reaching almost to the right edge.
 */
import opentype from 'opentype.js'
import fs from 'node:fs'
import path from 'node:path'

const TEXT = 'SLAVA VOLKOV'
const FONT = 'node_modules/@fontsource/russo-one/files/russo-one-latin-400-normal.woff'
const OUT = 'src/layers/title/mesh/glyphs.json'

const buf = fs.readFileSync(FONT)
const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))

const toCmds = (cmds) =>
  cmds.map((c) => {
    switch (c.type) {
      case 'M':
      case 'L':
        return [c.type, c.x, c.y]
      case 'Q':
        return ['Q', c.x1, c.y1, c.x, c.y]
      case 'C':
        return ['C', c.x1, c.y1, c.x2, c.y2, c.x, c.y]
      default:
        return ['Z']
    }
  })

/** Hand-edited S (font units, y up). Same curves as Russo One except the two terminals. */
const S_PATH =
  'M30,-10 L30,130 L410,130 Q433,130,446.5,143.5 Q460,157,460,180 L460,270 L230,270 ' +
  'Q125,270,77.5,317.5 Q30,365,30,470 L30,500 Q30,605,77.5,652.5 Q125,700,230,700 ' +
  'L640,700 L640,560 L270,560 Q210,560,210,500 L210,480 Q210,420,270,420 L450,420 ' +
  'Q548,420,594,374 Q640,328,640,230 L640,180 Q640,82,594,36 Q548,-10,450,-10 Z'

function parseSvgPath(d) {
  const out = []
  const re = /([MLQCZ])([^MLQCZ]*)/g
  let m
  while ((m = re.exec(d))) {
    const nums = m[2].trim() ? m[2].trim().split(/[\s,]+/).map(Number) : []
    out.push([m[1], ...nums])
  }
  return out
}

const glyphs = {}
for (const ch of new Set(TEXT.replace(/ /g, ''))) {
  const g = font.charToGlyph(ch)
  glyphs[ch] = {
    adv: g.advanceWidth,
    cmds: ch === 'S' ? parseSvgPath(S_PATH) : toCmds(g.path.commands),
  }
}

const kern = {}
for (let i = 0; i < TEXT.length - 1; i++) {
  const a = TEXT[i]
  const b = TEXT[i + 1]
  if (a === ' ' || b === ' ') continue
  const k = font.getKerningValue(font.charToGlyph(a), font.charToGlyph(b))
  if (k) kern[a + b] = k
}
// reference: the L sits tight against the S
kern.SL = (kern.SL ?? 0) - 30

const data = {
  source: 'Russo One (SIL OFL 1.1), S re-drawn',
  text: TEXT,
  unitsPerEm: font.unitsPerEm,
  capHeight: font.tables.os2?.sCapHeight ?? 700,
  space: font.charToGlyph(' ').advanceWidth,
  glyphs,
  kern,
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(data))
console.log(`baked ${Object.keys(glyphs).join('')} → ${OUT} (${fs.statSync(OUT).size} bytes)`, kern)
