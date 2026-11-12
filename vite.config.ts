import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true,
    // `npm run server` in another terminal: multiplayer works on the dev URL with no setup
    proxy: { '/ws': { target: 'ws://localhost:8787', ws: true } },
  },
  build: { chunkSizeWarningLimit: 1200 },
});
