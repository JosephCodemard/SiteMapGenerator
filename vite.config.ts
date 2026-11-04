import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

// Stamp every build with the commit and time, so a bug report shows which build produced it.
let commit = 'dev';
try { commit = execSync('git rev-parse --short HEAD').toString().trim(); } catch { /* not a git checkout */ }

// Relative base so the build works at https://<user>.github.io/<repo>/
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 2500 },
  worker: { format: 'es' },
  define: { __BUILD__: JSON.stringify(`${commit} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`) },
});
