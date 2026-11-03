import { defineConfig } from 'vite';

// Relative base so the build works at https://<user>.github.io/<repo>/
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 2500 },
  worker: { format: 'es' },
});
