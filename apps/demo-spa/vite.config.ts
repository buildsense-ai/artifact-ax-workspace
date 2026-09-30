import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
  },
  server: {
    port: 5173,
    proxy: {
      // Dev-only: the JEV judgment endpoint lives in a local sidecar so the
      // API key never enters the artifact bundle. `scripts/jev-sidecar.mjs`.
      '/jev': {
        target: 'http://127.0.0.1:8787',
        rewrite: (path) => path.replace(/^\/jev/, ''),
      },
    },
  },
});
