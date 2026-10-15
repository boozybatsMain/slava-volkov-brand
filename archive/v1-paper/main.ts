import './styles.css'
import { heroConfig } from './hero.config'
import { startHero } from './core/hero'

/** Version 1: world behind a paper sheet with two cutouts, UI on the paper, floating title. */
startHero({
  root: document.getElementById('hero')!,
  config: heroConfig,
  layers: {
    world: () => import('./layers/world').then((m) => m.createWorldLayer),
    paper: () => import('./layers/paper').then((m) => m.createPaperLayer),
    // straight to the raster chunk: one network round trip less before the title can load
    title: () => import('./layers/title/raster').then((m) => m.createLayer),
  },
})
