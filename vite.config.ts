import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: !!process.env.PORT,
  },
  build: {
    // three.js and Нетопырь live in one lazily loaded chunk (~150 kB gzip), loaded after the page is up
    chunkSizeWarningLimit: 700,
  },
})
