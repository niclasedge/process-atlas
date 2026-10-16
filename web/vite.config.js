import { defineConfig } from 'vite';

// The build lands where app/main.py mounts StaticFiles, so one container serves
// both halves and there is no CORS story to get wrong.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // `pnpm --dir web dev` talks to a locally running uvicorn; without this the
    // dev server would answer /api itself with a 404 and the failure reads like
    // a missing diagram rather than a missing proxy.
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/health': 'http://127.0.0.1:8080',
    },
  },
});
