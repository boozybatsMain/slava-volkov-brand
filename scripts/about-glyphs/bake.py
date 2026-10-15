"""
ABOUT — bake the letter outlines for the 3D concrete words (src/layers/about/font.json).

Russo One (SIL OFL 1.1, see OFL.txt next to this file) → the archived title-mesh glyph format:
  { source, license, unitsPerEm, capHeight, space, glyphs: { ch: { adv, cmds } }, kern: { "AB": dx } }
  cmds — ['M', x, y] ['L', x, y] ['Q', x1, y1, x, y] ['C', x1, y1, x2, y2, x, y] ['Z'], font units, y UP
  kern — GPOS pair kerning (the 'kern' feature, PairPos format 1 and 2) between every two baked
         characters, font units added to the first glyph's advance; only non-zero pairs are written.

No font is parsed at runtime: src/layers/about/mesh.ts reads this JSON.

Run (fontTools lives in the user site-packages: -E, not -I):
  /usr/bin/python3 -E scripts/about-glyphs/bake.py \
      scripts/about-glyphs/russo-one-latin-400-normal.woff src/layers/about/font.json
"""
import json
import sys

from fontTools.pens.basePen import BasePen
from fontTools.ttLib import TTFont

CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'’&.,-!?"


class Pen(BasePen):
    """Records the outline as the archive's command list (integers where the font has integers)."""

    def __init__(self, glyph_set):
        super().__init__(glyph_set)
        self.cmds = []

    @staticmethod
    def _n(v):
        return int(v) if float(v).is_integer() else round(float(v), 3)

    def _pt(self, *pts):
        return [self._n(c) for p in pts for c in p]

    def _moveTo(self, p):
        self.cmds.append(['M', *self._pt(p)])

    def _lineTo(self, p):
        self.cmds.append(['L', *self._pt(p)])

    def _qCurveToOne(self, a, b):
        self.cmds.append(['Q', *self._pt(a, b)])

    def _curveToOne(self, a, b, c):
        self.cmds.append(['C', *self._pt(a, b, c)])

    def _closePath(self):
        self.cmds.append(['Z'])

    def _endPath(self):
        self.cmds.append(['Z'])


def pair_kerning(font, names):
    """{(left glyph name, right glyph name): x advance adjustment} from GPOS 'kern' (PairPos 1 / 2)."""
    out = {}
    if 'GPOS' not in font:
        return out
    gpos = font['GPOS'].table
    want = set(names)
    lookups = set()
    for fr in gpos.FeatureList.FeatureRecord:
        if fr.FeatureTag == 'kern':
            lookups.update(fr.Feature.LookupListIndex)
    for li in sorted(lookups):
        lookup = gpos.LookupList.Lookup[li]
        subtables = lookup.SubTable
        if lookup.LookupType == 9:  # extension: keep only the wrapped pair adjustments
            subtables = [st.ExtSubTable for st in subtables if st.ExtensionLookupType == 2]
        elif lookup.LookupType != 2:
            continue
        for st in subtables:
            cover = st.Coverage.glyphs
            if st.Format == 1:
                for first, ps in zip(cover, st.PairSet):
                    if first not in want:
                        continue
                    for rec in ps.PairValueRecord:
                        v = getattr(rec.Value1, 'XAdvance', 0) if rec.Value1 else 0
                        if rec.SecondGlyph in want and v and (first, rec.SecondGlyph) not in out:
                            out[(first, rec.SecondGlyph)] = v
            elif st.Format == 2:
                c1 = st.ClassDef1.classDefs if st.ClassDef1 else {}
                c2 = st.ClassDef2.classDefs if st.ClassDef2 else {}
                covered = set(cover)
                for first in names:
                    if first not in covered:
                        continue
                    r1 = st.Class1Record[c1.get(first, 0)]
                    for second in names:
                        rec = r1.Class2Record[c2.get(second, 0)]
                        v = getattr(rec.Value1, 'XAdvance', 0) if rec.Value1 else 0
                        if v and (first, second) not in out:
                            out[(first, second)] = v
    return out


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    src, dst = sys.argv[1], sys.argv[2]
    font = TTFont(src)
    gs = font.getGlyphSet()
    cmap = font.getBestCmap()
    names = {}
    glyphs = {}
    for ch in CHARS:
        name = cmap.get(ord(ch))
        if name is None:
            sys.exit(f'no glyph for {ch!r} in {src}')
        pen = Pen(gs)
        gs[name].draw(pen)
        glyphs[ch] = {'adv': gs[name].width, 'cmds': pen.cmds}
        names[ch] = name
    kern_by_name = pair_kerning(font, list(names.values()))
    kern = {}
    for a in CHARS:
        for b in CHARS:
            v = kern_by_name.get((names[a], names[b]), 0)
            if v:
                kern[a + b] = v
    data = {
        'source': 'Russo One 400 (latin subset of @fontsource/russo-one 5.3.0), baked by scripts/about-glyphs/bake.py',
        'license': 'Copyright (c) 2011-2012, Jovanny Lemonad, with Reserved Font Name "Russo". SIL Open Font License 1.1 (scripts/about-glyphs/OFL.txt)',
        'unitsPerEm': font['head'].unitsPerEm,
        'capHeight': font['OS/2'].sCapHeight,
        'space': gs[cmap[32]].width,
        'glyphs': glyphs,
        'kern': kern,
    }
    with open(dst, 'w') as f:
        json.dump(data, f, separators=(',', ':'), ensure_ascii=False)
        f.write('\n')
    size = len(json.dumps(data, separators=(',', ':'), ensure_ascii=False).encode())
    print(f'{dst}: {len(glyphs)} glyphs, {len(kern)} kerning pairs, {size} bytes')


if __name__ == '__main__':
    main()
