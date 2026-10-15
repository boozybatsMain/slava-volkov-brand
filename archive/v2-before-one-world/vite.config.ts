import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: !!process.env.PORT,
  },
  // three.js lives in the lazily loaded title chunk (~140 kB gzip); that is expected
  // one page: index.html — version 2 (sky). Version 1 (paper + windows) is in archive/v1-paper.
  build: {
    chunkSizeWarningLimit: 600,
  },
})
