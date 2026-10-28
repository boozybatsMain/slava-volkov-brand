#!/usr/bin/env node
// Builds the mascot from these sources (node brand/mascot/src/build.mjs):
//   ../netopyr.html  the 3D viewer, one file, opens straight from disk (three.js comes from a CDN)
//   ../netopyr.js    the same model and moves as an ES module for three.js games: import from 'three'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(SRC, '..')
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8')

// the model: helpers, the rig, the pipistrelle's data, its moves (one shared scope, in this order)
const model = ['utils.js', 'rig.js', 'species.js', 'clips.js'].map(read).join('\n')

// the page: markup and styles, the model, then the viewer with the sky backdrop inlined
const viewer = read('viewer.js')
if (viewer.split('{{SKY}}').length !== 2) throw new Error('viewer.js must hold {{SKY}} exactly once')
const sky = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(SRC, 'sky.jpg')).toString('base64')
const page = read('shell.html') + model + '\n' + viewer.replace('{{SKY}}', sky) + '\n</script>\n</body>\n</html>\n'
fs.writeFileSync(path.join(OUT, 'netopyr.html'), page)

// the module
const head = `// Нетопырь, the Slava Volkov mascot: the 3D model and its moves for three.js (built from src/ by build.mjs; edit the sources).
// See README.md next to this file. Short version:
//   const bat = new BatView(NETOPYR, { env, shadow: true })   // bat.g is the bat, bat.fxg its eye trails: add both to one parent
//   each frame: TIME.value += dt; PXU.value = renderer.getPixelRatio()
//               const b = base(); CLIPS[i].fn(t, b); bat.pose(b); bat.tick(dt, worldUnitsPerCssPixel, dirToCamera)
// Bloom (threshold about 1) makes the eyes and their trails glow as in the viewer.
import * as THREE from 'three'
`
const tail = `
export { BatView, NETOPYR, CLIPS, base, K, PERCH_Y, TIME, PXU, qF, qH, qU }
`
fs.writeFileSync(path.join(OUT, 'netopyr.js'), head + model + tail)

console.log('netopyr.html', page.length, 'bytes; netopyr.js', (head + model + tail).length, 'bytes')
