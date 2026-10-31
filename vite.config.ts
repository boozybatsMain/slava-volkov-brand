import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { homeGames, allGames } from './src/games.render'

export default defineConfig({
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: !!process.env.PORT,
  },
  plugins: [
    {
      // the game cards come from src/games.data.ts, written into the pages at build (and dev) time
      name: 'games',
      // 'pre': before Vite's own pass, so the covers' URLs get the deploy base like any other asset
      transformIndexHtml: {
        order: 'pre',
        handler: (html) => html.replace('<!--games:home-->', homeGames()).replace('<!--games:all-->', allGames()),
      },
    },
  ],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        games: resolve(__dirname, 'games/index.html'),
      },
    },
    // three.js and Нетопырь live in one lazily loaded chunk (~150 kB gzip), loaded after the page is up
    chunkSizeWarningLimit: 700,
  },
})
